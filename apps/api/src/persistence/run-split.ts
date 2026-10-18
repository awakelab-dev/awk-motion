import { Prisma, type Db } from '@wilox/db';
import type { InsertState, Shot } from '@wilox/shared';
import { shiftIndexPath, shiftKeys } from '../pipeline/split.js';

const nn = (n: number) => String(n).padStart(2, '0');

/** remoteRef de un fotograma: en modo API es "file:<ruta relativa>" (se corre); en MCP, un id de Higgsfield (no). */
const shiftRef = (ref: string | null, clip: number) => (ref?.startsWith('file:') ? `file:${shiftIndexPath(ref.slice(5), clip)}` : ref);

/**
 * «Dividir en dos» el clip `clip` (hito 10, T3, ADR-130), en la BD y en una sola transacción: los fotogramas K≥clip y
 * los clips ≥clip+1 corren su índice (con sus rutas, prompts, observaciones del cliente, esquinas del logo, portada e
 * insertos); se crean el fotograma intermedio K`clip` (pendiente) y el clip `clip`+1 (pendiente); el clip `clip` pasa a
 * una versión nueva pendiente; y se guardan los planos nuevos. Los archivos se renombran aparte, antes de esto.
 */
export async function renumberForSplit(
  db: Db,
  id: string,
  clip: number,
  o: { shots: Shot[]; keyframeLabel: string; keyframeTexts: string[]; newClipTitle: string },
): Promise<void> {
  await db.$transaction(
    async (tx) => {
      // Índices: en dos tiempos para no chocar con el índice único (generationId, index).
      await tx.$executeRaw`UPDATE "Keyframe" SET "index" = "index" + 1000 WHERE "generationId" = ${id} AND "index" >= ${clip}`;
      await tx.$executeRaw`UPDATE "Keyframe" SET "index" = "index" - 999 WHERE "generationId" = ${id} AND "index" >= 1000`;
      await tx.$executeRaw`UPDATE "Clip" SET "index" = "index" + 1000 WHERE "generationId" = ${id} AND "index" >= ${clip + 1}`;
      await tx.$executeRaw`UPDATE "Clip" SET "index" = "index" - 999 WHERE "generationId" = ${id} AND "index" >= 1000`;

      // Etiquetas y rutas de los fotogramas corridos.
      const kfs = await tx.keyframe.findMany({ where: { generationId: id, index: { gt: clip } }, include: { versions: true } });
      for (const k of kfs) {
        await tx.keyframe.update({ where: { id: k.id }, data: { label: k.label.replace(/^K\d{2}/, `K${nn(k.index)}`) } });
        for (const v of k.versions)
          await tx.keyframeVersion.update({ where: { id: v.id }, data: { path: v.path ? shiftIndexPath(v.path, clip) : v.path, remoteRef: shiftRef(v.remoteRef, clip) } });
      }
      const clips = await tx.clip.findMany({ where: { generationId: id, index: { gt: clip + 1 } }, include: { versions: true } });
      for (const c of clips) for (const v of c.versions) if (v.path) await tx.clipVersion.update({ where: { id: v.id }, data: { path: shiftIndexPath(v.path, clip) } });

      // El clip dividido: versión nueva pendiente (va de K(clip-1) al fotograma intermedio).
      const old = await tx.clip.findUniqueOrThrow({ where: { generationId_index: { generationId: id, index: clip } } });
      await tx.clip.update({
        where: { id: old.id },
        data: { version: old.version + 1, status: 'pending', taskId: null, note: null, error: null, startKeyVersion: null, endKeyVersion: null, deliveredFrames: null, ssimStart: null, ssimEnd: null },
      });
      // Fotograma intermedio (versión 0: la primera imagen será la v1) y clip nuevo (del intermedio al final).
      await tx.keyframe.create({ data: { generationId: id, index: clip, label: o.keyframeLabel, texts: o.keyframeTexts, prompt: '', status: 'pending', version: 0 } });
      await tx.clip.create({
        data: { generationId: id, index: clip + 1, title: o.newClipTitle, startFrame: old.startFrame, slotEndFrame: old.slotEndFrame, prompt: '', status: 'pending', version: 1, soundMode: old.soundMode },
      });

      // Prompts guardados (nombres con Knn / clipNN): en dos tiempos por el índice único (generationId, name).
      const prompts = await tx.prompt.findMany({ where: { generationId: id }, select: { id: true, name: true } });
      const moved = prompts.map((p) => ({ ...p, to: shiftIndexPath(p.name, clip) })).filter((p) => p.to !== p.name);
      for (const p of moved) await tx.prompt.update({ where: { id: p.id }, data: { name: `__split__${p.to}` } });
      for (const p of moved) await tx.prompt.update({ where: { id: p.id }, data: { name: p.to } });

      // Observaciones del cliente sobre fotogramas corridos y aprobaciones (versiones por fotograma).
      await tx.$executeRaw`UPDATE "ReviewComment" SET "keyframeIndex" = "keyframeIndex" + 1 WHERE "generationId" = ${id} AND "keyframeIndex" >= ${clip}`;
      const approvals = await tx.reviewComment.findMany({ where: { generationId: id, versions: { not: Prisma.DbNull } }, select: { id: true, versions: true } });
      for (const a of approvals)
        await tx.reviewComment.update({ where: { id: a.id }, data: { versions: shiftKeys(a.versions as Record<string, number>, clip) as Prisma.InputJsonValue } });

      // Entrega (esquina del logo por clip y portada) e insertos.
      const g = await tx.generation.findUniqueOrThrow({ where: { id }, select: { delivery: true, inserts: true } });
      const delivery = (g.delivery ?? undefined) as { clipCorners?: Record<string, string>; posterClip?: number; posterSec?: number } | undefined;
      let newDelivery: Prisma.InputJsonValue | typeof Prisma.DbNull = Prisma.DbNull;
      const d = { ...(delivery ?? {}) };
      const corners = shiftKeys(d.clipCorners, clip + 1);
      // El clip nuevo (segunda mitad) lleva la misma esquina que el clip que se divide.
      if (corners && d.clipCorners?.[String(clip)] !== undefined) corners[String(clip + 1)] = d.clipCorners[String(clip)];
      if (corners) d.clipCorners = corners;
      // La portada (último cuadro antes del congelado de un clip; sin elegir, el clip 1) pasa a la segunda mitad
      // si era la del clip dividido: ahí sigue estando el fotograma que se eligió.
      const poster = typeof d.posterClip === 'number' ? d.posterClip : 1;
      if (poster >= clip && (d.posterClip !== undefined || d.posterSec === undefined)) d.posterClip = poster + 1;
      if (Object.keys(d).length) newDelivery = d as unknown as Prisma.InputJsonValue;
      const inserts = (g.inserts ?? undefined) as InsertState[] | undefined;
      const newInserts = inserts?.map((x) => (x.after >= clip ? { ...x, after: x.after + 1 } : x));
      await tx.generation.update({
        where: { id },
        data: {
          delivery: newDelivery,
          inserts: newInserts?.length ? (newInserts as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          shots: o.shots as unknown as Prisma.InputJsonValue,
        },
      });
    },
    { timeout: 60_000 },
  );
}
