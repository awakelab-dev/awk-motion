import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// El .env vive en la raíz del monorepo (los scripts corren desde packages/db o desde la raíz).
const envFile = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')].find((f) => existsSync(f));
if (envFile) loadDotenv({ path: envFile, quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // `prisma generate` no necesita la BD; migrate sí (y falla con un mensaje claro si falta).
    url: process.env.DATABASE_URL ?? '',
  },
});
