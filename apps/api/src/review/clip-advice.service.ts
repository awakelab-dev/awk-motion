import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '@wilox/db';
import { ClipAdviceSchema, FPS, type ClipAdvice, type ClipFeedback, type ClipFeedbackComment, type ReviewCommentStatus } from '@wilox/shared';
import { clipAdviceSystemPrompt, clipAdviceUserText, type ClipAdviceKeyframe } from '@wilox/prompts';
import { DB } from '../db/db.module.js';
import { RunStore, type RunRecord } from '../generations/run-store.js';
import { withJobs } from '../jobs/job-scope.js';
import { imagePreviewJpeg } from '../media/ffmpeg.js';
import { askJson } from '../pipeline/llm-json.js';
import { PROVIDERS, type LlmContent, type Providers } from '../providers/ports.js';
import { MediaService } from '../storage/media.service.js';
import { TrashService } from '../trash/trash.service.js';

const nn = (i: number) => String(i).padStart(2, '0');
const statusOf = (c: { resolvedAt: Date | null; inProgressAt: Date | null; archivedAt: Date | null }): ReviewCommentStatus =>
  c.archivedAt ? 'archived' : c.resolvedAt ? 'resolved' : c.inProgressAt ? 'progress' : 'pending';
const STATUS_EN: Record<ReviewCommentStatus, string> = { pending: 'pending', progress: 'in progress', resolved: 'resolved', archived: 'archived' };

/**
 * Observaciones del cliente sobre un clip y la sugerencia de Opus (hito 9, T11, ADR-122). Un clip i va del fotograma
 * K(i-1) al Ki: le tocan las observaciones del storyboard sobre esos dos fotogramas y las del video sobre su plano Ki (y,
 * en el clip 1, las del plano K00). Opus las lee con las dos imágenes, el plano de cada una, el prompt del clip y la
 * locución del tramo, y propone qué regenerar (el clip, el fotograma inicial o el final) con la indicación lista. La
 * sugerencia queda en memoria mientras no cambien las observaciones, el clip ni sus fotogramas; los prompts, en el video.
 */
@Injectable()
export class ClipAdviceService {
  private readonly cache = new Map<string, Omit<ClipAdvice, 'stale'> & { sig: string }>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PROVIDERS) private readonly p: Providers,
    private readonly store: RunStore,
    private readonly media: MediaService,
    private readonly trash: TrashService,
  ) {}

  /** El acceso al video (por su proyecto) lo comprobó el guard de generations/:id… (hito 11, ADR-142). */
  private async rec(id: string, _ownerId: string): Promise<RunRecord> {
    if (this.trash.isHidden(id)) throw new NotFoundException('El video está en la papelera.');
    const r = await this.store.get(id);
    if (!r) throw new NotFoundException('Generación no encontrada.');
    return r;
  }

  /** Fotogramas del clip: K(i-1) y Ki. */
  private frames(rec: RunRecord, index: number) {
    const k = (i: number) => rec.state.keyframes.find((x) => x.index === i);
    return { start: k(index - 1), end: k(index) };
  }

  private async comments(rec: RunRecord, index: number): Promise<ClipFeedbackComment[]> {
    const s = rec.state;
    const video = index === 1 ? [0, 1] : [index];
    const rows = await this.db.reviewComment.findMany({
      where: {
        generationId: s.id,
        OR: [
          { kind: 'comment', keyframeIndex: { in: [index - 1, index] } },
          { kind: 'video', keyframeIndex: { in: video } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    const version = new Map(s.keyframes.map((k) => [k.index, k.previous ? k.previous.version : k.version]));
    const finalPath = await this.db.generation.findUnique({ where: { id: s.id }, select: { finalPath: true } }).then((g) => g?.finalPath);
    const out = rows.map((r): ClipFeedbackComment => {
      const final = (r.versions as { final?: string } | null)?.final;
      const outdated = r.kind === 'video' ? !!finalPath && final !== finalPath : r.keyframeVersion !== null && r.keyframeVersion < (version.get(r.keyframeIndex ?? -1) ?? r.keyframeVersion);
      return {
        id: r.id,
        kind: r.kind === 'video' ? 'video' : 'comment',
        keyframeIndex: r.keyframeIndex ?? 0,
        author: r.author,
        text: r.text,
        createdAt: r.createdAt.toISOString(),
        status: statusOf(r),
        outdated,
      };
    });
    // Solo las abiertas: una observación resuelta (o archivada, ADR-140) ya no se muestra en «Editar clip» (T11b).
    return out.filter((c) => c.status !== 'resolved' && c.status !== 'archived');
  }

  /** Huella de lo que vio Opus: observaciones abiertas, versión del clip y de sus dos fotogramas. */
  private sig(rec: RunRecord, index: number, open: ClipFeedbackComment[]) {
    const c = rec.state.clips.find((x) => x.index === index);
    const { start, end } = this.frames(rec, index);
    return [open.map((x) => x.id).join(','), c?.version, start?.version, end?.version].join('|');
  }

  private key = (id: string, index: number) => `${id}:${index}`;

  async feedback(id: string, ownerId: string, index: number): Promise<ClipFeedback> {
    const rec = await this.rec(id, ownerId);
    if (!rec.state.clips.some((c) => c.index === index)) throw new NotFoundException('Clip no encontrado.');
    const comments = await this.comments(rec, index);
    const open = comments;
    const cached = this.cache.get(this.key(id, index));
    // Si se resolvió alguna de las observaciones que vio Opus, su sugerencia deja de mostrarse (T11b); si solo llegaron
    // observaciones nuevas o cambió el clip, se muestra marcada como desactualizada.
    const openIds = new Set(open.map((c) => c.id));
    const valid = cached && cached.commentIds.every((x) => openIds.has(x));
    if (cached && !valid) this.cache.delete(this.key(id, index));
    const advice = cached && valid ? (({ sig, ...a }) => ({ ...a, stale: sig !== this.sig(rec, index, open) }))(cached) : undefined;
    return { comments, advice };
  }

  /** Imagen de un fotograma en JPEG para Opus (la vigente, con la que está hecho el clip). */
  private async jpeg(rec: RunRecord, k: { index: number; version: number; url?: string; previous?: { version: number; url?: string } }) {
    const url = k.previous?.url ?? k.url;
    const version = k.previous?.version ?? k.version;
    const rel = url?.match(/\/files\/([^?]+)/)?.[1];
    const src = rec.keyAssets.get(k.index)?.path && !k.previous ? rec.keyAssets.get(k.index)!.path : rel ? join(rec.dir, decodeURIComponent(rel)) : undefined;
    if (!src) return undefined;
    await this.media.ensure(src);
    if (!existsSync(src)) return undefined;
    const out = join(rec.dir, 'keyframes', `_consejo_K${nn(k.index)}_v${version}.jpg`);
    await imagePreviewJpeg(src, out, 1344);
    return (await readFile(out)).toString('base64');
  }

  /** Pide la sugerencia a Opus (unos centavos) y la deja en memoria. */
  async advise(id: string, ownerId: string, index: number): Promise<ClipFeedback> {
    const rec = await this.rec(id, ownerId);
    const s = rec.state;
    const c = s.clips.find((x) => x.index === index);
    if (!c) throw new NotFoundException('Clip no encontrado.');
    const comments = await this.comments(rec, index);
    const open = comments;
    if (!open.length) throw new BadRequestException('Este clip no tiene observaciones abiertas.');
    const { start, end } = this.frames(rec, index);
    const shotOf = (i: number): ClipAdviceKeyframe | undefined => {
      const k = s.keyframes.find((x) => x.index === i);
      if (!k) return undefined;
      const scene = i === 0 ? (rec.storyboard?.intro.scene ?? '') : (rec.shots?.[i - 1]?.keyframe.scene ?? '');
      return { index: i, label: k.label.replace(/^K\d+ · /, ''), texts: k.texts, scene };
    };
    const t0 = c.startFrame / FPS;
    const t1 = c.slotEndFrame / FPS;
    const narration = (rec.words ?? [])
      .filter((w) => w.start >= t0 - 0.001 && w.start < t1 - 0.001)
      .map((w) => w.word)
      .join(' ');
    const where = (x: ClipFeedbackComment) =>
      x.kind === 'video' ? `on the finished video, shot K${nn(x.keyframeIndex)}` : `on the storyboard, keyframe K${nn(x.keyframeIndex)} (${x.keyframeIndex === index ? 'END of this clip' : 'START of this clip'})`;
    const system = clipAdviceSystemPrompt(rec.theme);
    const text = clipAdviceUserText({
      clip: index,
      start: start ? shotOf(start.index) : undefined,
      end: end ? shotOf(end.index) : undefined,
      clipPrompt: c.prompt,
      narration,
      comments: open.map((x) => ({ id: x.id.slice(-8), where: where(x), author: x.author, text: x.text, status: STATUS_EN[x.status], outdated: x.outdated })),
    });
    const priority = 0; // la pidió el editor: va primero en la cola de Opus
    const result = await withJobs({ ownerId, generationId: s.id, priority }, async () => {
      await this.media.hydrate(rec.dir);
      return this.media.use(rec.dir, async () => {
        const content: Exclude<LlmContent, string> = [{ type: 'text', text }];
        for (const [label, k] of [
          ['START', start],
          ['END', end],
        ] as const) {
          const b64 = k ? await this.jpeg(rec, k).catch(() => undefined) : undefined;
          content.push({ type: 'text', text: b64 ? `${label} keyframe image:` : `${label} keyframe image: not available` });
          if (b64) content.push({ type: 'image', mediaType: 'image/jpeg', base64: b64 });
        }
        const n = (await this.db.prompt.count({ where: { generationId: s.id, name: { startsWith: `clip${nn(index)}_consejo_` } } }).catch(() => 0)) / 3 + 1;
        const v = Math.floor(n);
        await this.store.savePrompt(rec, `clip${nn(index)}_consejo_v${v}_system.md`, system);
        await this.store.savePrompt(rec, `clip${nn(index)}_consejo_v${v}_user.md`, text);
        const r = await askJson(this.p.llm, ClipAdviceSchema, system, content, `Observaciones clip${nn(index)}`);
        await this.store.savePrompt(rec, `clip${nn(index)}_consejo_v${v}_respuesta.json`, JSON.stringify(r, null, 2));
        return r;
      });
    });
    const valid = result.actions
      .filter((a) => a.instruction.trim() && (a.target === 'clip' || (a.target === 'start' ? !!start : !!end)))
      .map((a) => ({ ...a, modelInstruction: a.target === 'clip' ? a.modelInstruction.trim() : '' }));
    const advice = { summary: result.summary, actions: valid.slice(0, 3), notes: result.notes, at: new Date().toISOString(), commentIds: open.map((x) => x.id) };
    this.cache.set(this.key(id, index), { ...advice, sig: this.sig(rec, index, open) });
    return { comments, advice: { ...advice, stale: false } };
  }
}
