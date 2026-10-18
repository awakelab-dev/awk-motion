import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Prisma, type Db } from '@wilox/db';
import type { AuthUser, DuplicateProjectResponse, GenerationSummary, ProjectSummary, RunStatus } from '@wilox/shared';
import { env, repoPath } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { RunStore } from '../generations/run-store.js';
import { HistoryService } from '../projects/history.service.js';
import { MediaService } from '../storage/media.service.js';
import { AccessService } from '../access/access.service.js';

/** Se duplica un video que no está trabajando: terminado, con error, detenido o esperando la aprobación de fotogramas. */
export const DUPLICABLE: RunStatus[] = ['done', 'error', 'paused', 'awaiting_approval'];

/** Lo que no se copia de la carpeta: el video con el logo dibujado (depende del logo del proyecto, se rehace si hace falta). */
export const skipInCopy = (rel: string) => /^exports\/.*_logo-[0-9a-f]+\.mp4(\.json)?$/i.test(rel);

/** Una copia de un JSON con el id viejo reemplazado (URLs /api/generations/<id>/… y rutas runs/<id>/…). */
export function rekey<T>(v: T, from: string, to: string): T {
  if (v === null || v === undefined) return v;
  return JSON.parse(JSON.stringify(v).split(from).join(to)) as T;
}

/** Entrega del video sin lo que es del original: el link para compartir y el de revisión (tokens propios). */
export function deliveryForCopy(d: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (!d || typeof d !== 'object') return Prisma.DbNull;
  const { share: _s, videoShare: _v, review: _r, ...rest } = d as Record<string, unknown>;
  return Object.keys(rest).length ? (rest as Prisma.InputJsonValue) : Prisma.DbNull;
}

/** «Nombre (copia)», «Nombre (copia 2)»… sin repetir un nombre de los proyectos del usuario. */
export function copyName(name: string, taken: Set<string>): string {
  const base = name.replace(/ \(copia(?: \d+)?\)$/, '');
  for (let i = 1; ; i++) {
    const n = `${base} (copia${i === 1 ? '' : ` ${i}`})`.slice(0, 80);
    if (!taken.has(n)) return n;
  }
}

const j = (v: unknown, from: string, to: string): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  v === null || v === undefined ? Prisma.DbNull : (rekey(v, from, to) as Prisma.InputJsonValue);

interface Copying {
  ownerId: string;
  total: number;
  done: number;
  failed: number;
}

/**
 * Duplicar un video o un proyecto (hito 9, T3e, ADR-107), sin costo: se copian las filas (párrafos, fotogramas y clips
 * con todas sus versiones, prompts, insertos, ajustes del logo por clip) y la carpeta (en el remoto, dentro de S3). El
 * duplicado toma el logo del proyecto donde queda. No se copian publicaciones, links para compartir o revisar,
 * observaciones del cliente ni el historial de costos (el duplicado cuesta 0).
 */
@Injectable()
export class DuplicateService {
  private readonly logger = new Logger('Duplicar');
  /** Proyectos duplicándose en segundo plano: id del proyecto nuevo → avance. */
  private readonly copying = new Map<string, Copying>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly store: RunStore,
    private readonly media: MediaService,
    private readonly history: HistoryService,
    private readonly access: AccessService,
  ) {}

  progress(projectId: string): ProjectSummary['copying'] {
    const c = this.copying.get(projectId);
    return c ? { done: c.done, total: c.total, failed: c.failed } : undefined;
  }

  /** Añade el avance a los proyectos que se están duplicando. */
  withProgress<T extends ProjectSummary>(p: T): T {
    const c = this.progress(p.id);
    return c ? { ...p, copying: c } : p;
  }

  /** Proyecto de destino: uno al que el usuario tiene acceso y no está archivado (hito 11, ADR-142). */
  private async targetProject(id: string, user: AuthUser) {
    const p = await this.access.project(id, user).catch(() => undefined);
    if (!p || p.archivedAt) throw new BadRequestException('Ese proyecto no existe o está archivado.');
    return p.id;
  }

  private statusOf(id: string, dbStatus: string): RunStatus {
    const rec = this.store.peek(id);
    if (rec?.busy) return 'render'; // trabajando aunque el estado diga otra cosa (p. ej. regenerando un clip)
    return (rec?.state.status ?? dbStatus) as RunStatus;
  }

  /** Duplica un video en su proyecto o en otro. */
  async duplicateVideo(id: string, user: AuthUser, projectId?: string): Promise<GenerationSummary> {
    // El acceso al video lo comprobó el guard (generations/:id…).
    const g = await this.db.generation.findFirst({ where: { id, trashedAt: null }, select: { id: true, status: true, projectId: true } });
    if (!g) throw new NotFoundException('Video no encontrado.');
    if (!DUPLICABLE.includes(this.statusOf(id, g.status))) throw new BadRequestException('El video se está generando: espera a que termine (o detenlo) para duplicarlo.');
    const target = projectId && projectId !== g.projectId ? await this.targetProject(projectId, user) : g.projectId;
    const newId = await this.copyVideo(id, target, user.id);
    const [s] = await this.history.summaries([newId]);
    return s;
  }

  /**
   * Duplica un proyecto: el proyecto nuevo («(copia)», con su logo y ajustes) sale al instante y sus videos se copian
   * en segundo plano, del más antiguo al más nuevo (así quedan en el mismo orden).
   */
  async duplicateProject(id: string, user: AuthUser): Promise<DuplicateProjectResponse> {
    // Hito 11 (ADR-142): cualquiera con acceso duplica; la copia es de quien duplica (no se comparte sola).
    await this.access.project(id, user);
    const ownerId = user.id;
    const p = await this.db.project.findFirst({ where: { id, trashedAt: null } });
    if (!p) throw new NotFoundException('Proyecto no encontrado.');
    if (p.system) throw new BadRequestException('«Sin clasificar» no se duplica: duplica sus videos uno a uno.');
    const gens = await this.db.generation.findMany({ where: { projectId: id, trashedAt: null }, select: { id: true, status: true }, orderBy: { createdAt: 'asc' } });
    const ids = gens.filter((g) => DUPLICABLE.includes(this.statusOf(g.id, g.status))).map((g) => g.id);
    const taken = new Set((await this.db.project.findMany({ where: { ownerId, deletedAt: null }, select: { name: true } })).map((r) => r.name));
    const np = await this.db.project.create({
      data: {
        ownerId,
        name: copyName(p.name, taken),
        description: p.description,
        scriptStyleId: p.scriptStyleId,
        // Logo y ajustes, sin el link del proyecto (T6): el duplicado no se comparte solo.
        delivery: deliveryForCopy(p.delivery),
      },
    });
    // El logo del proyecto (storage/projects/<id>/): el duplicado lo tiene igual y luego se cambia sin tocar el original.
    const pdir = (pid: string) => join(repoPath(env.STORAGE_DIR), 'projects', pid);
    await this.media.copyTree(pdir(id), pdir(np.id));
    if (ids.length) {
      const c: Copying = { ownerId, total: ids.length, done: 0, failed: 0 };
      this.copying.set(np.id, c);
      void (async () => {
        for (const gid of ids) {
          try {
            await this.copyVideo(gid, np.id, ownerId);
            c.done += 1;
          } catch (e) {
            c.failed += 1;
            this.logger.warn(`No se pudo duplicar ${gid} en el proyecto ${np.id}: ${(e as Error).message}`);
          }
        }
        this.logger.log(`Proyecto ${p.id} duplicado en ${np.id}: ${c.done} video(s)${c.failed ? `, ${c.failed} con error` : ''}.`);
        // El avance se muestra un rato más para que la web vea el final.
        setTimeout(() => this.copying.delete(np.id), 30_000).unref();
      })();
    }
    const summary = (await this.history.projects(user, true)).projects.find((x) => x.id === np.id)!;
    return { project: this.withProgress(summary), videos: ids.length, skipped: gens.length - ids.length };
  }

  /** Copia un video (filas y carpeta) en un proyecto; la copia es de quien duplica (hito 11, ADR-142). Devuelve el id nuevo. */
  private async copyVideo(id: string, projectId: string, ownerId: string): Promise<string> {
    // Lo último en memoria va primero a la BD.
    const rec = this.store.peek(id);
    if (rec) await this.store.flush(rec);
    const g = await this.db.generation.findUnique({
      where: { id },
      include: {
        paragraphs: true,
        keyframes: { include: { versions: true } },
        clips: { include: { versions: true } },
        prompts: true,
      },
    });
    if (!g) throw new NotFoundException('Video no encontrado.');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    const newId = `${stamp}-${g.themeKey}-${randomUUID().slice(0, 6)}`;
    const relDir = `runs/${newId}`;
    const root = repoPath(env.STORAGE_DIR);
    const srcDir = join(root, g.dir);
    const dstDir = join(root, relDir);
    // Primero los archivos: la fila nunca apunta a archivos que no están.
    const copied = await this.media.copyTree(srcDir, dstDir, { skip: skipInCopy });
    const r = <T>(v: T) => rekey(v, id, newId);
    try {
      await this.db.$transaction(
        async (tx) => {
          await tx.generation.create({
            data: {
              id: newId,
              ownerId,
              mode: g.mode,
              themeKey: g.themeKey,
              themeId: g.themeId,
              themeName: g.themeName,
              themeCopy: j(g.themeCopy, id, newId) as Prisma.InputJsonValue,
              voiceId: g.voiceId,
              text: g.text,
              status: g.status,
              message: g.message,
              error: g.error,
              approved: g.approved,
              durationSec: g.durationSec,
              totalFrames: g.totalFrames,
              voicePath: g.voicePath,
              finalPath: g.finalPath,
              finalFrames: g.finalFrames,
              // Sin historial de costos: el duplicado no cuesta nada.
              words: j(g.words, id, newId),
              storyboard: j(g.storyboard, id, newId),
              plan: j(g.plan, id, newId),
              shots: j(g.shots, id, newId),
              dir: relDir,
              projectId,
              parentId: null,
              copyOfId: id,
              musicTrack: g.musicTrack,
              soundMode: g.soundMode,
              soundGainDb: g.soundGainDb,
              voiceMode: g.voiceMode,
              delivery: deliveryForCopy(r(g.delivery)),
              inserts: j(g.inserts, id, newId),
              script: j(g.script, id, newId),
            },
          });
          if (g.paragraphs.length)
            await tx.paragraph.createMany({
              data: g.paragraphs.map((p) => ({ generationId: newId, index: p.index, text: p.text, startSec: p.startSec, durationSec: p.durationSec, version: p.version, spokenText: p.spokenText })),
            });
          for (const k of g.keyframes) {
            // Nada a medias: una regeneración interrumpida en el original no se retoma (ni se paga) en la copia.
            const ready = k.versions.some((v) => v.version === k.version && v.path);
            const status = k.status === 'generating' ? (ready ? 'ready' : 'error') : k.status;
            await tx.keyframe.create({
              data: {
                generationId: newId,
                index: k.index,
                label: k.label,
                texts: k.texts,
                prompt: k.prompt,
                status,
                version: k.version,
                error: status === 'error' && k.status === 'generating' ? 'Copiado mientras se regeneraba; regénéralo.' : k.error,
                review: j(k.review, id, newId),
                pending: Prisma.DbNull,
                previous: j(k.previous, id, newId),
                versions: { create: k.versions.map((v) => ({ version: v.version, path: v.path, prompt: v.prompt, remoteRef: v.remoteRef, createdAt: v.createdAt })) },
              },
            });
          }
          for (const c of g.clips)
            await tx.clip.create({
              data: {
                generationId: newId,
                index: c.index,
                title: c.title,
                startFrame: c.startFrame,
                slotEndFrame: c.slotEndFrame,
                prompt: c.prompt,
                status: c.status === 'generating' ? 'error' : c.status,
                version: c.version,
                deliveredFrames: c.deliveredFrames,
                ssimStart: c.ssimStart,
                ssimEnd: c.ssimEnd,
                error: c.error,
                startKeyVersion: c.startKeyVersion,
                endKeyVersion: c.endKeyVersion,
                note: c.note,
                taskId: c.taskId,
                soundMode: c.soundMode,
                soundLufs: c.soundLufs,
                versions: { create: c.versions.map((v) => ({ version: v.version, path: v.path, prompt: v.prompt, remoteRef: v.remoteRef, createdAt: v.createdAt })) },
              },
            });
          if (g.prompts.length)
            await tx.prompt.createMany({ data: g.prompts.map((p) => ({ generationId: newId, name: p.name, kind: p.kind, version: p.version, content: p.content, createdAt: p.createdAt })) });
          await tx.logEntry.create({ data: { generationId: newId, level: 'info', message: `Duplicado de ${id} (${copied.files} archivo(s); sin costo).` } });
        },
        { timeout: 60_000 },
      );
    } catch (e) {
      // Sin fila no hay video: se borra la carpeta copiada (también del remoto).
      await this.media.removed(dstDir).catch(() => undefined);
      await rm(dstDir, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
    return newId;
  }
}
