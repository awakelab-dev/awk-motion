import { PAUSE_MARGIN_SEC, PAUSE_MAX_SEC, PAUSE_MIN_SEC } from '@wilox/shared';
import type { TimedWord } from '@wilox/prompts';

export { PAUSE_MARGIN_SEC, PAUSE_MAX_SEC, PAUSE_MIN_SEC };

/**
 * «Pausa entre dos palabras» (hito 12, ADR-164): alargar o acortar el silencio entre dos palabras seguidas sin volver a
 * pedir la voz. La locución se corta en la mitad del silencio entre las dos palabras (nunca dentro de una palabra) y ahí
 * se agrega silencio (o se quita, sin tocar las palabras). Lo de antes queda idéntico; lo de después, igual pero corrido.
 */

export interface ParagraphTiming {
  index: number;
  startSec: number;
  durationSec: number;
}

export interface PausePlan {
  /** Cambio (s): positivo agrega silencio, negativo lo quita. */
  deltaSec: number;
  /** Punto del corte en la locución completa (s). */
  cutSec: number;
  /** Silencio que había y que queda entre las dos palabras (s). */
  gapBefore: number;
  gapAfter: number;
  /** Si las dos palabras son del mismo párrafo: el párrafo y el corte dentro de su audio (s desde su inicio). */
  inParagraph?: { index: number; atSec: number };
  words: TimedWord[];
  paragraphs: ParagraphTiming[];
}

/** Silencio entre la palabra `k` y la siguiente (s, nunca negativo). */
export const wordGap = (words: TimedWord[], k: number) => Math.max(0, words[k + 1].start - words[k].end);

/** Lo más que se puede acortar la pausa después de la palabra `k` (s). */
export const maxShorten = (words: TimedWord[], k: number) => Math.max(0, Math.floor((wordGap(words, k) - 2 * PAUSE_MARGIN_SEC) * 100) / 100);

/**
 * Plan de la pausa después de la palabra `afterWord` (índice global): los tiempos de las palabras y de los párrafos
 * después del corte se corren `deltaSec`. Lanza un error con el motivo si no se puede.
 */
export function planPause(words: TimedWord[], paragraphs: ParagraphTiming[], afterWord: number, deltaSec: number): PausePlan {
  if (!Number.isInteger(afterWord) || afterWord < 0 || afterWord >= words.length - 1) throw new Error('Elige dos palabras seguidas de la locución.');
  const delta = Math.round(deltaSec * 100) / 100;
  if (!Number.isFinite(delta) || Math.abs(delta) < PAUSE_MIN_SEC) throw new Error(`El cambio debe ser de al menos ${PAUSE_MIN_SEC.toFixed(2).replace('.', ',')} s.`);
  if (delta > PAUSE_MAX_SEC) throw new Error(`Se agregan hasta ${PAUSE_MAX_SEC} s de una vez.`);
  const a = words[afterWord];
  const b = words[afterWord + 1];
  const gap = wordGap(words, afterWord);
  if (delta < 0) {
    const max = maxShorten(words, afterWord);
    if (-delta > max + 1e-9)
      throw new Error(
        max >= PAUSE_MIN_SEC
          ? `Entre «${a.word}» y «${b.word}» hay ${fmt(gap)} s de silencio: se puede acortar hasta ${fmt(max)} s.`
          : `Entre «${a.word}» y «${b.word}» no hay silencio que acortar.`,
      );
  }
  const cutSec = a.end + gap / 2;
  const same = a.paragraph === b.paragraph;
  const para = paragraphs.find((p) => p.index === a.paragraph);
  return {
    deltaSec: delta,
    cutSec,
    gapBefore: gap,
    gapAfter: gap + delta,
    inParagraph: same && para ? { index: para.index, atSec: cutSec - para.startSec } : undefined,
    words: words.map((w, i) => (i > afterWord ? { ...w, start: w.start + delta, end: w.end + delta } : w)),
    paragraphs: paragraphs.map((p) =>
      same && p.index === a.paragraph ? { ...p, durationSec: p.durationSec + delta } : p.index > a.paragraph ? { ...p, startSec: p.startSec + delta } : p,
    ),
  };
}

const fmt = (s: number) => s.toFixed(2).replace('.', ',');
