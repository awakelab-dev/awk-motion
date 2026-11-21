import { describe, expect, it } from 'vitest';
import { V4_LEAD_SEC, V4_TAIL_SEC } from '@wilox/shared';
import { headOf, keepGapStarts, shiftWords, tailOf, v4Context, v4Starts, v4TrimWindow, V4_WAV_GAP_SEC } from './v4.js';

describe('voz v4 (hito 13a, ADR-177)', () => {
  it('contexto: el final del párrafo anterior y el comienzo del siguiente, sin la etiqueta de tono', () => {
    const sp = ['[calm] Uno dos tres.', '[excited] Cuatro cinco.', 'Seis siete ocho nueve.'];
    expect(v4Context(sp, 0)).toEqual({ nextText: 'Cuatro cinco.' });
    expect(v4Context(sp, 1)).toEqual({ previousText: 'Uno dos tres.', nextText: 'Seis siete ocho nueve.' });
    expect(v4Context(sp, 2)).toEqual({ previousText: 'Cuatro cinco.' });
    expect(v4Context(['Solo uno.'], 0)).toEqual({});
  });

  it('el contexto largo se corta en una palabra', () => {
    const t = 'alfa beta gamma delta epsilon zeta eta theta';
    expect(headOf(t, 20)).toBe('alfa beta gamma');
    expect(tailOf(t, 20)).toBe('epsilon zeta eta theta'.slice(-20).replace(/^\S*\s/, ''));
    expect(tailOf(t, 20).length).toBeLessThanOrEqual(20);
  });

  it('recorte: margen fijo antes de la primera palabra y después de la última (con silencio si no alcanza)', () => {
    const words = [
      { word: 'Hola', start: 0.3, end: 0.6 },
      { word: 'mundo', start: 0.7, end: 1.1 },
    ];
    const w = v4TrimWindow(words, 1.5);
    expect(w.start).toBeCloseTo(0.3 - V4_LEAD_SEC);
    expect(w.end).toBeCloseTo(1.1 + V4_TAIL_SEC);
    expect(w.padStart).toBeCloseTo(0);
    expect(w.padEnd).toBeCloseTo(0);
    const tight = v4TrimWindow([{ word: 'Hola', start: 0.02, end: 1.45 }], 1.5);
    expect(tight.start).toBe(0);
    expect(tight.padStart).toBeCloseTo(V4_LEAD_SEC - 0.02);
    expect(tight.end).toBe(1.5);
    expect(tight.padEnd).toBeCloseTo(V4_TAIL_SEC - 0.05);
    // La primera palabra queda siempre a V4_LEAD_SEC del inicio.
    expect(shiftWords(words, w)[0].start).toBeCloseTo(V4_LEAD_SEC);
    expect(shiftWords([{ word: 'Hola', start: 0.02, end: 1.45 }], tight)[0].start).toBeCloseTo(V4_LEAD_SEC);
  });

  it('0,6 s de voz a voz entre párrafos, en frames enteros', () => {
    const starts = v4Starts([3, 2.5, 4]);
    expect(starts[0]).toBe(0);
    for (const [i, s] of starts.entries()) expect(Math.abs(s * 24 - Math.round(s * 24))).toBeLessThan(1e-9);
    // Voz a voz = hueco entre audios + margen final + margen inicial ≥ 0,6 s y < 0,6 s + 1 frame.
    const v2v = starts[1] - 3 + V4_TAIL_SEC + V4_LEAD_SEC;
    expect(v2v).toBeGreaterThanOrEqual(0.6 - 1e-9);
    expect(v2v).toBeLessThan(0.6 + 1 / 24);
  });

  it('rehacer un párrafo conserva las pausas cambiadas a mano y recalcula las normales', () => {
    const durs = [3, 2.5, 4];
    const s = v4Starts(durs);
    const old = durs.map((d, i) => ({ startSec: s[i], durationSec: d }));
    // Pausa a mano: +0,5 s antes del párrafo 3.
    old[2].startSec += 0.5;
    const after = keepGapStarts(old, [3, 3.1, 4]);
    expect(after[0]).toBe(0);
    expect(after[1]).toBeCloseTo(s[1]);
    const gap2 = after[2] - (after[1] + 3.1);
    expect(gap2).toBeGreaterThanOrEqual(V4_WAV_GAP_SEC + 0.5 - 1e-9);
    // Sin cambios de largo, los inicios no se mueven.
    expect(keepGapStarts(old, durs).map((x) => x.toFixed(4))).toEqual(old.map((o) => o.startSec.toFixed(4)));
  });
});
