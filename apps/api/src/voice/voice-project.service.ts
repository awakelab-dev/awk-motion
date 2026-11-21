import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Db } from '@wilox/db';
import { V4_CREDITS_PER_CHAR } from '@wilox/shared';
import { env } from '../config/env.js';
import { DB } from '../db/db.module.js';
import type { RunRecord } from '../generations/run-store.js';
import { PipelineService } from '../pipeline/pipeline.service.js';
import { PROVIDERS, type Providers } from '../providers/ports.js';
import { projectSeed, voiceOf } from './project-voice.js';

const nf = (n: number, d = 0) => n.toLocaleString('es-CL', { maximumFractionDigits: d });

/**
 * Voz del proyecto al mover o duplicar un video (hito 13a, ADR-177): en un proyecto nunca se mezclan versiones de voz.
 * Un video v4 no entra en un proyecto v3; un video v3 que entra en un proyecto v4 rehace su locución en v4 (con aviso de
 * gasto; sin fotogramas ni clips nuevos).
 */
@Injectable()
export class VoiceProjectService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly pipeline: PipelineService,
    @Inject(PROVIDERS) private readonly providers: Providers,
  ) {}

  /** Caracteres que se envían a la voz por toda la locución del video. */
  private chars(rec: RunRecord) {
    return rec.state.paragraphs.reduce((n, p) => n + (p.spokenText ?? p.text).length, 0);
  }

  /** Texto del gasto de rehacer en v4 toda la locución: «1.234 caracteres, ≈ 598 créditos de ElevenLabs, ≈ US$ 0,08». */
  spendText(chars: number) {
    const credits = Math.round(chars * V4_CREDITS_PER_CHAR);
    const usd = env.PRICE_ELEVENLABS_CREDIT_USD !== undefined ? `, ≈ US$ ${nf(credits * env.PRICE_ELEVENLABS_CREDIT_USD, 2)}` : '';
    return `${nf(chars)} caracteres, ≈ ${nf(credits)} créditos de ElevenLabs${usd}`;
  }

  /**
   * Revisa la voz antes de llevar `rec` al proyecto `targetId` (mover o duplicar). Lanza un error si no se puede (v4 a un
   * proyecto v3, o un video v3 que no se puede rehacer ahora). Devuelve la semilla si el video debe pasar a v4 y el aviso
   * de gasto para la confirmación.
   */
  async check(rec: RunRecord, targetId: string, verb: 'mover' | 'duplicar'): Promise<{ toV4?: { seed: number; note: string } }> {
    if (this.providers.mode === 'mcp') return {};
    const t = await this.db.project.findUnique({ where: { id: targetId }, select: { name: true, voiceModel: true, voiceSpeed: true } });
    if (!t) return {};
    const target = voiceOf(t).model;
    const mine = rec.state.voiceModel === 'v4' ? 'v4' : 'v3';
    if (target === mine) return {};
    if (mine === 'v4')
      throw new BadRequestException(`«${t.name}» usa la voz v3 y este video está en v4: en un proyecto no se mezclan versiones. Pasa primero «${t.name}» a v4.`);
    const why = this.pipeline.revoiceBlocked(rec);
    if (why) throw new BadRequestException(`«${t.name}» usa la voz v4: para ${verb}lo allí su locución se rehace en v4, y ahora no se puede (${why.replace(/\.$/, '').toLowerCase()}).`);
    return {
      toV4: {
        seed: await projectSeed(this.db, targetId),
        note: `«${t.name}» usa la voz v4: al ${verb}lo, su locución se rehace en v4 por párrafo (${this.spendText(this.chars(rec))}). Los fotogramas y los clips no cambian; las pausas cambiadas a mano se pierden.`,
      },
    };
  }

  /** Confirmación del gasto de pasar a v4 al duplicar (al mover va junto con el aviso del logo). */
  confirm(note: string, confirmed: boolean, action: string) {
    if (confirmed) return;
    throw new ConflictException({ code: 'confirm', title: 'La locución pasa a v4', message: note, action });
  }

  /** Pasa el video a v4 (en la cola, sin bloquear). */
  toV4(rec: RunRecord, seed: number) {
    this.pipeline.toV4(rec, seed);
  }
}
