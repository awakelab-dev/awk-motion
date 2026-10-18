import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@wilox/db';
import type { Db } from '@wilox/db';
import type { AuthUser, VoiceTrialMark, VoiceTrialResponse, VoiceTrialSettings, VoiceTrialVariant } from '@wilox/shared';
import { DB } from '../db/db.module.js';
import { DuplicateService } from '../duplicate/duplicate.service.js';
import { RunStore } from '../generations/run-store.js';
import { PipelineService } from '../pipeline/pipeline.service.js';
import { PROVIDERS, type Providers } from '../providers/ports.js';
import { TrashService } from '../trash/trash.service.js';

/**
 * Prueba de voz (hito 10, T2, ADR-129): por cada variante, una copia del video (sin costo, ADR-107) que se vuelve a
 * locutar entera con esa variante; el plan se rehace con los mismos planos y el final se vuelve a unir (solo se paga
 * la voz). El original no se toca: es la voz de hoy (un pedido por párrafo).
 */
@Injectable()
export class VoiceTrialService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly store: RunStore,
    private readonly pipeline: PipelineService,
    private readonly duplicate: DuplicateService,
    private readonly trash: TrashService,
    @Inject(PROVIDERS) private readonly providers: Providers,
  ) {}

  async start(id: string, user: AuthUser, variants: VoiceTrialVariant[], v4?: VoiceTrialSettings): Promise<VoiceTrialResponse> {
    if (this.trash.isHidden(id)) throw new NotFoundException('El video está en la papelera.');
    // El acceso al video (por su proyecto) lo comprobó el guard de generations/:id… (hito 11, ADR-142).
    const rec = await this.store.get(id);
    if (!rec) throw new NotFoundException('Generación no encontrada.');
    if (this.providers.mode === 'mcp' || rec.state.mode === 'mcp') throw new BadRequestException('La prueba de voz usa la API de ElevenLabs: solo en videos del modo API.');
    if (rec.state.mode !== this.providers.mode) throw new BadRequestException(`Este video es del modo ${rec.state.mode.toUpperCase()} y la API corre en ${this.providers.mode.toUpperCase()}.`);
    if (rec.state.status !== 'done' || !rec.state.finalUrl) throw new BadRequestException('La prueba de voz se hace sobre un video terminado.');
    if (rec.busy) throw new BadRequestException('El video está trabajando: espera a que termine.');
    const copies: VoiceTrialResponse['copies'] = [];
    for (const variant of [...new Set(variants)]) {
      const copy = await this.duplicate.duplicateVideo(id, user);
      const g = await this.db.generation.findUniqueOrThrow({ where: { id: copy.id }, select: { delivery: true } });
      const settings = variant === 'v4-linked' && v4 && (v4.similarity !== undefined || v4.stability !== undefined) ? v4 : undefined;
      const mark: VoiceTrialMark = { variant, from: id, at: new Date().toISOString(), ...(settings ? { settings } : {}) };
      const delivery = { ...((g.delivery ?? {}) as Record<string, unknown>), voiceTrial: mark };
      await this.db.generation.update({ where: { id: copy.id }, data: { delivery: delivery as unknown as Prisma.InputJsonValue } });
      const r = await this.store.get(copy.id);
      if (!r) throw new Error(`No se pudo abrir la copia ${copy.id}.`);
      this.store.log(r, `Copia para la prueba de voz (${variant}) de ${id}.`);
      try {
        this.pipeline.voiceTrial(r, variant, settings);
      } catch (e) {
        throw new BadRequestException(`Copia ${copy.id}: ${(e as Error).message}`);
      }
      copies.push({ id: copy.id, variant });
    }
    return { copies };
  }
}
