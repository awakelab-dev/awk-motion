import type { ProjectRole } from '@wilox/shared';
import type { Prisma } from './generated/prisma/client.js';

/** Quién pide (hito 11, ADR-142): el usuario de la sesión con su rol en la app. */
export interface Viewer {
  id: string;
  role: 'admin' | 'user';
}

/**
 * Proyectos que el usuario ve (hito 11, ADR-142): los suyos, los compartidos con él y los públicos («Sin clasificar»
 * nunca es público). Con `all`, el admin ve los de todos. No filtra papelera ni archivo: eso lo pone cada consulta.
 */
export function visibleProjects(v: Viewer, all = false): Prisma.ProjectWhereInput {
  if (all && v.role === 'admin') return {};
  return { OR: [{ ownerId: v.id }, { shares: { some: { userId: v.id } } }, { publicAt: { not: null }, system: null }] };
}

/** Videos de los proyectos que el usuario ve. */
export function visibleGenerations(v: Viewer, all = false): Prisma.GenerationWhereInput {
  return all && v.role === 'admin' ? {} : { project: visibleProjects(v) };
}

/**
 * Papel del usuario en un proyecto, o null si no tiene acceso. El dueño manda sobre lo demás; el admin, sobre
 * «compartido» y «público» (puede compartir y cambiar el dueño).
 */
export function projectRole(p: { ownerId: string; publicAt: Date | null; system: string | null }, v: Viewer, sharedWithViewer: boolean): ProjectRole | null {
  if (p.ownerId === v.id) return 'owner';
  if (v.role === 'admin') return 'admin';
  if (sharedWithViewer) return 'shared';
  if (p.publicAt && !p.system) return 'public';
  return null;
}
