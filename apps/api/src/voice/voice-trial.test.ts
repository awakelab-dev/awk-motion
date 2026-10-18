import { describe, expect, it } from 'vitest';
import { nextTextFor, splitWholeVoice } from './voice-trial.js';

const w = (start: number, end: number) => ({ word: 'x', start, end });

describe('splitWholeVoice', () => {
  it('corta a la mitad del silencio entre párrafos', () => {
    const aligned = [w(0.1, 0.5), w(0.6, 1.0), w(2.0, 2.4), w(2.5, 3.0), w(3.1, 3.5)];
    expect(splitWholeVoice(aligned, [2, 3], 4)).toEqual([
      { start: 0, end: 1.5 },
      { start: 1.5, end: 4 },
    ]);
  });
  it('sin silencio, corta al inicio de la primera palabra', () => {
    const aligned = [w(0, 1), w(0.9, 2)];
    expect(splitWholeVoice(aligned, [1, 1], 2.2)).toEqual([
      { start: 0, end: 0.9 },
      { start: 0.9, end: 2.2 },
    ]);
  });
  it('rechaza conteos que no cuadran', () => {
    expect(() => splitWholeVoice([w(0, 1)], [1, 1], 2)).toThrow();
  });
});

describe('nextTextFor', () => {
  it('corta en una palabra', () => {
    expect(nextTextFor('uno dos tres cuatro', 9)).toBe('uno dos');
    expect(nextTextFor('corto')).toBe('corto');
    expect(nextTextFor(undefined)).toBeUndefined();
  });
});
