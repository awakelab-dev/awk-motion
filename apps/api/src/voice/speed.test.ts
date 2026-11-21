import { describe, expect, it } from 'vitest';
import { clampSpeed, V4_LEAD_SEC, V4_TAIL_SEC } from '@wilox/shared';
import { rescaleWords, respace, sameSpeed, scaleRelative, shiftedClips, speedRatio } from './speed.js';
import { v4Starts, v4WavGap } from './v4.js';

describe('velocidad de la narración (hito 13a, T2, ADR-178)', () => {
  it('razón nueva / actual y pasos de 0,05 dentro de 0,70–1,15', () => {
    expect(speedRatio(0.85)).toBe(0.85);
    expect(speedRatio(0.85, 0.85)).toBe(1);
    expect(sameSpeed(speedRatio(0.9, 0.9))).toBe(true);
    expect(speedRatio(1, 0.85)).toBeCloseTo(1.17647);
    expect(clampSpeed(0.83)).toBe(0.85);
    expect(clampSpeed(0.5)).toBe(0.7);
    expect(clampSpeed(1.3)).toBe(1.15);
  });

  it('respace conserva los silencios entre párrafos (también uno cambiado a mano)', () => {
    const old = [
      { startSec: 0, durationSec: 4 },
      { startSec: 4.5, durationSec: 3 },
      { startSec: 8.5, durationSec: 2 }, // 1 s de pausa (a mano)
    ];
    const s = respace(old, [4 / 0.8, 3 / 0.8, 2 / 0.8]);
    expect(s[0]).toBe(0);
    expect(s[1] - 5).toBeGreaterThanOrEqual(0.5 - 1e-9);
    expect(s[1] - 5).toBeCloseTo(0.5);
    expect(s[2] - (s[1] + 3.75)).toBeGreaterThanOrEqual(1 - 1e-9);
  });

  it('las palabras se escalan dentro de su párrafo y siguen su inicio nuevo', () => {
    const words = [
      { word: 'a', start: 1, end: 1.5, paragraph: 0 },
      { word: 'b', start: 5, end: 5.4, paragraph: 1 },
    ];
    const w = rescaleWords(words, [0, 4.5], [0, 5.5], 0.5);
    expect(w[0]).toMatchObject({ start: 2, end: 3 });
    expect(w[1].start).toBeCloseTo(6.5);
    expect(w[1].end).toBeCloseTo(7.3);
    expect(scaleRelative([{ start: 1, end: 2 }], 1.25)).toEqual([{ start: 0.8, end: 1.6 }]);
  });

  it('avisa de los clips que el plan corrió', () => {
    const words = [
      { word: 'a', start: 0, end: 0.3, paragraph: 0 },
      { word: 'b', start: 3, end: 3.3, paragraph: 0 },
      { word: 'c', start: 9, end: 9.3, paragraph: 0 },
    ];
    // Clip 2 anclado a «b» (frame 72 − 24 = 48) pero corrido a 124 por el clip 1.
    const plan = [
      { shot: 0, startFrame: 0, slotEndFrame: 124 },
      { shot: 1, startFrame: 124, slotEndFrame: 192 },
      { shot: 2, startFrame: 192, slotEndFrame: 400 },
    ];
    expect(shiftedClips(words, [0, 1, 2], [{ startSec: 0 }], plan)).toEqual([1]);
  });

  it('en v4 la pausa sigue en 0,6 s de voz a voz al cambiar la velocidad, y volver deja los mismos inicios', () => {
    const durs = [3, 2.5, 4];
    const s1 = v4Starts(durs);
    const old = durs.map((d, i) => ({ startSec: s1[i], durationSec: d }));
    const d85 = durs.map((d) => d / 0.85);
    const s85 = respace(old, d85, { from: v4WavGap(1), to: v4WavGap(0.85) });
    const v2v = s85[1] - d85[0] + (V4_LEAD_SEC + V4_TAIL_SEC) / 0.85;
    expect(v2v).toBeGreaterThanOrEqual(0.6 - 1e-9);
    expect(v2v).toBeLessThan(0.6 + 1 / 24 + 1e-9);
    const back = respace(d85.map((d, i) => ({ startSec: s85[i], durationSec: d })), durs, { from: v4WavGap(0.85), to: v4WavGap(1) });
    expect(back.map((x) => x.toFixed(4))).toEqual(s1.map((x) => x.toFixed(4)));
  });
});
