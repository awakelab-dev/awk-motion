import { randomInt } from 'node:crypto';
import type { Db } from '@wilox/db';
import type { ProjectVoice, VoiceModel } from '@wilox/shared';

/**
 * Voz del proyecto (hito 13a, ADR-177): versión (nulo en la BD = v3, los proyectos anteriores) y velocidad de la
 * narración (nulo = 1). La semilla de v4 se elige al azar la primera vez que hace falta y queda guardada.
 */
export function voiceOf(p: { voiceModel: string | null; voiceSpeed: number | null }): ProjectVoice {
  return { model: p.voiceModel === 'v4' ? 'v4' : 'v3', speed: p.voiceSpeed ?? 1 };
}

/** Semilla v4 del proyecto: si no tiene, se fija una al azar (sin pisar la de otra llamada simultánea). */
export async function projectSeed(db: Pick<Db, 'project'>, projectId: string): Promise<number> {
  await db.project.updateMany({ where: { id: projectId, voiceSeed: null }, data: { voiceSeed: randomInt(0, 2 ** 31 - 1) } });
  const p = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { voiceSeed: true } });
  return p.voiceSeed!;
}

/** Voz con la que nace un video del proyecto. */
export async function voiceForNewVideo(db: Pick<Db, 'project'>, projectId: string): Promise<{ model: VoiceModel; seed?: number; speed: number }> {
  const p = await db.project.findUnique({ where: { id: projectId }, select: { voiceModel: true, voiceSpeed: true } });
  const v = voiceOf(p ?? { voiceModel: null, voiceSpeed: null });
  return v.model === 'v4' ? { ...v, seed: await projectSeed(db, projectId) } : v;
}
