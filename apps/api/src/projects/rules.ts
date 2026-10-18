import { UNCLASSIFIED_NAME } from '@wilox/shared';

/**
 * Reglas de los proyectos (hito 4, ADR-035), sin BD para poder probarlas.
 * "Sin clasificar" es el proyecto del sistema de cada usuario: fijo, no se renombra, archiva ni elimina.
 */

/** Sin tildes, minúsculas y espacios simples: "  sin  CLASIFICAR " === "Sin clasificar". */
const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Un proyecto normal no puede llamarse como el del sistema (se confundirían en la home). */
export function reservedNameProblem(name: string): string | undefined {
  return norm(name) === norm(UNCLASSIFIED_NAME) ? `"${UNCLASSIFIED_NAME}" es un nombre reservado: elige otro.` : undefined;
}

export interface ProjectPatch {
  name?: string;
  description?: string | null;
  archived?: boolean;
}

/** Qué impide aplicar un cambio o eliminar un proyecto del sistema (undefined = se puede). */
export function systemProjectProblem(system: string | null, action: 'update' | 'delete', patch: ProjectPatch = {}): string | undefined {
  if (!system) return undefined;
  if (action === 'delete') return `"${UNCLASSIFIED_NAME}" es fijo: no se puede eliminar.`;
  if (patch.name !== undefined || patch.archived !== undefined) return `"${UNCLASSIFIED_NAME}" es fijo: no se puede renombrar ni archivar.`;
  return undefined;
}

/**
 * "Sin clasificar" primero; después, por el último video (o la creación si no tiene), del más reciente al más antiguo.
 * Con `firstId` (hito 11), solo ese «Sin clasificar» (el propio) va primero; los de otros usuarios (el admin viendo
 * los de todos) se ordenan como un proyecto más.
 */
export function sortProjects<T extends { id?: string; unclassified: boolean; lastVideoAt?: string; createdAt: string }>(list: T[], firstId?: string): T[] {
  const key = (p: T) => p.lastVideoAt ?? p.createdAt;
  const first = (p: T) => Number(firstId ? p.id === firstId : p.unclassified);
  return [...list].sort((a, b) => first(b) - first(a) || key(b).localeCompare(key(a)));
}
