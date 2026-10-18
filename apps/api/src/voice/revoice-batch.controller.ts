import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import type { AuthUser, RevoiceBatchResponse, RevoiceCandidate } from '@wilox/shared';
import { CurrentUser } from '../auth/decorators.js';
import { RevoiceBatchService } from './revoice-batch.service.js';

const Schema = z.object({ ids: z.array(z.string().regex(/^[\w-]+$/)).min(1).max(500) });

/** «Rehacer la locución» de varios videos de un proyecto (hito 10, T5, ADR-135). */
@Controller('projects/:id/revoice')
export class RevoiceBatchController {
  constructor(private readonly batch: RevoiceBatchService) {}

  @Get()
  candidates(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<RevoiceCandidate[]> {
    return this.batch.candidates(id, user.id);
  }

  @Post()
  @HttpCode(202)
  start(@Param('id') id: string, @Body() body: unknown, @Headers('x-confirm-change') confirm: string | undefined, @CurrentUser() user: AuthUser): Promise<RevoiceBatchResponse> {
    const r = Schema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException('Marca al menos un video.');
    return this.batch.start(id, user.id, r.data.ids, confirm === '1');
  }
}
