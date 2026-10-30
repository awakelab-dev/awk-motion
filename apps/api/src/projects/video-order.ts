import type { Db } from '@wilox/db';

/**
 * Orden de los videos dentro de un proyecto (hito 12, ADR-162): `Generation.sortKey`, de menor a mayor (y por fecha e
 * id si coinciden). Nace con la hora de creación y se cambia a mano, de a un lugar. Va por SQL: la columna no se usa
 * desde el cliente de Prisma.
 */
export async function videoSequence(db: Db, projectId: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Generation"
    WHERE "projectId" = ${projectId}::uuid AND "trashedAt" IS NULL AND "deletedAt" IS NULL
    ORDER BY "sortKey", "createdAt", id`;
  return rows.map((r) => r.id);
}

export type MoveDirection = 'earlier' | 'later';

/**
 * Cambia un video de lugar con el de al lado («antes» o «después») en su proyecto. Devuelve el id del vecino, o
 * undefined si ya está en el extremo.
 */
export async function moveVideo(db: Db, id: string, direction: MoveDirection): Promise<string | undefined> {
  const g = await db.generation.findUnique({ where: { id }, select: { projectId: true } });
  if (!g) return undefined;
  const rows = await db.$queryRaw<{ id: string; sortKey: number }[]>`
    SELECT id, "sortKey" FROM "Generation"
    WHERE "projectId" = ${g.projectId}::uuid AND "trashedAt" IS NULL AND "deletedAt" IS NULL
    ORDER BY "sortKey", "createdAt", id`;
  const i = rows.findIndex((r) => r.id === id);
  const j = direction === 'earlier' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= rows.length) return undefined;
  const a = rows[i];
  const b = rows[j];
  // Se intercambian sus lugares; si tienen el mismo (raro), el que se mueve queda justo antes o después del otro.
  const [ka, kb] = a.sortKey !== b.sortKey ? [b.sortKey, a.sortKey] : [b.sortKey + (direction === 'earlier' ? -0.001 : 0.001), b.sortKey];
  await db.$transaction([
    db.$executeRaw`UPDATE "Generation" SET "sortKey" = ${ka} WHERE id = ${a.id}`,
    db.$executeRaw`UPDATE "Generation" SET "sortKey" = ${kb} WHERE id = ${b.id}`,
  ]);
  return b.id;
}

/** Al final de su proyecto (p. ej. al moverlo a otro proyecto). */
export async function sendToEnd(db: Db, id: string): Promise<void> {
  await db.$executeRaw`UPDATE "Generation" SET "sortKey" = date_part('epoch'::text, now()) WHERE id = ${id}`;
}
