import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { loadRootEnv } from './env.js';

export * from './generated/prisma/client.js';
export { loadRootEnv, REPO_ROOT } from './env.js';
export { hashPassword, verifyPassword, passwordProblem, MIN_PASSWORD_LENGTH } from './password.js';
export { searchGenerationIds } from './search.js';
export { ensureUnclassified } from './projects.js';
export { visibleProjects, visibleGenerations, projectRole, type Viewer } from './access.js';

export type Db = PrismaClient;

/** Cliente de Prisma 7 con el adaptador de node-postgres. La URL sale de DATABASE_URL (.env de la raíz). */
export function createDb(url?: string): PrismaClient {
  if (!url) loadRootEnv();
  const connectionString = url ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Falta DATABASE_URL en el .env de la raíz (ver .env.example).');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
