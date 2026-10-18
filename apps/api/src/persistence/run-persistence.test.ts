import { describe, expect, it } from 'vitest';
import type { RunState } from '@wilox/shared';
import { markInterrupted, type RunData } from './run-data.js';
import { relInRun } from './run-persistence.js';

describe('persistencia de generaciones', () => {
  it('guarda las rutas relativas a la carpeta de la generación', () => {
    const dir = '/srv/wilox/storage/runs/abc';
    expect(relInRun(dir, 'abc', '/srv/wilox/storage/runs/abc/keyframes/K01_v2.png')).toBe('keyframes/K01_v2.png');
    // internal.json de otra máquina (rutas absolutas del Mac)
    expect(relInRun(dir, 'abc', '/Users/leo/projects/wilox-motion/storage/runs/abc/clips/clip01_ia_v1.mp4')).toBe('clips/clip01_ia_v1.mp4');
    expect(relInRun(dir, 'abc', 'keyframes/K00_v1.png')).toBe('keyframes/K00_v1.png');
  });

  it('marca lo que estaba en marcha como interrumpido (ADR-013)', () => {
    const state = {
      status: 'clips',
      keyframes: [
        { index: 0, status: 'ready', version: 1 },
        { index: 1, status: 'generating', version: 2, activity: 'Generando imagen…' },
      ],
      clips: [{ index: 1, status: 'generating' }],
    } as unknown as RunState;
    const d = { state, keyAssets: new Map([[0, { ref: 'x', path: 'K00_v1.png' }]]), storyboard: {}, shots: [] } as unknown as RunData;
    expect(markInterrupted(d)).toBe(true);
    expect(state.status).toBe('error');
    expect(state.keyframes[1].status).toBe('error');
    expect(state.keyframes[1].activity).toBeUndefined();
    expect(state.clips[0].status).toBe('error');
  });
});
