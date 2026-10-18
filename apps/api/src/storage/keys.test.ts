import { describe, expect, it } from 'vitest';
import { evictable, keyOfRel, mediaPrefix, relOfKey, unitOfRel } from './keys.js';

const P = mediaPrefix('prod');

describe('claves del almacenamiento remoto (ADR-093)', () => {
  it('espejo de storage/ con nombres propios bajo wilox-motion/<entorno>/', () => {
    expect(P).toBe('wilox-motion/prod/');
    // Otra instalación, otra raíz (hito 12, ADR-151).
    expect(keyOfRel('runs/abc/final.mp4', mediaPrefix('prod', 'otra-app'))).toBe('otra-app/prod/videos/abc/final.mp4');
    expect(keyOfRel('runs/20261008-1-pastel-abc/keyframes/K01_v2.png', P)).toBe('wilox-motion/prod/videos/20261008-1-pastel-abc/keyframes/K01_v2.png');
    expect(keyOfRel('themes/blue-6d09d7/referencias/ref_01.jpg', P)).toBe('wilox-motion/prod/temas/blue-6d09d7/referencias/ref_01.jpg');
    expect(keyOfRel('projects/0a1b/logo_v1.png', P)).toBe('wilox-motion/prod/proyectos/0a1b/logo_v1.png');
    expect(keyOfRel('downloads/ff00/wilox_x_html_3videos.zip', P)).toBe('wilox-motion/prod/lotes/ff00/wilox_x_html_3videos.zip');
    expect(keyOfRel('fuentes/roboto/Roboto-Regular.ttf', P)).toBe('wilox-motion/prod/fuentes/roboto/Roboto-Regular.ttf');
  });

  it('ida y vuelta', () => {
    for (const r of ['runs/a/final_v2.mp4', 'themes/t/pruebas/001/A_v1.png', 'downloads/b/x.zip'])
      expect(relOfKey(keyOfRel(r, P)!, P)).toBe(r);
    expect(relOfKey('otro-proyecto/videos/a.mp4', P)).toBeUndefined();
  });

  it('no sube lo de trabajo ni los temporales', () => {
    for (const r of ['mock/tasks.json', 'bench/x.json', 'previews/a.png', 'runs', 'runs/a/segments/clip01.tmp.mp4', 'downloads/b/x.zip.tmp', 'runs/a/keyframes/K01.png.part', 'runs/a/.DS_Store'])
      expect(keyOfRel(r, P)).toBeUndefined();
  });

  it('unidades: lo que se sube, se usa y sale de la caché junto', () => {
    expect(unitOfRel('runs/a/segments/clip01.mp4')).toBe('runs/a');
    expect(unitOfRel('themes/t/miniatura.png')).toBe('themes/t');
    expect(unitOfRel('fuentes/roboto/x.ttf')).toBe('fuentes');
    expect(unitOfRel('mock/tasks.json')).toBeUndefined();
    expect(evictable('runs/a')).toBe(true);
    expect(evictable('downloads/b')).toBe(true);
    expect(evictable('themes/t')).toBe(false);
    expect(evictable('projects/p')).toBe(false);
  });
});
