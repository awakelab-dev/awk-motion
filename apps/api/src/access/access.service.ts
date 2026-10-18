import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { projectRole, visibleGenerations, visibleProjects, type Db, type Prisma, type Viewer } from '@wilox/db';
import type { AuthUser, ProjectRole } from '@wilox/shared';
import { DB } from '../db/db.module.js';

const UUID = /^[0-9a-f-]{36}$/i;
/** Ids de las generaciones: `20261017-200710-pastel-43cfb6` (no son UUID). */
const GEN_ID = /^[\w-]{1,80}$/;
/** Cuánto se recuerda el papel de un usuario en un proyecto (los archivos de un video piden muchas veces lo mismo). */
const TTL_MS = 30_000;

/** Lo irreversible del proyecto (punto 5 del hito 11) y compartir: solo el dueño (compartir, también el admin). */
export type OwnerAction = 'trash' | 'restore' | 'archive' | 'delete' | 'share' | 'move-out';

const OWNER_ONLY: Record<OwnerAction, string> = {
  trash: 'Solo el dueño del proyecto puede enviarlo a la papelera (o enviar sus videos).',
  restore: 'Solo el dueño del proyecto puede restaurarlo de la papelera.',
  archive: 'Solo el dueño del proyecto puede archivarlo o desarchivarlo.',
  delete: 'Solo el dueño del proyecto puede eliminarlo definitivamente.',
  share: 'Solo el dueño del proyecto (o un administrador) puede compartirlo.',
  'move-out': 'Solo el dueño del proyecto puede sacar sus videos hacia un proyecto de otro dueño.',
};

export interface ProjectAccessRow {
  id: string;
  ownerId: string;
  name: string;
  system: string | null;
  publicAt: Date | null;
  archivedAt: Date | null;
  trashedAt: Date | null;
  delivery: Prisma.JsonValue;
  role: ProjectRole;
}

const PROJECT_SELECT = { id: true, ownerId: true, name: true, system: true, publicAt: true, archivedAt: true, trashedAt: true, delivery: true } as const;

/**
 * Acceso a los proyectos y a lo que cuelga de ellos (hito 11, ADR-142). Un único lugar decide quién ve y gestiona qué:
 * el dueño, los usuarios con los que se comparte, todos si es público y el admin. Con acceso se gestiona todo el
 * proyecto (videos, publicaciones, descargas, links, observaciones); lo irreversible y compartir, solo el dueño
 * (compartir, también el admin). Lo que no se ve responde 404, como antes; lo que se ve pero no se puede, 403.
 */
@Injectable()
export class AccessService {
  private cache = new Map<string, { role: ProjectRole | null; at: number }>();
  /** Proyecto de cada video (las miniaturas y archivos de un video llegan de a decenas). */
  private gens = new Map<string, { at: number; g: { id: string; ownerId: string; projectId: string; trashed: boolean; projectOwnerId: string } | null }>();

  constructor(@Inject(DB) private readonly db: Db) {}

  viewer(user: AuthUser): Viewer {
    return { id: user.id, role: user.role };
  }

  /** Olvida los papeles recordados (al compartir, hacer público o cambiar el dueño). */
  forget(): void {
    this.cache.clear();
    this.gens.clear();
  }

  /** Filtro de Prisma: proyectos que ve el usuario (con `all`, el admin ve los de todos). */
  projectsWhere(user: AuthUser, all = false): Prisma.ProjectWhereInput {
    return visibleProjects(this.viewer(user), all);
  }

  /** Filtro de Prisma: videos de los proyectos que ve el usuario. */
  generationsWhere(user: AuthUser, all = false): Prisma.GenerationWhereInput {
    return visibleGenerations(this.viewer(user), all);
  }

  /** Ids de los proyectos que ve el usuario (sin los eliminados definitivamente). */
  async visibleProjectIds(user: AuthUser, all = false): Promise<string[]> {
    const rows = await this.db.project.findMany({ where: { ...this.projectsWhere(user, all), deletedAt: null }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  /** Papel del usuario en el proyecto, o null si no lo ve (recordado 30 s). */
  async role(projectId: string, user: AuthUser): Promise<ProjectRole | null> {
    if (!UUID.test(projectId)) return null;
    const key = `${user.id}:${user.role}:${projectId}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.role;
    const p = await this.db.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true, publicAt: true, system: true, deletedAt: true, shares: { where: { userId: user.id }, select: { userId: true } } },
    });
    const role = p && !p.deletedAt ? projectRole(p, this.viewer(user), p.shares.length > 0) : null;
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(key, { role, at: Date.now() });
    return role;
  }

  /**
   * Proyecto al que el usuario tiene acceso (404 si no lo ve o está en la papelera, salvo `trashed`). Con `owner`, la
   * acción es solo del dueño: 403 con el motivo si lo ve pero no es suyo (compartir: también el admin).
   */
  async project(id: string, user: AuthUser, o: { owner?: OwnerAction; trashed?: boolean } = {}): Promise<ProjectAccessRow> {
    const p = UUID.test(id)
      ? await this.db.project.findFirst({
          where: { id, deletedAt: null, ...(o.trashed ? {} : { trashedAt: null }) },
          select: { ...PROJECT_SELECT, shares: { where: { userId: user.id }, select: { userId: true } } },
        })
      : null;
    const role = p ? projectRole(p, this.viewer(user), p.shares.length > 0) : null;
    if (!p || !role) throw new NotFoundException('Proyecto no encontrado.');
    if (o.owner) this.requireOwner(role, o.owner);
    const { shares: _s, ...row } = p;
    return { ...row, role };
  }

  /**
   * ¿Ve el usuario los temas (y estilos de guion) de `ownerId`? Sí si son suyos, si es admin o si `ownerId` le comparte
   * algún proyecto (o tiene uno público): en ese proyecto puede usarlos, sin editarlos (hito 11, ADR-142).
   */
  async seesOwnerAssets(ownerId: string, user: AuthUser): Promise<boolean> {
    if (ownerId === user.id || user.role === 'admin') return true;
    const key = `assets:${user.id}:${ownerId}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.role !== null;
    const n = await this.db.project.count({
      where: { ownerId, deletedAt: null, OR: [{ shares: { some: { userId: user.id } } }, { publicAt: { not: null }, system: null }] },
    });
    this.cache.set(key, { role: n > 0 ? 'shared' : null, at: Date.now() });
    return n > 0;
  }

  /** Lanza 403 si el papel no alcanza para una acción del dueño. */
  requireOwner(role: ProjectRole, action: OwnerAction): void {
    if (role === 'owner') return;
    if (action === 'share' && role === 'admin') return;
    throw new ForbiddenException(OWNER_ONLY[action]);
  }

  /**
   * Video al que el usuario tiene acceso por su proyecto (404 si no). Devuelve también el dueño del video (quien lo
   * creó, `ownerId`) y el del proyecto: los servicios que filtran por dueño reciben el que corresponde.
   */
  async generation(id: string, user: AuthUser, o: { owner?: OwnerAction; trashed?: boolean } = {}) {
    let hit = this.gens.get(id);
    if (!hit || Date.now() - hit.at >= TTL_MS) {
      const row = GEN_ID.test(id)
        ? await this.db.generation.findFirst({
            where: { id, deletedAt: null },
            select: { id: true, ownerId: true, projectId: true, trashedAt: true, project: { select: { ownerId: true } } },
          })
        : null;
      hit = { at: Date.now(), g: row && { id: row.id, ownerId: row.ownerId, projectId: row.projectId, trashed: !!row.trashedAt, projectOwnerId: row.project.ownerId } };
      if (this.gens.size > 5000) this.gens.clear();
      this.gens.set(id, hit);
    }
    const g = hit.g && (o.trashed || !hit.g.trashed) ? hit.g : null;
    const role = g ? await this.role(g.projectId, user) : null;
    if (!g || !role) throw new NotFoundException('Generación no encontrada.');
    if (o.owner) this.requireOwner(role, o.owner);
    return { id: g.id, ownerId: g.ownerId, projectId: g.projectId, projectOwnerId: g.projectOwnerId, role };
  }
}
