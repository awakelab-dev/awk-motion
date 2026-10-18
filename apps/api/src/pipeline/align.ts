import { norm } from './text.js';

export interface WordTime {
  word: string;
  start: number;
  end: number;
}

/**
 * Alinea las palabras del texto fuente con las que transcribió whisper (LCS sobre palabras
 * normalizadas). El texto fuente manda; whisper solo aporta los tiempos. Las palabras sin
 * pareja (p. ej. "IAAS" transcrito como "IAS") se interpolan entre sus vecinas.
 */
export function alignWords(source: string[], heard: WordTime[], totalSec: number): WordTime[] {
  const a = source.map(norm);
  const b = heard.map((w) => norm(w.word));
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = similar(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const times: ({ start: number; end: number } | null)[] = new Array(n).fill(null);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (similar(a[i], b[j])) {
      times[i] = { start: heard[j].start, end: heard[j].end };
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  // Interpolación de huecos
  const out: WordTime[] = [];
  for (let k = 0; k < n; k++) {
    if (times[k]) {
      out.push({ word: source[k], ...times[k]! });
      continue;
    }
    let p = k - 1;
    while (p >= 0 && !times[p]) p--;
    let q = k + 1;
    while (q < n && !times[q]) q++;
    const t0 = p >= 0 ? times[p]!.end : 0;
    const t1 = q < n ? times[q]!.start : totalSec;
    const span = q - p;
    const s = t0 + ((t1 - t0) * (k - p - 0.5)) / span;
    const e = t0 + ((t1 - t0) * (k - p + 0.4)) / span;
    out.push({ word: source[k], start: s, end: Math.max(s, e) });
  }
  return out;
}

function similar(x: string, y: string): boolean {
  if (x === y) return true;
  if (!x || !y) return false;
  if (Math.min(x.length, y.length) >= 3 && (x.startsWith(y) || y.startsWith(x))) return true;
  return x.length >= 4 && y.length >= 4 && levenshtein(x, y) <= 1;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Agrupa la alineación por caracteres de ElevenLabs en palabras del texto. */
export function wordsFromCharAlignment(
  chars: string[],
  starts: number[],
  ends: number[],
): WordTime[] {
  const out: WordTime[] = [];
  let cur = '';
  let s = 0;
  let e = 0;
  const flush = () => {
    if (cur && /[\p{L}\p{N}]/u.test(cur)) out.push({ word: cur, start: s, end: e });
    cur = '';
  };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (/\s/.test(c)) {
      flush();
      continue;
    }
    if (!cur) s = starts[i];
    cur += c;
    e = ends[i];
  }
  flush();
  return out;
}
