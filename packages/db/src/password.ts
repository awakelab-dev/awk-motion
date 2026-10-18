import { hash, verify } from '@node-rs/argon2';

/** Parámetros argon2id (mínimo recomendado por OWASP: 19 MiB, 2 pasadas, 1 hilo). */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export const MIN_PASSWORD_LENGTH = 10;

/** Hash argon2id en formato PHC ($argon2id$v=19$m=19456,t=2,p=1$…). */
export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/** Compara en tiempo constante; un hash ilegible cuenta como contraseña incorrecta. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export function passwordProblem(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  if (password.trim() !== password) return 'La contraseña no puede empezar ni terminar con espacios.';
  return undefined;
}
