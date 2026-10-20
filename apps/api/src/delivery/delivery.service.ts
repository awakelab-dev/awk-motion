import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Prisma, type Db } from '@wilox/db';
import {
  DEFAULT_LOGO_SETTINGS,
  FPS,
  LOGO_CORNERS,
  LOGO_EFFECTS,
  type ClipLogo,
  type DeliveryClip,
  type InsertState,
  type DownloadLogo,
  type DownloadRequest,
  type ExportQuality,
  type PackageStatus,
  isOriginalQuality,
  type LogoCorner,
  type LogoInfo,
  type LogoSettings,
  type ProjectDelivery,
  type VideoDelivery,
  type VideoDeliveryOverride,
} from '@wilox/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ZipArchive } from 'archiver';
import { z } from 'zod';
import { env, repoPath } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { ffmpeg } from '../media/ffmpeg.js';
import { buildCues, toSrt, toVtt, type SubtitleWord } from './subtitles.js';
import { clipShift, compose, finalCues, transitionFirst, transitionFrames } from '../pipeline/inserts.js';
import { videoFrames, type PlannedClip } from '../pipeline/timeline.js';
import { playerFiles, playerHtml, type PlayerCue, type PlayerOptions } from './player.js';
import { scormManifest, type ScormItem, type ScormVersion } from './scorm.js';
import { MediaService } from '../storage/media.service.js';
import { ExportsService } from './exports.service.js';

/** Lo que se guarda en Project.delivery. */
interface StoredLogo {
  file: string;
  mime: 'image/png' | 'image/svg+xml';
  width?: number;
  height?: number;
  fileName: string;
  version: number;
}
interface StoredProjectDelivery {
  logo?: StoredLogo;
  settings?: Partial<LogoSettings>;
}


/** Logo superpuesto a un video, como lo dibuja el reproductor (ADR-066/067). */
export interface LogoOverlay {
  logo: string;
  settings: LogoSettings;
  clips: { index: number; start: number; end: number }[];
  clipCorners: Record<string, ClipLogo>;
}
export const LogoSettingsSchema = z.object({
  corner: z.enum(LOGO_CORNERS as [string, ...string[]]).optional(),
  widthPct: z.number().min(2).max(40).optional(),
  marginPct: z.number().min(0).max(10).optional(),
  effect: z.enum(LOGO_EFFECTS as [string, ...string[]]).optional(),
  opacity: z.number().min(0.1).max(1).optional(),
});

const MAX_LOGO_BYTES = 5 * 1024 * 1024;

/** Ajustes completos: los por defecto, los del proyecto y el ajuste del video, en ese orden. */
export function mergeSettings(...layers: (Partial<LogoSettings> | undefined)[]): LogoSettings {
  const out = { ...DEFAULT_LOGO_SETTINGS };
  for (const l of layers) if (l) for (const [k, v] of Object.entries(l)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Ancho y alto de un PNG (cabecera IHDR) o de un SVG (width/height o viewBox). */
export function logoSize(buf: Buffer, mime: StoredLogo['mime']): { width?: number; height?: number } {
  if (mime === 'image/png') return buf.length > 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : {};
  const svg = buf.toString('utf8');
  const vb = svg.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  const w = svg.match(/<svg[^>]*\swidth\s*=\s*["']([\d.]+)/i);
  const h = svg.match(/<svg[^>]*\sheight\s*=\s*["']([\d.]+)/i);
  if (w && h) return { width: Number(w[1]), height: Number(h[1]) };
  if (vb) return { width: Number(vb[1]), height: Number(vb[2]) };
  return {};
}

/**
 * Limpia un SVG subido: sin scripts, sin manejadores de eventos, sin javascript: ni referencias externas.
 * (En el reproductor va como <img>, donde un SVG no ejecuta nada; se limpia igual.)
 */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href)\s*=\s*("|')\s*(javascript:|https?:|\/\/)[^"']*\2/gi, '');
}

/** Opciones del reproductor de un video (vista previa, un solo .html o paquete). */
export interface PlayerRequest {
  videoSrc?: string;
  embed?: boolean;
  preview?: boolean;
  settings?: Partial<LogoSettings>;
  posterSec?: number;
  /** Ancho de la portada (por defecto 1600 px; menos en las descargas de baja resolución, ADR-085). */
  posterWidth?: number;
  /** Video que va dentro del HTML (`embed`): la versión reducida de la descarga (ADR-085); sin el campo, el final. */
  videoPath?: string;
  logoDataUrl?: string | null;
  scorm?: ScormVersion;
  /** Una esquina para todos los clips (ADR-067); los que van sin logo siguen sin logo. */
  cornerAll?: LogoCorner;
  /** Link para compartir (ADR-083): subtítulos encendidos y sin indexar. */
  share?: boolean;
}

/** Agrega los archivos de un reproductor a un ZIP, bajo `folder` ('' = raíz). Imágenes sin comprimir. */
export function appendFiles(zip: ZipArchive, folder: string, files: Record<string, string | Buffer>) {
  for (const [name, data] of Object.entries(files)) zip.append(data, { name: folder ? `${folder}/${name}` : name, store: /\.(jpe?g|png)$/i.test(name) });
}

/** Una esquina para todos los clips de una descarga (ADR-067): los que van sin logo siguen sin logo. */
export function allCorners(clips: { index: number }[], current: Record<string, ClipLogo>, corner: LogoCorner): Record<string, ClipLogo> {
  return Object.fromEntries(clips.map((c) => [String(c.index), current[String(c.index)] === 'none' ? 'none' : corner]));
}

/** Valida un logo (PNG o SVG, hasta 5 MB) y limpia el SVG. */
export function parseLogo(buf: Buffer): { content: Buffer; mime: StoredLogo['mime'] } {
  if (!buf.length) throw new BadRequestException('El archivo está vacío.');
  if (buf.length > MAX_LOGO_BYTES) throw new BadRequestException('El logo pesa más de 5 MB.');
  const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isSvg = !isPng && /<svg[\s>]/i.test(buf.subarray(0, 4096).toString('utf8'));
  if (!isPng && !isSvg) throw new BadRequestException('El logo debe ser un PNG o un SVG.');
  return isPng ? { content: buf, mime: 'image/png' } : { content: Buffer.from(sanitizeSvg(buf.toString('utf8')), 'utf8'), mime: 'image/svg+xml' };
}

/**
 * Entrega (hito 6, ADR-065): logo del proyecto, ajustes, portada y reproductor HTML de cada video.
 */
@Injectable()
export class DeliveryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly exports: ExportsService,
    private readonly media: MediaService,
  ) {}

  private projectDir(id: string) {
    return join(repoPath(env.STORAGE_DIR), 'projects', id);
  }

  private async projectRow(id: string, _ownerId: string) {
    // Hito 11 (ADR-142): el acceso ya lo comprobó quien llama (guard de projects/:id y generations/:id o el servicio de
    // acceso); `ownerId` queda por compatibilidad y no filtra (un video puede ser de otro usuario del proyecto).
    const p = /^[0-9a-f-]{36}$/i.test(id) ? await this.db.project.findFirst({ where: { id }, select: { id: true, name: true, delivery: true } }) : null;
    if (!p) throw new NotFoundException('Proyecto no encontrado.');
    return p;
  }

  private logoInfo(projectId: string, l: StoredLogo | undefined): LogoInfo | undefined {
    if (!l) return undefined;
    return { url: `/api/projects/${projectId}/logo?v=${l.version}`, mime: l.mime, width: l.width, height: l.height, fileName: l.fileName };
  }

  async project(id: string, ownerId: string): Promise<ProjectDelivery> {
    const p = await this.projectRow(id, ownerId);
    const d = (p.delivery ?? {}) as StoredProjectDelivery;
    return { logo: this.logoInfo(p.id, d.logo), settings: mergeSettings(d.settings) };
  }

  async setProjectSettings(id: string, ownerId: string, settings: Partial<LogoSettings>): Promise<ProjectDelivery> {
    const p = await this.projectRow(id, ownerId);
    const d = (p.delivery ?? {}) as StoredProjectDelivery;
    d.settings = mergeSettings(d.settings, settings);
    await this.db.project.update({ where: { id }, data: { delivery: d as unknown as Prisma.InputJsonValue } });
    return this.project(id, ownerId);
  }

  /** Sube el logo del proyecto (PNG o SVG con transparencia, hasta 5 MB). Las versiones anteriores se conservan. */
  async setLogo(id: string, ownerId: string, fileName: string, base64: string): Promise<ProjectDelivery> {
    const p = await this.projectRow(id, ownerId);
    const { content, mime } = parseLogo(Buffer.from(base64.replace(/^data:[^,]+,/, ''), 'base64'));
    const isPng = mime === 'image/png';
    const d = (p.delivery ?? {}) as StoredProjectDelivery;
    const version = (d.logo?.version ?? 0) + 1;
    const file = `logo_v${version}.${isPng ? 'png' : 'svg'}`;
    await mkdir(this.projectDir(id), { recursive: true });
    await writeFile(join(this.projectDir(id), file), content);
    this.media.dirty(this.projectDir(id));
    d.logo = { file, mime, fileName: fileName.slice(0, 120), version, ...logoSize(content, mime) };
    await this.db.project.update({ where: { id }, data: { delivery: d as unknown as Prisma.InputJsonValue } });
    return this.project(id, ownerId);
  }

  async removeLogo(id: string, ownerId: string): Promise<ProjectDelivery> {
    const p = await this.projectRow(id, ownerId);
    const d = (p.delivery ?? {}) as StoredProjectDelivery;
    delete d.logo;
    await this.db.project.update({ where: { id }, data: { delivery: d as unknown as Prisma.InputJsonValue } });
    return this.project(id, ownerId);
  }

  /** Archivo del logo vigente del proyecto. */
  async logoFile(id: string, ownerId: string): Promise<{ path: string; mime: string } | undefined> {
    const p = await this.projectRow(id, ownerId);
    const l = ((p.delivery ?? {}) as StoredProjectDelivery).logo;
    if (!l) return undefined;
    const path = join(this.projectDir(id), l.file);
    await this.media.ensure(path);
    return existsSync(path) ? { path, mime: l.mime } : undefined;
  }

  /** Nombre del proyecto y sus videos con final (en orden de creación), para el SCORM del proyecto. */
  async projectVideos(id: string, ownerId: string): Promise<{ name: string; ids: string[] }> {
    const p = await this.projectRow(id, ownerId);
    const gens = await this.db.generation.findMany({ where: { projectId: id, finalPath: { not: null }, trashedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    return { name: p.name, ids: gens.map((g) => g.id) };
  }

  // ─── Videos ────────────────────────────────────────────────────────────────────────────────────────

  private async generation(id: string, _ownerId: string) {
    // Hito 11 (ADR-142): el acceso ya lo comprobó quien llama (guard de projects/:id y generations/:id o el servicio de
    // acceso); `ownerId` queda por compatibilidad y no filtra (un video puede ser de otro usuario del proyecto).
    const g = await this.db.generation.findFirst({
      where: { id },
      include: {
        project: { select: { id: true, name: true, delivery: true } },
        paragraphs: { orderBy: { index: 'asc' }, select: { text: true } },
        clips: { orderBy: { index: 'asc' }, select: { index: true, title: true, startFrame: true, slotEndFrame: true, deliveredFrames: true } },
      },
    });
    if (!g) throw new NotFoundException('Video no encontrado.');
    return g;
  }

  private dirOf(g: { dir: string }) {
    return join(repoPath(env.STORAGE_DIR), g.dir);
  }

  /** Último fotograma de un clip (antes de su congelado): ahí ya está todo dibujado (ADR-067). */
  private clipEndSec(c: { startFrame: number; slotEndFrame: number; deliveredFrames: number | null }): number {
    const len = Math.min(c.deliveredFrames ?? c.slotEndFrame - c.startFrame, c.slotEndFrame - c.startFrame);
    return Math.max(0, (c.startFrame + len - 1) / FPS);
  }

  /**
   * Tramos del final (ADR-067 y ADR-073): cada clip, corrido por los insertos anteriores, y cada inserto
   * (índice negativo: -id), con el segundo de su portada (su último fotograma propio).
   */
  private parts(g: Awaited<ReturnType<DeliveryService['generation']>>): DeliveryClip[] {
    const plan = g.plan as unknown as PlannedClip[] | null;
    const inserts = (g.inserts as unknown as InsertState[] | null) ?? [];
    const words = g.words as unknown as SubtitleWord[] | null;
    const voiceFrames = g.totalFrames ?? 0;
    const comp = plan && inserts.length ? compose(plan, voiceFrames, inserts, words?.length ? buildCues(g.paragraphs, words, voiceFrames / FPS) : []) : { totalFrames: videoFrames(plan, voiceFrames), gaps: [] };
    const out: DeliveryClip[] = g.clips.map((c) => {
      const d = clipShift(comp, c.index) / FPS;
      return { index: c.index, title: c.title, startSec: c.startFrame / FPS + d, endSec: c.slotEndFrame / FPS + d, posterSec: this.clipEndSec(c) + d };
    });
    for (const gap of comp.gaps)
      for (const gi of gap.inserts) {
        const ins = inserts.find((x) => x.id === gi.id)!;
        // Portada del inserto: el último cuadro de su video (en el cierre, después de su transición; ADR-074).
        const own = Math.min(ins.deliveredFrames ?? gi.frames, gi.frames) + (ins.kind === 'upload' && transitionFirst(ins) ? transitionFrames(ins) : 0);
        const title = ins.kind === 'upload' ? (ins.after === 0 ? 'Portada subida' : 'Cierre subido') : 'Clip insertado';
        out.push({ index: -ins.id, title, startSec: gi.startFrame / FPS, endSec: (gi.startFrame + gi.frames) / FPS, posterSec: Math.max(0, (gi.startFrame + own - 1) / FPS) });
      }
    return out.sort((a, b) => a.startSec - b.startSec);
  }

  /** Portada por defecto: el final del clip01 (K01, el primer fotograma con texto; K00 es solo el fondo). */
  private defaultPoster(parts: DeliveryClip[]): number {
    return parts.find((c) => c.index === 1)?.posterSec ?? 0;
  }

  /** Título de un video para el reproductor y el SCORM: el comienzo de su texto. */
  videoTitle(text: string) {
    const t = text.replace(/\s+/g, ' ').trim();
    const first = t.split(/(?<=[.!?])\s/)[0];
    const s = first.length <= 90 ? first : t;
    return s.length > 90 ? `${s.slice(0, 88).trimEnd()}…` : s;
  }

  async video(id: string, ownerId: string): Promise<VideoDelivery> {
    const g = await this.generation(id, ownerId);
    const pd = (g.project.delivery ?? {}) as StoredProjectDelivery;
    const o = (g.delivery ?? {}) as VideoDeliveryOverride;
    const durationSec = (g.finalFrames ?? g.totalFrames ?? 0) / FPS;
    const clips = this.parts(g);
    const defaultPosterSec = this.defaultPoster(clips);
    // Portada por clip (ADR-067); un segundo suelto solo queda en videos de antes. Sin clips, el segundo 0.
    const first = clips.find((c) => c.index === 1);
    const posterClip = o.posterClip && clips.some((c) => c.index === o.posterClip) ? o.posterClip : o.posterSec !== undefined || !first ? undefined : first.index;
    const final = g.finalPath ? join(this.dirOf(g), g.finalPath) : undefined;
    return {
      logo: this.logoInfo(g.project.id, pd.logo),
      settings: mergeSettings(pd.settings),
      clipCorners: o.clipCorners ?? {},
      clips,
      posterClip,
      posterSec: posterClip ? clips.find((c) => c.index === posterClip)!.posterSec : Math.min(o.posterSec ?? 0, Math.max(0, durationSec - 1 / FPS)),
      defaultPosterSec,
      durationSec,
      finalBytes: final ? await this.media.size(final) : undefined,
      share: o.share ? { url: this.shareUrl(o.share.token), createdAt: o.share.createdAt } : undefined,
    };
  }

  // ─── Link para compartir (hito 7, ADR-083) ──────────────────────────────────────────────────────────

  /** Dirección pública del link: la de la app (WEB_ORIGIN), que pasa /api/ a la API. */
  shareUrl(token: string) {
    return `${env.WEB_ORIGIN.replace(/\/+$/, '')}/api/ver/${token}`;
  }

  /** Crea el link (o uno nuevo, que deja sin efecto el anterior). */
  async createShare(id: string, ownerId: string): Promise<VideoDelivery> {
    const g = await this.generation(id, ownerId);
    if (!g.finalPath) throw new BadRequestException('El video aún no tiene final.');
    const cur = (g.delivery ?? {}) as VideoDeliveryOverride;
    cur.share = { token: randomBytes(18).toString('base64url'), createdAt: new Date().toISOString() };
    await this.db.generation.update({ where: { id }, data: { delivery: cur as unknown as Prisma.InputJsonValue } });
    return this.video(id, ownerId);
  }

  /** Desactiva el link: deja de funcionar para todos. */
  async removeShare(id: string, ownerId: string): Promise<VideoDelivery> {
    const g = await this.generation(id, ownerId);
    const cur = (g.delivery ?? {}) as VideoDeliveryOverride;
    delete cur.share;
    await this.db.generation.update({ where: { id }, data: { delivery: Object.keys(cur).length ? (cur as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });
    return this.video(id, ownerId);
  }

  /** Video y dueño de un link activo (o 404). Siempre el final vigente. */
  async resolveShare(token: string): Promise<{ id: string; ownerId: string }> {
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) throw new NotFoundException('Link no válido o desactivado.');
    const g = await this.db.generation.findFirst({ where: { delivery: { path: ['share', 'token'], equals: token }, trashedAt: null }, select: { id: true, ownerId: true, finalPath: true } });
    if (!g) throw new NotFoundException('Link no válido o desactivado.');
    if (!g.finalPath) throw new NotFoundException('El video aún no tiene final.');
    return { id: g.id, ownerId: g.ownerId };
  }

  /**
   * Guarda lo propio del video (ADR-066 y ADR-067): logo por clip (esquina, 'none' = ese clip sin logo, null =
   * la del proyecto) y/o el clip de la portada (null = el clip 1).
   */
  async setVideo(id: string, ownerId: string, o: { clipCorners?: Record<string, ClipLogo | null>; posterClip?: number | null }): Promise<VideoDelivery> {
    const g = await this.generation(id, ownerId);
    const cur = (g.delivery ?? {}) as VideoDeliveryOverride & { settings?: unknown };
    delete cur.settings; // ajuste por video del primer diseño (ADR-065): ahora tamaño y realce son del proyecto
    if (o.clipCorners) {
      const cc = { ...cur.clipCorners };
      const parts = this.parts(g);
      for (const [k, v] of Object.entries(o.clipCorners)) {
        if (!parts.some((c) => String(c.index) === k)) continue;
        if (v) cc[k] = v;
        else delete cc[k];
      }
      if (Object.keys(cc).length) cur.clipCorners = cc;
      else delete cur.clipCorners;
    }
    if (o.posterClip !== undefined) {
      delete cur.posterSec;
      if (o.posterClip === null || o.posterClip === 1 || !this.parts(g).some((c) => c.index === o.posterClip)) delete cur.posterClip;
      else cur.posterClip = o.posterClip;
    }
    await this.db.generation.update({ where: { id }, data: { delivery: Object.keys(cur).length ? (cur as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });
    return this.video(id, ownerId);
  }

  /** Portada: un fotograma del final en JPEG (1600 px, o `width` para las miniaturas), guardado junto al final. */
  async poster(id: string, ownerId: string, sec?: number, width = 1600): Promise<Buffer | undefined> {
    const g = await this.generation(id, ownerId);
    if (!g.finalPath) return undefined;
    const v = await this.video(id, ownerId);
    const t = sec ?? v.posterSec;
    const w = Math.max(160, Math.min(1600, Math.round(width)));
    const dir = this.dirOf(g);
    const out = join(dir, `${g.finalPath.replace(/\.mp4$/, '')}_portada_${Math.round(t * 1000)}${w === 1600 ? '' : `_w${w}`}.jpg`);
    // La portada queda junto al final; si la carpeta salió de la caché local, se baja (o se baja el final).
    await this.media.ensure(out);
    // Una portada vacía (ffmpeg no sacó ningún cuadro, p. ej. con el final a medio bajar) se vuelve a hacer.
    if (existsSync(out) && (await stat(out)).size === 0) await rm(out, { force: true });
    if (!existsSync(out)) {
      await this.media.ensure(join(dir, g.finalPath));
      const tmp = `${out}.${randomUUID().slice(0, 8)}.part`;
      try {
        const final = join(dir, g.finalPath);
        const grab = (seek: string[]) => ffmpeg([...seek, '-i', final, '-frames:v', '1', '-vf', `scale=${w}:-2`, '-q:v', '4', '-f', 'mjpeg', tmp]);
        const size = async () => (await stat(tmp).catch(() => undefined))?.size ?? 0;
        await grab(['-ss', t.toFixed(3)]);
        // Pasado el final (videos antiguos cuyo final es un poco más corto que sus tramos), ffmpeg termina bien
        // pero sin ningún cuadro: se usa el último cuadro del video.
        if (!(await size())) await grab(['-sseof', '-0.25']);
        if (!(await size())) throw new Error(`ffmpeg no sacó la portada en ${t.toFixed(3)} s.`);
        await rename(tmp, out);
      } finally {
        await rm(tmp, { force: true });
      }
      this.media.dirty(out);
    }
    return readFile(out);
  }

  /** Subtítulos del final: los de la locución y, con insertos, corridos y con su locución (ADR-073). */
  private finalCuesOf(g: Awaited<ReturnType<DeliveryService['generation']>>) {
    return finalCues({
      paragraphs: g.paragraphs,
      words: (g.words as unknown as SubtitleWord[] | null) ?? [],
      voiceFrames: g.totalFrames ?? 0,
      plan: (g.plan as unknown as PlannedClip[] | null) ?? undefined,
      inserts: (g.inserts as unknown as InsertState[] | null) ?? undefined,
    });
  }

  /** Subtítulos del video para el reproductor (una línea, ADR-062). */
  private cues(g: Awaited<ReturnType<DeliveryService['generation']>>): PlayerCue[] {
    const words = g.words as unknown as SubtitleWord[] | null;
    if (!words?.length) return [];
    return this.finalCuesOf(g).map((c) => ({ start: c.start, end: c.end, text: c.lines.join(' ') }));
  }

  /**
   * Logo de una descarga como data URL (ADR-066): el del proyecto, ninguno u otro subido solo para esa
   * descarga (se valida y se limpia igual que el del proyecto, pero no se guarda).
   */
  async logoDataUrl(projectId: string, ownerId: string, choice: DownloadLogo | undefined): Promise<string | null> {
    if (choice === 'none') return null;
    if (choice && typeof choice === 'object') {
      const { content, mime } = parseLogo(Buffer.from(choice.data.replace(/^data:[^,]+,/, ''), 'base64'));
      return `data:${mime};base64,${content.toString('base64')}`;
    }
    const logo = await this.logoFile(projectId, ownerId);
    return logo ? `data:${logo.mime};base64,${(await readFile(logo.path)).toString('base64')}` : null;
  }

  /**
   * index.html del reproductor. `videoSrc`: el video junto al HTML ("video.mp4", "final.mp4") o su URL en la
   * app (vista previa). `embed`: el video dentro del HTML (un solo archivo). `settings`: ajustes de esta
   * descarga o de la vista previa (sin el campo, los del proyecto). `logoDataUrl`: null = sin logo; sin el
   * campo, el del proyecto. `scorm`: el SCO de un paquete SCORM.
   */
  /**
   * El logo del proyecto superpuesto como en el reproductor (ADR-066/067): data URL, ajustes, tramos de los clips en el
   * final y esquina de cada uno. Para la revisión del video (T6b); sin logo, undefined.
   */
  async logoOverlay(id: string, ownerId: string): Promise<LogoOverlay | undefined> {
    const g = await this.generation(id, ownerId);
    const logo = await this.logoDataUrl(g.project.id, ownerId, 'project').catch(() => null);
    if (!logo) return undefined;
    const v = await this.video(id, ownerId);
    return { logo, settings: v.settings, clips: v.clips.map((c) => ({ index: c.index, start: c.startSec, end: c.endSec })), clipCorners: v.clipCorners };
  }

  async playerHtml(id: string, ownerId: string, o: PlayerRequest) {
    const p = await this.playerOptions(id, ownerId, o);
    return playerHtml({ ...p, posterDataUrl: p.posterJpeg ? `data:image/jpeg;base64,${p.posterJpeg.toString('base64')}` : undefined, posterJpeg: undefined });
  }

  /**
   * Reproductor en archivos separados (ADR-068): index.html, css/, js/, img/ y, si `withSubtitles`,
   * subtitulos.vtt y subtitulos.srt. Rutas relativas a la carpeta del video.
   */
  async playerFiles(id: string, ownerId: string, o: PlayerRequest & { withSubtitles?: boolean }) {
    const p = await this.playerOptions(id, ownerId, { ...o, embed: false });
    const subs = o.withSubtitles ? await this.subtitles(id, ownerId) : undefined;
    return playerFiles(p, subs ?? null);
  }

  private async playerOptions(id: string, ownerId: string, o: PlayerRequest): Promise<PlayerOptions> {
    const g = await this.generation(id, ownerId);
    if (!g.finalPath) throw new BadRequestException('El video aún no tiene final.');
    const v = await this.video(id, ownerId);
    const logoDataUrl = o.logoDataUrl !== undefined ? o.logoDataUrl : await this.logoDataUrl(g.project.id, ownerId, 'project');
    const poster = await this.poster(id, ownerId, o.posterSec, o.posterWidth);
    const final = o.videoPath ?? join(this.dirOf(g), g.finalPath);
    return {
      title: `${g.project.name} · ${this.videoTitle(g.text)}`,
      videoSrc: o.embed ? undefined : o.videoSrc,
      videoBase64: o.embed ? (await this.media.ensure(final), await readFile(final)).toString('base64') : undefined,
      posterJpeg: poster,
      cues: this.cues(g),
      logoDataUrl: logoDataUrl ?? undefined,
      settings: mergeSettings(v.settings, o.settings),
      durationSec: v.durationSec,
      clips: v.clips.map((c) => ({ index: c.index, start: c.startSec, end: c.endSec })),
      clipCorners: o.cornerAll ? allCorners(v.clips, v.clipCorners, o.cornerAll) : v.clipCorners,
      preview: o.preview,
      scorm: o.scorm,
      share: o.share,
    };
  }

  /** Subtítulos .vtt y .srt del video (una línea, ADR-062). */
  async subtitles(id: string, ownerId: string): Promise<{ vtt: string; srt: string } | undefined> {
    const g = await this.generation(id, ownerId);
    const words = g.words as unknown as SubtitleWord[] | null;
    if (!words?.length) return undefined;
    const cues = this.finalCuesOf(g);
    return { vtt: toVtt(cues), srt: toSrt(cues) };
  }

  /**
   * Datos para empaquetar la descarga: archivo del final, nombre base y proyecto. Para empaquetarlo, el final se
   * baja a la caché local si hace falta; para servirlo (`local: false`), no (MediaService.serve decide).
   */
  async finalFile(id: string, ownerId: string, o: { local?: boolean } = {}) {
    const g = await this.generation(id, ownerId);
    if (!g.finalPath) throw new BadRequestException('El video aún no tiene final.');
    const path = join(this.dirOf(g), g.finalPath);
    if (o.local !== false) await this.media.ensure(path);
    const bytes = await this.media.size(path);
    if (bytes === undefined || (o.local !== false && !existsSync(path))) throw new NotFoundException('No se encontró el archivo del final.');
    return { path, bytes, projectName: g.project.name, projectId: g.project.id, title: this.videoTitle(g.text) };
  }

  // ─── Paquetes ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * Paquete SCORM (ADR-066) con un SCO por video: `prefixNN/index.html` (reproductor con el registro del LMS)
   * y `prefixNN/video.mp4`, más `imsmanifest.xml` en la raíz. Los videos sin final no entran.
   */
  async addScorm(
    zip: ZipArchive,
    version: ScormVersion,
    o: {
      id: string;
      title: string;
      videoIds: string[];
      ownerId: string;
      logo?: DownloadLogo;
      settings?: LogoSettings;
      cornerAll?: LogoCorner;
      /** Versión reducida de cada video (ADR-085); sin ella, el final. */
      videoPath?: (id: string) => string | undefined;
      posterWidth?: number;
      /** SCORM liviano (T4, ADR-108): URL pública del video; el paquete no lo lleva adentro. */
      remoteVideo?: (id: string) => string | undefined;
    },
  ): Promise<number> {
    const items: ScormItem[] = [];
    let logo: string | null | undefined;
    for (const vid of o.videoIds) {
      let f: Awaited<ReturnType<DeliveryService['finalFile']>>;
      try {
        f = await this.finalFile(vid, o.ownerId);
      } catch {
        continue;
      }
      if (logo === undefined) logo = await this.logoDataUrl(f.projectId, o.ownerId, o.logo);
      const folder = o.videoIds.length === 1 ? 'video' : `video${String(items.length + 1).padStart(2, '0')}`;
      const remote = o.remoteVideo ? o.remoteVideo(vid) : undefined;
      if (o.remoteVideo && !remote) continue;
      const files = await this.playerFiles(vid, o.ownerId, { videoSrc: remote ?? 'video.mp4', logoDataUrl: logo, settings: o.settings, scorm: version, cornerAll: o.cornerAll, withSubtitles: true, posterWidth: o.posterWidth });
      appendFiles(zip, folder, files);
      if (!remote) zip.file(o.videoPath?.(vid) ?? f.path, { name: `${folder}/video.mp4`, store: true });
      const names = [...Object.keys(files), ...(remote ? [] : ['video.mp4'])].sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
      items.push({ id: vid, title: o.videoIds.length > 1 ? `${items.length + 1}. ${f.title}` : f.title, href: `${folder}/index.html`, files: names.map((n) => `${folder}/${n}`) });
    }
    if (!items.length) throw new BadRequestException('No hay videos con final para empaquetar.');
    zip.append(scormManifest(version, o.id, o.title, items), { name: 'imsmanifest.xml' });
    return items.length;
  }

  // Descargas con logo, ajustes o calidad propios: se piden por POST y se bajan por GET con un token (10 min; se
  // puede usar más de una vez en ese plazo, por si el navegador repite la descarga). Con otra resolución o
  // compresión (ADR-085), al pedirla se preparan las versiones reducidas de sus videos por la cola de ffmpeg; el
  // GET solo vale cuando están listas y el plazo cuenta desde entonces (30 min).
  private readonly requests = new Map<string, PackageEntry>();

  createRequest(ownerId: string, target: string, req: DownloadRequest, videoIds: string[] = []): string {
    const now = Date.now();
    for (const [k, v] of this.requests) if (v.exp < now && !(v.prep && !v.prep.done && !v.prep.error)) this.requests.delete(k);
    const token = randomUUID();
    const entry: PackageEntry = { ownerId, target, req, exp: now + 10 * 60_000 };
    if (!isOriginalQuality(req.quality) && videoIds.length) entry.prep = this.prepare(entry, videoIds, req.quality!);
    this.requests.set(token, entry);
    return token;
  }

  /** Prepara una a una las versiones reducidas de los videos de la descarga. */
  private prepare(entry: PackageEntry, ids: string[], q: ExportQuality): Preparation {
    const prep: Preparation = { ids, paths: new Map(), done: false };
    void (async () => {
      for (const id of ids) {
        prep.current = id;
        try {
          prep.paths.set(id, await this.exports.ensure(id, entry.ownerId, q));
        } catch (e) {
          prep.error = (e as Error).message;
          prep.current = undefined;
          return;
        }
      }
      prep.current = undefined;
      prep.done = true;
      let bytes = 0;
      for (const p of prep.paths.values()) bytes += (await stat(p)).size;
      prep.bytes = bytes;
      entry.exp = Date.now() + 30 * 60_000;
    })();
    return prep;
  }

  private entry(token: string | undefined, ownerId: string, target: string): PackageEntry | undefined {
    if (!token) return undefined;
    const r = this.requests.get(token);
    if (!r || r.ownerId !== ownerId || r.target !== target || (r.exp < Date.now() && !(r.prep && !r.prep.done && !r.prep.error)))
      throw new NotFoundException('La descarga caducó: vuelve a pedirla.');
    return r;
  }

  /** Avance de una descarga con versiones reducidas (sin ellas, lista). */
  packageStatus(token: string, ownerId: string, target: string): PackageStatus {
    const r = this.entry(token, ownerId, target)!;
    const p = r.prep;
    if (!p) return { ready: true, progress: 1 };
    if (p.error) return { ready: false, progress: 0, error: p.error };
    if (p.done) return { ready: true, progress: 1, bytes: p.bytes };
    const cur = p.current && r.req.quality ? this.exports.progressOf(p.current, r.req.quality) : 0;
    return { ready: false, progress: Math.min(0.99, (p.paths.size + cur) / p.ids.length) };
  }

  /**
   * La descarga pedida por POST (o undefined sin token) y el archivo de cada video: su versión reducida si se pidió
   * otra calidad (tiene que estar lista) o el final.
   */
  takeRequest(token: string | undefined, ownerId: string, target: string): { req: DownloadRequest; videoPath: (id: string) => string | undefined; posterWidth?: number } | undefined {
    const r = this.entry(token, ownerId, target);
    if (!r) return undefined;
    if (r.prep?.error) throw new BadRequestException(`No se pudo preparar la descarga: ${r.prep.error}`);
    if (r.prep && !r.prep.done) throw new BadRequestException('La descarga aún se está preparando.');
    const q = r.req.quality;
    return { req: r.req, videoPath: (id) => r.prep?.paths.get(id), posterWidth: isOriginalQuality(q) ? undefined : Math.min(1600, Math.round((q!.height * 16) / 9)) };
  }
}

interface Preparation {
  ids: string[];
  paths: Map<string, string>;
  current?: string;
  done: boolean;
  bytes?: number;
  error?: string;
}

interface PackageEntry {
  ownerId: string;
  target: string;
  req: DownloadRequest;
  exp: number;
  prep?: Preparation;
}
