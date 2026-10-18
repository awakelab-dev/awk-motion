import { describe, expect, it } from 'vitest';
import { PUBLIC_NAMES, variantOf } from './publications.service.js';

describe('publicaciones (ADR-101)', () => {
  it('la variante junta calidad y logo (el original se llama original)', () => {
    expect(variantOf({ height: 1080, compression: 'balanced' })).toBe('1080p_balanced|sin-logo');
    expect(variantOf({ height: 1440, compression: 'high' })).toBe('original|sin-logo');
    expect(variantOf({ height: 720, compression: 'light' }, true)).toBe('720p_light|logo');
  });

  it('solo se sirven los tres nombres fijos', () => {
    expect([...PUBLIC_NAMES].sort()).toEqual(['portada.jpg', 'subtitulos.vtt', 'video.mp4']);
  });
});

describe('direcciones públicas en un documento (ADR-139)', () => {
  it('saca los tokens en orden y sin repetir', async () => {
    const { tokensOf } = await import('./variant.js');
    const doc = [
      '<video src="https://cdn.x/wilox-motion/prod/publico/AAAAAAAAAAAAAAAAAAAAAAAA/video.mp4" poster="https://cdn.x/wilox-motion/prod/publico/AAAAAAAAAAAAAAAAAAAAAAAA/portada.jpg">',
      '<track src="https://cdn.x/wilox-motion/prod/publico/AAAAAAAAAAAAAAAAAAAAAAAA/subtitulos.vtt">',
      '<video src="http://localhost:5173/api/publico/BBBBBBBBBBBBBBBBBBBBBBBB/video.mp4">',
    ].join('\n');
    expect(tokensOf(doc)).toEqual(['AAAAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBBBB']);
  });
});
