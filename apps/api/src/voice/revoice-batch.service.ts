import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Db } from '@wilox/db';
import { FPS, type RevoiceBatchResponse, type RevoiceCandidate, type VoiceMode } from '@wilox/shared';
import { DB } from '../db/db.module.js';
import { DeliveryService } from '../delivery/delivery.service.js';
import { RunStore } from '../generations/run-store.js';
import { PipelineService } from '../pipeline/pipeline.service.js';
import { PROVIDERS, type Providers } from '../providers/ports.js';
import { PublicationsService } from '../publications/publications.service.js';
import { TrashService } from '../trash/trash.service.js';

/**
 * «Rehacer la locución» de varios videos de un proyecto (hito 10, T5, ADR-135). Cada video marcado hace lo mismo que su
 * botón (ADR-134): toda la locución en un solo pedido a v3, con la misma voz y el mismo texto; los fotogramas y los
 * clips no cambian y se rehacen el post y el final. Todos arrancan a la vez: la cola global (ElevenLabs y ffmpeg)
 * ordena el trabajo.
 */
@Injectable()
export class RevoiceBatchService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly store: RunStore,
    private readonly pipeline: PipelineService,
    private readonly delivery: DeliveryService,
    private readonly publications: PublicationsService,
    private readonly trash: TrashService,
    @Inject(PROVIDERS) private readonly providers: Providers,
  ) {}

  /** Videos del proyecto, en orden de creación, con lo que cuesta y si se pueden rehacer ahora. */
  async candidates(projectId: string, _ownerId: string): Promise<RevoiceCandidate[]> {
    if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new NotFoundException('Proyecto no encontrado.');
    // El acceso lo comprobó el guard de projects/:id… (hito 11, ADR-142): entran los videos de todos sus usuarios.
    const project = await this.db.project.findFirst({ where: { id: projectId, deletedAt: null }, select: { id: true } });
    if (!project) throw new NotFoundException('Proyecto no encontrado.');
    const rows = await this.db.generation.findMany({
      where: { projectId, trashedAt: null, deletedAt: null },
      select: {
        id: true,
        text: true,
        createdAt: true,
        status: true,
        approved: true,
        mode: true,
        voiceMode: true,
        finalPath: true,
        finalFrames: true,
        totalFrames: true,
        durationSec: true,
        paragraphs: { select: { text: true, spokenText: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const visible = rows.filter((g) => !this.trash.isHidden(g.id));
    const published = await this.publications.publishedUses(visible.map((g) => g.id));
    return visible.map((g) => {
      const live = this.store.peek(g.id);
      const status = live?.state.status ?? g.status;
      const approved = live?.approved ?? g.approved;
      const voiceMode: VoiceMode = (live?.state.voiceMode ?? g.voiceMode) === 'whole' ? 'whole' : 'paragraph';
      const reason =
        g.mode === 'mcp' || this.providers.mode === 'mcp'
          ? 'Video del modo MCP: la locución en un solo pedido usa la API.'
          : g.mode !== this.providers.mode
            ? `Video del modo ${g.mode.toUpperCase()}; la API corre en ${this.providers.mode.toUpperCase()}.`
            : live?.busy
              ? 'Está trabajando.'
              : status !== 'done' || !approved || !g.finalPath
                ? 'Aún no está terminado.'
                : undefined;
      return {
        id: g.id,
        title: this.delivery.videoTitle(g.text),
        createdAt: g.createdAt.toISOString(),
        durationSec: g.durationSec ?? (g.finalFrames ?? g.totalFrames ?? 0) / FPS,
        chars: g.paragraphs.reduce((n, p) => n + (p.spokenText ?? p.text).length, 0),
        voiceMode,
        published: published.has(g.id),
        available: !reason,
        ...(reason ? { reason } : {}),
      };
    });
  }

  /** Arranca los marcados. Si alguno está publicado, primero se pide confirmación (una sola, para todos). */
  async start(projectId: string, ownerId: string, ids: string[], confirmed: boolean): Promise<RevoiceBatchResponse> {
    if (this.providers.mode === 'mcp') throw new BadRequestException('La locución en un solo pedido usa la API de ElevenLabs (modo API).');
    const wanted = new Set(ids);
    const chosen = (await this.candidates(projectId, ownerId)).filter((c) => wanted.has(c.id));
    if (!chosen.length) throw new BadRequestException('Marca al menos un video del proyecto.');
    const pub = chosen.filter((c) => c.available && c.published);
    if (pub.length && !confirmed)
      throw new ConflictException({
        code: 'confirm',
        title: pub.length === 1 ? 'Hay un video publicado' : `Hay ${pub.length} videos publicados`,
        message: `${pub.length === 1 ? 'Uno de los videos marcados está publicado' : `${pub.length} de los videos marcados están publicados`}. Si rehaces su locución, quienes los ven —el curso del cliente— verán la nueva versión en unos minutos.`,
        action: 'Rehacer de todos modos',
      });
    const out: RevoiceBatchResponse = { started: [], skipped: [] };
    for (const c of chosen) {
      if (!c.available) {
        out.skipped.push({ id: c.id, title: c.title, reason: c.reason ?? 'No se puede ahora.' });
        continue;
      }
      try {
        const rec = await this.store.get(c.id);
        if (!rec || rec.projectId !== projectId) throw new Error('Video no encontrado.');
        this.pipeline.revoiceAll(rec);
        this.store.log(rec, 'Rehacer la locución desde el proyecto (varios videos a la vez).');
        out.started.push(c.id);
      } catch (e) {
        out.skipped.push({ id: c.id, title: c.title, reason: (e as Error).message });
      }
    }
    return out;
  }
}
