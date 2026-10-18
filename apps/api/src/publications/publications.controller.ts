import { BadRequestException, Body, Controller, Delete, Get, Header, NotFoundException, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthUser, CreateLightScormRequest, ExportQuality } from '@wilox/shared';
import { CurrentUser, Public } from '../auth/decorators.js';
import { CornerSchema, DownloadLogoSchema, QualitySchema } from '../delivery/delivery.controller.js';
import { DeliveryService, LogoSettingsSchema } from '../delivery/delivery.service.js';
import { BatchesService } from '../downloads/batches.service.js';
import { PublicationsService } from './publications.service.js';

const CreateSchema = z.object({ quality: QualitySchema, logo: z.boolean().optional() });
const RiseSchema = z.object({ quality: QualitySchema, logo: z.boolean(), subtitlesOn: z.boolean(), doc: z.enum(['html', 'txt']), videoIds: z.array(z.string().regex(/^[\w-]+$/)).max(500).optional() });
const LightSchema = z.object({
  version: z.enum(['1.2', '2004']),
  quality: QualitySchema,
  logo: DownloadLogoSchema.optional(),
  settings: LogoSettingsSchema.optional(),
  cornerAll: CornerSchema.optional(),
  videoIds: z.array(z.string().regex(/^[\w-]+$/)).max(500).optional(),
});

/**
 * Publicaciones (hito 9, T1, ADR-101). En la app: publicar un video en una calidad, ver sus publicaciones (las del
 * video o las de todo el proyecto), volver a publicar y despublicar. Sin S3 público (el Mac, MEDIA_DRIVER=none),
 * lo publicado se sirve desde `/api/publico/<token>/<archivo>` (sin sesión, con CORS abierto como CloudFront).
 */
@Controller()
export class PublicationsController {
  constructor(
    private readonly publications: PublicationsService,
    private readonly delivery: DeliveryService,
    private readonly batches: BatchesService,
  ) {}

  private rise(body: unknown) {
    const r = RiseSchema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join(' '));
    return { ...r.data, quality: r.data.quality as ExportQuality };
  }

  // ─── Código para Rise 360 (T3 y T3b, ADR-103/104) ────────────────────────────────────────────────

  /** Documento con el código de un video: queda en «Descargas» (se publica en segundo plano). */
  @Post('generations/:id/rise')
  async riseVideo(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const o = this.rise(body);
    const f = await this.delivery.finalFile(id, user.id, { local: false });
    const batchId = await this.publications.createRiseBatch(user.id, { ...o, projectId: f.projectId, projectName: f.projectName, title: f.title, generationIds: [id] });
    return this.batches.one(batchId, user);
  }

  /** Documento con el código de todos los videos del proyecto con final (en orden de creación). */
  @Post('projects/:id/rise')
  async riseProject(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const o = this.rise(body);
    const p = await this.delivery.projectVideos(id, user.id);
    // Los videos marcados (T5b) o, sin lista, todos los que tienen final.
    const ids = o.videoIds ? p.ids.filter((x) => o.videoIds!.includes(x)) : p.ids;
    if (!ids.length) throw new BadRequestException('Elige al menos un video con final.');
    const batchId = await this.publications.createRiseBatch(user.id, { ...o, projectId: id, projectName: p.name, title: p.name, generationIds: ids });
    return this.batches.one(batchId, user);
  }

  // ─── SCORM liviano (T4, ADR-108) ──────────────────────────────────────────────────────────────────

  private light(body: unknown): CreateLightScormRequest {
    const r = LightSchema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join(' '));
    return r.data as CreateLightScormRequest;
  }

  /** SCORM liviano de un video: queda en «Descargas» (se publica en segundo plano). */
  @Post('generations/:id/scorm-light')
  async lightVideo(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const o = this.light(body);
    const f = await this.delivery.finalFile(id, user.id, { local: false });
    const batchId = await this.publications.createLightScormBatch(user.id, { ...o, projectId: f.projectId, projectName: f.projectName, title: f.title, generationIds: [id] });
    return this.batches.one(batchId, user);
  }

  /** SCORM liviano del proyecto: un SCORM por video (en un ZIP), de los elegidos o de todos los que tienen final. */
  @Post('projects/:id/scorm-light')
  async lightProject(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const o = this.light(body);
    const p = await this.delivery.projectVideos(id, user.id);
    const ids = o.videoIds ? p.ids.filter((x) => o.videoIds!.includes(x)) : p.ids;
    if (!ids.length) throw new BadRequestException('Elige al menos un video con final.');
    const batchId = await this.publications.createLightScormBatch(user.id, { ...o, projectId: id, projectName: p.name, title: p.name, generationIds: ids });
    return this.batches.one(batchId, user);
  }

  @Get('generations/:id/publications')
  list(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.publications.list(id, user.id);
  }

  @Post('generations/:id/publications')
  create(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const r = CreateSchema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join(' '));
    return this.publications.ensure(id, user.id, { quality: r.data.quality as ExportQuality, logo: r.data.logo, use: 'manual' });
  }

  @Get('projects/:id/publications')
  listProject(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.publications.listProject(id, user.id);
  }

  @Post('publications/:id/refresh')
  refresh(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.publications.refresh(id, user);
  }

  @Delete('publications/:id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.publications.remove(id, user);
  }

  /** Lo publicado, sin S3 público: con rangos (el video se puede adelantar) y CORS abierto (subtítulos con crossorigin). */
  @Public()
  @Get('publico/:token/:name')
  @Header('x-robots-tag', 'noindex, nofollow')
  async file(@Param('token') token: string, @Param('name') name: string, @Res() res: Response) {
    const path = await this.publications.localFile(token, name);
    if (!path) throw new NotFoundException();
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('cache-control', 'public, max-age=300');
    res.sendFile(path, { dotfiles: 'deny' }, (err) => err && !res.headersSent && res.status(404).end());
  }
}
