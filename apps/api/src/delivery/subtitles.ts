/**
 * Subtítulos (hito 6, ADR-061): salen de los tiempos por palabra de la locución con el texto del video tal
 * cual está escrito (con su puntuación; no el texto con las reglas de pronunciación). WebVTT para el
 * reproductor HTML y SRT para CapCut, YouTube o Moodle. Nunca se incrustan en el video.
 *
 * Reglas: una sola línea de hasta 42 caracteres (pedido de Leonardo, ADR-062: dos líneas tapaban los textos
 * del video), de 1 a 6 s cada uno, cortes en la puntuación (siempre al final de una frase y de un párrafo)
 * y sin solaparse.
 */

export interface SubtitleWord {
  word: string;
  start: number;
  end: number;
  paragraph: number;
}

export interface Cue {
  start: number;
  end: number;
  lines: string[];
}

export const LINE_CHARS = 42;
export const MAX_LINES = 1;
export const MIN_SEC = 1;
export const MAX_SEC = 6;
/** Cuánto se queda el subtítulo en pantalla después de la última palabra (si no lo pisa el siguiente). */
const LINGER_SEC = 0.3;

const STRONG = /[.!?…]["'»”’)\]]*$/u;
const WEAK = /[,;:—–]["'»”’)\]]*$/u;
const isWord = (t: string) => /[\p{L}\p{N}]/u.test(t);

/** Palabras que no deberían cerrar un subtítulo ni una línea ("buena parte de la / jornada"). */
const FUNCTION_WORDS = new Set(
  'a al ante con de del desde e el en entre la las lo los o para por que se sin sobre su sus u un una unos unas y ya le les me te nos mi tu muy más pero como cuando donde'.split(' '),
);
const bare = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const endsWeakly = (t: string) => FUNCTION_WORDS.has(bare(t)) && !WEAK.test(t) && !STRONG.test(t);

interface Item {
  text: string;
  start: number;
  end: number;
}

/**
 * Une cada palabra con su tiempo, conservando el texto escrito: los signos sueltos ("—", "…") se pegan a
 * la palabra anterior. Si el texto y los tiempos no coinciden en número de palabras, se usan las palabras
 * de los tiempos.
 */
function itemsOf(text: string, words: SubtitleWord[]): Item[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const wordTokens = tokens.filter(isWord);
  if (wordTokens.length !== words.length) return words.map((w) => ({ text: w.word, start: w.start, end: w.end }));
  const items: Item[] = [];
  let k = 0;
  let lead = '';
  for (const t of tokens) {
    if (!isWord(t)) {
      if (items.length) items[items.length - 1].text += ` ${t}`;
      else lead += `${t} `;
      continue;
    }
    const w = words[k++];
    items.push({ text: lead + t, start: w.start, end: w.end });
    lead = '';
  }
  return items;
}

const joinText = (items: Item[]) => items.map((i) => i.text).join(' ');

/**
 * Parte las palabras de un párrafo en subtítulos: cada frase es uno si cabe (2 líneas, ≤ 6 s); si no, se
 * divide en dos partes lo más parejas posible, preferiendo cortar en una coma y nunca después de "de", "la",
 * "y"…, y cada parte se vuelve a dividir si aún no cabe.
 */
function group(items: Item[]): Item[][] {
  const out: Item[][] = [];
  let sentence: Item[] = [];
  for (const it of items) {
    sentence.push(it);
    if (STRONG.test(it.text)) {
      out.push(...splitSentence(sentence));
      sentence = [];
    }
  }
  if (sentence.length) out.push(...splitSentence(sentence));
  return out;
}

function splitSentence(items: Item[]): Item[][] {
  const dur = items[items.length - 1].end - items[0].start;
  if (items.length === 1 || (fits(joinText(items)) && dur <= MAX_SEC)) return [items];
  let best: { j: number; score: number } | undefined;
  for (let j = 1; j < items.length; j++) {
    const left = items.slice(0, j);
    const right = items.slice(j);
    const last = left[left.length - 1].text;
    const score =
      Math.abs(joinText(left).length - joinText(right).length) -
      (WEAK.test(last) ? 30 : 0) +
      (endsWeakly(last) ? 25 : 0) +
      (fits(joinText(left)) ? 0 : 15) +
      (fits(joinText(right)) ? 0 : 15);
    if (!best || score < best.score) best = { j, score };
  }
  return [...splitSentence(items.slice(0, best!.j)), ...splitSentence(items.slice(best!.j))];
}

/** ¿Cabe en dos líneas de ~42 caracteres? */
const fits = (text: string) => (MAX_LINES === 1 ? text.length <= LINE_CHARS : splitLines(text).every((l) => l.length <= LINE_CHARS));

/** Líneas del subtítulo: una (ADR-062); con MAX_LINES = 2, dos equilibradas y partidas después de un signo. */
export function splitLines(text: string): string[] {
  if (MAX_LINES === 1 || text.length <= LINE_CHARS) return [text];
  const words = text.split(' ');
  let best: { i: number; score: number } | undefined;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const over = Math.max(0, a.length - LINE_CHARS) + Math.max(0, b.length - LINE_CHARS);
    const punct = WEAK.test(words[i - 1]) || STRONG.test(words[i - 1]) ? 6 : 0;
    const weak = endsWeakly(words[i - 1]) ? 12 : 0;
    const score = over * 100 + Math.abs(a.length - b.length) - punct + weak;
    if (!best || score < best.score) best = { i, score };
  }
  return [words.slice(0, best!.i).join(' '), words.slice(best!.i).join(' ')];
}

/** Subtítulos de un video: párrafos (texto del video) y tiempos por palabra en segundos globales. */
export function buildCues(paragraphs: { text: string }[], words: SubtitleWord[], totalSec?: number): Cue[] {
  const groups: Item[][] = [];
  paragraphs.forEach((p, i) => {
    const ws = words.filter((w) => w.paragraph === i);
    if (ws.length) groups.push(...group(itemsOf(p.text, ws)));
  });
  const cues: Cue[] = groups.map((g) => ({ start: g[0].start, end: g[g.length - 1].end, lines: splitLines(joinText(g)) }));
  cues.forEach((c, i) => {
    const next = cues[i + 1]?.start ?? totalSec ?? Infinity;
    // Un poco más en pantalla tras la última palabra y al menos 1 s, sin pisar el siguiente.
    c.end = Math.min(Math.max(c.end + LINGER_SEC, c.start + MIN_SEC), next, c.start + MAX_SEC);
    if (totalSec !== undefined) c.end = Math.min(c.end, totalSec);
    c.start = round(c.start);
    c.end = Math.max(round(c.end), c.start + 0.001);
  });
  return cues;
}

const round = (s: number) => Math.round(s * 1000) / 1000;

function stamp(sec: number, sep: '.' | ',') {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export function toVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.lines.join('\n')}\n`).join('\n')}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.lines.join('\n')}\n`).join('\n');
}

/**
 * Palabras de toda la locución con su texto escrito (signos incluidos) y su tiempo (s), para la presentación
 * del storyboard (hito 8, ADR-098): cada slide muestra las de su tramo y resalta la que se oye.
 */
export function spokenWords(paragraphs: { text: string }[], words: SubtitleWord[]): { text: string; start: number; end: number }[] {
  const out: Item[] = [];
  paragraphs.forEach((p, i) => {
    const ws = words.filter((w) => w.paragraph === i);
    if (ws.length) out.push(...itemsOf(p.text, ws));
  });
  return out;
}
