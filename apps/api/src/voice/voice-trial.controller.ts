import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import type { AuthUser, VoiceTrialResponse } from '@wilox/shared';
import { CurrentUser } from '../auth/decorators.js';
import { VoiceTrialService } from './voice-trial.service.js';

const Unit = z.number().min(0).max(1);
const Schema = z.object({
  variants: z.array(z.enum(['v3-whole', 'v4-linked'])).min(1).max(2),
  /** Ajustes de la voz para la variante v4 (ADR-131). */
  v4: z.object({ similarity: Unit.optional(), stability: Unit.optional() }).optional(),
});

/** Prueba de voz (hito 10, T2, ADR-129). */
@Controller()
export class VoiceTrialController {
  constructor(private readonly trial: VoiceTrialService) {}

  /** Una copia del video por variante, locutada de nuevo con esa variante (solo se paga la voz). */
  @Post('generations/:id/voice-trial')
  @HttpCode(201)
  start(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser): Promise<VoiceTrialResponse> {
    const { variants, v4 } = Schema.parse(body ?? {});
    return this.trial.start(id, user, variants, v4);
  }
}
