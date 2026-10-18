import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ensureUnclassified, type Db } from '@wilox/db';
import { TRASH_RETENTION_DAYS, type AuthUser, type RunStatus, type TrashResponse } from '@wilox/shared';
import { DB } from '../db/db.module.js';
import { RunStore } from '../generations/run-store.js';
import { HistoryService } from '../projects/history.service.js';
import { PublicationsService } from '../publications/publications.service.js';
import { AccessService } from '../access/access.service.js';

const DAY = 86_400_000;
/** Un video solo va a la papelera si no está trabajando (terminado, con error o detenido). */
const IDLE: RunStatus[] = ['done', 'error', 'paused'];

/**
 * Papelera (hito 9, T3d, ADR-106). Eliminar un video o un proyecto lo deja en la papelera (`trashedAt`); un proyecto se
 * va con sus videos (`trashedWithProject`) y vuelve con ellos. Desde la papelera se restaura o se elimina
 * definitivamente (`deletedAt`): el usuario ya no lo ve, pero los datos y los archivos se conservan, inaccesibles, para un
 * futuro superadministrador. A los 180 días se eliminan solos. Lo publicado no se elimina: hay que despublicarlo antes.
 * Hito 11 (ADR-142): todo esto es del dueño del proyecto (también para un video suelto de un proyecto compartido); la
 * papelera de cada usuario tiene lo de sus proyectos.
 */
@Injectable()
export class TrashService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Papelera');
  /** Videos fuera de la vista (en la papelera o eliminados): la API no los abre. */
  private readonly hidden = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly store: RunStore,
    private readonly history: HistoryService,
    private readonly publications: PublicationsService,
    private readonly access: AccessService,
  ) {}

  async onModuleInit() {
    for (const g of await this.db.generation.findMany({ where: { trashedAt: { not: null } }, select: { id: true } })) this.hidden.add(g.id);
    await this.purge().catch((e: Error) => this.logger.warn(`Limpieza: ${e.message}`));
    this.timer = setInterval(() => void this.purge().catch(() => undefined), 3_600_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** El video está en la papelera o eliminado (la API responde como si no existiera, salvo su miniatura). */
  isHidden(id: string) {
    return this.hidden.has(id);
  }

  private expires(d: Date) {
    return new Date(d.getTime() + TRASH_RETENTION_DAYS * DAY).toISOString();
  }

  // ─── Mandar a la papelera ──────────────────────────────────────────────────────────────────────────

  /** Lo publicado no se elimina: aviso (no se puede confirmar) con qué despublicar. */
  private async blockPublished(ids: string[], what: 'video' | 'project') {
    const uses = await this.publications.publishedUses(ids);
    if (!uses.size) return;
    const n = uses.size;
    throw new ConflictException({
      code: 'blocked',
      title: what === 'video' ? 'El video está publicado' : 'El proyecto tiene videos publicados',
      message:
        what === 'video'
          ? `Está publicado (${this.publications.usesText([...uses.values()][0])}). Primero despublícalo (botón «Publicar» del video → «Despublicar» en cada publicación) y después podrás eliminarlo.`
          : `${n} video${n === 1 ? '' : 's'} del proyecto ${n === 1 ? 'está publicado' : 'están publicados'} (Rise 360, SCORM liviano o a mano). Primero despublícalos (botón «Publicar» de cada video) y después podrás eliminar el proyecto.`,
    });
  }

  async trashVideo(id: string, user: AuthUser): Promise<void> {
    const g = await this.db.generation.findFirst({ where: { id, trashedAt: null }, select: { id: true, status: true, projectId: true } });
    if (!g) throw new NotFoundException('Video no encontrado.');
    await this.access.project(g.projectId, user, { owner: 'trash', trashed: true });
    const rec = this.store.peek(id);
    const status = (rec?.state.status ?? g.status) as RunStatus;
    if (!IDLE.includes(status)) throw new BadRequestException('El video se está generando: detenlo antes de eliminarlo.');
    await this.blockPublished([id], 'video');
    await this.db.generation.update({ where: { id }, data: { trashedAt: new Date(), trashedWithProject: false } });
    this.hidden.add(id);
    this.store.release(id);
    this.access.forget();
  }

  async trashProject(id: string, user: AuthUser): Promise<{ videos: number }> {
    const p = await this.access.project(id, user, { owner: 'trash' });
    if (p.system) throw new BadRequestException('«Sin clasificar» no se puede eliminar.');
    const gens = await this.db.generation.findMany({ where: { projectId: id, trashedAt: null }, select: { id: true, status: true } });
    const busy = gens.filter((g) => !IDLE.includes((this.store.peek(g.id)?.state.status ?? g.status) as RunStatus)).length;
    if (busy) throw new BadRequestException(`${busy} video${busy === 1 ? ' del proyecto se está' : 's del proyecto se están'} generando: detenlos antes de eliminar el proyecto.`);
    await this.blockPublished(gens.map((g) => g.id), 'project');
    const now = new Date();
    await this.db.$transaction([
      this.db.project.update({ where: { id }, data: { trashedAt: now } }),
      this.db.generation.updateMany({ where: { id: { in: gens.map((g) => g.id) } }, data: { trashedAt: now, trashedWithProject: true } }),
    ]);
    for (const g of gens) {
      this.hidden.add(g.id);
      this.store.release(g.id);
    }
    this.access.forget();
    return { videos: gens.length };
  }

  // ─── La papelera ───────────────────────────────────────────────────────────────────────────────────

  async count(ownerId: string): Promise<{ count: number }> {
    const [p, v] = await Promise.all([
      this.db.project.count({ where: { ownerId, trashedAt: { not: null }, deletedAt: null } }),
      this.db.generation.count({ where: { project: { ownerId }, trashedAt: { not: null }, deletedAt: null, trashedWithProject: false } }),
    ]);
    return { count: p + v };
  }

  async list(ownerId: string): Promise<TrashResponse> {
    const projects = await this.db.project.findMany({ where: { ownerId, trashedAt: { not: null }, deletedAt: null }, orderBy: { trashedAt: 'desc' } });
    const inProjects = await this.db.generation.findMany({
      where: { projectId: { in: projects.map((p) => p.id) }, trashedWithProject: true, deletedAt: null },
      select: { id: true, projectId: true },
      orderBy: { createdAt: 'desc' },
    });
    const thumbs = await this.history.thumbnails(projects.map((p) => inProjects.find((g) => g.projectId === p.id)?.id).filter((x): x is string => !!x));
    const videos = await this.db.generation.findMany({
      where: { project: { ownerId }, trashedAt: { not: null }, deletedAt: null, trashedWithProject: false },
      select: { id: true, trashedAt: true, project: { select: { name: true, trashedAt: true, deletedAt: true } } },
      orderBy: { trashedAt: 'desc' },
    });
    const sums = new Map((await this.history.summaries(videos.map((v) => v.id))).map((s) => [s.id, s]));
    return {
      projects: projects.map((p) => {
        const mine = inProjects.filter((g) => g.projectId === p.id);
        return { id: p.id, name: p.name, videos: mine.length, thumbnailUrl: mine[0] ? thumbs.get(mine[0].id) : undefined, trashedAt: p.trashedAt!.toISOString(), expiresAt: this.expires(p.trashedAt!) };
      }),
      videos: videos
        .filter((v) => sums.has(v.id))
        .map((v) => ({
          summary: sums.get(v.id)!,
          projectName: v.project.name,
          projectGone: !!(v.project.trashedAt || v.project.deletedAt),
          trashedAt: v.trashedAt!.toISOString(),
          expiresAt: this.expires(v.trashedAt!),
        })),
    };
  }

  /** Restaurar: un proyecto vuelve con sus videos; un video vuelve a su proyecto o, si ya no está, a «Sin clasificar». */
  async restore(kind: 'project' | 'video', id: string, user: AuthUser): Promise<{ projectId: string; unclassified: boolean }> {
    const ownerId = user.id;
    if (kind === 'project') {
      const p = await this.db.project.findFirst({ where: { id, trashedAt: { not: null }, deletedAt: null } });
      if (!p) throw new NotFoundException('No está en la papelera.');
      this.onlyOwner(p.ownerId, user, 'restore');
      const gens = await this.db.generation.findMany({ where: { projectId: id, trashedWithProject: true, deletedAt: null }, select: { id: true } });
      await this.db.$transaction([
        this.db.project.update({ where: { id }, data: { trashedAt: null } }),
        this.db.generation.updateMany({ where: { id: { in: gens.map((g) => g.id) } }, data: { trashedAt: null, trashedWithProject: false } }),
      ]);
      for (const g of gens) this.hidden.delete(g.id);
      this.access.forget();
      return { projectId: id, unclassified: false };
    }
    const g = await this.db.generation.findFirst({
      where: { id, trashedAt: { not: null }, deletedAt: null, trashedWithProject: false },
      select: { id: true, projectId: true, project: { select: { ownerId: true, trashedAt: true, deletedAt: true } } },
    });
    if (!g) throw new NotFoundException('No está en la papelera.');
    this.onlyOwner(g.project.ownerId, user, 'restore');
    let projectId = g.projectId;
    const gone = !!(g.project.trashedAt || g.project.deletedAt);
    if (gone) projectId = await ensureUnclassified(this.db, ownerId);
    await this.db.generation.update({ where: { id }, data: { trashedAt: null, projectId } });
    this.hidden.delete(id);
    this.access.forget();
    return { projectId, unclassified: gone };
  }

  /** Eliminar definitivamente: deja de verse (los datos y archivos se conservan, inaccesibles). */
  async deleteForever(kind: 'project' | 'video', id: string, user: AuthUser): Promise<void> {
    const now = new Date();
    if (kind === 'project') {
      const p = await this.db.project.findFirst({ where: { id, trashedAt: { not: null }, deletedAt: null }, select: { id: true, ownerId: true } });
      if (!p) throw new NotFoundException('No está en la papelera.');
      this.onlyOwner(p.ownerId, user, 'delete');
      await this.db.$transaction([
        this.db.project.update({ where: { id }, data: { deletedAt: now } }),
        this.db.generation.updateMany({ where: { projectId: id, trashedWithProject: true, deletedAt: null }, data: { deletedAt: now } }),
      ]);
      this.access.forget();
      return;
    }
    const g = await this.db.generation.findFirst({ where: { id, trashedAt: { not: null }, deletedAt: null, trashedWithProject: false }, select: { id: true, project: { select: { ownerId: true } } } });
    if (!g) throw new NotFoundException('No está en la papelera.');
    this.onlyOwner(g.project.ownerId, user, 'delete');
    await this.db.generation.update({ where: { id }, data: { deletedAt: now } });
    this.access.forget();
  }

  /**
   * Lo de la papelera es del dueño del proyecto (hito 11, ADR-142): otro usuario con acceso recibe 403 con el motivo;
   * quien no lo ve, 404 (el admin, primero se asigna el proyecto).
   */
  private onlyOwner(ownerId: string, user: AuthUser, action: 'restore' | 'delete') {
    if (ownerId === user.id) return;
    if (user.role === 'admin') throw new ForbiddenException(`Es de otro usuario: para ${action === 'restore' ? 'restaurarlo' : 'eliminarlo'}, primero pásalo a tu nombre (Usuarios → «Pasar sus proyectos a…»).`);
    throw new NotFoundException('No está en la papelera.');
  }

  /** Vaciar la papelera (todo pasa a eliminado definitivamente). */
  async empty(ownerId: string): Promise<{ projects: number; videos: number }> {
    const now = new Date();
    const projects = await this.db.project.updateMany({ where: { ownerId, trashedAt: { not: null }, deletedAt: null }, data: { deletedAt: now } });
    const videos = await this.db.generation.updateMany({ where: { project: { ownerId }, trashedAt: { not: null }, deletedAt: null }, data: { deletedAt: now } });
    this.access.forget();
    return { projects: projects.count, videos: videos.count };
  }

  /** A los 180 días en la papelera, se eliminan solos (siguen conservados, inaccesibles). */
  async purge() {
    const limit = new Date(Date.now() - TRASH_RETENTION_DAYS * DAY);
    const now = new Date();
    const p = await this.db.project.updateMany({ where: { trashedAt: { lt: limit }, deletedAt: null }, data: { deletedAt: now } });
    const g = await this.db.generation.updateMany({ where: { trashedAt: { lt: limit }, deletedAt: null }, data: { deletedAt: now } });
    if (p.count || g.count) this.logger.log(`${p.count} proyecto(s) y ${g.count} video(s) eliminados tras ${TRASH_RETENTION_DAYS} días en la papelera.`);
  }
}
