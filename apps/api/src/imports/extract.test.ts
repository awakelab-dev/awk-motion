import { describe, expect, it } from 'vitest';
import { appearsInDocument } from './extract.js';

describe('importar guion (ADR-049)', () => {
  it('reconoce la locución literal aunque una tabla intercale otra columna', () => {
    const doc = 'Locución Escena Las IAAS son un desafío foto de un hospital para todos los equipos clínicos.';
    expect(appearsInDocument('Las IAAS son un desafío para todos los equipos clínicos.', doc)).toBe(true);
  });
  it('detecta una locución reescrita', () => {
    expect(appearsInDocument('Las infecciones son un gran reto para el personal.', 'Las IAAS son un desafío para todos los equipos.')).toBe(false);
  });
});
