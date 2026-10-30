import { BadRequestException, Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Db } from '@wilox/db';
import { DB } from '../db/db.module.js';
import { moveVideo } from './video-order.js';

const MoveSchema = z.object({ direction: z.enum(['earlier', 'later']) });

/**
 * Cambiar a mano el lugar de un video dentro de su proyecto (hito 12, ADR-162), de a un lugar. Quien tiene acceso al
 * proyecto (lo comprueba el guard de `generations/:id…`).
 */
@Controller('generations')
export class VideoOrderController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post(':id/order')
  @HttpCode(200)
  async move(@Param('id') id: string, @Body() body: unknown): Promise<{ swappedWith: string | null }> {
    const r = MoveSchema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException('Dirección no válida.');
    const other = await moveVideo(this.db, id, r.data.direction);
    return { swappedWith: other ?? null };
  }
}
