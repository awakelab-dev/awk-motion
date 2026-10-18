import { describe, expect, it } from 'vitest';
import { applyRules, mapWordIndices } from './pronunciation.js';

describe('reglas de pronunciación (ADR-048)', () => {
  it('reemplaza palabras y frases completas sin distinguir mayúsculas', () => {
    const rules = [
      { match: 'IAAS', say: 'I, A, A, S' },
      { match: 'control de infecciones', say: 'control  de  infecciones' },
    ];
    expect(applyRules('Las IAAS y las iaas; no IAASX.', rules)).toBe('Las I, A, A, S y las I, A, A, S; no IAASX.');
    expect(applyRules('El control de infecciones.', rules)).toBe('El control  de  infecciones.');
    expect(applyRules('Sin reglas.', [])).toBe('Sin reglas.');
  });
  it('mapea los índices de palabras al cambiar el texto', () => {
    expect(mapWordIndices(['Hola', 'a', 'todos', 'hoy'], ['Hola', 'a', 'todas', 'y', 'todos', 'hoy'])).toEqual([0, 1, 4, 5]);
    expect(mapWordIndices(['uno', 'dos', 'tres'], ['uno', 'cuatro', 'tres'])).toEqual([0, 1, 2]);
  });
});
