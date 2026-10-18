import { CLIP_FRAMES, FPS, type Shot } from '@wilox/shared';
import type { TimedWord } from '@wilox/prompts';
import { planShots } from './timeline.js';

/**
 * «Dividir en dos» un clip (hito 10, T3, ADR-130). El clip i va de K(i-1) a Ki y su tramo dura hasta el inicio del
 * siguiente; el resto del tramo es su último cuadro congelado. Al dividirlo se inserta un plano nuevo (fotograma
 * intermedio Kmedio) en una palabra cerca de la mitad del tramo: el clip i va de K(i-1) a Kmedio y uno nuevo, de
 * Kmedio a Ki. Los dos deben caber enteros (124 f cada uno) para que ninguno quede cortado antes de su fotograma final.
 */

/** Palabras de enlace: cortar justo antes de ellas parte la frase («millones | de personas»). */
const FUNCTION_WORDS = new Set(
  'a al ante bajo con contra de del desde durante e el en entre hacia hasta la las lo los mediante o para por según sin sobre su sus tras u un una unos unas y que como cual cuyo cuya se le les me te nos es son fue'.split(' '),
);

/** Tramo mínimo para dividir: dos clips completos. */
export const SPLIT_MIN_FRAMES = 2 * CLIP_FRAMES;

export interface SplitPoint {
  /** Palabra (índice global) donde empieza el segundo clip. */
  wordIndex: number;
  /** Frame en que empieza el segundo clip. */
  startFrame: number;
  /** Frames del primero y del segundo tramo. */
  firstFrames: number;
  secondFrames: number;
}

/**
 * Elige dónde cortar el clip `clip` (1 = el primero): entre las palabras de su tramo, la que deja los dos clips
 * completos y queda más cerca de la mitad, prefiriendo el inicio de una frase o tras una coma. Devuelve undefined si
 * el tramo no da para dos clips.
 */
export function pickSplitPoint(o: { words: TimedWord[]; shots: Shot[]; paragraphs: { startSec: number }[]; totalFrames: number; clip: number }): SplitPoint | undefined {
  const { words, shots, paragraphs, totalFrames, clip } = o;
  const plan = planShots(words, shots, paragraphs, totalFrames);
  const cur = plan[clip - 1];
  if (!cur || plan.length !== shots.length) return undefined;
  const slot = cur.slotEndFrame - cur.startFrame;
  if (slot < SPLIT_MIN_FRAMES) return undefined;
  const mid = cur.startFrame + slot / 2;
  const fromSec = cur.startFrame / FPS;
  const toSec = cur.slotEndFrame / FPS;
  let best: (SplitPoint & { score: number }) | undefined;
  for (let w = shots[clip - 1].anchorWordIndex + 1; w < words.length; w++) {
    const word = words[w];
    if (word.start < fromSec) continue;
    if (word.start >= toSec) break;
    const trial = [...shots.slice(0, clip - 1), { ...shots[clip - 1] }, { ...shots[clip - 1], anchorWordIndex: w }, ...shots.slice(clip)];
    const p = planShots(words, trial, paragraphs, totalFrames);
    if (p.length !== trial.length) continue;
    const a = p[clip - 1];
    const b = p[clip];
    if (a.startFrame !== cur.startFrame || b.slotEndFrame !== cur.slotEndFrame) continue;
    const firstFrames = b.startFrame - a.startFrame;
    const secondFrames = b.slotEndFrame - b.startFrame;
    if (firstFrames < CLIP_FRAMES || secondFrames < CLIP_FRAMES) continue;
    const prev = words[w - 1];
    // Mejor no empezar el segundo clip en una palabra de enlace («millones | de personas»).
    const weak = FUNCTION_WORDS.has(word.word.toLowerCase().replace(/[^\p{L}]/gu, '')) && !/[,.;:!?…—–-]$/.test(prev?.word ?? '.');
    const boundary = !prev || prev.paragraph !== word.paragraph || /[.;:!?…]$/.test(prev.word) ? 2 : /[,—–-]$/.test(prev.word) ? 1 : 0;
    // Se prefiere el inicio de una frase (hasta ≈ 1,7 s más lejos de la mitad) o tras una coma (≈ 0,75 s).
    const score = Math.abs(b.startFrame - mid) - (boundary === 2 ? 40 : boundary === 1 ? 18 : 0) + (weak ? 30 : 0);
    if (!best || score < best.score) best = { wordIndex: w, startFrame: b.startFrame, firstFrames, secondFrames, score };
  }
  if (!best) return undefined;
  const { score: _s, ...point } = best;
  return point;
}

/**
 * Nombre de un archivo tras insertar el plano nuevo en la posición `clip` (1 = el primero): los fotogramas Knn con
 * nn ≥ clip pasan a nn+1 (el nuevo Kmedio ocupa K`clip`) y los clips clipNN con NN ≥ clip+1 pasan a NN+1 (el nuevo es
 * el clip `clip`+1). El clip `clip` conserva su nombre (sus versiones anteriores siguen siendo suyas).
 */
export function shiftIndexName(name: string, clip: number): string {
  const nn = (n: number) => String(n).padStart(2, '0');
  return name
    .replace(/(^|[_.\-])K(\d{2})(?=[_.\-]|$)/g, (m, pre: string, d: string) => (Number(d) >= clip ? `${pre}K${nn(Number(d) + 1)}` : m))
    .replace(/(^|[_.\-])clip(\d{2})(?=\D|$)/g, (m, pre: string, d: string) => (Number(d) >= clip + 1 ? `${pre}clip${nn(Number(d) + 1)}` : m));
}

/** Ruta relativa con el nombre de archivo corrido (las carpetas no cambian). */
export function shiftIndexPath(path: string, clip: number): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? shiftIndexName(path, clip) : path.slice(0, i + 1) + shiftIndexName(path.slice(i + 1), clip);
}

/** Corre las claves numéricas de un objeto { "<índice>": v } desde `from` (incluido). */
export function shiftKeys<T>(o: Record<string, T> | undefined, from: number): Record<string, T> | undefined {
  if (!o) return o;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(o)) {
    const n = Number(k);
    out[Number.isInteger(n) && n >= from ? String(n + 1) : k] = v;
  }
  return out;
}
