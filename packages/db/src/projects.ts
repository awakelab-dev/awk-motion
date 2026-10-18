import { UNCLASSIFIED_NAME, UNCLASSIFIED_SYSTEM } from '@wilox/shared';
import type { PrismaClient } from './generated/prisma/client.js';

type Tx = Pick<PrismaClient, 'project'>;

/**
 * "Sin clasificar" del usuario (hito 4, ADR-035): lo crea si falta y devuelve su id. La migración
 * `unclassified` lo crea para los usuarios que ya existían; los nuevos lo reciben al darse de alta.
 * El índice único (ownerId, system) garantiza uno solo por usuario aunque dos llamadas coincidan.
 */
export async function ensureUnclassified(db: Tx, ownerId: string): Promise<string> {
  const p = await db.project.upsert({
    where: { ownerId_system: { ownerId, system: UNCLASSIFIED_SYSTEM } },
    create: { ownerId, system: UNCLASSIFIED_SYSTEM, name: UNCLASSIFIED_NAME, description: 'Videos que aún no están en ningún proyecto.' },
    update: {},
    select: { id: true },
  });
  return p.id;
}
