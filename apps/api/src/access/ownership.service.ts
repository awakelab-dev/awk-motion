import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { UNCLASSIFIED_NAME, type AuthUser, type ProjectAccessRequest, type ProjectAccessState, type UserRef, type UserTransferResponse } from '@wilox/shared';
import type { Db } from '@wilox/db';
import { DB } from '../db/db.module.js';
import { AccessService } from './access.service.js';
import { RunStore } from '../generations/run-store.js';

const USER_REF = { id: true, name: true, email: true, active: true } as const;
const label = (u: { name: string | null; email: string }) => u.name?.trim() || u.email;

/**
 * Compartir, hacer público y cambiar el dueño de los proyectos (hito 11, ADR-142). Compartir: el dueño o el admin.
 * Cambiar el dueño (de un proyecto o de todos los de un usuario, p. ej. suspendido): solo el admin.
 */
@Injectable()
export class OwnershipService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly store: RunStore,
  ) {}

  async state(projectId: string, user: AuthUser, o: { trashed?: boolean } = {}): Promise<ProjectAccessState> {
    const p = await this.access.project(projectId, user, o);
    const row = await this.db.project.findUniqueOrThrow({
      where: { id: p.id },
      select: {
        owner: { select: USER_REF },
        shares: { orderBy: { createdAt: 'asc' }, select: { createdAt: true, user: { select: USER_REF }, sharedBy: { select: USER_REF } } },
      },
    });
    const canShare = !p.system && (p.role === 'owner' || p.role === 'admin');
    // La lista de usuarios (con su email) solo la ve quien puede compartir; los demás ven con quién está compartido.
    const candidates = canShare ? await this.db.user.findMany({ where: { active: true, id: { not: p.ownerId } }, select: USER_REF, orderBy: [{ name: 'asc' }, { email: 'asc' }] }) : [];
    return {
      projectId: p.id,
      owner: row.owner,
      role: p.role,
      canShare,
      public: !!p.publicAt && !p.system,
      publicAt: p.publicAt?.toISOString() ?? null,
      shares: row.shares.map((s) => ({ user: s.user, sharedBy: s.sharedBy, createdAt: s.createdAt.toISOString() })),
      candidates,
      unclassified: !!p.system,
    };
  }

  /** Con quién se comparte (la lista completa) y si es público. Solo el dueño o el admin; «Sin clasificar», nunca. */
  async update(projectId: string, user: AuthUser, body: ProjectAccessRequest): Promise<ProjectAccessState> {
    const p = await this.access.project(projectId, user, { owner: 'share' });
    if (p.system) throw new BadRequestException(`«${UNCLASSIFIED_NAME}» no se comparte ni se hace público.`);
    const wanted = [...new Set(body.userIds)].filter((id) => id !== p.ownerId);
    const valid = wanted.length ? await this.db.user.findMany({ where: { id: { in: wanted }, active: true }, select: { id: true } }) : [];
    if (valid.length !== wanted.length) throw new BadRequestException('Algún usuario no existe o está suspendido.');
    const current = await this.db.projectShare.findMany({ where: { projectId: p.id }, select: { userId: true } });
    const have = new Set(current.map((s) => s.userId));
    await this.db.$transaction([
      this.db.projectShare.deleteMany({ where: { projectId: p.id, userId: { notIn: wanted } } }),
      this.db.projectShare.createMany({ data: wanted.filter((id) => !have.has(id)).map((userId) => ({ projectId: p.id, userId, sharedById: user.id })) }),
      this.db.project.update({ where: { id: p.id }, data: { publicAt: body.public ? (p.publicAt ?? new Date()) : null } }),
    ]);
    this.access.forget();
    return this.state(p.id, user);
  }

  /** Pasa un proyecto a otro dueño (admin). Si el nuevo dueño lo tenía compartido, deja de estarlo (ya es suyo). */
  async setOwner(projectId: string, admin: AuthUser, ownerId: string): Promise<ProjectAccessState> {
    const p = await this.access.project(projectId, admin, { trashed: true });
    if (p.system) throw new BadRequestException(`«${UNCLASSIFIED_NAME}» es de cada usuario: sus videos se pasan con «Pasar sus proyectos a…» en Usuarios.`);
    const to = await this.target(ownerId);
    if (to.id !== p.ownerId) {
      await this.db.$transaction([
        this.db.project.update({ where: { id: p.id }, data: { ownerId: to.id } }),
        this.db.projectShare.deleteMany({ where: { projectId: p.id, userId: to.id } }),
      ]);
      this.access.forget();
    }
    return this.state(p.id, admin, { trashed: true });
  }

  /**
   * Pasa todos los proyectos de un usuario a otro (admin), también los de la papelera. Los videos de su «Sin clasificar»
   * van a un proyecto normal nuevo del destinatario, «Sin clasificar de <nombre>»; el «Sin clasificar» del usuario
   * queda vacío (sigue siendo suyo).
   */
  async transferAll(fromId: string, toId: string): Promise<UserTransferResponse> {
    const from = await this.db.user.findUnique({ where: { id: fromId }, select: { id: true, name: true, email: true } });
    if (!from) throw new NotFoundException('Usuario no encontrado.');
    const to = await this.target(toId);
    if (to.id === from.id) throw new BadRequestException('Elige otro usuario.');
    const projects = await this.db.project.findMany({ where: { ownerId: from.id, deletedAt: null, system: null }, select: { id: true } });
    const ids = projects.map((p) => p.id);
    const unclassified = await this.db.project.findFirst({ where: { ownerId: from.id, system: { not: null } }, select: { id: true } });
    const loose = unclassified ? await this.db.generation.findMany({ where: { projectId: unclassified.id, deletedAt: null }, select: { id: true } }) : [];
    let unclassifiedProjectId: string | undefined;
    await this.db.$transaction(async (tx) => {
      await tx.project.updateMany({ where: { id: { in: ids } }, data: { ownerId: to.id } });
      await tx.projectShare.deleteMany({ where: { projectId: { in: ids }, userId: to.id } });
      if (loose.length) {
        const np = await tx.project.create({
          data: { ownerId: to.id, name: `${UNCLASSIFIED_NAME} de ${label(from)}`.slice(0, 80), description: `Videos que ${label(from)} tenía sin clasificar.` },
          select: { id: true },
        });
        unclassifiedProjectId = np.id;
        await tx.generation.updateMany({ where: { id: { in: loose.map((g) => g.id) } }, data: { projectId: np.id } });
      }
    });
    // Los videos abiertos en memoria también cambian de proyecto (si no, su próximo guardado devolvería el de antes).
    if (unclassifiedProjectId) {
      const np = unclassifiedProjectId;
      for (const g of loose) {
        const rec = this.store.peek(g.id);
        if (!rec) continue;
        rec.projectId = np;
        this.store.update(rec, (s) => (s.projectId = np));
        await this.store.flush(rec);
      }
    }
    this.access.forget();
    return { projects: ids.length, unclassifiedProjectId, videos: loose.length };
  }

  private async target(id: string): Promise<UserRef> {
    const u = /^[0-9a-f-]{36}$/i.test(id) ? await this.db.user.findUnique({ where: { id }, select: USER_REF }) : null;
    if (!u) throw new BadRequestException('Ese usuario no existe.');
    if (!u.active) throw new BadRequestException(`${label(u)} está suspendido: elige un usuario activo.`);
    return u;
  }
}
