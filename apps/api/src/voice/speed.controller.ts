import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { VOICE_SPEED_MAX, VOICE_SPEED_MIN, type AuthUser, type ProjectVoice, type RunState, type SpeedBatchResponse, type SpeedCandidate } from '@wilox/shared';
import { CurrentUser } from '../auth/decorators.js';
import { speedText } from './speed.js';
import { SpeedService } from './speed.service.js';

const SpeedSchema = z.object({ speed: z.coerce.number().min(VOICE_SPEED_MIN - 1e-6).max(VOICE_SPEED_MAX + 1e-6) });
const BatchSchema = SpeedSchema.extend({ ids: z.array(z.string().regex(/^[\w-]+$/)).min(1).max(500) });
const SampleSchema = SpeedSchema.extend({ voiceId: z.string().max(200).optional(), model: z.enum(['v3', 'v4']).default('v4') });

const bad = (r: { success: boolean }) => {
  if (!r.success) throw new BadRequestException(`La velocidad va de ${speedText(VOICE_SPEED_MIN)} a ${speedText(VOICE_SPEED_MAX)}.`);
};

/** Velocidad de la narración (hito 13a, T2, ADR-178). El guard global ya comprobó el acceso a `projects/:id…` y `generations/:id…`. */
@Controller()
export class SpeedController {
  constructor(private readonly speed: SpeedService) {}

  /** Velocidad del proyecto para sus videos nuevos. */
  @Patch('projects/:id/voice')
  setProject(@Param('id') id: string, @Body() body: unknown): Promise<ProjectVoice> {
    const r = SpeedSchema.safeParse(body ?? {});
    bad(r);
    return this.speed.setProjectSpeed(id, r.data!.speed);
  }

  /** Muestra de la voz a una velocidad (WAV). */
  @Get('voice-sample')
  async sample(@Query() q: Record<string, string>, @Res() res: Response) {
    const r = SampleSchema.safeParse(q);
    bad(r);
    const file = await this.speed.sample(r.data!.voiceId, r.data!.model, r.data!.speed);
    res.type('audio/wav').set('cache-control', 'private, max-age=86400').sendFile(file);
  }

  /** «Cambiar velocidad» de un video (sin pedir voz ni clips). */
  @Post('generations/:id/speed')
  @HttpCode(202)
  video(@Param('id') id: string, @Body() body: unknown, @Headers('x-confirm-change') confirm: string | undefined, @CurrentUser() user: AuthUser): Promise<RunState> {
    const r = SpeedSchema.safeParse(body ?? {});
    bad(r);
    return this.speed.changeVideo(id, user.id, r.data!.speed, confirm === '1');
  }

  @Get('projects/:id/speed')
  candidates(@Param('id') id: string): Promise<SpeedCandidate[]> {
    return this.speed.candidates(id);
  }

  /** «Cambiar velocidad» de varios videos del proyecto. */
  @Post('projects/:id/speed')
  @HttpCode(202)
  batch(@Param('id') id: string, @Body() body: unknown, @Headers('x-confirm-change') confirm: string | undefined): Promise<SpeedBatchResponse> {
    const r = BatchSchema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException('Marca al menos un video y una velocidad válida.');
    return this.speed.start(id, r.data.ids, r.data.speed, confirm === '1');
  }
}
