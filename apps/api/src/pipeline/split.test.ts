import { describe, expect, it } from 'vitest';
import type { Shot } from '@wilox/shared';
import type { TimedWord } from '@wilox/prompts';
import { pickSplitPoint, shiftIndexName, shiftIndexPath, shiftKeys } from './split.js';

const shot = (anchorWordIndex: number) => ({ anchorWordIndex }) as unknown as Shot;
/** Una palabra cada 0,5 s; un punto cada 8 palabras. */
const words: TimedWord[] = Array.from({ length: 60 }, (_, i) => ({ word: i % 8 === 7 ? `p${i}.` : `p${i}`, start: i * 0.5, end: i * 0.5 + 0.4, paragraph: 0 }));

describe('pickSplitPoint', () => {
  it('corta un tramo largo cerca de la mitad, con los dos clips completos y en el inicio de una frase', () => {
    // clip1 en 0, clip2 en la palabra 40 (20 s): el tramo del clip 1 dura ~19 s.
    const p = pickSplitPoint({ words, shots: [shot(0), shot(40)], paragraphs: [{ startSec: 0 }], totalFrames: 720, clip: 1 })!;
    expect(p).toBeDefined();
    expect(p.firstFrames).toBeGreaterThanOrEqual(124);
    expect(p.secondFrames).toBeGreaterThanOrEqual(124);
    expect(words[p.wordIndex - 1].word.endsWith('.')).toBe(true);
    expect(Math.abs(p.startFrame - 456 / 2)).toBeLessThan(48);
  });
  it('evita cortar antes de una palabra de enlace', () => {
    const ws: TimedWord[] = words.map((w, i) => ({ ...w, word: i === 21 ? 'de' : `p${i}` }));
    const p = pickSplitPoint({ words: ws, shots: [shot(0), shot(40)], paragraphs: [{ startSec: 0 }], totalFrames: 720, clip: 1 })!;
    expect(ws[p.wordIndex].word).not.toBe('de');
  });
  it('un tramo corto no se divide', () => {
    expect(pickSplitPoint({ words, shots: [shot(0), shot(18)], paragraphs: [{ startSec: 0 }], totalFrames: 720, clip: 1 })).toBeUndefined();
  });
  it('el último clip llega hasta el final', () => {
    const p = pickSplitPoint({ words, shots: [shot(0), shot(10)], paragraphs: [{ startSec: 0 }], totalFrames: 720, clip: 2 })!;
    // el clip 2 empieza en 124 (no puede pisar al 1, que dura 124 f) y su tramo llega hasta el final
    expect(p.firstFrames + p.secondFrames).toBe(720 - 124);
  });
});

describe('shiftIndexName', () => {
  it('corre los fotogramas desde el clip dividido y los clips desde el siguiente', () => {
    expect(shiftIndexName('K03_v2.png', 3)).toBe('K04_v2.png');
    expect(shiftIndexName('K02_v1.png', 3)).toBe('K02_v1.png');
    expect(shiftIndexName('_revision_K05_v1.jpg', 3)).toBe('_revision_K06_v1.jpg');
    expect(shiftIndexName('K04_plano_v2.json', 3)).toBe('K05_plano_v2.json');
    expect(shiftIndexName('clip03_ia_v1.mp4', 3)).toBe('clip03_ia_v1.mp4');
    expect(shiftIndexName('clip04_ia_v2.mp4', 3)).toBe('clip05_ia_v2.mp4');
    expect(shiftIndexName('clip04ex.mp4', 3)).toBe('clip05ex.mp4');
    expect(shiftIndexName('clip09_sound.wav', 3)).toBe('clip10_sound.wav');
    expect(shiftIndexName('escucha_clip04.mp4', 3)).toBe('escucha_clip05.mp4');
    expect(shiftIndexName('clip04_consejo_v1_user.md', 3)).toBe('clip05_consejo_v1_user.md');
    expect(shiftIndexName('storyboard.json', 3)).toBe('storyboard.json');
    expect(shiftIndexName('KEY01.txt', 1)).toBe('KEY01.txt');
  });
  it('rutas y claves', () => {
    expect(shiftIndexPath('keyframes/K03_v1.png', 2)).toBe('keyframes/K04_v1.png');
    expect(shiftKeys({ '1': 'tl', '3': 'br', '4': 'none' }, 3)).toEqual({ '1': 'tl', '4': 'br', '5': 'none' });
  });
});
