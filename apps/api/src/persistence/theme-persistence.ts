import type { Db, Prisma } from '@wilox/db';
import type { StoredTheme, ThemeReference, ThemeStyle, ThemeTest, ThemeTestClip, ThemeTestFrame } from '@wilox/shared';

/**
 * Conversión entre StoredTheme (lo que usa el Estudio en memoria) y las tablas Theme, ThemeReference
 * y ThemeTest (hito 3, ADR-029). La usan el ThemeStore y el script de importación.
 */

type ThemeRow = Prisma.ThemeGetPayload<{ include: { references: true; tests: true } }>;

const json = (v: unknown) => v as Prisma.InputJsonValue;

/** Lo transitorio (qué está haciendo Opus o la cola) no se guarda: tras un reinicio se recalcula (ADR-013). */
function frameForDb(f: ThemeTestFrame): ThemeTestFrame {
  const { activity: _activity, ...rest } = f;
  return rest;
}

export function storedFromRow(row: ThemeRow): StoredTheme {
  return {
    id: row.id,
    ownerId: row.ownerId,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    brief: row.brief as unknown as StoredTheme['brief'],
    style: row.style as unknown as ThemeStyle,
    references: [...row.references]
      .sort((a, b) => a.position - b.position)
      .map((r): ThemeReference => ({ file: r.file, originalName: r.originalName, mediaId: r.mediaId ?? undefined })),
    basedOn: row.basedOn ?? undefined,
    thumbnailTest: row.thumbnailTest ?? undefined,
    proposalNotes: row.proposalNotes ?? undefined,
    tests: [...row.tests]
      .sort((a, b) => a.n - b.n)
      .map(
        (t): ThemeTest => ({
          n: t.n,
          createdAt: t.createdAt.toISOString(),
          status: t.status as ThemeTest['status'],
          message: t.message,
          themeVersion: t.themeVersion,
          frames: t.frames as unknown as ThemeTestFrame[],
          withClip: t.withClip,
          clip: t.clip as unknown as ThemeTestClip,
          reviewSummary: t.reviewSummary ?? undefined,
          suggestions: (t.suggestions as unknown as ThemeTest['suggestions']) ?? undefined,
          error: t.error ?? undefined,
        }),
      ),
  };
}

export const THEME_INCLUDE = { references: true, tests: true } as const;

export async function loadThemes(db: Db): Promise<StoredTheme[]> {
  const rows = await db.theme.findMany({ where: { deletedAt: null }, include: THEME_INCLUDE });
  return rows.map(storedFromRow);
}

/**
 * Escribe el tema completo (upsert del tema, sus referencias y sus pruebas) en una transacción.
 * `snapshots`: copia del ThemeStyle de cada prueba nueva (theme.snapshot.json); si falta, el estilo actual.
 */
export async function persistTheme(
  db: Db,
  t: StoredTheme,
  opts: { ownerId: string; dir: string; snapshots?: Map<number, ThemeStyle>; deletedAt?: Date },
): Promise<void> {
  const base = {
    ownerId: opts.ownerId,
    status: t.status,
    version: t.version,
    brief: json(t.brief),
    style: json(t.style),
    basedOn: t.basedOn ?? null,
    thumbnailTest: t.thumbnailTest ?? null,
    proposalNotes: t.proposalNotes ?? null,
    dir: opts.dir,
    updatedAt: new Date(t.updatedAt),
    deletedAt: opts.deletedAt ?? null,
  };
  const files = t.references.map((r) => r.file);
  await db.$transaction(async (tx) => {
    await tx.theme.upsert({ where: { id: t.id }, create: { id: t.id, createdAt: new Date(t.createdAt), ...base }, update: base });
    await tx.themeReference.deleteMany({ where: { themeId: t.id, file: { notIn: files } } });
    for (const [position, r] of t.references.entries()) {
      const data = { originalName: r.originalName, position, mediaId: r.mediaId ?? null };
      await tx.themeReference.upsert({
        where: { themeId_file: { themeId: t.id, file: r.file } },
        create: { themeId: t.id, file: r.file, ...data },
        update: data,
      });
    }
    for (const test of t.tests) {
      const data = {
        status: test.status,
        message: test.message,
        themeVersion: test.themeVersion,
        frames: json(test.frames.map(frameForDb)),
        withClip: test.withClip,
        clip: json(test.clip),
        reviewSummary: test.reviewSummary ?? null,
        suggestions: test.suggestions ? json(test.suggestions) : undefined,
        error: test.error ?? null,
      };
      await tx.themeTest.upsert({
        where: { themeId_n: { themeId: t.id, n: test.n } },
        create: { themeId: t.id, n: test.n, createdAt: new Date(test.createdAt), snapshot: json(opts.snapshots?.get(test.n) ?? t.style), ...data },
        update: data,
      });
    }
  });
}
