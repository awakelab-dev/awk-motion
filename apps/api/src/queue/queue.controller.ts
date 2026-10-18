import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Db, Prisma } from '@wilox/db';
import type { AuthUser, QueueOverview, QueueResourceId, QueueResourceInfo, QueueVideo, QueueVideoState, RunStatus } from '@wilox/shared';
import { CurrentUser } from '../auth/decorators.js';
import { DB } from '../db/db.module.js';
import { RunStore } from '../generations/run-store.js';
import { HistoryService } from '../projects/history.service.js';
import { AccessService } from '../access/access.service.js';
import { PROVIDERS, type Providers } from '../providers/ports.js';
import { gateResources } from './gate.js';
import { QueueService, type Resource } from './queue.service.js';

const WORKING: RunStatus[] = ['queued', 'voice', 'timings', 'storyboard', 'keyframes', 'clips', 'post', 'render'];

const LABEL: Record<Resource, string> = {
  elevenlabs: 'Locución · ElevenLabs',
  anthropic: 'Storyboard y revisiones · Opus',
  openai: 'Fotogramas · OpenAI',
  minimax: 'Clips · MiniMax',
  higgsfield: 'Higgsfield',
  ffmpeg: 'Post y render · ffmpeg',
};

/** Vista "Cola" e indicador de la cabecera (hito 5, ADR-045). */
@Controller('queue')
export class QueueController {
  constructor(
    private readonly queue: QueueService,
    private readonly store: RunStore,
    @Inject(DB) private readonly db: Db,
    @Inject(PROVIDERS) private readonly providers: Providers,
    private readonly history: HistoryService,
    private readonly access: AccessService,
  ) {}

  /** Hito 11 (ADR-142): los videos de los proyectos a los que el usuario tiene acceso; ?all=1, el admin, los de todos. */
  @Get()
  overview(@CurrentUser() user: AuthUser, @Query('all') all?: string): Promise<QueueOverview> {
    return this.build(this.access.generationsWhere(user, all === '1'));
  }

  private async build(scope: Prisma.GenerationWhereInput): Promise<QueueOverview> {
    const live = this.queue.live();
    const since = new Date(Date.now() - 24 * 3600_000);
    const rows = await this.db.generation.findMany({
      where: {
        ...scope,
        trashedAt: null,
        OR: [{ status: { in: [...WORKING, 'awaiting_approval', 'paused'] } }, { status: 'error', updatedAt: { gte: since } }],
      },
      select: { id: true, projectId: true, project: { select: { name: true } }, themeName: true, status: true, message: true, error: true, createdAt: true, text: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    // Miniatura de cada video (K01 vigente o K00), como en las tarjetas del proyecto.
    const thumbs = await this.history.thumbnails(rows.map((g) => g.id));
    // Posición en la cola global: orden de lanzamiento entre los videos (de todos) con trabajos pendientes.
    const pending = new Map<string, number>();
    for (const t of live) if (t.spec.generationId) pending.set(t.spec.generationId, Math.min(pending.get(t.spec.generationId) ?? Infinity, t.spec.priority));
    const order = [...pending.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    const videos: QueueVideo[] = rows.map((g) => {
      const mine = live.filter((t) => t.spec.generationId === g.id);
      const byResource: QueueVideo['byResource'] = {};
      for (const t of mine) {
        const b = (byResource[t.spec.resource as QueueResourceId] ??= { queued: 0, running: 0 });
        if (t.state === 'running') b.running += 1;
        else b.queued += 1;
      }
      const running = mine.filter((t) => t.state === 'running').length;
      const retrying = mine.filter((t) => t.state === 'queued' && t.notBefore > Date.now()).length;
      const rec = this.store.peek(g.id);
      const status = (rec?.state.status ?? g.status) as RunStatus;
      const regenerating = rec?.state.keyframes.some((k) => k.status === 'generating' || k.activity) ?? false;
      const state: QueueVideoState =
        status === 'paused' ? 'paused' : status === 'error' ? 'error' : status === 'awaiting_approval' && !mine.length && !regenerating ? 'awaiting' : running || !mine.length ? 'working' : 'queued';
      const ks = rec?.state.keyframes ?? [];
      const cs = rec?.state.clips ?? [];
      const pos = order.indexOf(g.id);
      return {
        id: g.id,
        projectId: g.projectId,
        projectName: g.project.name,
        themeName: g.themeName ?? undefined,
        status,
        state,
        message: rec?.state.message ?? g.message,
        createdAt: g.createdAt.toISOString(),
        position: pos >= 0 ? pos + 1 : undefined,
        tasks: { queued: mine.length - running, running, retrying },
        byResource,
        keyframes: { ready: ks.filter((k) => k.status === 'ready').length, total: ks.length },
        clips: { ready: cs.filter((c) => c.status === 'ready').length, total: cs.length },
        error: (rec?.state.error ?? g.error) || undefined,
        textPreview: g.text.slice(0, 140),
        thumbnailUrl: thumbs.get(g.id),
      };
    });
    const counts: QueueOverview['counts'] = { queued: 0, working: 0, awaiting: 0, error: 0, paused: 0 };
    for (const v of videos) counts[v.state] += 1;
    const used = new Set<Resource>([...(Object.values(gateResources(this.providers.mode)).filter((x) => typeof x === 'string') as Resource[]), 'ffmpeg']);
    const resources: QueueResourceInfo[] = this.queue
      .capacities()
      .filter((c) => used.has(c.resource as Resource))
      .map((c) => ({
        resource: c.resource as QueueResourceId,
        label: LABEL[c.resource as Resource],
        running: c.running,
        capacity: c.effective,
        max: c.max,
        perMinute: c.perMinute,
        usedLastMinute: c.usedLastMinute,
        queued: live.filter((t) => t.spec.resource === c.resource && t.state === 'queued').length,
        pausedUntil: c.pausedUntil,
      }));
    return { counts, videos, resources };
  }
}
