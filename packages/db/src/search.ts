import type { PrismaClient } from './generated/prisma/client.js';

/**
 * Búsqueda full-text en español sobre el texto de la locución (sin tildes: "infeccion" encuentra "infección").
 * Usa la columna "searchVector" que mantiene el trigger de la migración search. Devuelve ids ordenados por relevancia.
 * La sintaxis es la de websearch_to_tsquery: palabras sueltas (AND), "frase exacta", -excluir, OR.
 */
export async function searchGenerationIds(db: Pick<PrismaClient, '$queryRaw'>, projectIds: string[], query: string, limit = 200): Promise<string[]> {
  const q = query.trim();
  if (!q || !projectIds.length) return [];
  // Hito 11 (ADR-142): en los proyectos que el usuario ve (los suyos, compartidos y públicos), no por el dueño del video.
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Generation"
    WHERE "projectId" = ANY(${projectIds}::uuid[]) AND "searchVector" @@ wilox_search_query(${q})
    ORDER BY ts_rank("searchVector", wilox_search_query(${q})) DESC, "createdAt" DESC
    LIMIT ${limit}`;
  return rows.map((r) => r.id);
}
