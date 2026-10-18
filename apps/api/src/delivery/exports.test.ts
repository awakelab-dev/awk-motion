import { describe, expect, it } from 'vitest';
import { isOriginalQuality, qualityLabel } from '@wilox/shared';
import { exportArgs, sampleArgs } from './exports.service.js';

/** Resolución y compresión de las descargas (hito 7, ADR-084 y ADR-085). */
describe('versiones reducidas del final', () => {
  it('1440p con alta calidad es el original; lo demás se recodifica', () => {
    expect(isOriginalQuality(undefined)).toBe(true);
    expect(isOriginalQuality({ height: 1440, compression: 'high' })).toBe(true);
    expect(isOriginalQuality({ height: 1440, compression: 'balanced' })).toBe(false);
    expect(isOriginalQuality({ height: 1080, compression: 'high' })).toBe(false);
    expect(qualityLabel({ height: 720, compression: 'light' })).toBe('720p · liviana');
    expect(qualityLabel({ height: 1440, compression: 'high' })).toBe('1440p original');
  });

  it('escala con lanczos (salvo 1440p), CRF según la compresión, AAC 128k y faststart', () => {
    const a = exportArgs('in.mp4', { height: 720, compression: 'light' }, 'out.mp4');
    expect(a.join(' ')).toContain('-vf scale=-2:720:flags=lanczos');
    expect(a.join(' ')).toContain('-preset slow -crf 28');
    expect(a.join(' ')).toContain('-c:a aac -b:a 128k');
    expect(a.join(' ')).toContain('-movflags +faststart');
    expect(a.at(-1)).toBe('out.mp4');
    const b = exportArgs('in.mp4', { height: 1440, compression: 'balanced' }, 'out.mp4');
    expect(b).not.toContain('-vf');
    expect(b.join(' ')).toContain('-crf 23');
  });

  it('las muestras para estimar son 2 s de video, sin audio y con los mismos ajustes', () => {
    const s = sampleArgs('in.mp4', { height: 1080, compression: 'balanced' }, 12.3456, 's.mp4');
    expect(s.slice(0, 7)).toEqual(['-ss', '12.346', '-t', '2', '-i', 'in.mp4', '-an']);
    expect(s.join(' ')).toContain('scale=-2:1080');
    expect(s.join(' ')).toContain('-crf 23');
  });
});
