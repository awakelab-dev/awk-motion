import { BadRequestException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ZipArchive } from 'archiver';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Response } from 'express';
import { Prisma, type Db } from '@wilox/db';
import {
  type AuthUser,
  BATCH_RETENTION_DAYS,
  LIGHT_SCORM_FORMATS,
  PUBLISHED_BATCH_FORMATS,
  isOriginalQuality,
  qualityLabel,
  type BatchCandidate,
  type BatchFormat,
  type BatchRequestFormat,
  type LogoSettings,
  type BatchSkipped,
  type CreateBatchRequest,
  type CreateDownloadLinkRequest,
  type UpdateDownloadLinkRequest,
  type DownloadBatchInfo,
  type DownloadRequest,
  type ExportQuality,
} from '@wilox/shared';
import { env, repoPath } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { DeliveryService, mergeSettings } from '../delivery/delivery.service.js';
import { MediaService } from '../storage/media.service.js';
import { ExportsService } from '../delivery/exports.service.js';
import { PackagesService, posterWidthOf, videoPackageName } from '../delivery/packages.service.js';
import { DownloadsService } from './downloads.service.js';
import { AccessService } from '../access/access.service.js';
import { fillVideosZip, safeName } from './zip.js';
import { applyRetention, linkExpiry, type LinkPage } from './links.js';
import { brand } from '../brand/brand.js';

const DAY = 86_400_000;
/** Espacio libre mínimo para seguir armando un lote (además del video que se añade). */
const MIN_FREE_BYTES = 1024 ** 3;

export const BATCH_FORMAT_LABEL: Record<BatchRequestFormat, string> = { html: 'HTML', scorm12: 'SCORM 1.2', scorm2004: 'SCORM 2004', single: 'Un solo .html', mp4: 'MP4', zip: 'ZIP completo', 'project-zip': 'ZIP del proyecto' };
const FORMAT_SLUG: Record<BatchRequestFormat, string> = { html: 'html', scorm12: 'scorm12', scorm2004: 'scorm2004', single: 'html1', mp4: 'mp4', zip: 'completo', 'project-zip': 'proyecto' };

/** Nombre del ZIP del lote: proyecto, formato, calidad, cantidad de videos y fecha (hora de Fortaleza). */
export function batchFileName(projectName: string, format: BatchRequestFormat, q: ExportQuality | undefined, videos: number, at: Date): string {
  const local = new Date(at.getTime() - 3 * 3_600_000).toISOString(); // UTC−3, sin horario de verano
  const stamp = `${local.slice(0, 10).replaceAll('-', '')}-${local.slice(11, 16).replace(':', '')}`;
  const quality = isOriginalQuality(q) ? '' : `_${q!.height}p`;
  return `wilox_${safeName(projectName)}_${FORMAT_SLUG[format]}${quality}_${videos}videos_${stamp}.zip`;
}

/** Nombre de cada archivo dentro del lote: el de su descarga individual con el orden delante. */
export const batchEntryName = (index: number, total: number, name: string) => `${String(index + 1).padStart(Math.max(2, String(total).length), '0')}_${name}`;

/** LEEME.txt del lote. */
export function batchReadme(o: { projectName: string; format: BatchFormat; quality?: ExportQuality; entries: { name: string; title: string }[]; skipped: BatchSkipped[]; at: Date }): string {
  const lines = [
    `${brand.name} · lote de descargas`,
    `Proyecto: ${o.projectName}`,
    `Formato: ${BATCH_FORMAT_LABEL[o.format]} · ${qualityLabel(o.quality)}`,
    `Armado: ${o.at.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `Cada archivo es la descarga individual de un video (${o.entries.length}):`,
    ...o.entries.map((e) => `  ${e.name}  ·  ${e.title}`),
  ];
  if (o.skipped.length) lines.push('', `No entraron (${o.skipped.length}):`, ...o.skipped.map((s) => `  ${s.title} (${s.id}): ${s.reason}`));
  return `${lines.join('\r\n')}\r\n`;
}

/** Lo que se armó en una descarga (T5, ADR-111). `logo` solo si lleva el logo del proyecto. */
interface Snapshot {
  videos: Record<string, string | null>;
  logo?: number | null;
}

/** Link público de descarga. */
export const linkUrl = (token: string) => `${env.WEB_ORIGIN.replace(/\/+$/, '')}/api/descargar/${token}`;

/** Nombre del tipo de descarga en la página pública (los que publican primero). */
const batchKindLabel = (f: string) => (f === 'rise' ? 'Código para Rise 360' : f === 'scorm12-light' ? 'SCORM 1.2 liviano' : f === 'scorm2004-light' ? 'SCORM 2004 liviano' : f);

class Aborted extends Error {
  constructor() {
    super('Lote eliminado.');
  }
}

/** Falló con videos que no entraron (se guardan en la fila con su motivo). */
class Skipped extends Error {
  constructor(
    message: string,
    readonly skipped: BatchSkipped[],
  ) {
    super(message);
  }
}

/** Lo que el lote en marcha está haciendo (para el avance en vivo). */
interface Live {
  id: string;
  total: number;
  done: number;
  abort: boolean;
  phase?: 'encode' | 'pack' | 'close';
  current?: string;
  quality?: ExportQuality;
  archive?: ZipArchive;
}

type Row = Awaited<ReturnType<Db['downloadBatch']['findFirstOrThrow']>>;

/**
 * Lotes de descarga (hito 7, ADR-087): la descarga individual de varios videos de un proyecto, con las mismas
 * opciones, en un ZIP que se arma en segundo plano y queda guardado 30 días. Los lotes se arman de a uno (orden
 * de llegada, de todos los usuarios) para no cargar el disco ni el CPU; las versiones reducidas pasan por la
 * cola de ffmpeg como en la descarga individual. Cada video se prepara y se añade al ZIP antes del siguiente, así
 * el disco solo guarda el ZIP y un archivo temporal. Si la API se reinicia, el lote vuelve a la cola y se arma de
 * nuevo (las versiones reducidas ya hechas se reutilizan).
 */
@Injectable()
export class BatchesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Lotes');
  private live?: Live;
  private kicking = false;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly delivery: DeliveryService,
    private readonly packages: PackagesService,
    private readonly exports: ExportsService,
    private readonly media: MediaService,
    private readonly downloads: DownloadsService,
    private readonly access: AccessService,
  ) {}

  async onModuleInit() {
    // Lo que quedó a medias en una ejecución anterior vuelve a la cola.
    // Los documentos para Rise 360 (T3b, ADR-104) los sigue PublicationsService: no se tocan aquí.
    await this.db.downloadBatch.updateMany({ where: { status: { in: ['preparing', 'packing'] }, format: { notIn: [...PUBLISHED_BATCH_FORMATS] } }, data: { status: 'queued', progress: 0, done: 0 } });
    await this.purge(true).catch((e: Error) => this.logger.warn(`Limpieza de lotes: ${e.message}`));
    this.timer = setInterval(() => void this.purge().catch(() => undefined), 3_600_000);
    this.timer.unref();
    setImmediate(() => void this.kick());
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.live) this.live.abort = true;
  }

  private root() {
    return join(repoPath(env.STORAGE_DIR), 'downloads');
  }

  private dirOf(id: string) {
    return join(this.root(), id);
  }

  private fileOf(row: { id: string; fileName: string }) {
    return join(this.dirOf(row.id), row.fileName);
  }

  // ─── Pedidos ─────────────────────────────────────────────────────────────────────────────────────────

  /** Videos del proyecto que pueden ir en un lote (con final), en orden de creación. */
  async candidates(projectId: string, user: AuthUser): Promise<BatchCandidate[]> {
    await this.access.project(projectId, user);
    const { ids } = await this.delivery.projectVideos(projectId, user.id);
    const rows = await this.db.generation.findMany({ where: { id: { in: ids } }, select: { id: true, text: true, createdAt: true, finalFrames: true, totalFrames: true, dir: true, finalPath: true }, orderBy: { createdAt: 'asc' } });
    const out: BatchCandidate[] = [];
    for (const g of rows) {
      const path = join(repoPath(env.STORAGE_DIR), g.dir, g.finalPath!);
      const bytes = (await this.media.size(path)) ?? 0;
      if (!bytes) continue;
      out.push({ id: g.id, title: this.delivery.videoTitle(g.text), createdAt: g.createdAt.toISOString(), durationSec: (g.finalFrames ?? g.totalFrames ?? 0) / 24, bytes });
    }
    return out;
  }

  async create(user: AuthUser, body: CreateBatchRequest): Promise<DownloadBatchInfo> {
    // Hito 11 (ADR-142): en un proyecto al que tiene acceso; la fila queda a nombre de quien la pide.
    await this.access.project(body.projectId, user);
    const ownerId = user.id;
    const project = await this.delivery.projectVideos(body.projectId, ownerId);
    let ids: string[];
    if (body.format === 'project-zip' || body.format === 'zip') {
      // ZIP completo (T5a): también los videos sin final (llevan clips, voz, fotogramas y prompts).
      const all = await this.downloads.projectIds(body.projectId, ownerId);
      // ZIP del proyecto: los videos marcados (T5b) o, sin lista, todos (también los que aún no tienen final).
      ids = body.format === 'project-zip' ? (body.videoIds.length ? all.filter((id) => body.videoIds.includes(id)) : all) : all.filter((id) => id === body.videoIds[0]).slice(0, 1);
      if (!ids.length) throw new BadRequestException(body.format === 'project-zip' ? 'El proyecto aún no tiene videos.' : 'Video no encontrado.');
    } else {
      const wanted = new Set(body.videoIds);
      ids = project.ids.filter((id) => wanted.has(id));
      if (!ids.length) throw new BadRequestException('Elige al menos un video con final.');
    }
    await this.delivery.logoDataUrl(body.projectId, ownerId, body.logo); // valida el logo ahora, no al armar
    const req: DownloadRequest = { format: body.format === 'project-zip' ? 'zip' : body.format, logo: body.logo, settings: body.settings, cornerAll: body.cornerAll, quality: isOriginalQuality(body.quality) ? undefined : body.quality };
    const now = new Date();
    // Un solo video: el nombre del paquete mismo (el de su descarga individual); varios: el del ZIP del lote.
    const fileName =
      body.format === 'zip'
        ? `wilox_${videoPackageName(project.name, ids[0], 'zip', req.quality).replace(/\.zip$/, '')}_completo.zip`
        : body.format !== 'project-zip' && ids.length === 1
          ? videoPackageName(project.name, ids[0], body.format, req.quality)
          : batchFileName(project.name, body.format, req.quality, ids.length, now);
    const row = await this.db.downloadBatch.create({
      data: {
        ownerId,
        projectId: body.projectId,
        projectName: project.name,
        format: body.format,
        request: req as object,
        videoIds: ids,
        fileName,
        createdAt: now,
      },
    });
    this.logger.log(`Descarga ${row.id}: ${ids.length} video(s) de «${project.name}» en ${BATCH_FORMAT_LABEL[body.format]} · ${qualityLabel(req.quality)}`);
    setImmediate(() => void this.kick());
    return (await this.infos([row]))[0];
  }

  /** Una fila de «Descargas» (p. ej. el documento para Rise recién pedido). */
  async one(id: string, user: AuthUser): Promise<DownloadBatchInfo> {
    return (await this.infos([await this.row(id, user)]))[0];
  }

  /**
   * «Descargas» (hito 11, ADR-142): las de los proyectos a los que el usuario tiene acceso (las pida quien las pida) y
   * las suyas de proyectos que ya no ve; con `all`, el admin ve las de todos.
   */
  async list(user: AuthUser, all = false): Promise<DownloadBatchInfo[]> {
    const where: Prisma.DownloadBatchWhereInput = all && user.role === 'admin' ? {} : { OR: [{ ownerId: user.id }, { projectId: { in: await this.access.visibleProjectIds(user) } }] };
    const rows = await this.db.downloadBatch.findMany({ where, orderBy: { createdAt: 'desc' } });
    return this.infos(rows);
  }

  /** Vuelve a la cola un lote con error. */
  async retry(id: string, user: AuthUser): Promise<DownloadBatchInfo> {
    const row = await this.row(id, user, { manage: true });
    if (row.status !== 'error') throw new BadRequestException('Solo se reintenta un lote con error.');
    await rm(this.dirOf(id), { recursive: true, force: true });
    await this.media.removed(this.dirOf(id));
    const r = await this.db.downloadBatch.update({ where: { id }, data: { status: 'queued', progress: 0, done: 0, skipped: [], error: null, bytes: null, startedAt: null, finishedAt: null, expiresAt: null } });
    setImmediate(() => void this.kick());
    return (await this.infos([r]))[0];
  }

  /** Elimina el lote (si se está armando, se detiene) y su ZIP. */
  async remove(id: string, user: AuthUser): Promise<void> {
    await this.row(id, user);
    if (this.live?.id === id) {
      this.live.abort = true;
      this.live.archive?.abort();
    }
    await this.db.downloadBatch.delete({ where: { id } });
    await rm(this.dirOf(id), { recursive: true, force: true });
    await this.media.removed(this.dirOf(id));
  }

  /**
   * Envía el ZIP. Cuenta una descarga por pedido que empieza desde el principio (un navegador que retoma una
   * descarga cortada pide un rango y no suma).
   */
  async send(id: string, user: AuthUser, range: string | undefined, res: Response) {
    const row = await this.row(id, user);
    const path = this.fileOf(row);
    if (row.status !== 'ready' || !this.media.has(path)) throw new NotFoundException(row.status === 'ready' ? 'El ZIP del lote ya no está en el servidor.' : 'El lote aún no está listo.');
    if (!range || /^bytes=0-/.test(range)) await this.db.downloadBatch.update({ where: { id }, data: { downloads: { increment: 1 }, lastDownloadAt: new Date() } });
    // Desde la caché local o, si ya salió de ella, con una URL firmada (hito 8, ADR-093).
    await this.media.serve(res, path, { download: row.fileName });
  }

  /**
   * Una fila de «Descargas» (hito 11, ADR-142): la de un proyecto al que el usuario tiene acceso o una suya. Con `manage`
   * (reintentar, actualizar, links nuevos o reactivados), hace falta el acceso de hoy al proyecto: quien lo perdió ve y
   * borra lo que pidió, pero no rearma el contenido actual ni lo vuelve a distribuir.
   */
  private async row(id: string, user: AuthUser, o: { manage?: boolean } = {}): Promise<Row> {
    const row = /^[0-9a-f-]{36}$/i.test(id) ? await this.db.downloadBatch.findFirst({ where: { id } }) : null;
    const access = row ? !!(await this.access.role(row.projectId, user)) : false;
    if (!row || (!access && (o.manage || row.ownerId !== user.id))) throw new NotFoundException('Lote no encontrado.');
    return row;
  }

  private async infos(rows: Row[]): Promise<DownloadBatchInfo[]> {
    const queued = await this.db.downloadBatch.findMany({ where: { status: 'queued', format: { notIn: [...PUBLISHED_BATCH_FORMATS] } }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    const ahead = this.live ? 1 : 0;
    // Título del video en las filas de un solo video (T5a).
    const single = rows.filter((r) => (r.videoIds as string[]).length === 1).map((r) => (r.videoIds as string[])[0]);
    const texts = single.length ? await this.db.generation.findMany({ where: { id: { in: single } }, select: { id: true, text: true } }) : [];
    const titles = new Map(texts.map((g) => [g.id, this.delivery.videoTitle(g.text)]));
    // Links (T5, ADR-111) y «desactualizada»: algún video tiene otro final o el proyecto otro logo desde que se armó.
    const links = await this.db.downloadLink.findMany({ where: { batchId: { in: rows.map((r) => r.id) } }, orderBy: { createdAt: 'asc' } });
    const snapRows = rows.filter((r) => r.status === 'ready' && r.snapshot);
    const snapIds = [...new Set(snapRows.flatMap((r) => Object.keys((r.snapshot as unknown as Snapshot).videos)))];
    const finals = new Map((snapIds.length ? await this.db.generation.findMany({ where: { id: { in: snapIds } }, select: { id: true, finalPath: true } }) : []).map((g) => [g.id, g.finalPath]));
    const logos = await this.logoVersions([...new Set(snapRows.map((r) => r.projectId))]);
    const stale = (r: Row) => {
      const snap = r.snapshot as unknown as Snapshot | null;
      if (r.status !== 'ready' || !snap) return false;
      if (Object.entries(snap.videos).some(([id, fp]) => finals.has(id) && finals.get(id) !== fp)) return true;
      return snap.logo !== undefined && snap.logo !== (logos.get(r.projectId) ?? null);
    };
    const now = Date.now();
    return rows.map((r) => {
      const req = r.request as unknown as DownloadRequest;
      const videos = (r.videoIds as string[]).length;
      const live = this.live?.id === r.id ? this.live : undefined;
      const pos = queued.findIndex((q) => q.id === r.id);
      const rise = r.format === 'rise' ? (r.request as unknown as { rise?: DownloadBatchInfo['rise'] }).rise : undefined;
      const light = (LIGHT_SCORM_FORMATS as readonly string[]).includes(r.format) ? (r.request as unknown as { light?: DownloadBatchInfo['light'] }).light ?? { each: false } : undefined;
      const published = !!rise || !!light;
      return {
        id: r.id,
        projectId: r.projectId,
        projectName: r.projectName,
        videoTitle: videos === 1 && r.format !== 'project-zip' ? titles.get((r.videoIds as string[])[0]) : undefined,
        format: r.format as DownloadBatchInfo['format'],
        rise,
        light,
        quality: req.quality,
        logo: !req.logo || req.logo === 'project' ? 'project' : req.logo === 'none' ? 'none' : 'other',
        videos,
        done: live?.done ?? r.done,
        status: r.status,
        progress: live ? this.progressOf(live) : r.progress,
        stage: live ? this.stageOf(live) : published && r.status === 'preparing' ? `Publicando en la nube: ${r.done} de ${videos} video${videos === 1 ? '' : 's'} listos` : published && r.status === 'queued' ? 'Publicando en la nube' : undefined,
        position: r.status === 'queued' && pos >= 0 ? pos + 1 + ahead : undefined,
        skipped: (r.skipped as unknown as BatchSkipped[] | null) ?? [],
        fileName: r.fileName,
        bytes: r.bytes === null ? undefined : Number(r.bytes),
        downloads: r.downloads,
        lastDownloadAt: r.lastDownloadAt?.toISOString(),
        error: r.error ?? undefined,
        createdAt: r.createdAt.toISOString(),
        startedAt: r.startedAt?.toISOString(),
        finishedAt: r.finishedAt?.toISOString(),
        expiresAt: r.expiresAt?.toISOString(),
        stale: stale(r) || undefined,
        links: links
          .filter((l) => l.batchId === r.id)
          .map((l) => ({
            id: l.id,
            url: linkUrl(l.token),
            label: l.label ?? undefined,
            createdAt: l.createdAt.toISOString(),
            expiresAt: l.expiresAt?.toISOString(),
            expired: !!l.expiresAt && l.expiresAt.getTime() < now,
            disabled: !!l.disabledAt,
            downloads: l.downloads,
            lastDownloadAt: l.lastDownloadAt?.toISOString(),
          })),
      };
    });
  }

  /** Versión del logo de cada proyecto (para saber si una descarga quedó desactualizada). */
  private async logoVersions(projectIds: string[]): Promise<Map<string, number | null>> {
    if (!projectIds.length) return new Map();
    const ps = await this.db.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, delivery: true } });
    return new Map(ps.map((p) => [p.id, ((p.delivery as { logo?: { version?: number } } | null)?.logo?.version ?? null) as number | null]));
  }

  /** Lo que se armó: el final de cada video y, si lleva el logo del proyecto, su versión. */
  private async snapshotOf(row: Row, req: DownloadRequest): Promise<Snapshot> {
    const ids = row.videoIds as string[];
    const gens = await this.db.generation.findMany({ where: { id: { in: ids } }, select: { id: true, finalPath: true } });
    const snap: Snapshot = { videos: Object.fromEntries(gens.map((g) => [g.id, g.finalPath])) };
    if (!req.logo || req.logo === 'project') snap.logo = (await this.logoVersions([row.projectId])).get(row.projectId) ?? null;
    return snap;
  }

  // ─── Links de descarga (T5, ADR-111) ──────────────────────────────────────────────────────────────────

  async createLink(batchId: string, user: AuthUser, body: CreateDownloadLinkRequest): Promise<DownloadBatchInfo> {
    const row = await this.row(batchId, user, { manage: true });
    if (row.status === 'error') throw new BadRequestException('Esta descarga falló: reinténtala antes de crear un link.');
    await this.db.downloadLink.create({ data: { token: randomBytes(18).toString('base64url'), ownerId: user.id, batchId, label: body.label?.trim() || null, expiresAt: linkExpiry(body.days) } });
    await applyRetention(this.db, batchId);
    return this.one(batchId, user);
  }

  async updateLink(linkId: string, user: AuthUser, body: UpdateDownloadLinkRequest): Promise<DownloadBatchInfo> {
    // Desactivar se puede siempre; reactivar, renovar o cambiar la etiqueta, con el acceso de hoy al proyecto.
    const l = await this.link(linkId, user, body.disabled !== true || body.days !== undefined);
    await this.db.downloadLink.update({
      where: { id: l.id },
      data: {
        ...(body.disabled !== undefined ? { disabledAt: body.disabled ? new Date() : null } : {}),
        ...(body.days !== undefined ? { expiresAt: linkExpiry(body.days) } : {}),
        ...(body.label !== undefined ? { label: body.label?.trim() || null } : {}),
      },
    });
    await applyRetention(this.db, l.batchId);
    return this.one(l.batchId, user);
  }

  async removeLink(linkId: string, user: AuthUser): Promise<DownloadBatchInfo> {
    const l = await this.link(linkId, user);
    await this.db.downloadLink.delete({ where: { id: l.id } });
    await applyRetention(this.db, l.batchId);
    return this.one(l.batchId, user);
  }

  /** Un link de una fila que el usuario puede gestionar (hito 11: la de un proyecto al que tiene acceso). */
  private async link(id: string, user: AuthUser, manage = false) {
    const l = /^[0-9a-f-]{36}$/i.test(id) ? await this.db.downloadLink.findFirst({ where: { id } }) : null;
    if (!l) throw new NotFoundException('Link no encontrado.');
    await this.row(l.batchId, user, { manage }).catch(() => {
      throw new NotFoundException('Link no encontrado.');
    });
    return l;
  }

  /** Lo que muestra la página pública de un link: listo, preparándose o no disponible. */
  async publicLink(token: string): Promise<{ page: LinkPage; row?: Row; linkId?: string }> {
    const l = /^[A-Za-z0-9_-]{20,40}$/.test(token) ? await this.db.downloadLink.findUnique({ where: { token }, include: { batch: true } }) : null;
    if (!l || l.disabledAt || (l.expiresAt && l.expiresAt.getTime() < Date.now())) return { page: { state: 'gone' } };
    const r = l.batch;
    const info = (await this.infos([r]))[0];
    const logoDataUrl = await this.delivery.logoDataUrl(r.projectId, r.ownerId, 'project').catch(() => null);
    const base = { projectName: r.projectName, videoTitle: info.videoTitle, format: BATCH_FORMAT_LABEL[r.format as BatchRequestFormat] ?? batchKindLabel(r.format), expiresAt: l.expiresAt, logoDataUrl };
    if (r.status === 'error') return { page: { state: 'gone' } };
    if (r.status !== 'ready' || !this.media.has(this.fileOf(r))) return { page: { ...base, state: r.status === 'ready' ? 'gone' : 'preparing' } };
    return { page: { ...base, state: 'ready', fileName: r.fileName, bytes: r.bytes === null ? undefined : Number(r.bytes), fileUrl: `${token}/archivo` }, row: r, linkId: l.id };
  }

  /** El archivo de un link (cuenta una descarga en el link y en la fila). */
  async sendPublic(token: string, range: string | undefined, res: Response) {
    const { row, linkId } = await this.publicLink(token);
    if (!row || !linkId) throw new NotFoundException('Link no disponible.');
    if (!range || /^bytes=0-/.test(range)) {
      const now = new Date();
      await this.db.downloadLink.update({ where: { id: linkId }, data: { downloads: { increment: 1 }, lastDownloadAt: now } });
      await this.db.downloadBatch.update({ where: { id: row.id }, data: { downloads: { increment: 1 }, lastDownloadAt: now } });
    }
    await this.media.serve(res, this.fileOf(row), { download: row.fileName });
  }

  /** «Actualizar»: vuelve a armar una descarga lista con los videos y el logo de hoy; sus links siguen igual. */
  async refresh(id: string, user: AuthUser): Promise<DownloadBatchInfo> {
    const row = await this.row(id, user, { manage: true });
    if (row.status !== 'ready') throw new BadRequestException('Solo se actualiza una descarga lista.');
    if ((PUBLISHED_BATCH_FORMATS as readonly string[]).includes(row.format)) throw new BadRequestException('Esta descarga sigue sola a los videos publicados: no hace falta actualizarla.');
    await rm(this.dirOf(id), { recursive: true, force: true });
    await this.media.removed(this.dirOf(id));
    const r = await this.db.downloadBatch.update({ where: { id }, data: { status: 'queued', progress: 0, done: 0, skipped: [], error: null, bytes: null, startedAt: null, finishedAt: null, expiresAt: null, snapshot: Prisma.DbNull } });
    this.logger.log(`Descarga ${id}: se vuelve a armar («Actualizar»).`);
    setImmediate(() => void this.kick());
    return (await this.infos([r]))[0];
  }

  private progressOf(l: Live): number {
    if (l.phase === 'close') return 0.99;
    const cur = l.phase === 'encode' && l.current && l.quality ? 0.8 * this.exports.progressOf(l.current, l.quality) : l.phase === 'pack' ? 0.85 : 0;
    return Math.min(0.99, (l.done + cur) / Math.max(1, l.total));
  }

  private stageOf(l: Live): string {
    if (l.phase === 'close') return 'Cerrando el ZIP';
    const n = `video ${Math.min(l.done + 1, l.total)} de ${l.total}`;
    if (l.phase === 'encode' && l.current && l.quality) return `Codificando ${n} en ${qualityLabel(l.quality)} (${Math.round(this.exports.progressOf(l.current, l.quality) * 100)} %)`;
    return `Añadiendo ${n}`;
  }

  // ─── Armado ──────────────────────────────────────────────────────────────────────────────────────────

  /** Arma los lotes en cola de a uno, por orden de llegada. */
  async kick() {
    if (this.kicking) return;
    this.kicking = true;
    try {
      for (;;) {
        const next = await this.db.downloadBatch.findFirst({ where: { status: 'queued', format: { notIn: [...PUBLISHED_BATCH_FORMATS] } }, orderBy: { createdAt: 'asc' } });
        if (!next) break;
        const claimed = await this.db.downloadBatch.updateMany({ where: { id: next.id, status: 'queued' }, data: { status: 'preparing', startedAt: new Date(), progress: 0, done: 0 } });
        if (!claimed.count) continue;
        await this.build(next);
      }
    } catch (e) {
      this.logger.error(`Cola de lotes: ${(e as Error).message}`);
    } finally {
      this.kicking = false;
    }
  }

  private async build(row: Row) {
    const req = row.request as unknown as DownloadRequest;
    const ids = row.videoIds as string[];
    const q = isOriginalQuality(req.quality) ? undefined : req.quality;
    const live: Live = { id: row.id, total: ids.length, done: 0, abort: false, quality: q };
    this.live = live;
    const dir = this.dirOf(row.id);
    const tmpOut = join(dir, '_armando.tmp');
    const started = Date.now();
    let skipped: BatchSkipped[] = [];
    try {
      await rm(dir, { recursive: true, force: true });
      await this.media.removed(dir);
      await mkdir(dir, { recursive: true });
      // Un solo paquete (un video en un formato por video) se entrega tal cual: el .zip del SCORM va directo al LMS
      // (T5a, ADR-109). Con varios, un ZIP con un paquete por video. El ZIP completo, el de siempre.
      const full = row.format === 'zip' || row.format === 'project-zip';
      let r: { fileName: string; files: number; skipped: BatchSkipped[] };
      if (full) r = await this.buildFull(row, req, live, tmpOut, q);
      else if (ids.length === 1) r = await this.buildSingle(row, req, live, tmpOut, q);
      else r = await this.buildMany(row, req, live, dir, tmpOut, q);
      skipped = r.skipped;
      if (live.abort) throw new Aborted();
      const out = join(dir, r.fileName);
      await rename(tmpOut, out);
      const bytes = (await stat(out)).size;
      this.media.dirty(out);
      const now = new Date();
      await this.db.downloadBatch.update({
        where: { id: row.id },
        data: {
          status: 'ready',
          progress: 1,
          done: ids.length,
          fileName: r.fileName,
          skipped: skipped as object[],
          bytes: BigInt(bytes),
          finishedAt: now,
          expiresAt: new Date(now.getTime() + BATCH_RETENTION_DAYS * DAY),
          snapshot: (await this.snapshotOf(row, req)) as unknown as Prisma.InputJsonValue,
        },
      });
      // Con links vigentes, el archivo se guarda hasta que venza el último (T5).
      await applyRetention(this.db, row.id);
      this.logger.log(`Lote ${row.id} listo: ${r.files} archivo(s), ${(bytes / 1e6).toFixed(1)} MB en ${Math.round((Date.now() - started) / 1000)} s`);
    } catch (e) {
      live.archive?.abort();
      await rm(tmpOut, { force: true }).catch(() => undefined);
      if (e instanceof Aborted || live.abort) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        await this.media.removed(dir);
        // Eliminado por el usuario: la fila ya no está. Al apagar la API: vuelve a la cola al arrancar.
        return;
      }
      if (e instanceof Skipped) skipped = e.skipped;
      const msg = (e as NodeJS.ErrnoException).code === 'ENOSPC' ? 'El servidor se quedó sin espacio en disco.' : (e as Error).message;
      this.logger.error(`Lote ${row.id}: ${msg}`);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      await this.media.removed(dir);
      const now = new Date();
      await this.db.downloadBatch
        .update({ where: { id: row.id }, data: { status: 'error', error: msg, skipped: skipped as object[], finishedAt: now, expiresAt: new Date(now.getTime() + BATCH_RETENTION_DAYS * DAY) } })
        .catch(() => undefined);
    } finally {
      if (this.live === live) this.live = undefined;
    }
  }

  /** Abre un ZIP hacia `file`; `written` se cumple al cerrarse el archivo. */
  private openZip(live: Live, file: string) {
    const archive = new ZipArchive({ zlib: { level: 6 } });
    live.archive = archive;
    const stream = createWriteStream(file);
    const written = new Promise<void>((resolve, reject) => {
      stream.on('close', resolve);
      stream.on('error', reject);
      archive.on('error', reject);
    });
    written.catch(() => undefined);
    archive.on('warning', (e) => {
      if (e.code !== 'ENOENT') this.logger.warn(`Lote ${live.id}: ${e.message}`);
    });
    archive.pipe(stream);
    return { archive, written };
  }

  /** Versión reducida del final de un video (si se pidió otra calidad), con el avance en vivo. */
  private async encoded(live: Live, vid: string, ownerId: string, q: ExportQuality | undefined): Promise<string | undefined> {
    if (!q) return undefined;
    live.phase = 'encode';
    live.current = vid;
    const path = await this.exports.ensure(vid, ownerId, q);
    if (live.abort) throw new Aborted();
    return path;
  }

  /** Un video en un formato por video: el paquete mismo (.zip del SCORM o del HTML, .html o .mp4). */
  private async buildSingle(row: Row, req: DownloadRequest, live: Live, tmpOut: string, q: ExportQuality | undefined) {
    const vid = (row.videoIds as string[])[0];
    const title = await this.titleOf(vid).catch(() => vid);
    try {
      await this.checkSpace(this.dirOf(row.id), vid, row.ownerId);
      const videoPath = await this.encoded(live, vid, row.ownerId, q);
      live.phase = 'pack';
      const pkg = await this.packages.videoPackage(vid, row.ownerId, req, { videoPath, posterWidth: posterWidthOf(q) });
      if (pkg.kind === 'file') await copyFile(pkg.path, tmpOut);
      else if (pkg.kind === 'data') await writeFile(tmpOut, pkg.data);
      else {
        const { archive, written } = this.openZip(live, tmpOut);
        await pkg.fill(archive);
        await archive.finalize();
        await written;
      }
      live.done = 1;
      return { fileName: pkg.name, files: 1, skipped: [] };
    } catch (e) {
      if (e instanceof Aborted || (e as NodeJS.ErrnoException).code === 'ENOSPC') throw e;
      const reason = (e as Error).message.split('\n')[0];
      throw new Skipped(`El video no se pudo preparar: ${reason}`, [{ id: vid, title, reason }]);
    }
  }

  /** El ZIP completo de un video o del proyecto: final con su reproductor, clips, voz, fotogramas, prompts y ficha. */
  private async buildFull(row: Row, req: DownloadRequest, live: Live, tmpOut: string, q: ExportQuality | undefined) {
    const ids = row.videoIds as string[];
    const logoDataUrl = req.logo ? await this.delivery.logoDataUrl(row.projectId, row.ownerId, req.logo) : undefined;
    // Primero las versiones reducidas (de los que tienen final), una a una.
    const paths = new Map<string, string>();
    if (q) {
      const withFinal = await this.db.generation.findMany({ where: { id: { in: ids }, finalPath: { not: null } }, select: { id: true } });
      for (const g of withFinal) {
        await this.checkSpace(this.dirOf(row.id), g.id, row.ownerId);
        const p = await this.encoded(live, g.id, row.ownerId, q);
        if (p) paths.set(g.id, p);
        live.done += 1;
        await this.db.downloadBatch.update({ where: { id: row.id }, data: { done: live.done, progress: this.progressOf(live) } }).catch(() => undefined);
      }
    }
    live.phase = 'pack';
    const project = row.format === 'project-zip';
    const videos = await this.downloads.videos(ids, project, { logoDataUrl, settings: req.settings && mergeSettings(req.settings as Partial<LogoSettings>), cornerAll: req.cornerAll, videoPath: (id) => paths.get(id), posterWidth: posterWidthOf(q) });
    if (!videos.length) throw new Error(project ? 'El proyecto aún no tiene videos.' : 'Video no encontrado.');
    let readme: string | undefined;
    if (project) {
      const p = await this.db.project.findUnique({ where: { id: row.projectId }, select: { name: true, description: true } });
      readme = this.downloads.projectReadme(p ?? { name: row.projectName, description: null }, videos);
    }
    live.phase = 'close';
    await this.db.downloadBatch.update({ where: { id: row.id }, data: { status: 'packing' } }).catch(() => undefined);
    const { archive, written } = this.openZip(live, tmpOut);
    fillVideosZip(archive, videos, readme);
    await archive.finalize();
    await written;
    return { fileName: row.fileName, files: videos.length, skipped: [] };
  }

  /** Varios videos: un ZIP con el paquete de cada uno (cada SCORM, su .zip tal cual) y un LEEME.txt. */
  private async buildMany(row: Row, req: DownloadRequest, live: Live, dir: string, tmpOut: string, q: ExportQuality | undefined) {
    const ids = row.videoIds as string[];
    const skipped: BatchSkipped[] = [];
    const entries: { name: string; title: string }[] = [];
    const { archive, written } = this.openZip(live, tmpOut);
    // Un archivo queda dentro del ZIP cuando archiver lo procesa ('entry'): hasta entonces no se borra el temporal.
    const added = new Map<string, () => void>();
    (archive as unknown as NodeJS.EventEmitter).on('entry', (e: { name: string }) => added.get(e.name)?.());
    const add = (name: string, src: string | Buffer, store: boolean) =>
      new Promise<void>((resolve, reject) => {
        added.set(name, () => (added.delete(name), resolve()));
        // Si el ZIP termina o falla antes de procesar este archivo, es que se abortó.
        written.then(() => reject(new Aborted()), reject);
        if (typeof src === 'string') archive.file(src, { name, store });
        else archive.append(src, { name, store });
      });

    for (const [i, vid] of ids.entries()) {
      if (live.abort) throw new Aborted();
      live.current = vid;
      let title = vid;
      try {
        title = await this.titleOf(vid);
        await this.checkSpace(dir, vid, row.ownerId);
        const videoPath = await this.encoded(live, vid, row.ownerId, q);
        live.phase = 'pack';
        const pkg = await this.packages.videoPackage(vid, row.ownerId, req, { videoPath, posterWidth: posterWidthOf(q) });
        const name = batchEntryName(i, ids.length, pkg.name);
        if (pkg.kind === 'file') await add(name, pkg.path, true);
        else if (pkg.kind === 'data') await add(name, Buffer.from(pkg.data), false);
        else {
          // El ZIP de la descarga individual, tal cual, en un temporal que se borra en cuanto entra al lote.
          const tmp = join(dir, `${String(i).padStart(4, '0')}.part.zip`);
          const inner = new ZipArchive({ zlib: { level: 6 } });
          const done = new Promise<void>((resolve, reject) => {
            const ws = createWriteStream(tmp);
            ws.on('close', resolve);
            ws.on('error', reject);
            inner.on('error', reject);
            inner.pipe(ws);
          });
          await pkg.fill(inner);
          await inner.finalize();
          await done;
          await add(name, tmp, true);
          await rm(tmp, { force: true });
        }
        entries.push({ name, title });
      } catch (e) {
        if (e instanceof Aborted || (e as NodeJS.ErrnoException).code === 'ENOSPC') throw e;
        skipped.push({ id: vid, title, reason: (e as Error).message.split('\n')[0] });
        this.logger.warn(`Lote ${row.id}: ${vid} no entra: ${(e as Error).message.split('\n')[0]}`);
      }
      live.done = i + 1;
      live.phase = undefined;
      await this.db.downloadBatch.update({ where: { id: row.id }, data: { done: live.done, progress: this.progressOf(live), skipped: skipped as object[] } }).catch(() => undefined);
    }
    if (!entries.length) throw new Skipped(skipped.length === 1 ? `El video no se pudo preparar: ${skipped[0].reason}` : 'Ningún video se pudo preparar (el motivo de cada uno está en la lista).', skipped);
    live.phase = 'close';
    await this.db.downloadBatch.update({ where: { id: row.id }, data: { status: 'packing' } });
    archive.append(batchReadme({ projectName: row.projectName, format: row.format as BatchFormat, quality: q, entries, skipped, at: new Date() }), { name: 'LEEME.txt' });
    await archive.finalize();
    await written;
    return { fileName: row.fileName, files: entries.length, skipped };
  }

  private async titleOf(id: string): Promise<string> {
    const g = await this.db.generation.findFirst({ where: { id }, select: { text: true } });
    return g ? this.delivery.videoTitle(g.text) : id;
  }

  /** Antes de cada video: queda espacio para él (el final, como referencia) y un margen de 1 GB. */
  private async checkSpace(dir: string, id: string, ownerId: string) {
    const f = await this.delivery.finalFile(id, ownerId).catch(() => undefined);
    const s = await statfs(dir);
    const free = s.bavail * s.bsize;
    if (free < MIN_FREE_BYTES + (f?.bytes ?? 0) * 1.5) {
      const err = new Error('El servidor se quedó sin espacio en disco.') as NodeJS.ErrnoException;
      err.code = 'ENOSPC';
      throw err;
    }
  }

  /** Borra los lotes vencidos (y, al arrancar, las carpetas de lotes que ya no existen). */
  async purge(orphans = false) {
    const expired = await this.db.downloadBatch.findMany({ where: { expiresAt: { lt: new Date() } }, select: { id: true } });
    for (const r of expired) {
      await rm(this.dirOf(r.id), { recursive: true, force: true });
      await this.media.removed(this.dirOf(r.id));
      await this.db.downloadBatch.delete({ where: { id: r.id } }).catch(() => undefined);
    }
    if (expired.length) this.logger.log(`${expired.length} lote(s) vencido(s) borrado(s)`);
    if (!orphans || !existsSync(this.root())) return;
    const known = new Set((await this.db.downloadBatch.findMany({ select: { id: true } })).map((r) => r.id));
    for (const d of await readdir(this.root()))
      if (!known.has(d)) {
        await rm(join(this.root(), d), { recursive: true, force: true });
        await this.media.removed(join(this.root(), d));
      }
  }
}
