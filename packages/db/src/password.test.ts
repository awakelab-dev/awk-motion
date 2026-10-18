import { describe, expect, it } from 'vitest';
import { hashPassword, passwordProblem, verifyPassword } from './password.js';

describe('contraseñas', () => {
  it('usa argon2id y verifica', async () => {
    const h = await hashPassword('una-clave-larga');
    expect(h.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    expect(await verifyPassword(h, 'una-clave-larga')).toBe(true);
    expect(await verifyPassword(h, 'otra-clave-larga')).toBe(false);
    expect(await verifyPassword('basura', 'una-clave-larga')).toBe(false);
  });
  it('exige un mínimo', () => {
    expect(passwordProblem('corta')).toBeDefined();
    expect(passwordProblem(' con-espacio-al-inicio')).toBeDefined();
    expect(passwordProblem('suficientemente-larga')).toBeUndefined();
  });
});
