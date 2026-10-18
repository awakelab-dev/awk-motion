import { BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, NotFoundException, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { REVIEW_COMMENT_STATUSES, type AuthUser, type ReviewCommentStatus } from '@wilox/shared';
import { CurrentUser, Public } from '../auth/decorators.js';
import { MediaService } from '../storage/media.service.js';
import { reviewGoneHtml, reviewHtml } from './review-page.js';
import { AccessService } from '../access/access.service.js';
import { ReviewService } from './review.service.js';
import { ClipAdviceService } from './clip-advice.service.js';

/**
 * Revisión del storyboard por el cliente (hito 8, A4, ADR-098). En la app (con sesión): crear o desactivar el
 * link, ver las observaciones y la aprobación, y marcarlas como resueltas. Link público (sin sesión):
 * `/api/revision/:token` con la presentación, sus imágenes y la locución, y el envío de observaciones.
 */
const StatusSchema = z.enum(REVIEW_COMMENT_STATUSES as [ReviewCommentStatus, ...ReviewCommentStatus[]]);
const BatchSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(2000), status: StatusSchema });

@Controller()
export class ReviewController {
  constructor(
    private readonly review: ReviewService,
    private readonly media: MediaService,
    private readonly advice: ClipAdviceService,
    private readonly access: AccessService,
  ) {}

  /** Videos cuyas observaciones ve el usuario (hito 11, ADR-142): los de los proyectos a los que tiene acceso. */
  private scope(user: AuthUser, all?: string) {
    return this.access.generationsWhere(user, all === '1');
  }

  @Get('generations/:id/review')
  state(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.review.state(id, user.id);
  }

  @Post('generations/:id/review')
  createLink(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.review.createLink(id, user.id);
  }

  @Delete('generations/:id/review')
  removeLink(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.review.removeLink(id, user.id);
  }

  @Patch('review-comments/:id')
  async resolve(@Param('id') id: string, @Body() body: { resolved?: unknown; status?: unknown } | undefined, @CurrentUser() user: AuthUser) {
    // Con `status` (T8, pantalla «Observaciones»): pendiente, en curso o resuelta; devuelve la fila actualizada.
    if (typeof body?.status === 'string') {
      const status = StatusSchema.parse(body.status);
      await this.review.setStatus(id, this.scope(user), status);
      return { ok: true };
    }
    return this.review.resolve(id, this.scope(user), body?.resolved === true);
  }

  /** Observaciones del cliente sobre un clip y la sugerencia de Opus guardada (T11, ADR-122). */
  @Get('generations/:id/clips/:index/feedback')
  clipFeedback(@Param('id') id: string, @Param('index', ParseIntPipe) index: number, @CurrentUser() user: AuthUser) {
    return this.advice.feedback(id, user.id, index);
  }

  /** Pide a Opus la sugerencia para el clip (unos centavos). */
  @Post('generations/:id/clips/:index/feedback')
  @HttpCode(200)
  clipAdvice(@Param('id') id: string, @Param('index', ParseIntPipe) index: number, @CurrentUser() user: AuthUser) {
    return this.advice.advise(id, user.id, index);
  }

  /** Pantalla «Observaciones» (T8, ADR-119): todas las del cliente, con filtros por proyecto y estado. */
  @Get('review-comments')
  inbox(@Query('projectId') projectId: string | undefined, @Query('status') status: string | undefined, @Query('all') all: string | undefined, @CurrentUser() user: AuthUser) {
    // Hito 11 (ADR-142): ?all=1 = el admin ve las de todos los proyectos.
    return this.review.inbox(this.scope(user, all), { projectId: projectId && /^[0-9a-f-]{36}$/i.test(projectId) ? projectId : undefined, status: status ? StatusSchema.parse(status) : undefined });
  }

  /** Varias observaciones a la vez (ADR-140): `{ ids, status }`. */
  @Post('review-comments/status')
  @HttpCode(200)
  async setMany(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    const r = BatchSchema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException('Marca al menos una observación.');
    return { changed: await this.review.setStatusMany(r.data.ids, this.scope(user), r.data.status) };
  }

  @Get('review-comments/count')
  count(@CurrentUser() user: AuthUser, @Query('all') all?: string) {
    return this.review.openCount(this.scope(user, all));
  }

  /** Lo nuevo del cliente desde `since` (los avisos de la app). */
  @Get('reviews/activity')
  activity(@Query('since') since: string | undefined, @CurrentUser() user: AuthUser) {
    return this.review.activity(this.scope(user), since);
  }

  // ─── Link público ───────────────────────────────────────────────────────────────────────────────────

  @Public()
  @Get('revision/:token')
  @Header('cache-control', 'no-store')
  @Header('x-robots-tag', 'noindex, nofollow')
  async page(@Param('token') token: string, @Res() res: Response) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    try {
      res.send(reviewHtml(await this.review.deck(token)));
    } catch (e) {
      if (!(e instanceof NotFoundException)) throw e;
      res.status(404).send(reviewGoneHtml());
    }
  }

  @Public()
  @Get('revision/:token/k/:index')
  @Header('x-robots-tag', 'noindex, nofollow')
  async image(@Param('token') token: string, @Param('index') index: string, @Res() res: Response) {
    const path = await this.review.slideImage(token, Number(index));
    await this.media.serve(res, path, { headers: { 'cache-control': 'private, max-age=86400' } });
  }

  @Public()
  @Get('revision/:token/voz.m4a')
  @Header('x-robots-tag', 'noindex, nofollow')
  async voice(@Param('token') token: string, @Res() res: Response) {
    const path = await this.review.voice(token);
    await this.media.serve(res, path, { headers: { 'cache-control': 'private, max-age=86400' } });
  }

  @Public()
  @Post('revision/:token/observaciones')
  @HttpCode(200)
  comment(@Param('token') token: string, @Body() body: Record<string, unknown> | undefined) {
    return this.review.addComment(token, body ?? {});
  }

  @Public()
  @Post('revision/:token/aprobar')
  @HttpCode(200)
  approve(@Param('token') token: string, @Body() body: Record<string, unknown> | undefined) {
    return this.review.approve(token, body ?? {});
  }
}
