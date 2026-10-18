import type { WordTime } from '../pipeline/align.js';

/**
 * Tramos de cada párrafo dentro de una locución pedida de una sola vez (prueba de voz, ADR-129).
 * `aligned`: las palabras del texto del video, en orden, con su tiempo en la locución completa (alignWords);
 * `counts`: cuántas de esas palabras tiene cada párrafo. El corte entre dos párrafos va a la mitad del silencio
 * entre la última palabra de uno y la primera del siguiente; el primero empieza en 0 y el último llega al final.
 */
export function splitWholeVoice(aligned: WordTime[], counts: number[], totalSec: number): { start: number; end: number }[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total !== aligned.length) throw new Error(`La alineación tiene ${aligned.length} palabras y los párrafos ${total}.`);
  if (counts.some((c) => c < 1)) throw new Error('Hay un párrafo sin palabras.');
  const firstIdx: number[] = [];
  let k = 0;
  for (const c of counts) {
    firstIdx.push(k);
    k += c;
  }
  const cuts: number[] = [0];
  for (let i = 1; i < counts.length; i++) {
    const prevEnd = aligned[firstIdx[i] - 1].end;
    const nextStart = aligned[firstIdx[i]].start;
    const cut = nextStart > prevEnd ? (prevEnd + nextStart) / 2 : nextStart;
    cuts.push(Math.min(totalSec, Math.max(cuts[i - 1], cut)));
  }
  return counts.map((_, i) => ({ start: cuts[i], end: i + 1 < cuts.length ? cuts[i + 1] : totalSec }));
}

/** Comienzo del párrafo siguiente para `next_text` (hasta ~200 caracteres, cortado en una palabra). */
export function nextTextFor(text: string | undefined, max = 200): string | undefined {
  if (!text) return undefined;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return sp > max / 2 ? cut.slice(0, sp) : cut;
}
