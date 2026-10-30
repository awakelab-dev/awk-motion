import { Inject, Injectable } from '@nestjs/common';
import { ensureUnclassified, projectRole, searchGenerationIds, type Db, type Prisma } from '@wilox/db';
import type { AuthUser, GenerationSummary, HistoryQuery, HistoryResponse, HistoryStatus, HistoryTotals, ProjectsResponse, ProjectSummary, RunStatus, SoundMode, VoiceTrialMark } from '@wilox/shared';
import { isBaseThemeId, UNCLASSIFIED_SYSTEM } from '@wilox/shared';
import { BASE_THEMES } from '@wilox/styles';
import { DB } from '../db/db.module.js';
import { videoSequence } from './video-order.js';
import { env } from '../config/env.js';
import { AccessService } from '../access/access.service.js';
import { fileUrlFor } from '../persistence/run-persistence.js';
import { sortProjects } from './rules.js';

const WORKING: RunStatus[] = ['queued', 'voice', 'timings', 'storyboard', 'keyframes', 'clips', 'post', 'render'];
const STATUS_GROUP: Record<HistoryStatus, RunStatus[]> = {
  done: ['done'],
  awaiting_approval: ['awaiting_approval'],
  working: WORKING,
  error: ['error'],
  paused: ['paused'],
};

/** Lo mínimo de cada generación para filtrar y sumar. */
interface Lite {
  id: string;
  projectId: string;
  themeKey: string;
  themeName: string | null;
  durationSec: number | null;
  balanceBefore: number | null;
  balanceAfter: number | null;
  createdAt: Date;
}

const LITE = {
  id: true,
  projectId: true,
  themeKey: true,
  voiceId: true,
  musicTrack: true,
  soundMode: true,
  themeName: true,
  durationSec: true,
  balanceBefore: true,
  balanceAfter: true,
  createdAt: true,
} as const satisfies Prisma.GenerationSelect;

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
/**
 * USD por crédito de Higgsfield (hito 11, ADR-145): para los videos antiguos del modo MCP sin USD anotado. La tarifa del
 * plan Ultra (US$ 302,50 / 6.000 créditos) salvo que `.env` diga otra.
 */
export const creditUsd = () => env.PRICE_HIGGSFIELD_CREDIT_USD ?? 302.5 / 6000;
/** Nombre del tema: el guardado en la generación o, en las importadas de los temas base, el del código. */
export const themeLabel = (key: string, name: string | null) => name ?? (isBaseThemeId(key) ? BASE_THEMES[key].info.name : key);

/**
 * Historial y proyectos (hito 3, ADR-032). Los totales se calculan sobre el conjunto filtrado
 * completo (no solo la página). Costo en USD (hito 11, ADR-145, sin créditos): la suma de sus trabajos (GenerationJob;
 * un trabajo de Higgsfield sin USD anotado, por sus créditos a la tarifa del plan); si no hay trabajos (generaciones
 * importadas del modo MCP), el saldo antes − después a esa tarifa.
 */
@Injectable()
export class HistoryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  /** USD de los trabajos de cada generación (los de Higgsfield sin USD anotado, por sus créditos). */
  private async jobSums(ids: string[]) {
    const out = new Map<string, number>();
    if (!ids.length) return out;
    const rows = await this.db.$queryRaw<{ id: string; usd: number | null }[]>`
      SELECT "generationId" AS id,
             sum(CASE WHEN "costUsd" > 0 THEN "costUsd"::float8 ELSE coalesce(credits, 0) * ${creditUsd()} END) AS usd
      FROM "GenerationJob" WHERE "generationId" = ANY(${ids}) GROUP BY 1`;
    for (const r of rows) out.set(r.id, r.usd ?? 0);
    return out;
  }

  /** Costo en USD de un video: sus trabajos o, sin trabajos (importados de MCP), el saldo antes − después. */
  private cost(g: Pick<Lite, 'id' | 'balanceBefore' | 'balanceAfter'>, jobs: Map<string, number>): number {
    const j = jobs.get(g.id) ?? 0;
    if (j > 0) return r4(j);
    if (g.balanceBefore != null && g.balanceAfter != null && g.balanceBefore > g.balanceAfter) return r4((g.balanceBefore - g.balanceAfter) * creditUsd());
    return 0;
  }

  private totals(list: Lite[], jobs: Map<string, number>): HistoryTotals {
    let durationSec = 0;
    let costUsd = 0;
    for (const g of list) {
      durationSec += g.durationSec ?? 0;
      costUsd += this.cost(g, jobs);
    }
    return { videos: list.length, durationSec: r2(durationSec), costUsd: r4(costUsd) };
  }

  /** Miniatura de cada generación: K01 (o K00) de la versión vigente. */
  async thumbnails(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const kfs = await this.db.keyframe.findMany({
      where: { generationId: { in: ids }, index: { in: [0, 1] } },
      include: { versions: { select: { version: true, path: true } } },
    });
    for (const id of ids) {
      const k = kfs.find((x) => x.generationId === id && x.index === 1) ?? kfs.find((x) => x.generationId === id && x.index === 0);
      const v = k?.versions.find((x) => x.version === k.version && x.path);
      if (k && v?.path) out.set(id, fileUrlFor(id, v.path, k.version));
    }
    return out;
  }

  /**
   * Historial (ADR-032) de los proyectos que ve el usuario (hito 11, ADR-142): los suyos, los compartidos con él y los
   * públicos; con `all`, el admin, los de todos.
   */
  async history(user: AuthUser, q: HistoryQuery, all = false): Promise<HistoryResponse> {
    // Lo que está en la papelera o eliminado no se ve (T3d, ADR-106).
    const where: Prisma.GenerationWhereInput = { trashedAt: null };
    // 'none' era "Sin proyecto" (hito 3): ahora es "Sin clasificar" (ADR-035).
    const project = q.project === 'none' ? await ensureUnclassified(this.db, user.id) : q.project;
    const visible = project ? ((await this.access.role(project, user)) ? [project] : []) : await this.access.visibleProjectIds(user, all);
    where.projectId = { in: visible };
    if (q.theme) where.themeKey = q.theme;
    if (q.status) where.status = { in: STATUS_GROUP[q.status] };
    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from ? { gte: new Date(`${q.from}T00:00:00`) } : {}),
        ...(q.to ? { lt: new Date(new Date(`${q.to}T00:00:00`).getTime() + 86_400_000) } : {}),
      };
    }
    let ranked: string[] | undefined;
    if (q.q?.trim()) {
      ranked = await searchGenerationIds(this.db, visible, q.q, 2000);
      where.id = { in: ranked };
    }
    // Sin la búsqueda de texto, los temas del filtro salen del conjunto sin el filtro de tema (para poder cambiarlo).
    // Dentro de un proyecto, en secuencia: el que se creó primero va primero (hito 12, ADR-160); fuera, el más nuevo primero.
    const [list, forThemes] = await Promise.all([
      this.db.generation.findMany({ where, select: LITE, orderBy: [{ createdAt: project ? 'asc' : 'desc' }, { id: project ? 'asc' : 'desc' }] }),
      this.db.generation.findMany({ where: { ...where, themeKey: undefined }, select: { themeKey: true, themeName: true } }),
    ]);
    if (ranked) {
      const pos = new Map(ranked.map((id, i) => [id, i]));
      list.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
    } else if (project) {
      // El orden del proyecto, que se cambia a mano (ADR-162).
      const pos = new Map((await videoSequence(this.db, project)).map((id, i) => [id, i]));
      list.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
    }
    const jobs = await this.jobSums(list.map((g) => g.id));
    const offset = Math.max(0, q.offset ?? 0);
    const limit = Math.min(100, Math.max(1, q.limit ?? 30));
    const page = list.slice(offset, offset + limit);
    const items = await this.summaries(page.map((g) => g.id), jobs);

    const themes = new Map<string, { key: string; name: string; count: number }>();
    for (const g of forThemes) {
      const t = themes.get(g.themeKey) ?? { key: g.themeKey, name: themeLabel(g.themeKey, g.themeName), count: 0 };
      t.count += 1;
      themes.set(g.themeKey, t);
    }
    return { items, total: list.length, totals: this.totals(list, jobs), themes: [...themes.values()].sort((a, b) => b.count - a.count) };
  }

  /** Filas del historial en el orden de `ids`. */
  async summaries(ids: string[], jobsIn?: Map<string, number>): Promise<GenerationSummary[]> {
    if (!ids.length) return [];
    const [rows, thumbs, jobs, pubs] = await Promise.all([
      this.db.generation.findMany({ where: { id: { in: ids } } }),
      this.thumbnails(ids),
      jobsIn ?? this.jobSums(ids),
      // Publicado (T3c, ADR-105): usos de sus publicaciones.
      this.db.publication.findMany({ where: { generationId: { in: ids }, status: { not: 'unpublished' } }, select: { generationId: true, uses: true } }),
    ]);
    const published = new Map<string, Set<'manual' | 'rise' | 'scorm'>>();
    for (const p of pubs) {
      const set = published.get(p.generationId) ?? new Set();
      const uses = ((p.uses ?? []) as ('manual' | 'rise' | 'scorm')[]).filter(Boolean);
      for (const u of uses.length ? uses : (['manual'] as const)) set.add(u);
      published.set(p.generationId, set);
    }
    const byId = new Map(rows.map((g) => [g.id, g]));
    return ids
      .map((id) => byId.get(id))
      .filter((g): g is NonNullable<typeof g> => !!g)
      .map((g) => {
        return {
          id: g.id,
          createdAt: g.createdAt.toISOString(),
          updatedAt: g.updatedAt.toISOString(),
          status: g.status,
          mode: g.mode,
          theme: g.themeKey,
          themeName: themeLabel(g.themeKey, g.themeName),
          voiceId: g.voiceId,
          projectId: g.projectId,
          parentId: g.parentId,
          textPreview: g.text.slice(0, 220),
          durationSec: g.durationSec ?? undefined,
          thumbnailUrl: thumbs.get(g.id),
          finalUrl: g.finalPath ? fileUrlFor(g.id, g.finalPath, g.updatedAt.getTime()) : undefined,
          costUsd: this.cost(g, jobs),
          published: published.has(g.id) ? [...published.get(g.id)!] : undefined,
          copyOf: g.copyOfId ?? undefined,
          voiceTrial: ((g.delivery as { voiceTrial?: VoiceTrialMark } | null)?.voiceTrial?.variant) ?? undefined,
        };
      });
  }

  /**
   * Proyectos del usuario (hito 4, ADR-035): "Sin clasificar" primero (siempre, nunca está archivado)
   * y después el resto por actividad: fecha del último video o, si no tiene, de creación.
   * Hito 11 (ADR-142): también los compartidos con él y los públicos, con su papel y su dueño; con `all`, el admin ve los
   * de todos (su «Sin clasificar» sigue primero).
   */
  async projects(user: AuthUser, includeArchived: boolean, all = false): Promise<ProjectsResponse> {
    const unclassifiedId = await ensureUnclassified(this.db, user.id);
    const projects = await this.db.project.findMany({
      where: { AND: [this.access.projectsWhere(user, all), { trashedAt: null, deletedAt: null }, includeArchived ? {} : { OR: [{ archivedAt: null }, { system: { not: null } }] }] },
      include: {
        owner: { select: { id: true, name: true, email: true, active: true } },
        shares: { select: { userId: true } },
      },
    });
    const gens = await this.db.generation.findMany({ where: { projectId: { in: projects.map((p) => p.id) }, trashedAt: null }, select: LITE, orderBy: { createdAt: 'desc' } });
    const jobs = await this.jobSums(gens.map((g) => g.id));
    // Videos publicados por proyecto (T3c, ADR-105).
    const pubGens = new Set((await this.db.publication.findMany({ where: { generationId: { in: gens.map((g) => g.id) }, status: { not: 'unpublished' } }, select: { generationId: true } })).map((r) => r.generationId));
    const latest = projects.map((p) => gens.find((g) => g.projectId === p.id)?.id).filter((x): x is string => !!x);
    const thumbs = await this.thumbnails(latest);
    const summaries: ProjectSummary[] = projects.map((p) => {
      const list = gens.filter((g) => g.projectId === p.id);
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
        archived: !!p.archivedAt,
        unclassified: p.system === UNCLASSIFIED_SYSTEM,
        totals: this.totals(list, jobs),
        published: list.filter((g) => pubGens.has(g.id)).length || undefined,
        lastVideoAt: list[0]?.createdAt.toISOString(),
        thumbnailUrl: list[0] ? thumbs.get(list[0].id) : undefined,
        // Valores por defecto de un video nuevo en este proyecto (ADR-053): los del último video.
        defaults: list[0]
          ? { theme: list[0].themeKey, voiceId: list[0].voiceId, musicTrack: list[0].musicTrack ?? null, soundMode: (list[0].soundMode as SoundMode | null) ?? 'model' }
          : undefined,
        access: {
          role: projectRole(p, this.access.viewer(user), p.shares.some((x) => x.userId === user.id)) ?? 'admin',
          owner: p.owner,
          public: !!p.publicAt && !p.system,
          shared: p.shares.length,
        },
      };
    });
    return { projects: sortProjects(summaries, unclassifiedId), unclassifiedId, all: this.totals(gens, jobs) };
  }
}

