import { describe, expect, it } from 'vitest';
import { promptMeta } from './prompt-meta.js';

describe('promptMeta', () => {
  it('clasifica los prompts por su nombre de archivo', () => {
    expect(promptMeta('K01_superprompt_v2.md')).toEqual({ kind: 'keyframe', version: 2 });
    expect(promptMeta('A_imagen_v3.md')).toEqual({ kind: 'keyframe', version: 3 });
    expect(promptMeta('clip03_superprompt_v1.md')).toEqual({ kind: 'clip', version: 1 });
    expect(promptMeta('clip_video_v1.md')).toEqual({ kind: 'clip', version: 1 });
    expect(promptMeta('revision_system.md')).toEqual({ kind: 'review', version: 1 });
    expect(promptMeta('storyboard.json').kind).toBe('storyboard');
    expect(promptMeta('tiempos_por_palabra.json').kind).toBe('timing');
    expect(promptMeta('20260925T101010_system.md').kind).toBe('proposal');
    expect(promptMeta('20260925T101010_respuesta.json').kind).toBe('proposal');
  });
});
