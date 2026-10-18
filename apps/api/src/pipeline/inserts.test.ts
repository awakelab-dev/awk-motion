import { describe, expect, it } from 'vitest';
import { FPS, type InsertState } from '@wilox/shared';
import { boundaryFrame, clipShift, compose, cutSecFor, finalCues, insertFrames, transitionFirst, transitionFrames, transitionWindow, voiceShift } from './inserts.js';
import type { PlannedClip } from './timeline.js';

const plan: PlannedClip[] = [
  { shot: 0, startFrame: 0, slotEndFrame: 120 },
  { shot: 1, startFrame: 120, slotEndFrame: 240 },
  { shot: 2, startFrame: 240, slotEndFrame: 360 },
];
const ins = (o: Partial<InsertState>): InsertState => ({ id: 1, kind: 'generated', after: 1, status: 'ready', version: 1, voice: 'pause', deliveredFrames: 124, ...o });
const cues = [
  { start: 0.2, end: 2.0 },
  { start: 2.3, end: 4.9 },
  { start: 5.2, end: 9.0 },
  { start: 9.4, end: 14.8 },
];

describe('insertos (ADR-073)', () => {
  it('bordes: principio, entre clips y final', () => {
    expect(boundaryFrame(plan, 0, 360)).toBe(0);
    expect(boundaryFrame(plan, 1, 360)).toBe(120);
    expect(boundaryFrame(plan, 3, 360)).toBe(360);
  });

  it('la voz se corta justo antes del subtítulo más cercano al borde (nunca a mitad de palabra)', () => {
    expect(cutSecFor(cues, 5.0, 1, 3, 15)).toBeCloseTo(5.15, 5); // borde a 5 s: antes del subtítulo de 5,2 s
    expect(cutSecFor(cues, 10.0, 2, 3, 15)).toBeCloseTo(9.35, 5);
    expect(cutSecFor(cues, 0, 0, 3, 15)).toBe(0);
    expect(cutSecFor(cues, 15, 3, 3, 15)).toBe(15);
  });

  it('con locución propia, el inserto dura lo que ella más los márgenes (y nunca menos que su video)', () => {
    expect(insertFrames(ins({ voice: 'pause' }))).toBe(124);
    expect(insertFrames(ins({ voice: 'text', voiceSec: 8 }))).toBe(Math.ceil((0.3 + 8 + 0.4) * FPS));
    expect(insertFrames(ins({ voice: 'text', voiceSec: 2 }))).toBe(124);
  });

  it('compone el final: corre los clips siguientes y suma los frames', () => {
    const c = compose(plan, 360, [ins({ id: 1, after: 1 }), ins({ id: 2, kind: 'upload', after: 0, deliveredFrames: 48 }), ins({ id: 3, after: 1, status: 'pending' })], cues);
    expect(c.totalFrames).toBe(360 + 124 + 48);
    expect(c.gaps.map((g) => [g.after, g.frames])).toEqual([
      [0, 48],
      [1, 124],
    ]);
    expect(c.gaps[1].inserts[0].startFrame).toBe(120 + 48);
    expect(clipShift(c, 1)).toBe(48);
    expect(clipShift(c, 2)).toBe(48 + 124);
    expect(voiceShift(c, 1)).toBeCloseTo(2, 5);
    expect(voiceShift(c, 6)).toBeCloseTo((48 + 124) / FPS, 5);
  });

  it('subtítulos: se corren, no cruzan un corte y llevan los de la locución del inserto', () => {
    const words = [
      { word: 'Hola', start: 0.2, end: 0.6, paragraph: 0 },
      { word: 'mundo.', start: 0.7, end: 1.2, paragraph: 0 },
      { word: 'Segundo', start: 6.0, end: 6.5, paragraph: 1 },
      { word: 'párrafo.', start: 6.6, end: 7.2, paragraph: 1 },
    ];
    const paragraphs = [{ text: 'Hola mundo.' }, { text: 'Segundo párrafo.' }];
    const inserts = [ins({ id: 1, after: 1, voice: 'text', text: 'Nuevo tramo.', voiceSec: 1, voiceWords: [{ word: 'Nuevo', start: 0, end: 0.4 }, { word: 'tramo.', start: 0.5, end: 1 }] })];
    const out = finalCues({ paragraphs, words, voiceFrames: 360, plan, inserts });
    const texts = out.map((c) => c.lines.join(' '));
    expect(texts).toEqual(['Hola mundo.', 'Nuevo tramo.', 'Segundo párrafo.']);
    expect(out[0].start).toBeCloseTo(0.2, 5);
    expect(out[1].start).toBeCloseTo(120 / FPS + 0.3, 5); // dentro del inserto, tras 0,3 s
    expect(out[2].start).toBeCloseTo(6.0 + 124 / FPS, 5);
    expect(out.every((c, i) => i === 0 || c.start >= out[i - 1].end - 1e-6)).toBe(true);
  });

  it('la transición de un video subido suma sus frames solo cuando está lista (ADR-074)', () => {
    const up = ins({ kind: 'upload', after: 0, deliveredFrames: 72 });
    expect(insertFrames({ ...up, transition: { status: 'pending', version: 1 } })).toBe(72);
    // ADR-075: la transición dura 2 s (48 f) aunque una antigua tenga los 124 f de MiniMax.
    expect(insertFrames({ ...up, transition: { status: 'ready', version: 1, deliveredFrames: 48 } })).toBe(120);
    expect(insertFrames({ ...up, transition: { status: 'ready', version: 1, deliveredFrames: 124 } })).toBe(120);
    expect(insertFrames({ ...up, voice: 'text', voiceSec: 10, transition: { status: 'ready', version: 1, deliveredFrames: 124 } })).toBe(Math.ceil(10.7 * FPS));
    expect(transitionFirst({ after: 0 })).toBe(false); // portada: después
    expect(transitionFirst({ after: 3 })).toBe(true); // cierre: antes
  });
});

describe('transitionWindow (ADR-076)', () => {
  // Curva de 124 f con movimiento entre los frames a y b (como entrega MiniMax: anima y después se queda quieto).
  const curve = (a: number, b: number) => Array.from({ length: 124 }, (_, i) => (i >= a && i <= b ? 6 : i ? 0.1 : 0));

  it('toma el tramo con movimiento aunque MiniMax anime al principio', () => {
    const w = transitionWindow(curve(5, 70), false);
    expect(w.from).toBe(2);
    expect(w.frames).toBe(71); // 2…72: se acelera ×1,5 a 48 f
  });

  it('completa con cuadros quietos del lado del video vecino si el movimiento dura menos de 2 s', () => {
    // Portada: termina en el clip01, se completa hacia el final.
    expect(transitionWindow(curve(10, 30), false)).toEqual({ from: 7, frames: 48 });
    // Cierre: empieza en el último clip, se completa hacia atrás.
    expect(transitionWindow(curve(100, 115), true)).toEqual({ from: 70, frames: 48 });
  });

  it('sin movimiento usa los 2 s del lado del video vecino', () => {
    const still = Array.from({ length: 124 }, () => 0.1);
    expect(transitionWindow(still, false)).toEqual({ from: 76, frames: 48 });
    expect(transitionWindow(still, true)).toEqual({ from: 0, frames: 48 });
  });
});

describe('transición activable (hito 7, ADR-086)', () => {
  const ins = (enabled?: boolean) => ({ deliveredFrames: 72, voice: 'pause' as const, transition: { status: 'ready' as const, version: 1, deliveredFrames: 48, ...(enabled === undefined ? {} : { enabled }) } });
  it('activa (o sin el campo) suma sus 2 s; desactivada no suma nada y se conserva', () => {
    expect(transitionFrames(ins())).toBe(48);
    expect(transitionFrames(ins(true))).toBe(48);
    expect(transitionFrames(ins(false))).toBe(0);
    expect(insertFrames(ins())).toBe(120);
    expect(insertFrames(ins(false))).toBe(72);
    expect(ins(false).transition.deliveredFrames).toBe(48);
  });
});
