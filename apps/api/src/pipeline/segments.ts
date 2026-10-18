import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SEGMENT_FORMAT } from '../media/encode.js';
import type { ClipState, RunState, SoundMode } from '@wilox/shared';
import { env } from '../config/env.js';
import { FADE_IN_SEC, FADE_OUT_SEC } from '../media/sound.js';
import type { Segment } from './timeline.js';

/**
 * Con qué se hizo cada segmento (hito 6, ADR-055/056). Cada segmento deja a su lado `<nombre>.json` con
 * su clave de contenido: si la clave no cambia, el segmento en disco vale y no se vuelve a codificar.
 *
 * La clave no incluye la posición en el video (el orden y el frame de inicio salen del plan al unir):
 * si rehacer el audio solo desplaza un clip, su segmento se reutiliza; si cambia su largo, se rehace.
 */
export type SegmentKey =
  | { format: number; kind: 'clip'; raw: string; frames: number; sound: string }
  | { format: number; kind: 'freeze'; raw: string; srcFrame: number; frames: number };

/**
 * Clave de un segmento. `raw` es el nombre del clip IA en bruto (cambia con cada versión del clip);
 * `sound` describe el sonido del clip (desde T3: del modelo, sintetizado, silencio, ganancia…).
 */
export function segmentKey(seg: Segment, raw: string, sound: string, clipSeg?: Segment): SegmentKey {
  const frames = seg.endFrame - seg.startFrame;
  if (seg.kind === 'clip') return { format: SEGMENT_FORMAT, kind: 'clip', raw, frames, sound };
  if (!clipSeg) throw new Error(`Falta el segmento del clip de ${seg.name}.`);
  return { format: SEGMENT_FORMAT, kind: 'freeze', raw, srcFrame: clipSeg.endFrame - clipSeg.startFrame - 1, frames };
}

const keyFile = (dir: string, seg: Segment) => join(dir, `${seg.name}.json`);
export const soundWav = (dir: string, seg: Segment) => join(dir, `${seg.name}_sound.wav`);

/**
 * Estado de un segmento frente a la clave que se quiere: 'ready' = vale tal cual; 'sound' = el video
 * vale y solo cambia el sonido (se rehace el WAV y se cambia la pista sin recodificar, ADR-059);
 * 'missing' = hay que hacerlo.
 */
export async function segmentStatus(dir: string, seg: Segment, key: SegmentKey): Promise<'ready' | 'sound' | 'missing'> {
  if (!existsSync(join(dir, `${seg.name}.mp4`))) return 'missing';
  let saved: SegmentKey;
  try {
    saved = JSON.parse(await readFile(keyFile(dir, seg), 'utf8')) as SegmentKey;
  } catch {
    return 'missing';
  }
  if (saved.kind === 'clip' && key.kind === 'clip') {
    const video = (k: SegmentKey) => JSON.stringify({ ...k, sound: undefined });
    if (video(saved) !== video(key)) return 'missing';
    return saved.sound === key.sound && existsSync(soundWav(dir, seg)) ? 'ready' : 'sound';
  }
  return JSON.stringify(saved) === JSON.stringify(key) ? 'ready' : 'missing';
}

/** ¿Está en disco el segmento hecho con esta clave (video y, si es un clip, su WAV de sonido)? */
export async function segmentReady(dir: string, seg: Segment, key: SegmentKey): Promise<boolean> {
  return (await segmentStatus(dir, seg, key)) === 'ready';
}

/** Anota la clave del segmento recién hecho (se escribe después del video, así un corte deja el segmento como no hecho). */
export async function writeSegmentKey(dir: string, seg: Segment, key: SegmentKey) {
  await writeFile(keyFile(dir, seg), JSON.stringify(key));
}

/** Clave del sonido de un clip: SFX sintetizados (ADR-006; la de los segmentos de antes de T3). */
export const SOUND_SFX = 'sfx';
export const SOUND_NONE = 'none';

/**
 * Sonido efectivo de un clip (ADR-059): la excepción del clip ('mute' → sin sonido, 'synth' →
 * sintetizado) o el del video. Los videos anteriores al hito 6 (sin modo) se hicieron con SFX sintetizados.
 */
export function clipSound(s: Pick<RunState, 'soundMode'>, c: Pick<ClipState, 'soundMode'>): SoundMode {
  if (c.soundMode === 'mute') return 'none';
  if (c.soundMode === 'synth') return 'synth';
  return s.soundMode ?? 'synth';
}

/** Clave del sonido para la clave del segmento: si cambia el objetivo, el ajuste o los fundidos, se rehace. */
export function soundKey(mode: SoundMode, gainDb: number): string {
  if (mode === 'synth') return SOUND_SFX;
  if (mode === 'none') return SOUND_NONE;
  return `model:${env.MODEL_SOUND_LUFS}:${env.MODEL_SOUND_MAX_GAIN_DB}:${gainDb}:${FADE_IN_SEC}/${FADE_OUT_SEC}`;
}
