import { describe, expect, it } from 'vitest';
import { CLIP_FRAMES, FPS, type InsertState } from '@wilox/shared';
import { compose } from './inserts.js';
import { END_HOLD_FRAMES, holdLastClip, planTimeline, segmentsFor, videoFrames } from './timeline.js';

describe('cierre del video: el último clip se ve entero (ADR-157)', () => {
  it('si la voz termina antes de que acabe la animación, el video sigue hasta el clip entero + la pausa', () => {
    // Voz de 30 s; la última PFC cae 3 s antes del final: el clip empieza en 26 s (con el adelanto de 1 s).
    const total = 30 * FPS;
    const plan = planTimeline({ anchorFrames: [0, 10 * FPS, 27 * FPS], totalFrames: total });
    const last = plan[plan.length - 1];
    expect(last.startFrame).toBe(26 * FPS);
    expect(last.slotEndFrame).toBe(last.startFrame + CLIP_FRAMES + END_HOLD_FRAMES);
    expect(videoFrames(plan, total)).toBe(last.slotEndFrame);
    // El clip no se corta: su segmento dura el clip entero y el congelado es la pausa.
    const segs = segmentsFor(plan, () => CLIP_FRAMES).slice(-2);
    expect(segs[0]).toMatchObject({ kind: 'clip', endFrame: last.startFrame + CLIP_FRAMES });
    expect(segs[1]).toMatchObject({ kind: 'freeze', startFrame: last.startFrame + CLIP_FRAMES, endFrame: last.slotEndFrame });
  });

  it('si el clip y la pausa caben en la voz, nada cambia: el video dura la voz', () => {
    const total = 30 * FPS;
    const plan = planTimeline({ anchorFrames: [0, 10 * FPS, 18 * FPS], totalFrames: total });
    expect(plan[plan.length - 1].slotEndFrame).toBe(total);
    expect(videoFrames(plan, total)).toBe(total);
  });

  it('planes de antes: holdLastClip los alarga con los frames que entregó el clip; es idempotente', () => {
    const old = [
      { shot: 0, startFrame: 0, slotEndFrame: 300 },
      { shot: 1, startFrame: 300, slotEndFrame: 380 },
    ];
    const held = holdLastClip(old, 380, 124);
    expect(held[1].slotEndFrame).toBe(300 + 124 + END_HOLD_FRAMES);
    expect(held[0]).toBe(old[0]);
    expect(old[1].slotEndFrame).toBe(380); // no muta el original
    expect(holdLastClip(held, 380, 124)).toBe(held);
    expect(holdLastClip([], 380)).toEqual([]);
  });

  it('con insertos: el final suma el cierre y un inserto al final va después de la pausa', () => {
    const plan = [
      { shot: 0, startFrame: 0, slotEndFrame: 300 },
      { shot: 1, startFrame: 300, slotEndFrame: 300 + 124 + END_HOLD_FRAMES },
    ];
    const ins = { id: 1, after: 2, status: 'ready', deliveredFrames: 48, voice: 'none', kind: 'upload' } as unknown as InsertState;
    const c = compose(plan, 380, [ins], []);
    expect(c.gaps[0].boundaryFrame).toBe(300 + 124 + END_HOLD_FRAMES);
    expect(c.totalFrames).toBe(300 + 124 + END_HOLD_FRAMES + c.gaps[0].frames);
    // Sin insertos, compose da el video con el cierre.
    expect(compose(plan, 380, [], []).totalFrames).toBe(300 + 124 + END_HOLD_FRAMES);
  });
});
