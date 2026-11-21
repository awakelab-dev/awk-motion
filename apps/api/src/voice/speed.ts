import { FPS, LEAD_FRAMES } from '@wilox/shared';
import type { TimedWord } from '@wilox/prompts';
import type { PlannedClip } from '../pipeline/timeline.js';
import { regap } from './v4.js';

/**
 * Velocidad de la narración (hito 13a, T2, ADR-178). Se aplica después de pedir la voz, igual en v3 y en v4: el audio de
 * cada párrafo se estira con ffmpeg `rubberband` (sin cambiar el tono) por la razón velocidad nueva / actual, y los
 * tiempos de sus palabras se escalan. Las pausas entre párrafos (el punto aparte y las cambiadas a mano entre dos
 * párrafos) no cambian; las de dentro de cada párrafo se estiran con todo.
 */

/** Razón de estiramiento para pasar de `from` a `to` (1,0 = la de la voz). */
export const speedRatio = (to: number, from = 1) => to / from;

/** La razón no cambia nada (misma velocidad). */
export const sameSpeed = (ratio: number) => Math.abs(ratio - 1) < 1e-3;

/**
 * Inicios de los párrafos con sus duraciones nuevas, conservando el silencio que había entre uno y otro (en v4, con
 * `normal`, la pausa normal se ajusta a los márgenes estirados para que siga en 0,6 s de voz a voz, en un frame entero).
 * El primero conserva su inicio.
 */
export function respace(old: { startSec: number; durationSec: number }[], durations: number[], normal?: { from: number; to: number }): number[] {
  return regap(old, durations, normal);
}

/** Velocidad en texto: «0,85». */
export const speedText = (v: number) => v.toFixed(2).replace('.', ',');

/** Palabras con los tiempos nuevos: dentro de su párrafo, escaladas por 1/razón desde su inicio, que pasa al inicio nuevo. */
export function rescaleWords(words: TimedWord[], oldStarts: number[], newStarts: number[], ratio: number): TimedWord[] {
  return words.map((w) => {
    const o = oldStarts[w.paragraph] ?? 0;
    const n = newStarts[w.paragraph] ?? 0;
    return { ...w, start: n + (w.start - o) / ratio, end: n + (w.end - o) / ratio };
  });
}

/** Tiempos relativos al inicio del audio (párrafo suelto), escalados. */
export function scaleRelative<T extends { start: number; end: number }>(words: T[], ratio: number): T[] {
  return words.map((w) => ({ ...w, start: w.start / ratio, end: w.end / ratio }));
}

/**
 * Clips que el plan tuvo que correr (empiezan más tarde de lo que pide su palabra clave porque el clip anterior aún no
 * terminaba). Al acelerar la voz los huecos se acortan y puede pasar; se avisa.
 */
export function shiftedClips(words: TimedWord[], anchors: number[], paragraphs: { startSec: number }[], plan: PlannedClip[], lead = LEAD_FRAMES): number[] {
  const out: number[] = [];
  plan.forEach((p, i) => {
    if (i === 0) return;
    const a = anchors[p.shot];
    const w = words[a];
    if (!w) return;
    const firstOfPara = a === 0 || words[a - 1].paragraph !== w.paragraph;
    const ideal = firstOfPara ? Math.round(paragraphs[w.paragraph].startSec * FPS) : Math.round(w.start * FPS) - lead;
    if (p.startFrame > ideal + 1) out.push(i);
  });
  return out;
}
