/**
 * pnpm publications:restore (hito 10, ADR-139): recupera las direcciones públicas perdidas al despublicar.
 *
 * Hasta el ADR-139, «Despublicar» borraba la publicación con su token: aunque el video se volviera a publicar, la
 * dirección era otra y el código de Rise ya pegado en el curso quedaba en negro. Los documentos para Rise que siguen
 * en «Descargas» guardan esas direcciones (`…/publico/<token>/video.mp4`), en el orden de sus videos: con ellos se
 * vuelve a crear la publicación de cada video con su token de antes. La API la publica sola en el minuto siguiente.
 *   (sin flag)    solo lista: qué direcciones de Rise están vigentes, cuáles se perdieron y qué se haría
 *   --aplicar     recrea las publicaciones perdidas con su token (o revive la despublicada con ese token)
 *   --reemplazar  con --aplicar: si el video ya se volvió a publicar con otra dirección (misma calidad y logo), esa
 *                 publicación pasa a usar la dirección antigua (la nueva deja de responder)
 * No toca los videos en la papelera ni los eliminados: primero hay que restaurarlos.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDb, Prisma } from '@wilox/db';
import type { ExportQuality } from '@wilox/shared';
import { env } from '../src/config/env.js';
import { tokensOf, UNPUBLISHED, variantOf } from '../src/publications/variant.js';
import { MediaService } from '../src/storage/media.service.js';

const args = process.argv.slice(2);
const apply = args.includes('--aplicar');
const replace = args.includes('--reemplazar');
const db = createDb(env.DATABASE_URL);
const media = new MediaService(db);

interface Lost {
  token: string;
  generationId: string;
  ownerId: string;
  variant: string;
  quality: ExportQuality;
  logo: boolean;
  title: string;
  batch: string;
}

const short = (s: string) => (s.length > 70 ? `${s.slice(0, 68)}…` : s);

try {
  const batches = await db.downloadBatch.findMany({ where: { format: 'rise', status: 'ready' }, orderBy: { createdAt: 'asc' } });
  console.log(`Documentos para Rise en «Descargas»: ${batches.length}.`);
  const lost = new Map<string, Lost>();
  let live = 0;
  for (const b of batches) {
    const req = b.request as { quality: ExportQuality; logo: 'project' | 'none' };
    const skipped = new Set(((b.skipped ?? []) as { id: string }[]).map((x) => x.id));
    const ids = (b.videoIds as string[]).filter((id) => !skipped.has(id));
    const file = join(media.root, 'downloads', b.id, b.fileName);
    await media.ensure(file).catch(() => undefined);
    const doc = await readFile(file, 'utf8').catch(() => undefined);
    if (!doc) {
      console.log(`  · ${b.fileName} (${b.id}): el documento ya no está; se omite.`);
      continue;
    }
    const tokens = tokensOf(doc);
    if (tokens.length !== ids.length) {
      console.log(`  · ${b.fileName} (${b.id}): ${tokens.length} direcciones para ${ids.length} videos; no se puede emparejar, se omite.`);
      continue;
    }
    for (let i = 0; i < ids.length; i++) {
      const token = tokens[i];
      const row = await db.publication.findUnique({ where: { token }, select: { status: true } });
      if (row && row.status !== UNPUBLISHED) {
        live++;
        continue;
      }
      if (lost.has(token)) continue;
      const g = await db.generation.findUnique({ where: { id: ids[i] }, select: { id: true, ownerId: true, text: true } });
      if (!g) continue;
      lost.set(token, {
        token,
        generationId: g.id,
        ownerId: g.ownerId,
        variant: variantOf(req.quality, req.logo === 'project'),
        quality: req.quality,
        logo: req.logo === 'project',
        title: short(g.text.replace(/\s+/g, ' ').trim()),
        batch: b.fileName,
      });
    }
  }
  console.log(`Direcciones vigentes: ${live} · perdidas: ${lost.size}.`);
  let restored = 0;
  for (const l of lost.values()) {
    const g = await db.generation.findUnique({ where: { id: l.generationId }, select: { trashedAt: true, deletedAt: true, finalPath: true } });
    const head = `  · ${l.generationId} «${l.title}» (${l.variant}, de ${l.batch})`;
    if (!g || g.deletedAt) {
      console.log(`${head}: el video está eliminado definitivamente; no se recupera.`);
      continue;
    }
    if (g.trashedAt) {
      console.log(`${head}: el video está en la papelera; restáuralo y vuelve a lanzar el comando.`);
      continue;
    }
    if (!g.finalPath) {
      console.log(`${head}: el video no tiene final; no se puede publicar.`);
      continue;
    }
    const same = await db.publication.findUnique({ where: { generationId_variant: { generationId: l.generationId, variant: l.variant } }, select: { id: true, token: true, status: true } });
    if (same && same.status !== UNPUBLISHED && !replace) {
      console.log(`${head}: ya está publicado con otra dirección (${same.token}). Con --reemplazar pasa a la antigua (la nueva deja de responder).`);
      continue;
    }
    const what = !same ? 'se vuelve a publicar con su dirección de antes' : same.status === UNPUBLISHED ? 'la despublicada vuelve con su dirección de antes' : `pasa de ${same.token} a su dirección de antes`;
    if (!apply) {
      console.log(`${head}: ${what}.`);
      restored++;
      continue;
    }
    if (same) {
      if (same.status !== UNPUBLISHED) await media.unpublish(same.token);
      await db.publication.update({
        where: { id: same.id },
        data: { token: l.token, status: 'queued', error: null, files: Prisma.DbNull, source: Prisma.DbNull, bytes: null, publishedAt: null, uses: ['rise'] },
      });
    } else {
      await db.publication.create({
        data: {
          token: l.token,
          ownerId: l.ownerId,
          generationId: l.generationId,
          variant: l.variant,
          quality: l.quality as unknown as Prisma.InputJsonValue,
          logo: l.logo ? { mode: 'project' } : Prisma.DbNull,
          uses: ['rise'],
        },
      });
    }
    console.log(`${head}: ${what}. ✔`);
    restored++;
  }
  if (!apply) console.log(restored ? `Se recuperarían ${restored}. Para hacerlo: el mismo comando con --aplicar.` : 'No hay nada que recuperar.');
  else console.log(restored ? `RECUPERADAS ${restored}: la API las publica en los próximos minutos (de a una).` : 'No se recuperó nada.');
} finally {
  await db.$disconnect();
}
