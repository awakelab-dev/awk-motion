import { describe, expect, it } from 'vitest';
import { buildCues, LINE_CHARS, toSrt, toVtt, type SubtitleWord } from './subtitles.js';

/** Palabras con tiempos regulares (0,35 s cada una) a partir de un texto. */
function timed(paragraphs: string[], gap = 0.6): SubtitleWord[] {
  const out: SubtitleWord[] = [];
  let t = 0;
  paragraphs.forEach((p, i) => {
    for (const w of p.split(/\s+/).filter((x) => /[\p{L}\p{N}]/u.test(x))) {
      out.push({ word: w, start: t, end: t + 0.3, paragraph: i });
      t += 0.35;
    }
    t += gap;
  });
  return out;
}

describe('subtítulos (ADR-061)', () => {
  const paras = [
    'Piense por un momento en un día habitual de trabajo. La agenda se llena de reuniones, los mensajes se acumulan y buena parte de la jornada se va en tareas que se repiten una y otra vez.',
    'Le damos la bienvenida a Productividad Exponencial — un curso de veinte horas.',
  ];
  const words = timed(paras);
  const cues = buildCues(
    paras.map((text) => ({ text })),
    words,
  );

  it('el texto sale palabra por palabra como está escrito (con la puntuación y los signos sueltos)', () => {
    expect(cues.flatMap((c) => c.lines).join(' ')).toBe(paras.join(' '));
  });

  it('una sola línea de hasta 42 caracteres, de 1 a 6 s y sin solaparse', () => {
    for (const [i, c] of cues.entries()) {
      expect(c.lines.length).toBe(1);
      for (const l of c.lines) expect(l.length).toBeLessThanOrEqual(LINE_CHARS);
      expect(c.end - c.start).toBeGreaterThanOrEqual(0.999);
      expect(c.end - c.start).toBeLessThanOrEqual(6.001);
      if (i) expect(c.start).toBeGreaterThanOrEqual(cues[i - 1].end);
    }
  });

  it('corta al final de cada frase y de cada párrafo', () => {
    const ends = cues.map((c) => c.lines.join(' '));
    expect(ends.some((t) => t.endsWith('trabajo.'))).toBe(true);
    expect(ends.some((t) => t.endsWith('otra vez.'))).toBe(true);
    // un subtítulo nunca mezcla dos párrafos
    expect(ends.some((t) => t.includes('vez. Le'))).toBe(false);
  });

  it('un subtítulo no termina en "de", "la", "y"… si se puede evitar', () => {
    for (const c of cues.slice(0, -1)) expect(c.lines[0]).not.toMatch(/ (de|la|el|los|las|y|en|a|que|un|una)$/);
  });

  it('formatos WebVTT y SRT', () => {
    const c = [{ start: 1.5, end: 3.25, lines: ['Hola,', 'mundo.'] }];
    expect(toVtt(c)).toBe('WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.250\nHola,\nmundo.\n');
    expect(toSrt(c)).toBe('1\n00:00:01,500 --> 00:00:03,250\nHola,\nmundo.\n');
  });
});
