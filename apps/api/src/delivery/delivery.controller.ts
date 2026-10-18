import { BadRequestException, Body, Controller, Delete, Get, Header, Headers, NotFoundException, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ZipArchive } from 'archiver';
import { z } from 'zod';
import { EXPORT_COMPRESSIONS, LOGO_CORNERS, isOriginalQuality, type AuthUser, type DownloadRequest, type ExportEstimate, type ExportQuality, type LogoCorner, type LogoSettings } from '@wilox/shared';
import { CurrentUser, Public } from '../auth/decorators.js';
import { DownloadsService } from '../downloads/downloads.service.js';
import { safeName, sendZip } from '../downloads/zip.js';
import { RunStore } from '../generations/run-store.js';
import { appendFiles, DeliveryService, LogoSettingsSchema, mergeSettings } from './delivery.service.js';
import { ExportsService } from './exports.service.js';
import { MediaService } from '../storage/media.service.js';
import { PackagesService, scormVersion } from './packages.service.js';
import { PublicationsService } from '../publications/publications.service.js';

const LogoUploadSchema = z.object({ fileName: z.string().max(200), data: z.string().min(10) });
export const CornerSchema = z.enum(LOGO_CORNERS as [LogoCorner, ...LogoCorner[]]);
const VideoDeliverySchema = z.object({
  clipCorners: z.record(z.string().regex(/^-?\d+$/), z.union([CornerSchema, z.literal('none')]).nullable()).optional(),
  posterClip: z.number().int().nullable().optional(),
});
export const DownloadLogoSchema = z.union([z.literal('project'), z.literal('none'), LogoUploadSchema]);
export const VIDEO_FORMATS = ['html', 'single', 'mp4', 'scorm12', 'scorm2004', 'zip'] as const;
/** El SCORM del proyecto es uno por video (lote), no un paquete con todos (ADR-108). */
const PROJECT_FORMATS = ['zip'] as const;
export const QualitySchema = z.object({
  height: z.union([z.literal(1440), z.literal(1080), z.literal(720), z.literal(480)]),
  compression: z.enum(EXPORT_COMPRESSIONS.map((c) => c.id) as [ExportQuality['compression'], ...ExportQuality['compression'][]]),
});
const requestSchema = (formats: readonly [string, ...string[]]) =>
  z.object({ format: z.enum(formats), logo: DownloadLogoSchema.optional(), settings: LogoSettingsSchema.optional(), cornerAll: CornerSchema.optional(), quality: QualitySchema.optional() });
/** ?height=&compression= de la estimación de peso. */
const qualityQuery = (height: string | undefined, compression: string | undefined): ExportQuality => parse(QualitySchema, { height: Number(height), compression });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join(' '));
  return r.data;
}

/** Ajustes sin guardar de la vista previa, en la URL (?s={...}). */
function previewSettings(raw: string | undefined): Partial<LogoSettings> | undefined {
  if (!raw) return undefined;
  try {
    const r = LogoSettingsSchema.safeParse(JSON.parse(raw));
    return r.success ? (r.data as Partial<LogoSettings>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Entrega (hito 6, ADR-065): logo y ajustes del proyecto, ajuste fino y portada de cada video, reproductor
 * HTML (vista previa y descarga) y paquetes de descarga.
 */
@Controller()
export class DeliveryController {
  constructor(
    private readonly delivery: DeliveryService,
    private readonly exports: ExportsService,
    private readonly packages: PackagesService,
    private readonly downloads: DownloadsService,
    private readonly store: RunStore,
    private readonly media: MediaService,
    private readonly publications: PublicationsService,
  ) {}

  @Get('projects/:id/delivery')
  project(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.delivery.project(id, user.id);
  }

  @Put('projects/:id/delivery')
  async setProject(@Param('id') id: string, @Body() body: unknown, @Headers('x-confirm-change') confirm: string | undefined, @CurrentUser() user: AuthUser) {
    await this.publications.guardProjectLogo(id, user.id, confirm === '1'); // T3c: aviso si hay videos publicados con el logo
    const r = LogoSettingsSchema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join(' '));
    return this.delivery.setProjectSettings(id, user.id, r.data as Partial<LogoSettings>);
  }

  @Post('projects/:id/logo')
  async uploadLogo(@Param('id') id: string, @Body() body: unknown, @Headers('x-confirm-change') confirm: string | undefined, @CurrentUser() user: AuthUser) {
    await this.publications.guardProjectLogo(id, user.id, confirm === '1');
    const r = LogoUploadSchema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException('Archivo no válido.');
    return this.delivery.setLogo(id, user.id, r.data.fileName, r.data.data);
  }

  @Delete('projects/:id/logo')
  async removeLogo(@Param('id') id: string, @Headers('x-confirm-change') confirm: string | undefined, @CurrentUser() user: AuthUser) {
    await this.publications.guardProjectLogo(id, user.id, confirm === '1');
    return this.delivery.removeLogo(id, user.id);
  }

  @Get('projects/:id/logo')
  async logo(@Param('id') id: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const f = await this.delivery.logoFile(id, user.id);
    if (!f) throw new NotFoundException('El proyecto no tiene logo.');
    res.setHeader('content-type', f.mime);
    res.sendFile(f.path);
  }

  @Get('generations/:id/delivery')
  video(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.delivery.video(id, user.id);
  }

  @Put('generations/:id/delivery')
  async setVideo(@Param('id') id: string, @Body() body: unknown, @Headers('x-confirm-change') confirm: string | undefined, @CurrentUser() user: AuthUser) {
    await this.publications.guardVideo(id, user.id, confirm === '1'); // T3c: esquina del logo o portada de un video publicado
    return this.delivery.setVideo(id, user.id, parse(VideoDeliverySchema, body));
  }

  /** Portada (JPEG) en un segundo dado o la del video; `w` = ancho de una miniatura. */
  @Get('generations/:id/poster')
  async poster(@Param('id') id: string, @Query('t') t: string | undefined, @Query('w') w: string | undefined, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const buf = await this.delivery.poster(id, user.id, t !== undefined && t !== '' ? Math.max(0, Number(t) || 0) : undefined, w ? Number(w) || 1600 : undefined);
    if (!buf) throw new NotFoundException('El video aún no tiene final.');
    res.setHeader('content-type', 'image/jpeg');
    res.send(buf);
  }

  /** Vista previa del reproductor HTML en la app (el video se sirve desde la app). */
  @Get('generations/:id/player')
  async player(@Param('id') id: string, @Query('s') s: string | undefined, @Query('t') t: string | undefined, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const html = await this.delivery.playerHtml(id, user.id, {
      videoSrc: `/api/generations/${id}/final.mp4`,
      preview: true,
      settings: previewSettings(s),
      posterSec: t !== undefined && t !== '' ? Number(t) || 0 : undefined,
    });
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(html);
  }

  // ─── Link para compartir (hito 7, ADR-083) ─────────────────────────────────────────────────────────

  /** Crea el link del video (o uno nuevo: el anterior deja de funcionar). */
  @Post('generations/:id/share')
  createShare(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.delivery.createShare(id, user.id);
  }

  /** Desactiva el link del video. */
  @Delete('generations/:id/share')
  removeShare(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.delivery.removeShare(id, user.id);
  }

  /**
   * Página pública del link (sin sesión): el reproductor de las descargas con el final vigente, la portada,
   * el logo del proyecto (esquina por clip) y los subtítulos encendidos.
   */
  @Public()
  @Get('ver/:token')
  @Header('cache-control', 'no-store')
  @Header('x-robots-tag', 'noindex, nofollow')
  async sharePage(@Param('token') token: string, @Res() res: Response) {
    const { id, ownerId } = await this.delivery.resolveShare(token);
    const html = await this.delivery.playerHtml(id, ownerId, { videoSrc: `/api/ver/${token}/video.mp4`, share: true });
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(html);
  }

  /** El video del link (con rangos, para poder adelantar). */
  @Public()
  @Get('ver/:token/video.mp4')
  @Header('x-robots-tag', 'noindex, nofollow')
  async shareVideo(@Param('token') token: string, @Res() res: Response) {
    const { id, ownerId } = await this.delivery.resolveShare(token);
    const f = await this.delivery.finalFile(id, ownerId, { local: false });
    await this.media.serve(res, f.path, { headers: { 'cache-control': 'private, max-age=300' } });
  }

  /** El final vigente (para la vista previa del reproductor). */
  @Get('generations/:id/final.mp4')
  async final(@Param('id') id: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const f = await this.delivery.finalFile(id, user.id, { local: false });
    await this.media.serve(res, f.path);
  }

  /**
   * Pide una descarga con logo o ajustes propios (ADR-066): devuelve un token para bajarla por GET (el logo
   * de una sola vez no se guarda). Sin pedirla, la descarga usa el logo y los ajustes del proyecto.
   */
  @Post('generations/:id/package')
  async requestVideo(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const req = parse(requestSchema(VIDEO_FORMATS), body) as DownloadRequest;
    const f = await this.delivery.finalFile(id, user.id, { local: false });
    await this.delivery.logoDataUrl(f.projectId, user.id, req.logo); // valida el logo ahora, no al bajar
    // Otra resolución o compresión (ADR-085): la versión reducida empieza a prepararse ya.
    const token = this.delivery.createRequest(user.id, `g:${id}`, req, [id]);
    return { token, preparing: !isOriginalQuality(req.quality) };
  }

  /** Avance de una descarga que prepara versiones reducidas (ADR-085). */
  @Get('generations/:id/package/status')
  packageStatus(@Param('id') id: string, @Query('token') token: string, @CurrentUser() user: AuthUser) {
    return this.delivery.packageStatus(token, user.id, `g:${id}`);
  }

  /** Peso estimado del final con una resolución y compresión (ADR-084). */
  @Get('generations/:id/export-estimate')
  exportEstimate(@Param('id') id: string, @Query('height') height: string, @Query('compression') compression: string, @CurrentUser() user: AuthUser): Promise<ExportEstimate> {
    return this.exports.estimate(id, user.id, qualityQuery(height, compression));
  }

  /**
   * Descarga del final (hito 6): `html` (ZIP con index.html, css/, js/, img/, video.mp4 y los subtítulos; por defecto),
   * `single` (un solo .html con el video dentro, solo hasta 40 MB), `mp4` (solo el video), `scorm12` /
   * `scorm2004` (paquete SCORM con un SCO, ADR-066) o `zip` (todo: final, reproductor, subtítulos, clips, voz,
   * fotogramas, prompts y ficha; ADR-067). Con `token`, la descarga pedida por POST.
   */
  @Get('generations/:id/package')
  async package(@Param('id') id: string, @Query('format') format: string | undefined, @Query('token') token: string | undefined, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const taken = this.delivery.takeRequest(token, user.id, `g:${id}`);
    const req = taken?.req ?? { format: (format ?? 'html') as DownloadRequest['format'] };
    if (req.format === 'zip') {
      // ZIP completo (ADR-067): final, reproductor, subtítulos, clips, voz, fotogramas, prompts y ficha.
      const suffix = isOriginalQuality(req.quality) ? '' : `_${req.quality!.height}p`;
      const f = await this.delivery.finalFile(id, user.id);
      const logoDataUrl = req.logo ? await this.delivery.logoDataUrl(f.projectId, user.id, req.logo) : undefined;
      const settings = req.settings as Partial<LogoSettings> | undefined;
      const rec = await this.store.get(id);
      if (rec) await this.store.flush(rec);
      const videos = await this.downloads.videos([id], false, { logoDataUrl, settings: settings && mergeSettings(settings), cornerAll: req.cornerAll, videoPath: taken?.videoPath, posterWidth: taken?.posterWidth });
      return sendZip(res, `wilox_${safeName(id)}${suffix}`, videos);
    }
    // Con otra resolución o compresión (ADR-085), la versión reducida ya preparada; si no, el final.
    const pkg = await this.packages.videoPackage(id, user.id, req, { videoPath: taken?.videoPath(id), posterWidth: taken?.posterWidth });
    if (pkg.kind === 'file') return res.download(pkg.path, pkg.name);
    if (pkg.kind === 'data') {
      res.setHeader('content-type', pkg.contentType);
      res.setHeader('content-disposition', `attachment; filename="${pkg.name}"`);
      return res.send(pkg.data);
    }
    // Primero se arma (si falla, la respuesta aún puede ser un error) y después se envía.
    const z = new ZipArchive({ zlib: { level: 6 } });
    z.on('error', () => res.destroy());
    await pkg.fill(z);
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', `attachment; filename="${pkg.name}"`);
    z.pipe(res);
    await z.finalize();
  }

  /** Pide la descarga de un proyecto con logo o ajustes propios (ADR-066): devuelve un token. */
  @Post('projects/:id/package')
  async requestProject(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    if (scormVersion(String((body as { format?: unknown } | null)?.format ?? ''))) throw new BadRequestException('El SCORM del proyecto es uno por video: elige «Un archivo por video».');
    const req = parse(requestSchema(PROJECT_FORMATS), body) as DownloadRequest;
    await this.delivery.logoDataUrl(id, user.id, req.logo);
    const ids = isOriginalQuality(req.quality) ? [] : (await this.delivery.projectVideos(id, user.id)).ids;
    return { token: this.delivery.createRequest(user.id, `p:${id}`, req, ids), preparing: ids.length > 0 };
  }

  @Get('projects/:id/package/status')
  projectPackageStatus(@Param('id') id: string, @Query('token') token: string, @CurrentUser() user: AuthUser) {
    return this.delivery.packageStatus(token, user.id, `p:${id}`);
  }

  /** Peso estimado de los finales del proyecto con una resolución y compresión (ADR-084). */
  @Get('projects/:id/export-estimate')
  async projectExportEstimate(@Param('id') id: string, @Query('height') height: string, @Query('compression') compression: string, @CurrentUser() user: AuthUser): Promise<ExportEstimate> {
    const { ids } = await this.delivery.projectVideos(id, user.id);
    return this.exports.estimateMany(ids, user.id, qualityQuery(height, compression));
  }

  /**
   * Descarga de un proyecto (ADR-066): `zip` (todo, una carpeta por video, como «ZIP del proyecto»). El SCORM del
   * proyecto ya no sale en un paquete: es uno por video, desde «Un archivo por video» (ADR-108). Con `token`, la
   * descarga pedida por POST.
   */
  @Get('projects/:id/package')
  async projectPackage(@Param('id') id: string, @Query('format') format: string | undefined, @Query('token') token: string | undefined, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const taken = this.delivery.takeRequest(token, user.id, `p:${id}`);
    const req = taken?.req ?? { format: (format ?? 'zip') as DownloadRequest['format'] };
    const settings = req.settings ? mergeSettings(req.settings as Partial<LogoSettings>) : undefined;
    if (scormVersion(req.format)) throw new BadRequestException('El SCORM del proyecto es uno por video: elige «Un archivo por video».');
    const quality = { videoPath: taken?.videoPath, posterWidth: taken?.posterWidth };
    const logoDataUrl = req.logo ? await this.delivery.logoDataUrl(id, user.id, req.logo) : undefined;
    return this.downloads.sendProject(res, id, user.id, { logoDataUrl, settings, cornerAll: req.cornerAll, ...quality });
  }
}
