import { describe, expect, it } from 'vitest';
import { Prisma } from '@wilox/db';
import { copyName, deliveryForCopy, rekey, skipInCopy } from './duplicate.service.js';

describe('duplicar (T3e, ADR-107)', () => {
  it('reemplaza el id viejo en URLs y rutas de los JSON', () => {
    const v = { url: '/api/generations/20261001-120000-dark-abc123/files/inserts/a.mp4?v=2', path: 'runs/20261001-120000-dark-abc123/x', n: 3 };
    expect(rekey(v, '20261001-120000-dark-abc123', '20261012-090000-dark-ffffff')).toEqual({
      url: '/api/generations/20261012-090000-dark-ffffff/files/inserts/a.mp4?v=2',
      path: 'runs/20261012-090000-dark-ffffff/x',
      n: 3,
    });
    expect(rekey(null, 'a', 'b')).toBeNull();
  });

  it('la entrega del duplicado no lleva los links del original', () => {
    expect(deliveryForCopy({ settings: { corner: 'tl' }, posterSec: 2, share: { token: 'x' }, videoShare: { token: 'w' }, review: { token: 'y' } })).toEqual({ settings: { corner: 'tl' }, posterSec: 2 });
    expect(deliveryForCopy({ share: { token: 'x' } })).toBe(Prisma.DbNull);
    expect(deliveryForCopy(null)).toBe(Prisma.DbNull);
  });

  it('nombre «(copia)» sin repetir', () => {
    expect(copyName('Curso A', new Set(['Curso A']))).toBe('Curso A (copia)');
    expect(copyName('Curso A', new Set(['Curso A', 'Curso A (copia)']))).toBe('Curso A (copia 2)');
    expect(copyName('Curso A (copia)', new Set(['Curso A (copia)']))).toBe('Curso A (copia 2)');
  });

  it('no copia el video con el logo dibujado', () => {
    expect(skipInCopy('exports/final_v2_1080p_balanced_logo-0123456789ab.mp4')).toBe(true);
    expect(skipInCopy('exports/final_720p_balanced_logo-152e660ee19b.mp4.json')).toBe(true);
    expect(skipInCopy('exports/final_v2_1080p_balanced.mp4')).toBe(false);
    expect(skipInCopy('clips/clip01_ia_v1.mp4')).toBe(false);
  });
});
