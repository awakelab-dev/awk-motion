import { describe, expect, it } from 'vitest';
import { musicGainDb, musicVolume } from './gain.js';

describe('ganancia de la música (ADR-044)', () => {
  it('el track de referencia queda exactamente a 0.1', () => {
    expect(musicGainDb(-9.1, -9.1, 12)).toBe(0);
    expect(musicVolume(0)).toBe(0.1);
  });
  it('un track más fuerte baja y uno más suave sube', () => {
    expect(musicGainDb(-6.1, -9.1, 12)).toBe(-3);
    expect(musicVolume(-3)).toBeCloseTo(0.0708, 4);
    expect(musicGainDb(-15.1, -9.1, 12)).toBe(6);
  });
  it('tope de ±maxDb y sin medida no se toca', () => {
    expect(musicGainDb(-40, -9, 12)).toBe(12);
    expect(musicGainDb(0, -20, 12)).toBe(-12);
    expect(musicGainDb(undefined, -9, 12)).toBe(0);
    expect(musicGainDb(-9, undefined, 12)).toBe(0);
  });
});
