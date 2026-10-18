import { BadRequestException, Body, Controller, Delete, Get, Header, Headers, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { BATCH_REQUEST_FORMATS, type AuthUser, type LinkDays, type BatchRequestFormat, type CreateBatchRequest, type ExportEstimate, type ExportQuality } from '@wilox/shared';
import { CurrentUser, Public } from '../auth/decorators.js';
import { CornerSchema, DownloadLogoSchema, QualitySchema } from '../delivery/delivery.controller.js';
import { LogoSettingsSchema } from '../delivery/delivery.service.js';
import { ExportsService } from '../delivery/exports.service.js';
import { AccessService } from '../access/access.service.js';
import { BatchesService } from './batches.service.js';
import { linkPageHtml } from './links.js';

const CreateSchema = z.object({
  projectId: z.string().uuid(),
  format: z.enum(BATCH_REQUEST_FORMATS as [BatchRequestFormat, ...BatchRequestFormat[]]),
  // `project-zip` lleva todos los videos del proyecto (sin lista).
  videoIds: z.array(z.string().min(1).max(200)).max(1000),
  quality: QualitySchema.optional(),
  logo: DownloadLogoSchema.optional(),
  settings: LogoSettingsSchema.optional(),
  cornerAll: CornerSchema.optional(),
});
const DaysSchema = z.union([z.literal(7), z.literal(30), z.null()]) as z.ZodType<LinkDays>;
const LinkSchema = z.object({ days: DaysSchema, label: z.string().trim().max(120).optional() });
const LinkPatchSchema = z.object({ disabled: z.boolean().optional(), days: DaysSchema.optional(), label: z.string().trim().max(120).nullable().optional() });
const EstimateSchema = z.object({ videoIds: z.array(z.string().min(1).max(200)).max(1000), quality: QualitySchema });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join(' '));
  return r.data;
}

/** Lotes de descarga (hito 7, ADR-087) y su vista de control «Descargas»; desde T5a (ADR-109), todas las descargas. */
@Controller('download-batches')
export class BatchesController {
  constructor(
    private readonly batches: BatchesService,
    private readonly exports: ExportsService,
    private readonly access: AccessService,
  ) {}

  /** Lotes del usuario, del más reciente al más antiguo, con su estado y avance. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('all') all?: string) {
    // Hito 11 (ADR-142): ?all=1 = el admin ve las de todos.
    return this.batches.list(user, all === '1');
  }

  /** Videos del proyecto que pueden ir en un lote (los que tienen final). */
  @Get('candidates')
  candidates(@Query('project') project: string, @CurrentUser() user: AuthUser) {
    if (!project) throw new BadRequestException('Falta el proyecto.');
    return this.batches.candidates(project, user);
  }

  /** Peso estimado de los videos elegidos con una resolución y compresión (ADR-084). */
  @Post('estimate')
  estimate(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<ExportEstimate> {
    const r = parse(EstimateSchema, body);
    return this.estimateVisible(r.videoIds, user, r.quality as ExportQuality);
  }

  /** Solo los videos de proyectos a los que el usuario tiene acceso (hito 11, ADR-142). */
  private async estimateVisible(ids: string[], user: AuthUser, q: ExportQuality): Promise<ExportEstimate> {
    const ok: string[] = [];
    for (const id of ids) if (await this.access.generation(id, user).then(() => true, () => false)) ok.push(id);
    return this.exports.estimateMany(ok, user.id, q);
  }

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.batches.create(user, parse(CreateSchema, body) as CreateBatchRequest);
  }

  @Post(':id/retry')
  retry(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.batches.retry(id, user);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.batches.remove(id, user);
    return { ok: true };
  }

  /** «Actualizar» (T5, ADR-111): vuelve a armar la descarga con los videos y el logo de hoy; sus links siguen igual. */
  @Post(':id/refresh')
  refresh(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.batches.refresh(id, user);
  }

  /** Crea un link de descarga para el cliente (7 o 30 días, o sin caducidad). */
  @Post(':id/links')
  createLink(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.batches.createLink(id, user, parse(LinkSchema, body));
  }

  /** El ZIP del lote (cuenta una descarga). */
  @Get(':id/file')
  file(@Param('id') id: string, @Headers('range') range: string | undefined, @CurrentUser() user: AuthUser, @Res() res: Response) {
    return this.batches.send(id, user, range, res);
  }
}

/** Links de descarga (T5, ADR-111): gestión (con sesión) y la página pública para el cliente (sin sesión). */
@Controller()
export class DownloadLinksController {
  constructor(private readonly batches: BatchesService) {}

  @Patch('download-links/:id')
  update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.batches.updateLink(id, user, parse(LinkPatchSchema, body));
  }

  @Delete('download-links/:id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.batches.removeLink(id, user);
  }

  /** Página pública del link: el archivo, su peso y «Descargar» (o por qué no está disponible). */
  @Public()
  @Get('descargar/:token')
  @Header('cache-control', 'no-store')
  @Header('x-robots-tag', 'noindex, nofollow')
  async page(@Param('token') token: string, @Res() res: Response) {
    const { page } = await this.batches.publicLink(token);
    res.status(page.state === 'gone' ? 404 : 200);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(linkPageHtml(page));
  }

  /** El archivo del link (cuenta una descarga; desde la caché o con una URL firmada de S3). */
  @Public()
  @Get('descargar/:token/archivo')
  @Header('x-robots-tag', 'noindex, nofollow')
  file(@Param('token') token: string, @Headers('range') range: string | undefined, @Res() res: Response) {
    return this.batches.sendPublic(token, range, res);
  }
}
