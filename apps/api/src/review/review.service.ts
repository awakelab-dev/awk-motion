import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Prisma, type Db } from '@wilox/db';
import {
  FPS,
  REVIEW_AUTHOR_MAX,
  REVIEW_MAX_COMMENTS,
  REVIEW_TEXT_MAX,
  type InsertState,
  type KeyframeState,
  type ProjectShareKind,
  type ReviewActivityPage,
  type ReviewComment,
  type ReviewCommentStatus,
  type ReviewInbox,
  type ReviewInboxItem,
  type VideoDeliveryOverride,
  type VideoReview,
} from '@wilox/shared';
import { env, repoPath } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { DeliveryService } from '../delivery/delivery.service.js';
import { projectSharePath, projectVideoPath, resolveProjectShare } from '../share/project-share.js';
import { buildCues, spokenWords, type SubtitleWord } from '../delivery/subtitles.js';
import { clipShift, compose, voiceShift, type Composition } from '../pipeline/inserts.js';
import { ffmpeg } from '../media/ffmpeg.js';
import type { PlannedClip } from '../pipeline/timeline.js';
import { MediaService } from '../storage/media.service.js';
import type { ReviewDeck, ReviewSlide, PublicComment } from './review-page.js';

const nn = (i: number) => String(i).padStart(2, '0');
const TOKEN = /^[A-Za-z0-9_-]{20,40}$/;
/** Ancho de las imágenes de la presentación (JPEG): livianas para el cliente, nítidas en pantalla completa. */
const SLIDE_WIDTH = 1920;

type Row = Awaited<ReturnType<ReviewService['row']>>;
type CommentRow = {
  id: string;
  kind: string;
  keyframeIndex: number | null;
  keyframeVersion: number | null;
  versions: Prisma.JsonValue;
  author: string;
  text: string;
  createdAt: Date;
  inProgressAt?: Date | null;
  resolvedAt: Date | null;
  archivedAt?: Date | null;
};
const statusOf = (c: { resolvedAt: Date | null; inProgressAt?: Date | null; archivedAt?: Date | null }): ReviewCommentStatus =>
  c.archivedAt ? 'archived' : c.resolvedAt ? 'resolved' : c.inProgressAt ? 'progress' : 'pending';

/** Fotograma que ve el cliente: el vigente (ADR-071: con una propuesta sin aplicar, la versión anterior). */
interface Shown {
  index: number;
  label: string;
  texts: string[];
  version: number;
  /** Relativa a la carpeta del video; sin el campo, aún no hay imagen. */
  path?: string;
}

/**
 * Revisión del storyboard por el cliente (hito 8, A4, ADR-098): link sin sesión (token en
 * `Generation.delivery.review`), presentación con los fotogramas vigentes y la locución de cada tramo,
 * observaciones por fotograma y aprobación (tabla `ReviewComment`), y su vista en la app.
 */
/**
 * Un link de revisión: el token del video o el de un link del proyecto con el video: el de aprobación del storyboard
 * (T6, ADR-112; `kind` 'review' o sin él) o el de revisión de los videos terminados (T6b, ADR-116; `kind` 'videos').
 */
export type ReviewRef = string | { project: string; video: string; kind?: ProjectShareKind };
/**
 * Tramo de cada plano en el final (T6b): empieza donde empieza su clip, corrido por los insertos anteriores (K00, en 0), y
 * termina donde empieza el siguiente; el último, al final del video. Un inserto queda dentro del plano que lo precede.
 */
export function planoTimes(indices: number[], slots: Map<number, { start: number }>, comp: Composition): { start: number; end: number }[] {
  const total = comp.totalFrames / FPS;
  const starts = indices.map((i) => (i === 0 ? 0 : (slots.get(i)?.start ?? 0) + clipShift(comp, i) / FPS));
  return starts.map((start, j) => ({ start, end: j + 1 < starts.length ? starts[j + 1] : Math.max(total, start) }));
}

const kindOf = (ref: ReviewRef): ProjectShareKind => (typeof ref === 'string' ? 'review' : (ref.kind ?? 'review'));
/** El final que vio el cliente en una observación sobre el video (`ReviewComment.versions`). */
const finalOf = (v: Prisma.JsonValue): string | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? ((v as { final?: unknown }).final as string | undefined) : undefined);

@Injectable()
export class ReviewService {
  /** Conversiones en curso (imagen o voz), para no lanzar dos ffmpeg sobre el mismo archivo. */
  private readonly making = new Map<string, Promise<void>>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly media: MediaService,
    private readonly delivery: DeliveryService,
  ) {}

  private row(where: Prisma.GenerationWhereInput) {
    return this.db.generation.findFirst({
      // En la papelera o eliminado (T3d, ADR-106): su link de revisión deja de funcionar.
      where: { ...where, trashedAt: null },
      select: {
        id: true,
        ownerId: true,
        dir: true,
        text: true,
        status: true,
        delivery: true,
        finalPath: true,
        inserts: true,
        voicePath: true,
        words: true,
        plan: true,
        totalFrames: true,
        project: { select: { id: true, name: true } },
        paragraphs: { orderBy: { index: 'asc' }, select: { text: true } },
        clips: { orderBy: { index: 'asc' }, select: { index: true, startFrame: true, slotEndFrame: true } },
        keyframes: {
          orderBy: { index: 'asc' },
          select: { index: true, label: true, texts: true, status: true, version: true, previous: true, versions: { select: { version: true, path: true } } },
        },
      },
    });
  }

  /** Video con sesión: el acceso a su proyecto lo comprobó el guard (generations/:id…, hito 11, ADR-142). */
  private async own(id: string, _ownerId?: string) {
    const g = await this.row({ id });
    if (!g) throw new NotFoundException('Video no encontrado.');
    return g;
  }

  private dirOf(g: { dir: string }) {
    return join(repoPath(env.STORAGE_DIR), g.dir);
  }

  url(token: string) {
    return `${env.WEB_ORIGIN.replace(/\/+$/, '')}/api/revision/${token}`;
  }

  /** Los fotogramas tal como los ve el cliente (los que aún no tienen imagen van sin `path`). */
  private shown(g: Row): Shown[] {
    return g!.keyframes.map((k) => {
      const prev = k.previous as unknown as KeyframeState['previous'] | null;
      if (prev?.path) return { index: k.index, label: prev.label, texts: prev.texts, version: prev.version, path: prev.path };
      const v = k.versions.find((x) => x.version === k.version);
      const ready = k.status === 'ready' && !!v?.path;
      return { index: k.index, label: k.label, texts: k.texts, version: k.version, path: ready ? v!.path! : undefined };
    });
  }

  /** Tramo de locución de cada fotograma (s): Ki narra el tramo del clip i; K0, lo que suena antes del clip 1. */
  private slots(g: Row): Map<number, { start: number; end: number }> {
    const plan = (g!.plan as unknown as PlannedClip[] | null) ?? [];
    const clips = g!.clips.length ? g!.clips : plan.map((p, i) => ({ index: i + 1, startFrame: p.startFrame, slotEndFrame: p.slotEndFrame }));
    const out = new Map<number, { start: number; end: number }>();
    for (const c of clips) out.set(c.index, { start: c.startFrame / FPS, end: c.slotEndFrame / FPS });
    const first = out.get(1)?.start ?? 0;
    out.set(0, { start: 0, end: first });
    return out;
  }

  private comment(c: CommentRow, current: Map<number, number>, finalPath?: string | null): ReviewComment {
    let outdated = false;
    // Sobre el video (T6b): queda «sobre una versión anterior» si el final cambió desde entonces.
    if (c.kind === 'video') outdated = !!finalPath && finalOf(c.versions) !== finalPath;
    else if (c.kind === 'approval') {
      const v = (c.versions ?? {}) as Record<string, number>;
      outdated = [...current].some(([i, ver]) => v[String(i)] !== undefined && v[String(i)] !== ver) || [...current.keys()].some((i) => v[String(i)] === undefined);
    } else if (c.keyframeIndex !== null && c.keyframeVersion !== null) outdated = c.keyframeVersion < (current.get(c.keyframeIndex) ?? c.keyframeVersion);
    return {
      id: c.id,
      kind: c.kind === 'approval' || c.kind === 'video' ? c.kind : 'comment',
      keyframeIndex: c.keyframeIndex ?? undefined,
      keyframeVersion: c.keyframeVersion ?? undefined,
      author: c.author,
      text: c.text,
      createdAt: c.createdAt.toISOString(),
      resolvedAt: c.resolvedAt?.toISOString(),
      inProgressAt: c.resolvedAt ? undefined : c.inProgressAt?.toISOString(),
      archivedAt: c.archivedAt?.toISOString(),
      status: statusOf(c),
      outdated,
    };
  }

  // ─── En la app ──────────────────────────────────────────────────────────────────────────────────────

  async state(id: string, ownerId: string): Promise<VideoReview> {
    const g = await this.own(id, ownerId);
    const o = (g.delivery ?? {}) as VideoDeliveryOverride;
    // En la app, "anterior" es respecto de la última versión de cada fotograma (también las propuestas).
    const current = new Map(g.keyframes.map((k) => [k.index, k.version]));
    const rows = await this.db.reviewComment.findMany({ where: { generationId: id }, orderBy: { createdAt: 'asc' } });
    const all = rows.map((r) => this.comment(r, current, g.finalPath));
    // Las del storyboard y las del video (T6b), juntas por fotograma; la tarjeta marca las del video.
    const comments = all.filter((c) => c.kind !== 'approval');
    const open = comments.filter((c) => !c.resolvedAt);
    const openByKeyframe: Record<string, number> = {};
    for (const c of open) openByKeyframe[String(c.keyframeIndex)] = (openByKeyframe[String(c.keyframeIndex)] ?? 0) + 1;
    return {
      link: o.review ? { url: this.url(o.review.token), createdAt: o.review.createdAt } : undefined,
      comments,
      approval: all.filter((c) => c.kind === 'approval').at(-1),
      open: open.length,
      openByKeyframe,
    };
  }

  private async saveOverride(id: string, cur: VideoDeliveryOverride) {
    await this.db.generation.update({ where: { id }, data: { delivery: Object.keys(cur).length ? (cur as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });
  }

  /** Crea el link (o uno nuevo, que deja sin efecto el anterior). Las observaciones se conservan. */
  async createLink(id: string, ownerId: string): Promise<VideoReview> {
    const g = await this.own(id, ownerId);
    if (!this.shown(g).some((k) => k.path)) throw new BadRequestException('El video aún no tiene fotogramas.');
    const cur = (g.delivery ?? {}) as VideoDeliveryOverride;
    cur.review = { token: randomBytes(18).toString('base64url'), createdAt: new Date().toISOString() };
    await this.saveOverride(id, cur);
    return this.state(id, ownerId);
  }

  async removeLink(id: string, ownerId: string): Promise<VideoReview> {
    const g = await this.own(id, ownerId);
    const cur = (g.delivery ?? {}) as VideoDeliveryOverride;
    delete cur.review;
    await this.saveOverride(id, cur);
    return this.state(id, ownerId);
  }

  /** Marca una observación como resuelta (o la vuelve a abrir). */
  async resolve(commentId: string, scope: Prisma.GenerationWhereInput, resolved: boolean): Promise<VideoReview> {
    const generationId = await this.setStatus(commentId, scope, resolved ? 'resolved' : 'pending');
    return this.state(generationId, '');
  }

  /** Cambia el estado de una observación (T8): pendiente, en curso, resuelta o archivada. Devuelve su video. */
  async setStatus(commentId: string, scope: Prisma.GenerationWhereInput, status: ReviewCommentStatus): Promise<string> {
    const c = /^[0-9a-f-]{36}$/i.test(commentId)
      ? await this.db.reviewComment.findFirst({ where: { id: commentId, kind: { not: 'approval' }, generation: scope }, select: { generationId: true } })
      : null;
    if (!c) throw new NotFoundException('Observación no encontrada.');
    await this.setStatusMany([commentId], scope, status);
    return c.generationId;
  }

  /**
   * El mismo estado a varias observaciones a la vez (ADR-140). Solo las de los proyectos a los que el usuario tiene acceso
   * (`scope`, hito 11; y no las aprobaciones). «En curso»
   * conserva desde cuándo estaba en curso; «Archivada» deja el resto como estaba. Devuelve cuántas cambiaron.
   */
  async setStatusMany(ids: string[], scope: Prisma.GenerationWhereInput, status: ReviewCommentStatus): Promise<number> {
    const valid = [...new Set(ids)].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (!valid.length) return 0;
    const where: Prisma.ReviewCommentWhereInput = { id: { in: valid }, kind: { not: 'approval' }, generation: scope };
    const now = new Date();
    if (status === 'progress') await this.db.reviewComment.updateMany({ where: { ...where, inProgressAt: null }, data: { inProgressAt: now } });
    const data: Prisma.ReviewCommentUpdateManyMutationInput =
      status === 'archived'
        ? { archivedAt: now }
        : status === 'resolved'
          ? { resolvedAt: now, archivedAt: null }
          : status === 'progress'
            ? { resolvedAt: null, archivedAt: null }
            : { resolvedAt: null, inProgressAt: null, archivedAt: null };
    const r = await this.db.reviewComment.updateMany({ where, data });
    return r.count;
  }

  /**
   * Todas las observaciones del cliente en los videos de los proyectos a los que el usuario tiene acceso (`scope`, hito 11,
   * ADR-142: suyos, compartidos y públicos; con «Ver los de todos», el admin, todos) (pantalla «Observaciones», T8, ADR-119): del storyboard
   * y del video, sin aprobaciones ni videos en la papelera. Filtros por proyecto y estado; las cuentas por estado ignoran
   * el filtro de estado. Cada una con la miniatura del fotograma vigente al que se refiere.
   */
  async inbox(scope: Prisma.GenerationWhereInput, o: { projectId?: string; status?: ReviewCommentStatus } = {}): Promise<ReviewInbox> {
    const base: Prisma.ReviewCommentWhereInput = { kind: { in: ['comment', 'video'] }, generation: { AND: [scope, { trashedAt: null, project: { trashedAt: null } }] } };
    const rows = await this.db.reviewComment.findMany({
      where: o.projectId ? { ...base, generation: { AND: [scope, { trashedAt: null, projectId: o.projectId, project: { trashedAt: null } }] } } : base,
      orderBy: { createdAt: 'desc' },
      take: 2000,
      include: {
        generation: {
          select: {
            id: true,
            text: true,
            finalPath: true,
            project: { select: { id: true, name: true } },
            keyframes: { select: { index: true, label: true, texts: true, status: true, version: true, previous: true, versions: { select: { version: true, path: true } } } },
          },
        },
      },
    });
    const counts: Record<ReviewCommentStatus, number> = { pending: 0, progress: 0, resolved: 0, archived: 0 };
    const items: ReviewInboxItem[] = [];
    const shownCache = new Map<string, Map<number, Shown>>();
    for (const r of rows) {
      const st = statusOf(r);
      counts[st]++;
      if (o.status && st !== o.status) continue;
      const g = r.generation;
      let shown = shownCache.get(g.id);
      if (!shown) {
        shown = new Map(this.shown(g as unknown as Row).map((k) => [k.index, k]));
        shownCache.set(g.id, shown);
      }
      const k = r.keyframeIndex !== null ? shown.get(r.keyframeIndex) : undefined;
      const current = new Map([...shown.values()].map((x) => [x.index, x.version]));
      const c = this.comment(r, current, g.finalPath);
      items.push({
        ...c,
        kind: r.kind === 'video' ? 'video' : 'comment',
        generationId: g.id,
        videoTitle: this.delivery.videoTitle(g.text),
        projectId: g.project.id,
        projectName: g.project.name,
        thumb: k?.path ? `/api/generations/${g.id}/files/${k.path}?v=${k.version}` : undefined,
        currentVersion: k?.version,
      });
    }
    // Proyectos con observaciones (sin el filtro de proyecto), para el selector.
    const per = await this.db.reviewComment.groupBy({
      by: ['generationId'],
      where: { ...base, resolvedAt: null, archivedAt: null },
      _count: { _all: true },
    });
    const all = await this.db.reviewComment.findMany({ where: base, distinct: ['generationId'], select: { generation: { select: { id: true, project: { select: { id: true, name: true } } } } } });
    const projects = new Map<string, { id: string; name: string; open: number }>();
    for (const x of all) projects.set(x.generation.project.id, projects.get(x.generation.project.id) ?? { ...x.generation.project, open: 0 });
    const projOf = new Map(all.map((x) => [x.generation.id, x.generation.project.id]));
    for (const p of per) {
      const pid = projOf.get(p.generationId);
      if (pid) projects.get(pid)!.open += p._count._all;
    }
    return { items, counts, projects: [...projects.values()].sort((a, b) => b.open - a.open || a.name.localeCompare(b.name)) };
  }

  /** Observaciones abiertas (pendientes + en curso) del usuario: el contador de la cabecera. */
  async openCount(scope: Prisma.GenerationWhereInput): Promise<{ pending: number; progress: number }> {
    const where: Prisma.ReviewCommentWhereInput = { kind: { in: ['comment', 'video'] }, resolvedAt: null, archivedAt: null, generation: { AND: [scope, { trashedAt: null, project: { trashedAt: null } }] } };
    const [pending, progress] = await Promise.all([this.db.reviewComment.count({ where: { ...where, inProgressAt: null } }), this.db.reviewComment.count({ where: { ...where, inProgressAt: { not: null } } })]);
    return { pending, progress };
  }

  /** Lo nuevo del cliente en los videos del usuario desde `since` (avisos de la app). */
  async activity(scope: Prisma.GenerationWhereInput, since: string | undefined): Promise<ReviewActivityPage> {
    const now = new Date();
    const from = since && !Number.isNaN(Date.parse(since)) ? new Date(since) : now;
    const rows = await this.db.reviewComment.findMany({
      where: { createdAt: { gt: from, lte: now }, generation: scope },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: { id: true, kind: true, keyframeIndex: true, author: true, text: true, createdAt: true, generation: { select: { id: true, text: true, project: { select: { name: true } } } } },
    });
    return {
      now: now.toISOString(),
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind === 'approval' || r.kind === 'video' ? r.kind : 'comment',
        generationId: r.generation.id,
        projectName: r.generation.project.name,
        videoTitle: this.delivery.videoTitle(r.generation.text),
        keyframeIndex: r.keyframeIndex ?? undefined,
        author: r.author,
        text: r.text,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  // ─── Link público ───────────────────────────────────────────────────────────────────────────────────

  private async byToken(token: string) {
    if (!TOKEN.test(token)) throw new NotFoundException('Link no válido o desactivado.');
    const g = await this.row({ delivery: { path: ['review', 'token'], equals: token } });
    if (!g) throw new NotFoundException('Link no válido o desactivado.');
    return g;
  }

  /**
   * El video de un link: el de revisión del video o, en el link del proyecto (T6, ADR-112), un video visible de ese
   * proyecto. Si el link del proyecto se desactiva, su revisión deja de funcionar (el link del video, aparte, sigue).
   */
  private async byRef(ref: ReviewRef) {
    if (typeof ref === 'string') return this.byToken(ref);
    const s = await resolveProjectShare(this.db, ref.project, kindOf(ref));
    if (!s || !s.ids.includes(ref.video)) throw new NotFoundException('Link no válido o desactivado.');
    const g = await this.row({ id: ref.video, projectId: s.project.id });
    if (!g) throw new NotFoundException('Link no válido o desactivado.');
    return g;
  }

  /** Ruta pública de la revisión de un link. */
  private baseOf(ref: ReviewRef) {
    if (typeof ref === 'string') return `/api/revision/${ref}`;
    return kindOf(ref) === 'videos' ? projectVideoPath(ref.project, ref.video, 'videos') : `${projectVideoPath(ref.project, ref.video)}/revision`;
  }

  private publicComments(rows: CommentRow[], shown: Map<number, number>, kind: 'comment' | 'video' = 'comment', finalPath?: string | null): PublicComment[] {
    return rows
      .filter((r) => r.kind === kind)
      .map((r) => {
        const c = this.comment(r, shown, finalPath);
        return { id: c.id, keyframeIndex: c.keyframeIndex ?? 0, author: c.author, text: c.text, createdAt: c.createdAt, resolved: !!c.resolvedAt, outdated: c.outdated };
      });
  }

  /** Datos de la presentación. */
  async deck(ref: ReviewRef): Promise<ReviewDeck> {
    const g = await this.byRef(ref);
    if (kindOf(ref) === 'videos') return this.videoDeck(ref as Exclude<ReviewRef, string>, g);
    const base = this.baseOf(ref);
    const shown = this.shown(g);
    const slots = this.slots(g);
    const words = (g.words as unknown as SubtitleWord[] | null) ?? [];
    const spoken = words.length ? spokenWords(g.paragraphs, words) : [];
    const voice = g.voicePath && words.length ? `${base}/voz.m4a?v=${this.voiceTag(words)}` : undefined;
    const slides: ReviewSlide[] = shown.map((k) => {
      const slot = slots.get(k.index) ?? { start: 0, end: 0 };
      // Las palabras que empiezan en el tramo (la última de un tramo puede terminar ya en el siguiente).
      const ws = spoken.filter((w) => w.start >= slot.start - 0.001 && w.start < slot.end - 0.001);
      return {
        index: k.index,
        label: `K${nn(k.index)}`,
        version: k.version,
        image: k.path ? `${base}/k/${k.index}?v=${k.version}` : undefined,
        start: slot.start,
        end: slot.end,
        words: ws.map((w) => ({ t: w.text, s: Math.round(w.start * 1000) / 1000, e: Math.round(w.end * 1000) / 1000 })),
      };
    });
    const versions = new Map(shown.map((k) => [k.index, k.version]));
    const rows = await this.db.reviewComment.findMany({ where: { generationId: g.id }, orderBy: { createdAt: 'asc' } });
    const approvalRow = rows.filter((r) => r.kind === 'approval').at(-1);
    const approval = approvalRow ? this.comment(approvalRow, versions) : undefined;
    const logo = await this.delivery.logoDataUrl(g.project.id, g.ownerId, 'project').catch(() => null);
    return {
      base,
      back: typeof ref === 'string' ? undefined : { href: projectSharePath(ref.project), label: g.project.name },
      title: this.delivery.videoTitle(g.text),
      project: g.project.name,
      logo: logo ?? undefined,
      audio: voice,
      slides,
      comments: this.publicComments(rows, versions),
      approval: approval ? { author: approval.author, at: approval.createdAt, outdated: approval.outdated } : undefined,
    };
  }

  /**
   * Revisión del video terminado (T6b, ADR-116): la misma página que la del storyboard, con el final en lugar de los
   * fotogramas y la locución. Cada fotograma marca su plano en la línea de tiempo del final: el clip y su congelado,
   * corridos por los insertos anteriores (un inserto queda en el plano que lo precede; la portada subida, en K00). Las
   * palabras, igual. Las observaciones van al plano, con el final que vio el cliente; sin aprobación.
   */
  private async videoDeck(ref: Exclude<ReviewRef, string>, g: NonNullable<Row>): Promise<ReviewDeck> {
    const base = this.baseOf(ref);
    const shown = this.shown(g);
    const slots = this.slots(g);
    const words = (g.words as unknown as SubtitleWord[] | null) ?? [];
    const spoken = words.length ? spokenWords(g.paragraphs, words) : [];
    const plan = (g.plan as unknown as PlannedClip[] | null) ?? [];
    const inserts = (g.inserts as unknown as InsertState[] | null) ?? [];
    const voiceFrames = g.totalFrames ?? 0;
    const comp = compose(plan, voiceFrames, inserts, buildCues(g.paragraphs, words, voiceFrames ? voiceFrames / FPS : undefined));
    const times = planoTimes(shown.map((k) => k.index), slots, comp);
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    const all: ReviewSlide[] = shown.map((k, i) => {
      const slot = slots.get(k.index) ?? { start: 0, end: 0 };
      const ws = spoken.filter((w) => w.start >= slot.start - 0.001 && w.start < slot.end - 0.001);
      return {
        index: k.index,
        label: `K${nn(k.index)}`,
        version: k.version,
        image: k.path ? `${base}/k/${k.index}?v=${k.version}` : undefined,
        start: r3(times[i].start),
        end: r3(times[i].end),
        words: ws.map((w) => {
          const d = voiceShift(comp, w.start);
          return { t: w.text, s: r3(w.start + d), e: r3(w.end + d) };
        }),
      };
    });
    // Un plano sin tiempo en el video (K00 cuando el clip 1 empieza en 0 y no hay portada subida) no se muestra.
    const slides = all.filter((x) => x.end - x.start > 0.05);
    const versions = new Map(shown.map((k) => [k.index, k.version]));
    const rows = await this.db.reviewComment.findMany({ where: { generationId: g.id, kind: 'video' }, orderBy: { createdAt: 'asc' } });
    const logo = await this.delivery.logoDataUrl(g.project.id, g.ownerId, 'project').catch(() => null);
    // El logo encima del video, como en el reproductor (pedido de Leonardo en la prueba).
    const overlay = g.finalPath ? await this.delivery.logoOverlay(g.id, g.ownerId).catch(() => undefined) : undefined;
    return {
      mode: 'video',
      overlay,
      base,
      back: { href: projectSharePath(ref.project, 'videos'), label: g.project.name },
      title: this.delivery.videoTitle(g.text),
      project: g.project.name,
      logo: logo ?? undefined,
      video: g.finalPath ? `${base}/video.mp4?v=${createHash('sha1').update(g.finalPath).digest('hex').slice(0, 10)}` : undefined,
      slides,
      comments: this.publicComments(rows, versions, 'video', g.finalPath),
    };
  }

  /** Huella de la locución: cambia si se rehace (tiempos nuevos), así la voz en m4a se vuelve a hacer. */
  private voiceTag(words: SubtitleWord[]) {
    return createHash('sha1').update(JSON.stringify(words)).digest('hex').slice(0, 10);
  }

  /** Una sola conversión a la vez por archivo; se escribe aparte y se renombra al terminar. */
  private async make(out: string, fn: (tmp: string) => Promise<unknown>) {
    let p = this.making.get(out);
    if (!p) {
      p = (async () => {
        await this.media.ensure(out);
        if (existsSync(out)) return;
        await mkdir(dirname(out), { recursive: true });
        const tmp = `${out}.part`;
        try {
          await fn(tmp);
          if (!((await stat(tmp).catch(() => undefined))?.size ?? 0)) throw new Error(`ffmpeg no generó ${out}.`);
          await rename(tmp, out);
        } finally {
          await rm(tmp, { force: true });
        }
        this.media.dirty(out);
      })().finally(() => this.making.delete(out));
      this.making.set(out, p);
    }
    await p;
  }

  /** Imagen del fotograma vigente en JPEG (1920 px), guardada en `review/` junto al video. */
  async slideImage(ref: ReviewRef, index: number): Promise<string> {
    const g = await this.byRef(ref);
    const k = this.shown(g).find((x) => x.index === index);
    if (!k?.path) throw new NotFoundException('Fotograma no disponible.');
    const dir = this.dirOf(g);
    const src = join(dir, k.path);
    const out = join(dir, 'review', `K${nn(index)}_v${k.version}.jpg`);
    await this.make(out, async (tmp) => {
      await this.media.ensure(src);
      if (!existsSync(src)) throw new NotFoundException('Fotograma no disponible.');
      await ffmpeg(['-i', src, '-vf', `scale='min(${SLIDE_WIDTH},iw)':-2`, '-q:v', '3', '-f', 'mjpeg', tmp]);
    });
    return out;
  }

  /** Miniatura de un video en el link del proyecto (T6): el primer fotograma con texto (K01) o, si no hay, el que haya. */
  async thumbnail(ref: ReviewRef): Promise<string> {
    const g = await this.byRef(ref);
    const shown = this.shown(g).filter((k) => k.path);
    const k = shown.find((x) => x.index === 1) ?? shown[0];
    if (!k) throw new NotFoundException('El video aún no tiene fotogramas.');
    return this.slideImage(ref, k.index);
  }

  /** El final de un video en el link de los videos (T6b): ruta para servirlo (local o S3). */
  async finalVideo(ref: ReviewRef): Promise<string> {
    const g = await this.byRef(ref);
    if (!g.finalPath) throw new NotFoundException('El video aún no está terminado.');
    return join(this.dirOf(g), g.finalPath);
  }

  /** La locución en m4a (AAC 96 kb/s): pesa ~10 veces menos que el WAV y el navegador puede adelantar. */
  async voice(ref: ReviewRef): Promise<string> {
    const g = await this.byRef(ref);
    const words = (g.words as unknown as SubtitleWord[] | null) ?? [];
    if (!g.voicePath || !words.length) throw new NotFoundException('El video aún no tiene locución.');
    const dir = this.dirOf(g);
    const src = join(dir, g.voicePath);
    const out = join(dir, 'review', `voz_${this.voiceTag(words)}.m4a`);
    await this.make(out, async (tmp) => {
      await this.media.ensure(src);
      if (!existsSync(src)) throw new NotFoundException('El video aún no tiene locución.');
      await ffmpeg(['-i', src, '-vn', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-f', 'mp4', tmp]);
    });
    return out;
  }

  private clean(s: unknown, max: number) {
    return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  }

  /** Observación del cliente sobre un fotograma (con la versión que está viendo). */
  async addComment(ref: ReviewRef, body: { author?: unknown; text?: unknown; keyframeIndex?: unknown }) {
    const g = await this.byRef(ref);
    const author = this.clean(body.author, REVIEW_AUTHOR_MAX);
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, REVIEW_TEXT_MAX) : '';
    const index = Number(body.keyframeIndex);
    if (!author) throw new BadRequestException('Escribe tu nombre.');
    if (!text) throw new BadRequestException('Escribe la observación.');
    const shown = this.shown(g);
    const k = shown.find((x) => x.index === index);
    if (!k) throw new BadRequestException('Fotograma no válido.');
    const n = await this.db.reviewComment.count({ where: { generationId: g.id } });
    if (n >= REVIEW_MAX_COMMENTS) throw new BadRequestException('Este video ya tiene demasiadas observaciones.');
    if (kindOf(ref) === 'videos') {
      // Sobre el video terminado (T6b): al plano, con el final que estaba viendo.
      if (!g.finalPath) throw new BadRequestException('El video aún no está terminado.');
      await this.db.reviewComment.create({ data: { generationId: g.id, kind: 'video', keyframeIndex: index, keyframeVersion: k.version, versions: { final: g.finalPath }, author, text } });
    } else await this.db.reviewComment.create({ data: { generationId: g.id, kind: 'comment', keyframeIndex: index, keyframeVersion: k.version, author, text } });
    return this.deck(ref);
  }

  /** «Todo bien, aprobado»: guarda las versiones de todos los fotogramas que vio el cliente. */
  async approve(ref: ReviewRef, body: { author?: unknown }) {
    // El link de los videos es solo para observaciones (T6b, decisión de Leonardo).
    if (kindOf(ref) === 'videos') throw new NotFoundException('Este link no aprueba.');
    const g = await this.byRef(ref);
    const author = this.clean(body.author, REVIEW_AUTHOR_MAX);
    if (!author) throw new BadRequestException('Escribe tu nombre.');
    const n = await this.db.reviewComment.count({ where: { generationId: g.id } });
    if (n >= REVIEW_MAX_COMMENTS) throw new BadRequestException('Este video ya tiene demasiadas observaciones.');
    const versions = Object.fromEntries(this.shown(g).map((k) => [String(k.index), k.version]));
    await this.db.reviewComment.create({ data: { generationId: g.id, kind: 'approval', versions, author, text: 'Aprobado' } });
    return this.deck(ref);
  }
}
