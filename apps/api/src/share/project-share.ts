import type { Db } from '@wilox/db';
import type { ProjectShareKind } from '@wilox/shared';

/**
 * Links del proyecto completo, guardados en `Project.delivery`: `share` es el de **aprobación** del storyboard (hito 9, T6,
 * ADR-112) y `videoShare` el de **revisión de los videos** terminados (T6b, ADR-116). Son independientes: cada uno con su
 * token y sus videos (`videoIds` nulo = todos, también los que se agreguen después).
 */
export interface StoredProjectShare {
  token: string;
  createdAt: string;
  videoIds: string[] | null;
}

export const SHARE_TOKEN = /^[A-Za-z0-9_-]{20,40}$/;

/** Clave de cada link en `Project.delivery`. */
export const SHARE_KEY: Record<ProjectShareKind, 'share' | 'videoShare'> = { review: 'share', videos: 'videoShare' };

export const projectShareOf = (delivery: unknown, kind: ProjectShareKind = 'review'): StoredProjectShare | undefined =>
  (delivery as Record<string, StoredProjectShare | undefined> | null)?.[SHARE_KEY[kind]];

/** Ruta pública de cada página: `/api/proyecto/<token>` (aprobación) y `/api/revision-videos/<token>` (videos). */
const ROOT: Record<ProjectShareKind, string> = { review: '/api/proyecto', videos: '/api/revision-videos' };
export const projectSharePath = (token: string, kind: ProjectShareKind = 'review') => `${ROOT[kind]}/${token}`;
export const projectVideoPath = (token: string, videoId: string, kind: ProjectShareKind = 'review') => `${projectSharePath(token, kind)}/v/${videoId}`;

/**
 * El proyecto de un link y los ids de sus videos visibles (en orden de creación; sin los de la papelera). Undefined si el
 * link no existe, se desactivó o el proyecto está en la papelera.
 */
export async function resolveProjectShare(db: Db, token: string, kind: ProjectShareKind = 'review') {
  if (!SHARE_TOKEN.test(token)) return undefined;
  const p = await db.project.findFirst({
    where: { delivery: { path: [SHARE_KEY[kind], 'token'], equals: token }, trashedAt: null },
    select: { id: true, name: true, description: true, ownerId: true, delivery: true },
  });
  const share = p && projectShareOf(p.delivery, kind);
  if (!p || !share) return undefined;
  const gens = await db.generation.findMany({ where: { projectId: p.id, trashedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  const wanted = share.videoIds ? new Set(share.videoIds) : undefined;
  return { project: p, share, ids: gens.map((g) => g.id).filter((id) => !wanted || wanted.has(id)) };
}
