import { Body, Controller, Delete, Get, Header, HttpCode, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { PROJECT_SHARE_KINDS, type AuthUser, type ProjectShareKind, type ProjectShareRequest } from '@wilox/shared';
import { CurrentUser, Public } from '../auth/decorators.js';
import { DeliveryService } from '../delivery/delivery.service.js';
import { reviewGoneHtml, reviewHtml } from '../review/review-page.js';
import { ReviewService } from '../review/review.service.js';
import { MediaService } from '../storage/media.service.js';
import { projectGoneHtml, projectPageHtml } from './project-share-page.js';
import { ProjectShareService } from './project-share.service.js';

const KindSchema = z.enum(PROJECT_SHARE_KINDS as [ProjectShareKind, ...ProjectShareKind[]]);
const ShareSchema = z.object({ kind: KindSchema.default('review'), videoIds: z.array(z.string().regex(/^[\w-]+$/)).max(1000).nullable(), renew: z.boolean().optional() });

/**
 * Links del proyecto completo: gestión en la app y páginas públicas. Aprobación del storyboard (T6, ADR-112) en
 * `/api/proyecto/:token/…`; revisión de los videos terminados (T6b, ADR-116) en `/api/revision-videos/:token/…`.
 */
@Controller()
export class ProjectShareController {
  constructor(
    private readonly share: ProjectShareService,
    private readonly review: ReviewService,
    private readonly delivery: DeliveryService,
    private readonly media: MediaService,
  ) {}

  @Get('projects/:id/share')
  state(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.share.state(id, user.id);
  }

  @Post('projects/:id/share')
  @HttpCode(200)
  upsert(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.share.upsert(id, user.id, ShareSchema.parse(body ?? {}) as ProjectShareRequest);
  }

  @Delete('projects/:id/share')
  remove(@Param('id') id: string, @Query('kind') kind: string | undefined, @CurrentUser() user: AuthUser) {
    return this.share.remove(id, user.id, KindSchema.parse(kind ?? 'review'));
  }

  // ─── Público: aprobación del storyboard ─────────────────────────────────────────────────────────────

  @Public()
  @Get('proyecto/:token')
  @Header('cache-control', 'no-store')
  @Header('x-robots-tag', 'noindex, nofollow')
  async page(@Param('token') token: string, @Res() res: Response) {
    const p = await this.share.page(token, 'review');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (!p) return res.status(404).send(projectGoneHtml());
    res.send(projectPageHtml(p));
  }

  @Public()
  @Get('proyecto/:token/v/:id/miniatura.jpg')
  @Header('x-robots-tag', 'noindex, nofollow')
  async thumb(@Param('token') token: string, @Param('id') id: string, @Res() res: Response) {
    const path = await this.review.thumbnail({ project: token, video: id });
    await this.media.serve(res, path, { headers: { 'cache-control': 'private, max-age=3600' } });
  }

  // Revisión del storyboard de un video (la misma página que el link de revisión, con «← Proyecto»).
  @Public()
  @Get('proyecto/:token/v/:id/revision')
  @Header('cache-control', 'no-store')
  @Header('x-robots-tag', 'noindex, nofollow')
  async reviewPage(@Param('token') token: string, @Param('id') id: string, @Res() res: Response) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    try {
      res.send(reviewHtml(await this.review.deck({ project: token, video: id })));
    } catch (e) {
      if (!(e instanceof NotFoundException)) throw e;
      res.status(404).send(reviewGoneHtml());
    }
  }

  @Public()
  @Get('proyecto/:token/v/:id/revision/k/:index')
  @Header('x-robots-tag', 'noindex, nofollow')
  async image(@Param('token') token: string, @Param('id') id: string, @Param('index') index: string, @Res() res: Response) {
    const path = await this.review.slideImage({ project: token, video: id }, Number(index));
    await this.media.serve(res, path, { headers: { 'cache-control': 'private, max-age=86400' } });
  }

  @Public()
  @Get('proyecto/:token/v/:id/revision/voz.m4a')
  @Header('x-robots-tag', 'noindex, nofollow')
  async voice(@Param('token') token: string, @Param('id') id: string, @Res() res: Response) {
    const path = await this.review.voice({ project: token, video: id });
    await this.media.serve(res, path, { headers: { 'cache-control': 'private, max-age=86400' } });
  }

  @Public()
  @Post('proyecto/:token/v/:id/revision/observaciones')
  @HttpCode(200)
  comment(@Param('token') token: string, @Param('id') id: string, @Body() body: Record<string, unknown> | undefined) {
    return this.review.addComment({ project: token, video: id }, body ?? {});
  }

  @Public()
  @Post('proyecto/:token/v/:id/revision/aprobar')
  @HttpCode(200)
  approve(@Param('token') token: string, @Param('id') id: string, @Body() body: Record<string, unknown> | undefined) {
    return this.review.approve({ project: token, video: id }, body ?? {});
  }

  // ─── Público: revisión de los videos terminados (T6b, ADR-116) ─────────────────────────────────────────

  @Public()
  @Get('revision-videos/:token')
  @Header('cache-control', 'no-store')
  @Header('x-robots-tag', 'noindex, nofollow')
  async videosPage(@Param('token') token: string, @Res() res: Response) {
    const p = await this.share.page(token, 'videos');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (!p) return res.status(404).send(projectGoneHtml());
    res.send(projectPageHtml(p));
  }

  /** La revisión del video: el final con las miniaturas de sus planos y las observaciones por plano. */
  @Public()
  @Get('revision-videos/:token/v/:id')
  @Header('cache-control', 'no-store')
  @Header('x-robots-tag', 'noindex, nofollow')
  async videoReview(@Param('token') token: string, @Param('id') id: string, @Res() res: Response) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    try {
      res.send(reviewHtml(await this.review.deck({ project: token, video: id, kind: 'videos' })));
    } catch (e) {
      if (!(e instanceof NotFoundException)) throw e;
      res.status(404).send(reviewGoneHtml());
    }
  }

  @Public()
  @Get('revision-videos/:token/v/:id/k/:index')
  @Header('x-robots-tag', 'noindex, nofollow')
  async videoImage(@Param('token') token: string, @Param('id') id: string, @Param('index') index: string, @Res() res: Response) {
    const path = await this.review.slideImage({ project: token, video: id, kind: 'videos' }, Number(index));
    await this.media.serve(res, path, { headers: { 'cache-control': 'private, max-age=86400' } });
  }

  @Public()
  @Get('revision-videos/:token/v/:id/video.mp4')
  @Header('x-robots-tag', 'noindex, nofollow')
  async videoFile(@Param('token') token: string, @Param('id') id: string, @Res() res: Response) {
    const path = await this.review.finalVideo({ project: token, video: id, kind: 'videos' });
    await this.media.serve(res, path, { headers: { 'cache-control': 'private, max-age=300' } });
  }

  /** Portada de la tarjeta: un fotograma del final (la portada del video, 640 px). */
  @Public()
  @Get('revision-videos/:token/v/:id/portada.jpg')
  @Header('x-robots-tag', 'noindex, nofollow')
  async videoPoster(@Param('token') token: string, @Param('id') id: string, @Res() res: Response) {
    const v = await this.share.video(token, id, 'videos');
    const jpg = await this.delivery.poster(v.id, v.ownerId, undefined, 640);
    if (!jpg) throw new NotFoundException('El video aún no está terminado.');
    res.setHeader('content-type', 'image/jpeg');
    res.setHeader('cache-control', 'private, max-age=3600');
    res.send(jpg);
  }

  @Public()
  @Post('revision-videos/:token/v/:id/observaciones')
  @HttpCode(200)
  videoComment(@Param('token') token: string, @Param('id') id: string, @Body() body: Record<string, unknown> | undefined) {
    return this.review.addComment({ project: token, video: id, kind: 'videos' }, body ?? {});
  }
}
