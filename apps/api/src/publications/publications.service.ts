import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { UNPUBLISHED, variantOf } from './variant.js';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { ZipArchive } from 'archiver';
import { join } from 'node:path';
import { Prisma, type Db } from '@wilox/db';
import {
  type AuthUser,
  BATCH_RETENTION_DAYS,
  PUBLISHED_BATCH_FORMATS,
  isOriginalQuality,
  qualityLabel,
  type BatchSkipped,
  type CreateLightScormRequest,
  type CreateRiseRequest,
  type DownloadLogo,
  type ExportQuality,
  type LightScormFormat,
  type LogoCorner,
  type LogoSettings,
  type PublicationInfo,
  type PublicationStatus,
  type PublicationUse,
} from '@wilox/shared';
import { DB } from '../db/db.module.js';
import { AccessService } from '../access/access.service.js';
import { DeliveryService } from '../delivery/delivery.service.js';
import { ExportsService } from '../delivery/exports.service.js';
import { LogoBurnService } from '../delivery/logo-burn.service.js';
import { ffmpeg } from '../media/ffmpeg.js';
import { MediaService } from '../storage/media.service.js';
import { riseHtml, riseTxt, type RiseItem } from '../delivery/rise.js';
import { mergeSettings } from '../delivery/delivery.service.js';
import { posterWidthOf } from '../delivery/packages.service.js';
import type { ScormVersion } from '../delivery/scorm.js';
import { batchEntryName } from '../downloads/batches.service.js';
import { applyRetention } from '../downloads/links.js';
import { safeName } from '../downloads/zip.js';
import { brand } from '../brand/brand.js';

/** Nombres fijos dentro de la carpeta pública. */
export const PUBLIC_FILES = { video: 'video.mp4', subtitles: 'subtitulos.vtt', poster: 'portada.jpg' } as const;
export const PUBLIC_NAMES: readonly string[] = Object.values(PUBLIC_FILES);

/** Cada cuánto se buscan publicaciones con un final más nuevo que lo publicado. */
const CHECK_EVERY_MS = 60_000;
const ORPHANS_EVERY_MS = 60 * 60_000;

interface Source {
  finalPath: string;
  posterSec: number;
  /** Huella del logo dibujado (T2, ADR-102): 'sin-logo' si el proyecto no tenía logo al publicar. */
  logoSig?: string;
}

interface RiseBatchRequest {
  format: 'rise';
  quality: ExportQuality;
  logo: 'project' | 'none';
  rise: { doc: 'html' | 'txt'; subtitlesOn: boolean };
  /** Publicaciones de cada video, en el orden del documento (desde que se piden). */
  pubIds?: string[];
}

interface LightBatchRequest {
  format: LightScormFormat;
  quality: ExportQuality;
  logo?: DownloadLogo;
  settings?: Partial<LogoSettings>;
  cornerAll?: LogoCorner;
  light: { each: boolean };
  /** Título del paquete del proyecto. */
  title: string;
  pubIds?: string[];
}

const stampOf = (at: Date) => {
  const local = new Date(at.getTime() - 3 * 3_600_000).toISOString();
  return `${local.slice(0, 10).replaceAll('-', '')}-${local.slice(11, 16).replace(':', '')}`;
};

/** Parte de un nombre de archivo: sin tildes ni signos y sin punto o guion al final («…duplicar.» → «…duplicar»). */
const namePart = (s: string, max = 60) => safeName(s).slice(0, max).replace(/[._-]+$/, '') || 'video';

/** Nombre del SCORM liviano: «wilox_<título>_scorm12-nube[_720p][_uno-por-video]_<n>video(s)_<fecha>.zip». */
export function lightScormFileName(title: string, version: '1.2' | '2004', each: boolean, q: ExportQuality, videos: number, at: Date): string {
  const quality = isOriginalQuality(q) ? '' : `_${q.height}p`;
  return `wilox_${namePart(title)}_scorm${version === '1.2' ? '12' : '2004'}-nube${quality}${each ? '_uno-por-video' : ''}_${videos}video${videos === 1 ? '' : 's'}_${stampOf(at)}.zip`;
}

/** LEEME.txt del SCORM liviano: de dónde se carga cada video y qué pasa si se despublica. */
export function lightScormReadme(version: ScormVersion, items: { title: string; url: string }[]): string {
  return [
    `${brand.name} · SCORM ${version} liviano`,
    '',
    'Este paquete no lleva el video adentro: el reproductor lo carga desde la nube (dirección fija). El logo, la',
    'portada y los subtítulos sí van en el paquete. Se sube al LMS (p. ej. Moodle) como cualquier SCORM.',
    '',
    `- Si el video se corrige en ${brand.name}, el curso muestra la versión nueva en unos minutos (misma dirección).`,
    `- Si el video se despublica en ${brand.name}, este SCORM deja de mostrarlo.`,
    '- Necesita internet para ver el video.',
    '',
    ...items.map((x) => `${x.title}\r\n  ${x.url}`),
    '',
  ].join('\r\n');
}

/** Escribe un ZIP en un archivo. */
async function writeZip(file: string, fill: (z: ZipArchive) => Promise<void>) {
  const z = new ZipArchive({ zlib: { level: 6 } });
  const done = new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(file);
    ws.on('close', resolve);
    ws.on('error', reject);
    z.on('error', reject);
    z.pipe(ws);
  });
  await fill(z);
  await z.finalize();
  await done;
}

/** Un ZIP en memoria (paquetes de unos KB). */
async function zipBuffer(fill: (z: ZipArchive) => Promise<void>): Promise<Buffer> {
  const z = new ZipArchive({ zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  const done = new Promise<void>((resolve, reject) => {
    sink.on('data', (c: Buffer) => chunks.push(c));
    sink.on('end', resolve);
    z.on('error', reject);
  });
  z.pipe(sink);
  await fill(z);
  await z.finalize();
  await done;
  return Buffer.concat(chunks);
}

/** Nombre del documento: como los lotes, con la hora de Chile/Brasil (UTC−3). */
export function riseFileName(title: string, doc: 'html' | 'txt', videos: number, at: Date): string {
  const local = new Date(at.getTime() - 3 * 3_600_000).toISOString();
  const stamp = `${local.slice(0, 10).replaceAll('-', '')}-${local.slice(11, 16).replace(':', '')}`;
  const name = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'video';
  return `wilox_${name}_rise360_${videos}video${videos === 1 ? '' : 's'}_${stamp}.${doc}`;
}


interface Files {
  video: string;
  subtitles?: string;
  poster?: string;
}

type Row = Prisma.PublicationGetPayload<{ include: { generation: { select: { text: true; finalPath: true } } } }>;

/**
 * Clave para reutilizar una publicación: misma calidad y con o sin el logo del proyecto dibujado. El logo no entra
 * por su huella: si cambian el logo, sus ajustes o las esquinas, la misma publicación (misma URL) se rehace.
 */
export { UNPUBLISHED, variantOf };
const LIVE = { status: { not: UNPUBLISHED } };

/**
 * Publicaciones (hito 9, T1, ADR-101): copia del final de un video (en la calidad elegida) con sus subtítulos y
 * su portada en la carpeta pública `wilox-motion/<entorno>/publico/<token>/`, con URLs estables que sirve
 * CloudFront. Se preparan de a una (la versión reducida pasa por la cola de ffmpeg, como las descargas) y siguen
 * al final vigente: cada minuto se buscan las que quedaron atrás y se vuelven a publicar con la misma URL. Si la
 * API se reinicia, lo que estaba a medias vuelve a la cola. Cada hora se borran las carpetas públicas sin fila
 * (p. ej. de un video eliminado).
 */
@Injectable()
export class PublicationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Publicaciones');
  private timers: NodeJS.Timeout[] = [];
  private kicking = false;
  private again = false;
  private current?: { id: string; generationId: string; quality: ExportQuality; phase: 'encode' | 'upload' };

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly delivery: DeliveryService,
    private readonly exports: ExportsService,
    private readonly burn: LogoBurnService,
    private readonly media: MediaService,
    private readonly access: AccessService,
  ) {}

  async onModuleInit() {
    await this.db.publication.updateMany({ where: { status: 'preparing' }, data: { status: 'queued' } });
    this.timers.push(setInterval(() => void this.check().catch((e: Error) => this.logger.warn(`Revisión: ${e.message}`)), CHECK_EVERY_MS));
    this.timers.push(setInterval(() => void this.orphans().catch((e: Error) => this.logger.warn(`Limpieza: ${e.message}`)), ORPHANS_EVERY_MS));
    this.timers.push(setTimeout(() => void this.orphans().catch(() => undefined), 5 * 60_000));
    // Documentos para Rise (T3b) y SCORM livianos (T4) en «Descargas»: cada 4 s mientras haya alguno en curso.
    this.timers.push(setInterval(() => void this.batchTick().catch((e: Error) => this.logger.warn(`Descargas publicadas: ${e.message}`)), 4_000));
    for (const t of this.timers) t.unref();
    setImmediate(() => void this.check().catch(() => undefined));
  }

  onModuleDestroy() {
    for (const t of this.timers) clearInterval(t);
  }

  // ─── Consultas ─────────────────────────────────────────────────────────────────────────────────────

  private info(r: Row): PublicationInfo {
    const files = (r.files ?? null) as Files | null;
    const src = (r.source ?? null) as Source | null;
    const url = (name: string) => this.media.publicUrl(r.token, name);
    const quality = r.quality as unknown as ExportQuality;
    const preparing = this.current?.id === r.id;
    return {
      id: r.id,
      generationId: r.generationId,
      title: this.delivery.videoTitle(r.generation.text),
      quality,
      logo: !!r.logo,
      status: r.status as PublicationStatus,
      error: r.error ?? undefined,
      progress: preparing ? this.progressOf(r, quality) : undefined,
      urls: { video: url(PUBLIC_FILES.video), subtitles: files?.subtitles ? url(files.subtitles) : undefined, poster: files?.poster ? url(files.poster) : undefined },
      bytes: r.bytes === null ? undefined : Number(r.bytes),
      createdAt: r.createdAt.toISOString(),
      publishedAt: r.publishedAt?.toISOString(),
      stale: !!src && !!r.generation.finalPath && src.finalPath !== r.generation.finalPath,
      uses: ((r.uses ?? []) as PublicationUse[]).filter(Boolean),
    };
  }

  private progressOf(r: Row, quality: ExportQuality) {
    if (this.current!.phase === 'upload') return 0.99;
    if (r.logo) return Math.min(0.98, this.burn.progressOf(r.generationId, quality));
    return isOriginalQuality(quality) ? 0.5 : Math.min(0.98, this.exports.progressOf(r.generationId, quality));
  }

  private readonly include = { generation: { select: { text: true, finalPath: true } } } as const;

  // Hito 11 (ADR-142): las publicaciones son del proyecto (las ve y gestiona todo el que tiene acceso, lo comprueba el
  // guard o `row`); `ownerId` es quien la creó.
  async list(generationId: string, _ownerId: string): Promise<PublicationInfo[]> {
    const rows = await this.db.publication.findMany({ where: { generationId, ...LIVE }, include: this.include, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => this.info(r));
  }

  async listProject(projectId: string, _ownerId: string): Promise<PublicationInfo[]> {
    const rows = await this.db.publication.findMany({ where: { generation: { projectId }, ...LIVE }, include: this.include, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => this.info(r));
  }

  private async row(id: string, user: AuthUser) {
    const r = /^[0-9a-f-]{36}$/i.test(id) ? await this.db.publication.findFirst({ where: { id, ...LIVE }, include: { ...this.include, generation: { select: { text: true, finalPath: true, projectId: true } } } }) : null;
    if (!r || !(await this.access.role(r.generation.projectId, user))) throw new NotFoundException('Publicación no encontrada.');
    return r;
  }

  // ─── Pedidos ───────────────────────────────────────────────────────────────────────────────────────

  /**
   * Publica un video en una calidad (o devuelve la publicación que ya existe con esa calidad y logo, sumando el
   * uso). La preparación sigue en segundo plano.
   */
  async ensure(generationId: string, ownerId: string, o: { quality: ExportQuality; logo?: boolean; use?: PublicationUse }): Promise<PublicationInfo> {
    const g = await this.db.generation.findFirst({ where: { id: generationId, trashedAt: null, deletedAt: null }, select: { id: true, finalPath: true } });
    if (!g) throw new NotFoundException('Video no encontrado.');
    if (!g.finalPath) throw new BadRequestException('El video aún no tiene final.');
    const variant = variantOf(o.quality, o.logo);
    const use = o.use ?? 'manual';
    let r = await this.db.publication.findUnique({ where: { generationId_variant: { generationId, variant } }, include: this.include });
    if (!r) {
      try {
        r = await this.db.publication.create({
          data: {
            token: randomBytes(18).toString('base64url'),
            ownerId,
            generationId,
            variant,
            quality: o.quality as unknown as Prisma.InputJsonValue,
            logo: o.logo ? { mode: 'project' } : Prisma.DbNull,
            uses: [use],
          },
          include: this.include,
        });
      } catch (e) {
        // Dos pedidos iguales a la vez: gana el primero.
        if ((e as { code?: string }).code !== 'P2002') throw e;
        r = await this.db.publication.findUniqueOrThrow({ where: { generationId_variant: { generationId, variant } }, include: this.include });
      }
    } else {
      const uses = ((r.uses ?? []) as PublicationUse[]).filter(Boolean);
      const data: Prisma.PublicationUpdateInput = {};
      if (!uses.includes(use)) data.uses = [...uses, use];
      // Una que falló se reintenta al pedirla otra vez.
      if (r.status === 'error') Object.assign(data, { status: 'queued', error: null });
      // Una despublicada vuelve con su misma dirección (ADR-139).
      if (r.status === UNPUBLISHED) Object.assign(data, { status: 'queued', error: null, uses: [use] });
      if (Object.keys(data).length) r = await this.db.publication.update({ where: { id: r.id }, data, include: this.include });
    }
    void this.kick();
    return this.info(r);
  }

  /** Vuelve a publicar (misma URL): p. ej. tras cambiar la portada del video. */
  async refresh(id: string, user: AuthUser): Promise<PublicationInfo> {
    const r = await this.row(id, user);
    const u = await this.db.publication.update({ where: { id: r.id }, data: { status: 'queued', error: null }, include: this.include });
    void this.kick();
    return this.info(u);
  }

  /**
   * Despublica: borra la carpeta pública; la URL deja de responder (por CloudFront, en MEDIA_PUBLIC_MAX_AGE_SEC). La
   * fila queda como despublicada con su token (ADR-139): publicar de nuevo el video con esa calidad y logo recupera
   * la misma dirección.
   */
  async remove(id: string, user: AuthUser): Promise<{ ok: true }> {
    const r = await this.row(id, user);
    if (this.current?.id === r.id) throw new BadRequestException('Se está publicando ahora: espera a que termine y vuelve a intentarlo.');
    await this.media.unpublish(r.token);
    await this.db.publication.update({
      where: { id: r.id },
      data: { status: UNPUBLISHED, error: null, files: Prisma.DbNull, source: Prisma.DbNull, bytes: null, publishedAt: null, uses: [] },
    });
    return { ok: true };
  }

  /** Para la ruta pública sin S3: la carpeta de un token publicado (o undefined). */
  async localFile(token: string, name: string): Promise<string | undefined> {
    if (!PUBLIC_NAMES.includes(name) || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return undefined;
    const r = await this.db.publication.findFirst({ where: { token, ...LIVE }, select: { files: true } });
    const files = (r?.files ?? null) as Files | null;
    if (!files || !Object.values(files).includes(name)) return undefined;
    return join(this.media.publicDir(token), name);
  }


  // ─── Estado «Publicado» y avisos (T3c, ADR-105) ──────────────────────────────────────────────────────

  /** Usos (sin repetir) de las publicaciones de cada video: un video con alguna publicación está «publicado». */
  async publishedUses(generationIds: string[]): Promise<Map<string, PublicationUse[]>> {
    const out = new Map<string, PublicationUse[]>();
    if (!generationIds.length) return out;
    const rows = await this.db.publication.findMany({ where: { generationId: { in: generationIds }, ...LIVE }, select: { generationId: true, uses: true } });
    for (const r of rows) {
      const set = new Set(out.get(r.generationId) ?? []);
      for (const u of ((r.uses ?? []) as PublicationUse[]).filter(Boolean)) set.add(u);
      if (!set.size) set.add('manual');
      out.set(r.generationId, [...set]);
    }
    return out;
  }

  /** «Rise 360 y publicado a mano». */
  usesText(uses: PublicationUse[]): string {
    const label: Record<PublicationUse, string> = { rise: 'Rise 360', scorm: 'SCORM liviano', manual: 'publicado a mano' };
    const order: PublicationUse[] = ['rise', 'scorm', 'manual'];
    const parts = order.filter((u) => uses.includes(u)).map((u) => label[u]);
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}` : (parts[0] ?? 'publicado');
  }

  /**
   * Antes de cambiar un video publicado (su final, su logo dibujado o su portada): sin la confirmación del usuario
   * (cabecera `x-confirm-change: 1`), responde 409 con el aviso; la app lo muestra y repite el pedido confirmado.
   */
  async guardVideo(generationId: string, ownerId: string, confirmed: boolean): Promise<void> {
    if (confirmed) return;
    const uses = (await this.publishedUses([generationId])).get(generationId);
    if (!uses) return;
    const g = await this.db.generation.findFirst({ where: { id: generationId }, select: { id: true } });
    if (!g) return;
    throw new ConflictException({
      code: 'confirm',
      title: 'Este video está publicado',
      message: `Está publicado (${this.usesText(uses)}). Si lo cambias, quienes lo ven en esas direcciones —el curso del cliente— verán la nueva versión en unos minutos.`,
      action: 'Cambiar de todos modos',
    });
  }

  /** Antes de cambiar el logo del proyecto o sus ajustes: avisa si hay videos publicados con el logo dibujado. */
  async guardProjectLogo(projectId: string, ownerId: string, confirmed: boolean): Promise<void> {
    if (confirmed) return;
    const rows = await this.db.publication.findMany({ where: { logo: { not: Prisma.DbNull }, generation: { projectId }, ...LIVE }, select: { generationId: true } });
    const n = new Set(rows.map((r) => r.generationId)).size;
    if (!n) return;
    throw new ConflictException({
      code: 'confirm',
      title: 'Hay videos publicados con este logo',
      message: `${n} video${n === 1 ? '' : 's'} de este proyecto ${n === 1 ? 'está publicado' : 'están publicados'} con el logo dibujado. Si cambias el logo o sus ajustes, se vuelven a publicar y quienes los ven —el curso del cliente— verán el logo nuevo en unos minutos.`,
      action: 'Cambiar de todos modos',
    });
  }

  /**
   * Antes de mover un video a otro proyecto: siempre se confirma, porque toma el logo del proyecto nuevo (en sus
   * descargas y, si está publicado con logo, en lo que ve el cliente).
   */
  async guardMove(generationId: string, ownerId: string, to: { id: string; name: string; hasLogo: boolean }, confirmed: boolean): Promise<void> {
    if (confirmed) return;
    const g = await this.db.generation.findFirst({ where: { id: generationId }, select: { projectId: true } });
    if (!g || g.projectId === to.id) return;
    const pubs = await this.db.publication.findMany({ where: { generationId, ...LIVE }, select: { uses: true, logo: true } });
    const logo = to.hasLogo ? `el logo de «${to.name}»` : `el logo de «${to.name}» (no tiene: queda sin logo)`;
    const uses = (await this.publishedUses([generationId])).get(generationId);
    throw new ConflictException({
      code: 'confirm',
      title: pubs.length ? 'Mover un video publicado' : 'Mover el video',
      message: pubs.length
        ? `Está publicado (${this.usesText(uses ?? [])}). Al moverlo toma ${logo}${pubs.some((x) => x.logo) ? ': se vuelve a publicar y el cliente verá el cambio de logo en unos minutos' : ''}.`
        : `Al moverlo toma ${logo} en sus descargas y publicaciones.`,
      action: 'Mover',
    });
  }

  // ─── Código para Rise 360 (T3 y T3b, ADR-103 y ADR-104) ─────────────────────────────────────────────

  /**
   * Pide el documento para Rise como una fila de «Descargas» (`DownloadBatch` con formato `rise`): se publica cada
   * video (calidad y logo elegidos, uso «rise»; lo ya publicado se reutiliza) y, cuando todos están listos, se
   * escribe el documento en `downloads/<id>/`. Lo sigue `batchTick` (cada pocos segundos), no la cola de lotes.
   */
  async createRiseBatch(ownerId: string, o: CreateRiseRequest & { projectId: string; projectName: string; title: string; generationIds: string[] }): Promise<string> {
    if (!o.generationIds.length) throw new BadRequestException('No hay videos con final.');
    const now = new Date();
    const request: RiseBatchRequest = { format: 'rise', quality: o.quality, logo: o.logo ? 'project' : 'none', rise: { doc: o.doc, subtitlesOn: o.subtitlesOn } };
    const row = await this.db.downloadBatch.create({
      data: {
        ownerId,
        projectId: o.projectId,
        projectName: o.projectName,
        format: 'rise',
        request: request as unknown as Prisma.InputJsonValue,
        videoIds: o.generationIds,
        fileName: riseFileName(o.title, o.doc, o.generationIds.length, now),
        createdAt: now,
      },
    });
    this.logger.log(`Documento para Rise ${row.id}: ${o.generationIds.length} video(s) de «${o.projectName}» · ${qualityLabel(o.quality)}${o.logo ? ' con logo' : ''}`);
    setImmediate(() => void this.batchTick());
    return row.id;
  }

  /**
   * SCORM liviano (T4, ADR-108): como el documento para Rise, una fila de «Descargas» (formato `scorm12-light` o
   * `scorm2004-light`) que primero publica cada video (calidad elegida, sin logo dibujado, uso «scorm») y, con todo
   * listo, arma el paquete con el reproductor apuntando a esas direcciones. El logo, la portada y los subtítulos van
   * dentro del paquete; el video no.
   */
  async createLightScormBatch(ownerId: string, o: CreateLightScormRequest & { projectId: string; projectName: string; title: string; generationIds: string[] }): Promise<string> {
    if (!o.generationIds.length) throw new BadRequestException('No hay videos con final.');
    const now = new Date();
    const format: LightScormFormat = o.version === '1.2' ? 'scorm12-light' : 'scorm2004-light';
    // Siempre un SCORM por video (decisión de Leonardo): con varios videos, un ZIP con un SCORM por cada uno.
    const each = o.generationIds.length > 1;
    const request: LightBatchRequest = { format, quality: o.quality, logo: o.logo, settings: o.settings, cornerAll: o.cornerAll, light: { each }, title: o.title };
    const row = await this.db.downloadBatch.create({
      data: {
        ownerId,
        projectId: o.projectId,
        projectName: o.projectName,
        format,
        request: request as unknown as Prisma.InputJsonValue,
        videoIds: o.generationIds,
        fileName: lightScormFileName(o.title, o.version, each, o.quality, o.generationIds.length, now),
        createdAt: now,
      },
    });
    this.logger.log(`SCORM liviano ${row.id}: ${o.generationIds.length} video(s) de «${o.projectName}» · SCORM ${o.version}${each ? ' (uno por video)' : ''} · ${qualityLabel(o.quality)}`);
    setImmediate(() => void this.batchTick());
    return row.id;
  }

  private ticking = false;

  /** Avanza las filas de «Descargas» que publican primero (Rise y SCORM liviano): publica, mide el avance y arma el archivo. */
  async batchTick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const rows = await this.db.downloadBatch.findMany({ where: { format: { in: [...PUBLISHED_BATCH_FORMATS] }, status: { in: ['queued', 'preparing'] } }, orderBy: { createdAt: 'asc' } });
      for (const b of rows)
        await this.batchStep(b).catch(async (e: Error) => {
          this.logger.warn(`${b.format === 'rise' ? 'Documento para Rise' : 'SCORM liviano'} ${b.id}: ${e.message}`);
          await this.batchFail(b.id, e.message.split('\n')[0]);
        });
    } finally {
      this.ticking = false;
    }
  }

  private async batchFail(id: string, error: string) {
    const now = new Date();
    await this.db.downloadBatch.updateMany({ where: { id }, data: { status: 'error', error, finishedAt: now, expiresAt: new Date(now.getTime() + BATCH_RETENTION_DAYS * 86_400_000) } });
  }

  private async batchStep(b: { id: string; ownerId: string; format: string; status: string; request: Prisma.JsonValue; videoIds: Prisma.JsonValue; done: number; progress: number; projectName: string; fileName: string }) {
    const req = b.request as unknown as RiseBatchRequest | LightBatchRequest;
    const ids = b.videoIds as string[];
    // Rise: el logo dibujado en el video. SCORM liviano: sin logo dibujado (lo dibuja el reproductor del paquete).
    const pub = req.format === 'rise' ? { quality: req.quality, logo: req.logo === 'project', use: 'rise' as const } : { quality: req.quality, logo: false, use: 'scorm' as const };
    if (b.status === 'queued') {
      // Publicar (o reutilizar) cada video; los que no tienen final quedan fuera con su motivo.
      const pubIds: string[] = [];
      const skipped: BatchSkipped[] = [];
      for (const id of ids) {
        try {
          pubIds.push((await this.ensure(id, b.ownerId, pub)).id);
        } catch (e) {
          const g = await this.db.generation.findUnique({ where: { id }, select: { text: true } });
          skipped.push({ id, title: g ? this.delivery.videoTitle(g.text) : id, reason: (e as Error).message });
        }
      }
      if (!pubIds.length) throw new Error(skipped[0]?.reason ?? 'Ningún video se pudo publicar.');
      await this.db.downloadBatch.update({
        where: { id: b.id },
        data: { status: 'preparing', startedAt: new Date(), progress: 0, done: 0, error: null, skipped: skipped as unknown as Prisma.InputJsonValue, request: { ...req, pubIds } as unknown as Prisma.InputJsonValue },
      });
      return;
    }
    const pubIds = req.pubIds ?? [];
    const rows = await this.db.publication.findMany({ where: { id: { in: pubIds }, ...LIVE }, include: this.include });
    // Despublicada mientras tanto: se vuelve a pedir (se publica de nuevo, con la misma dirección).
    if (rows.length !== pubIds.length) {
      await this.db.downloadBatch.update({ where: { id: b.id }, data: { status: 'queued' } });
      return;
    }
    const failed = rows.find((x) => x.status === 'error');
    if (failed) throw new Error(`${this.delivery.videoTitle(failed.generation.text)}: ${failed.error ?? 'no se pudo publicar'}`);
    const byId = new Map(rows.map((x) => [x.id, this.info(x)]));
    const infos = pubIds.map((id) => byId.get(id)!);
    const done = infos.filter((p) => p.status === 'ready' && !p.stale).length;
    const partial = infos.reduce((n, p) => n + (p.status === 'ready' && !p.stale ? 0 : (p.progress ?? 0)), 0);
    const progress = Math.min(0.99, (done + partial) / infos.length);
    if (done < infos.length) {
      if (done !== b.done || Math.abs(progress - b.progress) > 0.01) await this.db.downloadBatch.update({ where: { id: b.id }, data: { done, progress } });
      return;
    }
    // Todo publicado: el documento o el paquete.
    const dir = join(this.media.root, 'downloads', b.id);
    await mkdir(dir, { recursive: true });
    const file = join(dir, b.fileName);
    let bytes: number;
    if (req.format === 'rise') {
      const items: RiseItem[] = infos.map((p, i) => ({ title: infos.length > 1 ? `${i + 1}. ${p.title}` : p.title, video: p.urls.video, subtitles: p.urls.subtitles, poster: p.urls.poster }));
      const title = infos.length > 1 ? b.projectName : infos[0].title;
      const o = { subtitlesOn: req.rise.subtitlesOn, quality: qualityLabel(req.quality), logo: req.logo === 'project', createdAt: new Date() };
      const body = req.rise.doc === 'html' ? riseHtml(title, items, o) : riseTxt(title, items, o);
      await writeFile(file, body);
      bytes = Buffer.byteLength(body);
    } else bytes = await this.writeLightScorm(b, req, infos, file);
    this.media.dirty(file);
    const now = new Date();
    await this.db.downloadBatch.update({
      where: { id: b.id },
      data: { status: 'ready', progress: 1, done: infos.length, bytes: BigInt(bytes), finishedAt: now, expiresAt: new Date(now.getTime() + BATCH_RETENTION_DAYS * 86_400_000) },
    });
    await applyRetention(this.db, b.id); // con links vigentes se guarda más (T5)
    this.logger.log(`${req.format === 'rise' ? 'Documento para Rise' : 'SCORM liviano'} ${b.id} listo (${infos.length} video(s), ${(bytes / 1024).toFixed(0)} KB).`);
  }

  /** El SCORM liviano: el SCORM del video o, con varios (`each`), un ZIP con un SCORM por video. Devuelve el peso. */
  private async writeLightScorm(b: { id: string; ownerId: string; projectName: string }, req: LightBatchRequest, infos: PublicationInfo[], file: string): Promise<number> {
    const version: ScormVersion = req.format === 'scorm12-light' ? '1.2' : '2004';
    const urls = new Map(infos.map((p) => [p.generationId, p.urls.video]));
    const posterWidth = posterWidthOf(req.quality);
    const opts = { ownerId: b.ownerId, logo: req.logo, settings: req.settings && mergeSettings(req.settings), cornerAll: req.cornerAll, posterWidth, remoteVideo: (id: string) => urls.get(id) };
    const readme = lightScormReadme(version, infos.map((p) => ({ title: p.title, url: p.urls.video })));
    const tmp = `${file}.tmp`;
    if (!req.light.each || infos.length === 1) {
      const p = infos[0];
      await writeZip(tmp, async (z) => {
        await this.delivery.addScorm(z, version, { ...opts, id: p.generationId, title: `${b.projectName} · ${p.title}`, videoIds: [p.generationId] });
        z.append(readme, { name: 'LEEME.txt' });
      });
    } else {
      // Un SCORM por video, cada uno armado en memoria (pesan unos KB) y guardado dentro del ZIP.
      const inner: { name: string; data: Buffer }[] = [];
      for (const [i, p] of infos.entries()) {
        const data = await zipBuffer(async (z) => {
          await this.delivery.addScorm(z, version, { ...opts, id: p.generationId, title: `${b.projectName} · ${p.title}`, videoIds: [p.generationId] });
          z.append(lightScormReadme(version, [{ title: p.title, url: p.urls.video }]), { name: 'LEEME.txt' });
        });
        inner.push({ name: batchEntryName(i, infos.length, `${namePart(p.title, 50)}_scorm${version === '1.2' ? '12' : '2004'}.zip`), data });
      }
      await writeZip(tmp, async (z) => {
        for (const x of inner) z.append(x.data, { name: x.name, store: true });
        z.append(readme, { name: 'LEEME.txt' });
      });
    }
    await rename(tmp, file);
    return (await stat(file)).size;
  }

  // ─── Preparación ───────────────────────────────────────────────────────────────────────────────────

  /** Busca las publicaciones que quedaron atrás del final vigente y las vuelve a la cola. */
  async check() {
    const rows = await this.db.publication.findMany({
      where: { status: { in: ['ready', 'error'] } },
      select: { id: true, status: true, source: true, logo: true, ownerId: true, generationId: true, quality: true, generation: { select: { finalPath: true } } },
    });
    const stale: string[] = [];
    for (const r of rows) {
      const src = (r.source ?? null) as Source | null;
      if (!r.generation.finalPath) continue;
      // Las que fallaron solo se reintentan solas si hay un final nuevo.
      if (!src) {
        if (r.status === 'ready') stale.push(r.id);
        continue;
      }
      if (src.finalPath !== r.generation.finalPath) {
        stale.push(r.id);
        continue;
      }
      // La portada elegida en el video (T3c): la publicada se rehace.
      if (r.status === 'ready') {
        const v = await this.delivery.video(r.generationId, r.ownerId).catch(() => undefined);
        if (v && Math.abs(v.posterSec - src.posterSec) > 0.01) {
          stale.push(r.id);
          continue;
        }
      }
      // Con el logo dibujado: si cambió el logo, sus ajustes o la esquina de algún clip (T2, ADR-102).
      if (r.logo && r.status === 'ready') {
        const sig = await this.burn.signature(r.generationId, r.ownerId, r.quality as unknown as ExportQuality).catch(() => src.logoSig);
        if ((sig ?? 'sin-logo') !== (src.logoSig ?? 'sin-logo')) stale.push(r.id);
      }
    }
    if (stale.length) {
      await this.db.publication.updateMany({ where: { id: { in: stale } }, data: { status: 'queued', error: null } });
      this.logger.log(`${stale.length} publicación(es) con un final, un logo, unas esquinas o una portada nuevos: se vuelven a publicar.`);
    }
    await this.kick();
  }

  /** Prepara de a una las publicaciones en cola (por orden de pedido). */
  async kick() {
    if (this.kicking) {
      this.again = true;
      return;
    }
    this.kicking = true;
    this.again = false;
    try {
      for (;;) {
        const r = await this.db.publication.findFirst({ where: { status: 'queued' }, orderBy: { updatedAt: 'asc' }, include: this.include });
        if (!r) break;
        await this.publish(r);
      }
    } finally {
      this.kicking = false;
    }
    // Lo pedido mientras terminaba la vuelta anterior.
    if (this.again) await this.kick();
  }

  private async publish(r: Row) {
    const quality = r.quality as unknown as ExportQuality;
    await this.db.publication.update({ where: { id: r.id }, data: { status: 'preparing', error: null } });
    this.current = { id: r.id, generationId: r.generationId, quality, phase: 'encode' };
    const tmpDir = join(this.media.root, 'publico', `_tmp_${randomUUID().slice(0, 8)}`);
    try {
      const v = await this.delivery.video(r.generationId, r.ownerId);
      const g = await this.db.generation.findUniqueOrThrow({ where: { id: r.generationId }, select: { finalPath: true } });
      if (!g.finalPath) throw new Error('El video ya no tiene final.');
      const source: Source = { finalPath: g.finalPath, posterSec: v.posterSec };
      // El video en la calidad elegida (la versión reducida por la cola de ffmpeg, reutilizada si ya está) o, con el
      // logo dibujado (T2), esa versión con el logo; si el proyecto no tiene logo, sin él.
      let video: string;
      const burned = r.logo ? await this.burn.ensure(r.generationId, r.ownerId, quality) : undefined;
      if (r.logo) source.logoSig = burned?.sig ?? 'sin-logo';
      if (burned) video = burned.path;
      else video = await this.exports.ensure(r.generationId, r.ownerId, quality);
      this.current.phase = 'upload';
      await mkdir(tmpDir, { recursive: true });
      const posterWidth = isOriginalQuality(quality) ? 1600 : Math.min(1600, Math.round((quality.height * 16) / 9));
      // Con el logo dibujado, la portada sale de ese video (lleva el logo, como la del reproductor).
      const poster = burned ? await this.frameAt(burned.path, v.posterSec, posterWidth, tmpDir) : await this.delivery.poster(r.generationId, r.ownerId, undefined, posterWidth);
      const subs = await this.delivery.subtitles(r.generationId, r.ownerId);
      const files: Files = { video: PUBLIC_FILES.video };
      // Primero los subtítulos y la portada (pequeños), el video al final: así no queda un video nuevo con subtítulos viejos.
      if (subs) {
        const f = join(tmpDir, PUBLIC_FILES.subtitles);
        await writeFile(f, subs.vtt);
        await this.media.publishFile(r.token, PUBLIC_FILES.subtitles, f);
        files.subtitles = PUBLIC_FILES.subtitles;
      } else await this.media.unpublishFile(r.token, PUBLIC_FILES.subtitles);
      if (poster) {
        const f = join(tmpDir, PUBLIC_FILES.poster);
        await writeFile(f, poster);
        await this.media.publishFile(r.token, PUBLIC_FILES.poster, f);
        files.poster = PUBLIC_FILES.poster;
      }
      await this.media.publishFile(r.token, PUBLIC_FILES.video, video);
      // Con S3 público no queda copia en el disco (p. ej. una publicación hecha antes sin S3).
      if (this.media.publicRemote) await rm(this.media.publicDir(r.token), { recursive: true, force: true });
      const bytes = (await stat(video)).size;
      // Si la despublicaron mientras tanto, se borra lo que se acaba de subir.
      const still = await this.db.publication.findFirst({ where: { id: r.id, ...LIVE }, select: { id: true } });
      if (!still) {
        await this.media.unpublish(r.token);
        return;
      }
      await this.db.publication.update({
        where: { id: r.id },
        data: { status: 'ready', source: source as unknown as Prisma.InputJsonValue, files: files as unknown as Prisma.InputJsonValue, bytes: BigInt(bytes), publishedAt: new Date() },
      });
      this.logger.log(`${r.generationId} publicado (${r.variant}, ${(bytes / 1e6).toFixed(1)} MB).`);
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0].slice(0, 500);
      this.logger.warn(`${r.generationId} (${r.variant}): no se pudo publicar: ${msg}`);
      await this.db.publication.updateMany({ where: { id: r.id, ...LIVE }, data: { status: 'error', error: msg } });
    } finally {
      this.current = undefined;
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  /** Un cuadro del video en JPEG (la portada de una publicación con el logo dibujado). */
  private async frameAt(video: string, sec: number, width: number, dir: string): Promise<Buffer | undefined> {
    const out = join(dir, 'cuadro.jpg');
    const grab = (seek: string[]) => ffmpeg([...seek, '-i', video, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', '-f', 'mjpeg', out]);
    await grab(['-ss', sec.toFixed(3)]);
    if (!existsSync(out) || !(await stat(out)).size) await grab(['-sseof', '-0.25']);
    return existsSync(out) && (await stat(out)).size ? readFile(out) : undefined;
  }

  /** Borra las carpetas públicas que ya no tienen fila (video eliminado, despublicación cortada). */
  async orphans() {
    const tokens = await this.media.publishedTokens();
    if (!tokens.size) return;
    const known = new Set((await this.db.publication.findMany({ select: { token: true } })).map((r) => r.token));
    let n = 0;
    for (const t of tokens) {
      if (known.has(t) || t.startsWith('_')) continue;
      await this.media.unpublish(t).catch((e: Error) => this.logger.warn(`No se pudo borrar la carpeta pública ${t}: ${e.message}`));
      n++;
    }
    if (n) this.logger.log(`${n} carpeta(s) pública(s) sin publicación borradas.`);
  }
}
