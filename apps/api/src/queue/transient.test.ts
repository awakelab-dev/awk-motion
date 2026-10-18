import { describe, expect, it } from 'vitest';
import { Capacity } from './capacity.js';
import { transientInfo } from './transient.js';

describe('errores transitorios (ADR-045)', () => {
  it('429, 5xx, red y límites de MiniMax se reintentan', () => {
    expect(transientInfo(new Error('HTTP 429 en api.openai.com/v1/images: rate limit'))).toBeDefined();
    expect(transientInfo(new Error('HTTP 503 en api.minimax.io/v2/video_generation'))).toBeDefined();
    expect(transientInfo(Object.assign(new Error('overloaded'), { status: 529 }))).toBeDefined();
    expect(transientInfo(new Error('fetch failed'))).toBeDefined();
    expect(transientInfo('MiniMax no creó la tarea: rate limit exceeded (1002)')).toBeDefined();
    expect(transientInfo(Object.assign(new Error('x'), { status: 429, headers: { 'retry-after': '7' } }))?.retryAfterMs).toBe(7000);
  });
  it('los errores de contenido o parámetros no', () => {
    expect(transientInfo(new Error('HTTP 400 en api.openai.com: content policy'))).toBeUndefined();
    expect(transientInfo(new Error('MiniMax: tarea failed. invalid prompt'))).toBeUndefined();
    expect(transientInfo('MiniMax: tarea failed. network timeout (1002)')).toBeUndefined();
    expect(transientInfo(Object.assign(new Error('bad'), { status: 401 }))).toBeUndefined();
  });
});

describe('capacidad por recurso (ADR-045)', () => {
  it('respeta la concurrencia y el límite por minuto', () => {
    const c = new Capacity('openai', 2, 3);
    const t = 1_000_000;
    expect(c.canStart(t)).toBe(true);
    c.onStart(t);
    c.onStart(t);
    expect(c.canStart(t)).toBe(false);
    c.onEnd('ok', t);
    c.onStart(t);
    c.onEnd('ok', t);
    expect(c.canStart(t + 1000)).toBe(false); // 3 en el último minuto
    expect(c.nextTimeSlot(t + 1000)).toBe(t + 60_000);
    expect(c.canStart(t + 60_001)).toBe(true);
  });
  it('un 429 baja la concurrencia y respeta Retry-After; los éxitos la recuperan', () => {
    const c = new Capacity('minimax', 6);
    const t = 0;
    c.onStart(t);
    c.onEnd('transient', t, 10_000);
    expect(c.effective).toBe(3);
    expect(c.canStart(5_000)).toBe(false);
    expect(c.canStart(10_001)).toBe(true);
    for (let i = 0; i < 20; i++) {
      c.onStart(20_000);
      c.onEnd('ok', 20_000);
    }
    expect(c.effective).toBe(6);
  });
  it('un proveedor caído se pausa y se reanuda solo', () => {
    const c = new Capacity('anthropic', 4);
    for (let i = 0; i < 5; i++) {
      c.onStart(0);
      c.onEnd('transient', 0);
    }
    expect(c.canStart(1000)).toBe(false);
    expect(c.canStart(31_000)).toBe(true);
  });
});
