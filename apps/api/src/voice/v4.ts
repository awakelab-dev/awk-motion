import { FPS, V4_CONTEXT_CHARS, V4_LEAD_SEC, V4_PARAGRAPH_GAP_SEC, V4_TAIL_SEC } from '@wilox/shared';
import type { WordTime } from '../pipeline/align.js';
import { paragraphStarts } from '../pipeline/timeline.js';

/**
 * Voz v4 (hito 13a, ADR-177): cada párrafo se pide por separado a `eleven_v4`, con el texto anterior y el siguiente como
 * contexto y la semilla del proyecto. El audio de cada párrafo se recorta con la alineación (queda un margen fijo antes
 * de la primera palabra y después de la última) y los párrafos se montan con 0,6 s de voz a voz.
 */

/** Etiqueta de tono del guion al inicio de un texto («[excited] …»): no va en el contexto. */
const stripTag = (t: string) => t.replace(/^\s*\[[^\]\n]{1,40}\]\s*/, '');
const clean = (t: string) => stripTag(t).replace(/\s+/g, ' ').trim();

/** Comienzo de un texto (hasta `max` caracteres, cortado en una palabra). */
export function headOf(text: string, max: number): string {
  const t = clean(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return sp > max / 2 ? cut.slice(0, sp) : cut;
}

/** Final de un texto (hasta `max` caracteres, cortado en una palabra). */
export function tailOf(text: string, max: number): string {
  const t = clean(text);
  if (t.length <= max) return t;
  const cut = t.slice(t.length - max);
  const sp = cut.indexOf(' ');
  return sp >= 0 && sp < max / 2 ? cut.slice(sp + 1) : cut;
}

/** Contexto del párrafo `i` (lo que se envía a la voz, con las reglas de pronunciación): el final del anterior y el comienzo del siguiente. */
export function v4Context(spoken: string[], i: number, max = V4_CONTEXT_CHARS): { previousText?: string; nextText?: string } {
  const previousText = i > 0 ? tailOf(spoken[i - 1], max) || undefined : undefined;
  const nextText = i + 1 < spoken.length ? headOf(spoken[i + 1], max) || undefined : undefined;
  return { ...(previousText ? { previousText } : {}), ...(nextText ? { nextText } : {}) };
}

/** Recorte del audio de un párrafo: tramo [start, end] del audio recibido y silencio que se agrega antes y después. */
export interface TrimWindow {
  start: number;
  end: number;
  padStart: number;
  padEnd: number;
}

/**
 * Con las palabras alineadas (tiempos en el audio recibido), el tramo que queda: `lead` antes de la primera palabra y
 * `tail` después de la última; si el audio no alcanza, se completa con silencio. Así todo párrafo v4 empieza y termina
 * igual y la pausa entre párrafos es la misma.
 */
export function v4TrimWindow(words: WordTime[], totalSec: number, lead = V4_LEAD_SEC, tail = V4_TAIL_SEC): TrimWindow {
  if (!words.length) return { start: 0, end: totalSec, padStart: 0, padEnd: 0 };
  const first = Math.max(0, Math.min(totalSec, words[0].start));
  const last = Math.max(first, Math.min(totalSec, Math.max(...words.map((w) => w.end))));
  const start = Math.max(0, first - lead);
  const end = Math.min(totalSec, last + tail);
  return { start, end, padStart: lead - (first - start), padEnd: tail - (end - last) };
}

/** Tiempos de las palabras dentro del audio ya recortado. */
export function shiftWords(words: WordTime[], w: TrimWindow): WordTime[] {
  return words.map((x) => ({ word: x.word, start: x.start - w.start + w.padStart, end: x.end - w.start + w.padStart }));
}

/** Silencio entre dos audios de párrafo v4 (0,6 s de voz a voz, menos los márgenes de cada uno). */
export const V4_WAV_GAP_SEC = V4_PARAGRAPH_GAP_SEC - V4_LEAD_SEC - V4_TAIL_SEC;

/**
 * Silencio entre dos audios de párrafo v4 a una velocidad de narración (T2, ADR-178): los márgenes se estiran con el
 * audio, la pausa de voz a voz sigue siendo de 0,6 s.
 */
export const v4WavGap = (speed = 1) => V4_PARAGRAPH_GAP_SEC - (V4_LEAD_SEC + V4_TAIL_SEC) / speed;

/** Inicio de cada párrafo v4 (en un frame entero, sin la rejilla de 12 frames de v3). */
export function v4Starts(durations: number[], speed = 1): number[] {
  return paragraphStarts(durations, v4WavGap(speed), 1);
}

/**
 * Inicios al rehacer un párrafo v4: cambia el largo de uno y los demás conservan la pausa que tenían (también una pausa
 * entre párrafos cambiada a mano, ADR-164). Una pausa normal (la de v4 más el redondeo al frame) se vuelve a calcular.
 */
export function keepGapStarts(old: { startSec: number; durationSec: number }[], durations: number[], speed = 1): number[] {
  const normal = v4WavGap(speed);
  return regap(old, durations, { from: normal, to: normal });
}

/**
 * Inicios con duraciones nuevas: cada pausa entre párrafos se conserva. Con `normal`, una pausa normal (la de v4 a la
 * velocidad de antes, `from`, más el redondeo al frame) pasa a ser la normal de ahora (`to`, en el frame siguiente: nunca
 * menos de 0,6 s de voz a voz); otra (cambiada a mano) conserva lo que tenía de más. Sin `normal` (v3), el silencio
 * exacto. El primero conserva su inicio.
 */
export function regap(old: { startSec: number; durationSec: number }[], durations: number[], normal?: { from: number; to: number }): number[] {
  const starts: number[] = [];
  const frame = 1 / FPS;
  durations.forEach((_, i) => {
    if (i === 0) return starts.push(old[0]?.startSec ?? 0);
    const gap = Math.max(0, old[i].startSec - (old[i - 1].startSec + old[i - 1].durationSec));
    const end = starts[i - 1] + durations[i - 1];
    if (normal) {
      const extra = gap - normal.from;
      if (extra > -1e-6 && extra < frame + 1e-6) return starts.push(Math.ceil((end + normal.to) * FPS - 1e-6) / FPS);
      return starts.push(Math.round((end + Math.max(0, normal.to + extra)) * FPS) / FPS);
    }
    // Sin pausa normal (v3): el silencio exacto, sin redondear (los párrafos de v3 en un solo pedido van pegados).
    starts.push(end + gap);
  });
  return starts;
}
