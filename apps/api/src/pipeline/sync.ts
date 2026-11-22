/**
 * Palabra clave al inicio del clip (hito 13a, T5, ADR-181): el ancla de cada plano es la PRIMERA palabra de su frase clave
 * tal como la dice la voz. Opus recibe la regla en el storyboard y el código la verifica: busca la frase clave (`pfc`) —o,
 * si no es literal, el comienzo de uno de los textos en pantalla— en la narración cerca del ancla de Opus y, si la
 * encuentra en otro lugar, corrige el ancla. Los planos que abren un párrafo no se mueven (el clip empieza con el
 * párrafo). Sirve también para «Reajustar sincronía» de videos ya hechos (T6).
 */

/** Palabras de enlace: una sola de ellas no basta para reconocer la frase. */
const LINK = new Set(['a', 'al', 'con', 'de', 'del', 'el', 'en', 'es', 'la', 'las', 'lo', 'los', 'o', 'para', 'por', 'que', 'se', 'su', 'sus', 'un', 'una', 'y']);

/** Palabra normalizada: minúsculas, sin tildes ni signos. */
export function normWord(w: string): string {
  return w
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ]/g, '');
}

const tokens = (t: string) => t.split(/[\s/]+/).map(normWord).filter(Boolean);

/** Cuántos de los primeros tokens de `phrase` coinciden desde la posición `j` de la narración. */
function prefixAt(toks: string[], j: number, phrase: string[]): number {
  let k = 0;
  while (k < phrase.length && j + k < toks.length && toks[j + k] === phrase[k]) k++;
  return k;
}

/** Posición en [lo, hi] donde empieza la frase (entera o, si no, sus primeras palabras), la más cercana a `near`. */
function findPhrase(toks: string[], phrase: string[], lo: number, hi: number, near: number): number | undefined {
  if (!phrase.length) return undefined;
  let best: { j: number; k: number } | undefined;
  for (let j = lo; j <= hi; j++) {
    const k = prefixAt(toks, j, phrase);
    // Vale la frase entera, o sus 2 primeras palabras, o una sola palabra que no sea de enlace y tenga 4 letras o más.
    const ok = k === phrase.length || k >= 2 || (k === 1 && phrase[0].length >= 4 && !LINK.has(phrase[0]));
    if (!ok) continue;
    if (!best || k > best.k || (k === best.k && Math.abs(j - near) < Math.abs(best.j - near))) best = { j, k };
  }
  return best?.j;
}

export interface SyncShot {
  anchorWordIndex: number;
  pfc: string;
  keyframe?: { texts?: string[] };
}

export interface SyncResult {
  anchors: number[];
  moved: { shot: number; from: number; to: number; by: 'pfc' | 'texto' }[];
}

/** Palabras alrededor del ancla de Opus donde se busca la frase. */
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
    const lo = Math.max(anchors[i - 1] + 1, a - SYNC_WINDOW_WORDS);
    const next = i + 1 < shots.length ? shots[i + 1].anchorWordIndex : words.length;
    const hi = Math.min(next - 1, a + SYNC_WINDOW_WORDS, words.length - 1);
    if (hi < lo) continue;
    let to = findPhrase(toks, tokens(shots[i].pfc), lo, hi, a);
    let by: 'pfc' | 'texto' = 'pfc';
    if (to === undefined)
      for (const t of shots[i].keyframe?.texts ?? []) {
        const ph = tokens(t);
        if (ph.length < 2) continue;
        const j = findPhrase(toks, ph, lo, hi, a);
        if (j !== undefined && prefixAt(toks, j, ph) >= 2) {
          to = j;
          by = 'texto';
          break;
        }
      }
    if (to !== undefined && to !== a) {
      anchors[i] = to;
      moved.push({ shot: i, from: a, to, by });
    }
  }
  return { anchors, moved };
}
