import { isAbsolute, join, relative, sep } from 'node:path';
import { Prisma, type Db } from '@wilox/db';
import type { ClipState, KeyframeState, ParagraphState, RunLogEntry, RunState, Shot, Storyboard, ThemeStyle } from '@wilox/shared';
import type { TimedWord } from '@wilox/prompts';
import type { PlannedClip } from '../pipeline/timeline.js';
import type { RunData } from './run-data.js';

/**
 * Generaciones en la BD (hito 3, ADR-031): Generation + Paragraph + Keyframe/KeyframeVersion +
 * Clip/ClipVersion + LogEntry. Las rutas se guardan relativas a la carpeta de la generación.
 * La usan el RunStore (escritura en serie) y el script de importación.
 */

const nn = (i: number) => String(i).padStart(2, '0');
const json = (v: unknown) => (v === undefined ? undefined : (v as Prisma.InputJsonValue));
const FILE_REF = 'file:';

/** Ruta relativa a la carpeta de la generación (acepta rutas absolutas de otra máquina: …/runs/<id>/…). */
export function relInRun(dir: string, id: string, p: string): string {
  if (!isAbsolute(p)) return p;
  if (p.startsWith(dir + sep)) return relative(dir, p).split(sep).join('/');
  const marker = `/runs/${id}/`;
  const i = p.split('\\').join('/').indexOf(marker);
  return i >= 0 ? p.split('\\').join('/').slice(i + marker.length) : p;
}

/** Referencia remota (job_id / media_id) o, en modo API, la ruta local guardada como "file:<relativa>". */
function refForDb(dir: string, id: string, ref: string): string | null {
  if (!ref) return null;
  return isAbsolute(ref) ? FILE_REF + relInRun(dir, id, ref) : ref;
}
function refFromDb(dir: string, ref: string | null): string {
  if (!ref) return '';
  return ref.startsWith(FILE_REF) ? join(dir, ref.slice(FILE_REF.length)) : ref;
}

export const fileUrlFor = (id: string, rel: string, v?: number | string) =>
  `/api/generations/${id}/files/${rel.split('\\').join('/')}${v !== undefined ? `?v=${v}` : ''}`;

/** Caché de lo último escrito por fila: solo se reescriben las filas que cambiaron. */
export type WriteCache = Map<string, string>;

export interface PersistOpts {
  /** Carpeta relativa a STORAGE_DIR (runs/<id>). */
  relDir: string;
  /** Obligatorio desde el hito 4 (ADR-035). */
  projectId: string;
  parentId?: string | null;
  /** LogEntry nuevas desde la última escritura. */
  newLogs?: RunLogEntry[];
  cache?: WriteCache;
  /** Solo al importar: fecha de creación de la fila. */
  createdAt?: Date;
}

function changed(cache: WriteCache | undefined, key: string, value: unknown): boolean {
  if (!cache) return true;
  const s = JSON.stringify(value);
  if (cache.get(key) === s) return false;
  cache.set(key, s);
  return true;
}

/** Escribe la generación en una transacción (solo lo que cambió, si hay caché). */
export async function persistRun(db: Db, d: RunData, o: PersistOpts): Promise<void> {
  const s = d.state;
  const rel = (p: string | undefined) => (p ? relInRun(d.dir, s.id, p) : null);
  const fromUrl = (u: string | undefined) => (u ? decodeURIComponent(u.split('/files/')[1]?.split('?')[0] ?? '') || null : null);
  const gen = {
    ownerId: d.ownerId,
    mode: s.mode,
    themeKey: s.theme,
    themeId: null as string | null,
    themeName: s.themeName ?? null,
    themeCopy: json({ style: d.theme, references: d.themeRefs.map((r) => ({ path: r.path, ref: r.ref ? refForDb(d.dir, s.id, r.ref) : undefined, ...(r.typography ? { typography: true } : {}) })) })!,
    voiceId: s.voiceId,
    musicTrack: s.musicTrack ?? null,
    soundMode: s.soundMode ?? null,
    soundGainDb: s.soundGainDb ?? 0,
    voiceMode: s.voiceMode ?? null,
    script: s.script ? json(s.script) : Prisma.DbNull,
    inserts: s.inserts?.length ? json(s.inserts)! : Prisma.DbNull,
    text: s.text,
    status: s.status,
    message: s.message ?? '',
    error: s.error ?? null,
    approved: d.approved,
    durationSec: s.durationSec ?? null,
    totalFrames: s.totalFrames ?? null,
    voicePath: fromUrl(s.voiceUrl),
    finalPath: fromUrl(s.finalUrl),
    finalFrames: s.finalFrames ?? null,
    // Hito 11 (ADR-145): los créditos ya no se escriben (las columnas quedan con lo de antes, sin uso).
    words: json(d.words),
    storyboard: json(d.storyboard),
    plan: json(d.plan),
    shots: json(d.shots),
    dir: o.relDir,
    projectId: o.projectId,
    parentId: o.parentId ?? null,
  };
  const c = o.cache;
  await db.$transaction(
    async (tx) => {
      if (changed(c, 'gen', gen)) {
        // themeId: FK solo si el tema del Estudio sigue existiendo.
        const themeRow = await tx.theme.findUnique({ where: { id: s.theme }, select: { id: true } });
        const data = { ...gen, themeId: themeRow?.id ?? null };
        await tx.generation.upsert({
          where: { id: s.id },
          create: { id: s.id, createdAt: o.createdAt ?? new Date(s.createdAt), ...data },
          update: data,
        });
      }
      for (const p of s.paragraphs as ParagraphState[]) {
        const data = { text: p.text, startSec: p.startSec, durationSec: p.durationSec, version: p.version ?? 1, spokenText: p.spokenText ?? null };
        if (!changed(c, `p${p.index}`, data)) continue;
        await tx.paragraph.upsert({
          where: { generationId_index: { generationId: s.id, index: p.index } },
          create: { generationId: s.id, index: p.index, ...data },
          update: data,
        });
      }
      for (const k of s.keyframes as KeyframeState[]) {
        const asset = d.keyAssets.get(k.index);
        const current = asset && asset.path.endsWith(`K${nn(k.index)}_v${k.version}.png`) ? asset : undefined;
        const row = { label: k.label, texts: k.texts, prompt: k.prompt, status: k.status, version: k.version, error: k.error ?? null, review: json(k.review), pending: json(k.pending), previous: json(k.previous) };
        const ver = { path: current ? rel(current.path) : null, prompt: k.prompt, remoteRef: current ? refForDb(d.dir, s.id, current.ref) : null };
        const rowChanged = changed(c, `k${k.index}`, row);
        const verChanged = changed(c, `k${k.index}v${k.version}`, ver);
        if (!rowChanged && !verChanged) continue;
        const kf = await tx.keyframe.upsert({
          where: { generationId_index: { generationId: s.id, index: k.index } },
          create: { generationId: s.id, index: k.index, ...row, review: row.review ?? undefined, pending: row.pending ?? undefined, previous: row.previous ?? undefined },
          update: { ...row, review: row.review ?? Prisma.DbNull, pending: row.pending ?? Prisma.DbNull, previous: row.previous ?? Prisma.DbNull },
          select: { id: true },
        });
        if (verChanged)
          await tx.keyframeVersion.upsert({
            where: { keyframeId_version: { keyframeId: kf.id, version: k.version } },
            create: { keyframeId: kf.id, version: k.version, ...ver },
            // Una versión anterior nunca pierde su archivo: solo se completa.
            update: { prompt: ver.prompt, ...(ver.path ? { path: ver.path, remoteRef: ver.remoteRef } : {}) },
          });
      }
      for (const cl of s.clips as ClipState[]) {
        const raw = d.clipRaw.get(cl.index);
        const current = raw && raw.endsWith(`clip${nn(cl.index)}_ia_v${cl.version}.mp4`) ? raw : undefined;
        const row = {
          title: cl.title,
          startFrame: cl.startFrame,
          slotEndFrame: cl.slotEndFrame,
          prompt: cl.prompt,
          status: cl.status,
          version: cl.version,
          deliveredFrames: cl.deliveredFrames ?? null,
          ssimStart: cl.ssimStart ?? null,
          ssimEnd: cl.ssimEnd ?? null,
          error: cl.error ?? null,
          startKeyVersion: cl.builtWith?.[0] ?? null,
          endKeyVersion: cl.builtWith?.[1] ?? null,
          note: cl.note ?? null,
          taskId: cl.taskId ?? null,
          soundMode: cl.soundMode ?? null,
          soundLufs: cl.soundLufs ?? null,
        };
        const ver = { path: current ? rel(current) : null, prompt: cl.prompt };
        const rowChanged = changed(c, `c${cl.index}`, row);
        const verChanged = changed(c, `c${cl.index}v${cl.version}`, ver);
        if (!rowChanged && !verChanged) continue;
        const clip = await tx.clip.upsert({
          where: { generationId_index: { generationId: s.id, index: cl.index } },
          create: { generationId: s.id, index: cl.index, ...row },
          update: row,
          select: { id: true },
        });
        if (verChanged)
          await tx.clipVersion.upsert({
            where: { clipId_version: { clipId: clip.id, version: cl.version } },
            create: { clipId: clip.id, version: cl.version, ...ver },
            update: { prompt: ver.prompt, ...(ver.path ? { path: ver.path } : {}) },
          });
      }
      if (o.newLogs?.length)
        await tx.logEntry.createMany({
          data: o.newLogs.map((l) => ({ generationId: s.id, at: new Date(l.at), level: l.level, message: l.message })),
        });
    },
    { timeout: 30_000 },
  );
}

export const RUN_INCLUDE = {
  paragraphs: { orderBy: { index: 'asc' } },
  keyframes: { orderBy: { index: 'asc' }, include: { versions: true } },
  clips: { orderBy: { index: 'asc' }, include: { versions: true } },
} as const satisfies Prisma.GenerationInclude;

type GenerationRow = Prisma.GenerationGetPayload<{ include: typeof RUN_INCLUDE }>;

/** Reconstruye la generación (estado + datos internos) desde sus filas. `dir`: carpeta absoluta. */
export async function loadRun(db: Db, id: string, dirOf: (relDir: string) => string): Promise<(RunData & { projectId: string; parentId: string | null }) | undefined> {
  const g: GenerationRow | null = await db.generation.findUnique({ where: { id }, include: RUN_INCLUDE });
  if (!g) return undefined;
  const dir = dirOf(g.dir);
  const logs = await db.logEntry.findMany({ where: { generationId: id }, orderBy: { id: 'desc' }, take: 300 });
  const keyAssets = new Map<number, { ref: string; path: string }>();
  const clipRaw = new Map<number, string>();
  const keyframes: KeyframeState[] = g.keyframes.map((k) => {
    const v = k.versions.find((x) => x.version === k.version);
    if (v?.path) keyAssets.set(k.index, { ref: refFromDb(dir, v.remoteRef), path: join(dir, v.path) });
    return {
      index: k.index,
      label: k.label,
      texts: k.texts ?? [],
      prompt: k.prompt,
      status: k.status,
      version: k.version,
      url: v?.path ? fileUrlFor(id, v.path, k.version) : undefined,
      error: k.error ?? undefined,
      review: (k.review as KeyframeState['review']) ?? undefined,
      pending: (k.pending as KeyframeState['pending']) ?? undefined,
      previous: (k.previous as unknown as KeyframeState['previous']) ?? undefined,
    };
  });
  const clips: ClipState[] = g.clips.map((c) => {
    const v = c.versions.find((x) => x.version === c.version);
    if (v?.path) clipRaw.set(c.index, join(dir, v.path));
    return {
      index: c.index,
      title: c.title,
      startFrame: c.startFrame,
      slotEndFrame: c.slotEndFrame,
      prompt: c.prompt,
      status: c.status,
      version: c.version,
      url: v?.path ? fileUrlFor(id, v.path, c.version) : undefined,
      deliveredFrames: c.deliveredFrames ?? undefined,
      ssimStart: c.ssimStart ?? undefined,
      ssimEnd: c.ssimEnd ?? undefined,
      error: c.error ?? undefined,
      builtWith: c.startKeyVersion != null && c.endKeyVersion != null ? [c.startKeyVersion, c.endKeyVersion] : undefined,
      note: c.note ?? undefined,
      taskId: c.taskId ?? undefined,
      soundMode: (c.soundMode as ClipState['soundMode']) ?? undefined,
      soundLufs: c.soundLufs,
    };
  });
  const copy = g.themeCopy as unknown as { style: ThemeStyle; references?: { path: string; ref?: string; typography?: boolean }[] };
  const state: RunState = {
    id: g.id,
    createdAt: g.createdAt.toISOString(),
    mode: g.mode,
    projectId: g.projectId,
    parentId: g.parentId,
    theme: g.themeKey,
    themeName: g.themeName ?? undefined,
    voiceId: g.voiceId,
    musicTrack: g.musicTrack,
    soundMode: (g.soundMode as RunState['soundMode']) ?? undefined,
    soundGainDb: g.soundGainDb || undefined,
    voiceMode: (g.voiceMode as RunState['voiceMode']) ?? undefined,
    script: (g.script as unknown as RunState['script']) ?? undefined,
    text: g.text,
    status: g.status,
    message: g.message,
    paragraphs: g.paragraphs.map((p) => ({
      index: p.index,
      text: p.text,
      startSec: p.startSec,
      durationSec: p.durationSec,
      version: p.version,
      spokenText: p.spokenText ?? undefined,
    })),
    voiceUrl: g.voicePath ? fileUrlFor(id, g.voicePath) : undefined,
    durationSec: g.durationSec ?? undefined,
    totalFrames: g.totalFrames ?? undefined,
    keyframes,
    clips,
    inserts: (g.inserts as unknown as RunState['inserts']) ?? undefined,
    finalUrl: g.finalPath ? fileUrlFor(id, g.finalPath, g.updatedAt.getTime()) : undefined,
    finalFrames: g.finalFrames ?? undefined,
    log: logs.reverse().map((l) => ({ at: l.at.toISOString(), level: l.level, message: l.message })),
    error: g.error ?? undefined,
  };
  return {
    state,
    dir,
    ownerId: g.ownerId,
    theme: copy.style,
    themeRefs: (copy.references ?? []).map((r) => ({ path: r.path, ref: r.ref ? refFromDb(dir, r.ref) : undefined, ...(r.typography ? { typography: true } : {}) })),
    approved: g.approved,
    words: (g.words as unknown as TimedWord[]) ?? undefined,
    storyboard: (g.storyboard as unknown as Storyboard) ?? undefined,
    plan: (g.plan as unknown as PlannedClip[]) ?? undefined,
    shots: (g.shots as unknown as Shot[]) ?? undefined,
    keyAssets,
    clipRaw,
    projectId: g.projectId,
    parentId: g.parentId,
  };
}
