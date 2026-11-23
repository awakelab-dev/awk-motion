/**
 * Palabra clave al inicio del clip (hito 13a, T5, ADR-181; regla `v3`, ADR-183): el clip de cada plano empieza 0,5 s
 * antes de que la voz diga el PRIMERO de los textos que el plano muestra en pantalla (normalmente su frase clave). Opus
 * recibe la regla en el storyboard y el código la verifica: busca cada texto del plano (y su `pfc`) en la narración, cerca
 * del ancla de Opus, y pone el ancla en el que la voz dice primero. Los planos que abren un párrafo no se mueven (el clip
 * empieza con el párrafo). Sirve también para «Reajustar sincronía» de videos ya hechos (T6).
 *
 * Por qué el primer texto y no solo la `pfc` (ADR-183): en storyboards anteriores la `pfc` a menudo no era lo que domina
 * el fotograma (p. ej. pfc «dB HL» con «EJE VERTICAL» como título, dicho 5 s antes): anclar en la pfc hacía llegar el clip
 * tarde respecto de lo que muestra.
 */

/** Palabras de enlace: una sola de ellas no basta para reconocer un texto. */
const LINK = new Set(['a', 'al', 'con', 'de', 'del', 'el', 'en', 'es', 'la', 'las', 'lo', 'los', 'o', 'para', 'por', 'que', 'se', 'su', 'sus', 'un', 'una', 'y', 'u']);

/** Palabra normalizada: minúsculas, sin tildes ni signos. */
export function normWord(w: string): string {
  return w
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ]/g, '');
}

const tokens = (t: string) => t.split(/[\s/,;:.]+/).map(normWord).filter(Boolean);

/** Cuántos de los primeros tokens de `phrase` coinciden desde la posición `j` de la narración. */
function prefixAt(toks: string[], j: number, phrase: string[]): number {
  let k = 0;
  while (k < phrase.length && j + k < toks.length && toks[j + k] === phrase[k]) k++;
  return k;
}

/**
 * Dónde dice la voz el texto `phrase` dentro de [lo, hi] (la aparición más cercana a `near`). Un texto de varias palabras
 * se reconoce por sus 2 primeras (o entero); uno de una sola palabra, si tiene 4 letras o más y no es de enlace.
 */
function findPhrase(toks: string[], phrase: string[], lo: number, hi: number, near: number): number | undefined {
  if (!phrase.length) return undefined;
  const need = phrase.length === 1 ? 1 : 2;
  if (phrase.length === 1 && (phrase[0].length < 4 || LINK.has(phrase[0]))) return undefined;
  let best: number | undefined;
  for (let j = lo; j <= hi; j++) {
    if (prefixAt(toks, j, phrase) < need) continue;
    if (best === undefined || Math.abs(j - near) < Math.abs(best - near)) best = j;
  }
  return best;
}

export interface SyncShot {
  anchorWordIndex: number;
  pfc: string;
  keyframe?: { texts?: string[] };
}

export interface SyncResult {
  anchors: number[];
  moved: { shot: number; from: number; to: number; by: string }[];
}

/** Hasta cuántas palabras antes del ancla de Opus puede decir la voz el primer texto del plano. */
export const SYNC_BACK_WORDS = 20;
/** Hasta cuántas palabras después. */
export const SYNC_WINDOW_WORDS = 25;

/** Anclas corregidas de los planos (en orden; siguen siendo crecientes). */
export function syncAnchors(words: { word: string; paragraph: number }[], shots: SyncShot[]): SyncResult {
  const toks = words.map((w) => normWord(w.word));
  const anchors = shots.map((s) => s.anchorWordIndex);
  const moved: SyncResult['moved'] = [];
  for (let i = 1; i < shots.length; i++) {
    const a = anchors[i];
    if (a <= 0 || a >= words.length) continue;
    if (words[a - 1].paragraph !== words[a].paragraph) continue; // abre un párrafo: queda
    const lo = Math.max(anchors[i - 1] + 1, a - SYNC_BACK_WORDS);
    const next = i + 1 < shots.length ? shots[i + 1].anchorWordIndex : words.length;
    const hi = Math.min(next - 1, a + SYNC_WINDOW_WORDS, words.length - 1);
    if (hi < lo) continue;
    // El primero que dice la voz entre la frase clave y los textos en pantalla.
    let to: number | undefined;
    let by = '';
    for (const t of [shots[i].pfc, ...(shots[i].keyframe?.texts ?? [])]) {
      const j = findPhrase(toks, tokens(t), lo, hi, a);
      if (j !== undefined && (to === undefined || j < to)) {
        to = j;
        by = t;
      }
    }
    if (to !== undefined && to !== a) {
      anchors[i] = to;
      moved.push({ shot: i, from: a, to, by });
    }
  }
  return { anchors, moved };
}

/**
 * Dónde dice la voz por primera vez el texto `text` dentro de [lo, hi] (con las mismas reglas: 2 primeras palabras, o una
 * sola palabra de 4 letras o más que no sea de enlace). Para «Dividir en dos» (ADR-184).
 */
export function firstSaid(words: { word: string }[], text: string, lo: number, hi: number): number | undefined {
  const toks = words.map((w) => normWord(w.word));
  const ph = tokens(text);
  return findPhrase(toks, ph, lo, Math.min(hi, toks.length - 1), lo);
}

/** Palabras normalizadas de un texto (para comprobar que un texto nuevo sale literal de la narración). */
export const textTokens = tokens;
