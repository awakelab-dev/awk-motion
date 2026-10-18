import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

/** Raíz del monorepo (packages/db/{src,dist} → ../../..). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Carga el .env de la raíz si DATABASE_URL no está ya en el entorno (scripts sueltos de packages/db). */
export function loadRootEnv(): void {
  if (process.env.DATABASE_URL) return;
  const f = resolve(REPO_ROOT, '.env');
  if (existsSync(f)) loadDotenv({ path: f, quiet: true });
}
