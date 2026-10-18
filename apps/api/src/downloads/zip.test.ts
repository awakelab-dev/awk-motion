import { describe, expect, it } from 'vitest';
import { safeName } from './zip.js';

describe('safeName', () => {
  it('deja nombres de archivo seguros y sin tildes', () => {
    expect(safeName('wilox_IAAS · Módulo 1')).toBe('wilox_IAAS_Modulo_1');
    expect(safeName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeName('')).toBe('wilox');
  });
});
