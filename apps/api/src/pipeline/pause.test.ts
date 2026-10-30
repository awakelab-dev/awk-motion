import { describe, expect, it } from 'vitest';
import { maxShorten, planPause } from './pause.js';

const w = (word: string, start: number, end: number, paragraph: number) => ({ word, start, end, paragraph });
// Párrafo 0: «Hola mundo bonito» (0–2 s); párrafo 1: «Adiós amigos» (2,6–3,8 s).
const words = [w('Hola', 0.1, 0.5, 0), w('mundo', 0.9, 1.4, 0), w('bonito', 1.45, 1.9, 0), w('Adiós', 2.7, 3.1, 1), w('amigos', 3.2, 3.7, 1)];
const paragraphs = [
  { index: 0, startSec: 0, durationSec: 2 },
  { index: 1, startSec: 2.5, durationSec: 1.3 },
];

describe('pausa entre dos palabras (ADR-164)', () => {
  it('dentro de un párrafo: corta en la mitad del silencio y corre lo que viene después', () => {
    const p = planPause(words, paragraphs, 0, 0.5);
    expect(p.cutSec).toBeCloseTo(0.7);
    expect(p.inParagraph).toEqual({ index: 0, atSec: 0.7 });
    expect(p.gapAfter).toBeCloseTo(0.9);
    expect(p.words[0]).toBe(words[0]);
    expect(p.words[1].start).toBeCloseTo(1.4);
    expect(p.words[4].end).toBeCloseTo(4.2);
    expect(p.paragraphs[0].durationSec).toBeCloseTo(2.5);
    expect(p.paragraphs[1].startSec).toBeCloseTo(3);
  });

  it('entre dos párrafos: no se toca ningún audio de párrafo, se corren los siguientes', () => {
    const p = planPause(words, paragraphs, 2, 1);
    expect(p.inParagraph).toBeUndefined();
    expect(p.paragraphs[0]).toEqual(paragraphs[0]);
    expect(p.paragraphs[1].startSec).toBeCloseTo(3.5);
    expect(p.words[3].start).toBeCloseTo(3.7);
  });

  it('acortar: solo el silencio, sin cortar palabras', () => {
    expect(maxShorten(words, 0)).toBeCloseTo(0.32);
    const p = planPause(words, paragraphs, 0, -0.3);
    expect(p.gapAfter).toBeCloseTo(0.1);
    expect(p.words[1].start).toBeCloseTo(0.6);
    expect(() => planPause(words, paragraphs, 0, -0.35)).toThrow(/hasta 0,32 s/);
    expect(() => planPause(words, paragraphs, 1, -0.1)).toThrow(/no hay silencio/);
  });

  it('límites', () => {
    expect(() => planPause(words, paragraphs, 4, 0.5)).toThrow(/dos palabras seguidas/);
    expect(() => planPause(words, paragraphs, -1, 0.5)).toThrow(/dos palabras seguidas/);
    expect(() => planPause(words, paragraphs, 0, 0.01)).toThrow(/al menos/);
    expect(() => planPause(words, paragraphs, 0, 4)).toThrow(/hasta 3 s/);
  });
});
