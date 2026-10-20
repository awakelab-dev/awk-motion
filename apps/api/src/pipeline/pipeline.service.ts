import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import pLimit from 'p-limit';
import { z } from 'zod';
import {
  CLIP_FRAMES,
  FPS,
  ImageReviewSchema,
  TransitionPlanSchema,
  ShotSchema,
  ClipSplitSchema,
  StoryboardReviewSchema,
  applyMediaFrameRule,
  mediaKindsLabel,
  StoryboardSchema,
  type ClipState,
  type KeyframeState,
  type RunState,
  type SoundMode,
  type ClipSoundMode,
  type Shot,
  type Storyboard,
  type RevoiceRequest,
  type VoiceSegment,
  type InsertRequest,
  type InsertState,
  type MediaRulePlan,
  type ClipSplitInfo,
  MAX_REFERENCES_IN_PROMPT,
  voiceTrialLabel,
  type VoiceTrialVariant,
  type VoiceTrialSettings,
} from '@wilox/shared';
import {
  clipVideoPrompt,
  insertClipPrompt,
  transitionClipPrompt,
  transitionPlanSystemPrompt,
  transitionPlanUserText,
  imageReviewItemText,
  imageReviewSystemPrompt,
  introImagePrompt,
  keyframeImagePrompt,
  referenceNote,
  typographyNote,
  reviewSystemPrompt,
  reviewUserPrompt,
  reviseShotSystemPrompt,
  splitShotSystemPrompt,
  splitShotUserPrompt,
  reviseShotUserPrompt,
  scriptDirectionPrompt,
  storyboardSystemPrompt,
  storyboardUserPrompt,
  type StoryboardInput,
  type TimedWord,
} from '@wilox/prompts';
import { env } from '../config/env.js';
import {
  assembleVoice,
  countFrames,
  durationSec,
  imagePreviewJpeg,
  assembleFinal,
  countPackets,
  videoStartTime,
  clipFrame,
  cutClip,
  encodeClipSegment,
  encodeFreeze,
  ssimAgainst,
  toWav48k,
  encodeUploadSegment,
  extractAudio,
  probeVideo,
  videoFrameAt,
  voiceWithGaps,
} from '../media/ffmpeg.js';
import { motionCurve, motionPeaks } from '../media/motion.js';
import { planSfx, renderSfx } from '../media/sfx.js';
import { PROVIDERS, type LlmContent, type Providers, type TtsOptions, type TtsResult } from '../providers/ports.js';
import { RunStore, type RunRecord } from '../generations/run-store.js';
import { MusicService } from '../music/music.service.js';
import { PausedError, QueueService } from '../queue/queue.service.js';
import { transientInfo } from '../queue/transient.js';
import { withJobs } from '../jobs/job-scope.js';
import { MediaService } from '../storage/media.service.js';
import { Prisma, type Db } from '@wilox/db';
import { DB } from '../db/db.module.js';
import { flattenPng } from '../media/flatten.js';
import { ThemeStore } from '../themes/theme-store.js';
import { markInterrupted, RUNNING } from '../persistence/run-data.js';
import { askJson, toApiSchema } from './llm-json.js';
import { alignWords } from './align.js';
import {
  applyRules,
  mapWordIndices,
  PronunciationFixSchema,
  pronunciationSystemPrompt,
  pronunciationUserPrompt,
  rulesIn,
  type Rule,
} from '../voice/pronunciation.js';
import { splitParagraphs, tokenize } from './text.js';
import { nextTextFor, splitWholeVoice } from '../voice/voice-trial.js';
import { pickSplitPoint, shiftIndexName, SPLIT_MIN_FRAMES, type SplitPoint } from './split.js';
import { renumberForSplit } from '../persistence/run-split.js';
import { clipShift, compose, finalCues, INSERT_VOICE_LEAD, TRANSITION_FRAMES, transitionCut, transitionFirst, transitionFrames, transitionWindow, type Composition } from './inserts.js';

/** Segmento del final ya ubicado: frame de inicio en el final y, en los insertos, cuál es. */
type FinalSegment = Segment & { finalStart: number; insert?: number; upload?: boolean };
import { clipSegments, holdLastClip, paragraphStarts, planShots, planTimeline, segmentsFor, totalFramesFor, videoFrames, type Segment } from './timeline.js';
import { clipSound, segmentKey, segmentReady, segmentStatus, soundKey, soundWav, writeSegmentKey } from './segments.js';
import { buildCues, toSrt, toVtt } from '../delivery/subtitles.js';
import { clipLoudness, modelSoundGainDb, remuxSegmentSound, renderModelSound, renderSilence } from '../media/sound.js';

const nn = (i: number) => String(i).padStart(2, '0');
/** Prioridad de las correcciones de clips (ADR-091): la más alta de la cola, como el Estudio. */
const URGENT_PRIORITY = 0;
const SOUND_LABEL: Record<SoundMode, string> = { model: 'del modelo', synth: 'sintetizado', none: 'sin sonido' };

@Injectable()
export class PipelineService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Pipeline');
  /** Generaciones que trabajaban en la cola cuando se detuvo la API (se retoman solas al arrancar). */
  private readonly resumable = new Set<string>();
  /** Post de clips en marcha por video (hito 6, ADR-056): el mismo trabajo no se lanza dos veces. */
  private readonly posting = new WeakMap<RunRecord, Map<string, Promise<void>>>();
  /** Hora en que llegó el último clip de cada video (para medir cuánto tarda el final después). */
  private readonly lastClipAt = new WeakMap<RunRecord, number>();
  /** Trabajos de insertos en marcha (ADR-075) y contador de cambios para volver a unir el final. */
  /** Trabajos en marcha de los insertos de cada video (x<id> = locución y clip; t<id> = transición; ADR-075). */
  private readonly insertJobs = new WeakMap<RunRecord, Map<string, Promise<void>>>();
  /** Cambios de los insertos (listos, quitados…) y los que ya están en el último final unido. */
  private readonly insertRev = new WeakMap<RunRecord, number>();
  private readonly renderedRev = new WeakMap<RunRecord, number>();
  /**
   * Videos con una corrección de clips en marcha (ADR-091): sus trabajos van primero en la cola global, y
   * también la unión del final que sigue. Se quita al terminar esa unión.
   */
  private readonly urgent = new WeakSet<RunRecord>();

  constructor(
    private readonly store: RunStore,
    @Inject(PROVIDERS) private readonly p: Providers,
    private readonly music: MusicService,
    private readonly queue: QueueService,
    @Inject(DB) private readonly db: Db,
    private readonly media: MediaService,
    private readonly themes: ThemeStore,
  ) {
    this.store.onRestore = (rec) => this.resume(rec);
    // La carpeta de un video solo sale de la caché local si no está trabajando ni tiene trabajos aparte.
    this.media.addEvictGuard((unit) => {
      if (!unit.startsWith('runs/')) return true;
      const rec = this.store.peek(unit.slice('runs/'.length));
      if (!rec) return true;
      if (rec.busy || this.insertJobs.get(rec)?.size || this.posting.get(rec)?.size) return false;
      return this.store.release(rec.state.id);
    });
  }

  // ---------------------------------------------------------------- reinicio (hito 5, ADR-046)

  /**
   * Al arrancar, retoma las generaciones que estaban trabajando: lo pendiente vuelve a la cola, los
   * clips ya enviados a MiniMax se siguen consultando y nada de lo terminado se repite.
   */
  async onApplicationBootstrap() {
    await this.queue.ready;
    try {
      const rows = await this.db.generation.findMany({
        where: {
          mode: env.GENERATION_MODE,
          OR: [
            { status: { in: RUNNING } },
            { status: { in: ['awaiting_approval', 'done'] }, keyframes: { some: { OR: [{ status: 'generating' }, { pending: { not: Prisma.DbNull } }] } } },
            // Videos terminados con insertos (ADR-075): se retoman los que quedaron en marcha.
            { status: 'done', inserts: { not: Prisma.DbNull } },
            // Clips regenerándose por su lado en un video terminado (ADR-091).
            { status: 'done', clips: { some: { status: { in: ['pending', 'generating'] } } } },
          ],
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      // Solo se retoman las que trabajaban en la cola hace poco (24 h): una generación antigua que quedó a
      // medias antes del hito 5 no se relanza sola (podría gastar sin que nadie lo pida); queda con Reintentar.
      const recent = await this.db.queueTask.findMany({
        where: { generationId: { in: rows.map((r) => r.id) }, createdAt: { gt: new Date(Date.now() - 24 * 3600_000) } },
        select: { generationId: true },
        distinct: ['generationId'],
      });
      for (const r of recent) if (r.generationId) this.resumable.add(r.generationId);
      if (rows.length) this.logger.log(`Retomando ${this.resumable.size} generación(es) que estaban trabajando (${rows.length - this.resumable.size} antiguas quedan para Reintentar)…`);
      for (const r of rows) await this.store.get(r.id); // restaurar llama a resume()
    } catch (e) {
      this.logger.error(`No se pudieron retomar las generaciones: ${(e as Error).message}`);
    }
  }

  /** Apagado ordenado: deja de despachar, espera los trabajos que no se pueden retomar y guarda todo. */
  async beforeApplicationShutdown() {
    await this.queue.drain();
    await this.store.flushAll();
  }

  /** Retoma una generación restaurada desde la BD que estaba trabajando cuando la API se detuvo. */
  resume(rec: RunRecord) {
    const s = rec.state;
    if (rec.busy) return;
    const working = RUNNING.includes(s.status);
    const regens = s.keyframes.filter((k) => k.pending || k.status === 'generating' || k.activity);
    if (s.status === 'done' && s.clips.some((c) => c.status === 'pending' || c.status === 'generating')) this.resumeClips(rec);
    if (s.status === 'done' && !regens.length) return this.resumeInserts(rec);
    if (!working && !((s.status === 'awaiting_approval' || s.status === 'done') && regens.length)) return;
    if (!this.resumable.has(s.id)) {
      // Interrumpida antes de la cola global (o hace más de 24 h): como antes del hito 5, queda para Reintentar.
      if (markInterrupted(rec)) {
        this.store.update(rec);
        this.store.log(rec, 'Generación restaurada tras un reinicio de la API: lo que estaba en marcha quedó para reintentar.', 'warn');
      }
      return;
    }
    this.resumable.delete(s.id);
    this.store.update(rec, () => s.keyframes.forEach((k) => (k.activity = undefined)));
    if (working && !rec.approved) {
      this.store.log(rec, 'Retomada tras un reinicio de la API: sigue desde donde quedó (lo hecho no se repite).', 'warn');
      this.store.update(rec, () => s.keyframes.forEach((k) => k.status === 'generating' && (k.status = 'pending')));
      this.startPhase1(rec);
    } else if (working) {
      const sent = s.clips.filter((c) => c.status !== 'ready' && c.taskId).length;
      this.store.log(rec, `Retomada tras un reinicio de la API${sent ? `: ${sent} clip(s) ya enviados se siguen consultando` : ''}.`, 'warn');
      this.startPhase2(rec);
    } else {
      for (const k of regens) {
        if (k.pending) {
          this.store.log(rec, `K${nn(k.index)}: se retoma la regeneración tras un reinicio.`, 'warn');
          this.runRegen(rec, k.index);
        } else
          this.store.update(rec, () => {
            k.status = rec.keyAssets.has(k.index) ? 'ready' : 'error';
            if (k.status === 'error') k.error = 'Interrumpido por un reinicio de la API; regénéralo.';
          });
      }
      if (s.status === 'awaiting_approval') this.reviewMessage(rec);
    }
  }

  // ---------------------------------------------------------------- helpers
  private fileUrl(rec: RunRecord, abs: string, version?: number) {
    return `/api/generations/${rec.state.id}/files/${relative(rec.dir, abs).split('\\').join('/')}${version ? `?v=${version}` : ''}`;
  }

  private step(rec: RunRecord, status: RunState['status'], message: string) {
    // Detenido (ADR-052): lo que estaba en marcha termina, pero el video sigue "detenido" (salvo si acaba).
    if (this.queue.isPaused(rec.state.id)) {
      if (status !== 'done') {
        this.store.log(rec, message);
        return;
      }
      this.queue.resumeGeneration(rec.state.id);
    }
    this.store.update(rec, (s) => {
      s.status = status;
      s.message = message;
    });
    this.store.log(rec, message);
  }

  /** Archivo en prompts/ y fila Prompt en la BD (hito 3). */
  private savePrompt(rec: RunRecord, name: string, content: string) {
    return this.store.savePrompt(rec, name, content);
  }

  private fail(rec: RunRecord, e: unknown) {
    if (this.queue.isPaused(rec.state.id) || e instanceof PausedError) return this.markPaused(rec);
    const msg = e instanceof Error ? e.message : String(e);
    this.logger.error(`[${rec.state.id}] ${msg}`);
    this.store.update(rec, (s) => {
      s.status = 'error';
      s.error = msg;
      s.message = 'Error: ' + (msg.split('\n').find((l) => l.trim()) ?? msg).trim();
    });
    this.store.log(rec, msg, 'error');
  }

  /**
   * Trabajo de un video (hito 8, ADR-093): con el remoto activo, primero se baja lo que falte de su carpeta
   * y, mientras corre, la carpeta no sale de la caché local.
   */
  private work<T>(rec: RunRecord, scope: ReturnType<PipelineService['scope']>, fn: () => Promise<T>): Promise<T> {
    return withJobs(scope, async () => {
      await this.media.hydrate(rec.dir);
      return this.media.use(rec.dir, fn);
    });
  }

  /** Ámbito de los trabajos del video: dueño, generación y prioridad en la cola (hora de lanzamiento, ADR-045). */
  private scope(rec: RunRecord) {
    const priority = this.urgent.has(rec) ? URGENT_PRIORITY : Date.parse(rec.state.createdAt) || Date.now();
    return { ownerId: rec.ownerId, generationId: rec.state.id, priority };
  }

  private guard(rec: RunRecord, fn: () => Promise<void>) {
    if (rec.busy) throw new Error('La generación ya está trabajando.');
    rec.busy = true;
    // Cada trabajo de un proveedor dentro de fn queda anotado a esta generación y a su dueño.
    void this.work(rec, this.scope(rec), fn)
      .then(() => {
        // Terminó lo que estaba en marcha mientras se detenía (p. ej. quedó esperando aprobación).
        if (this.queue.isPaused(rec.state.id)) this.markPaused(rec);
      })
      .catch((e) => this.fail(rec, e))
      .finally(() => {
        rec.busy = false;
        this.rejoinIfNeeded(rec);
      });
  }

  /** Un video terminado cuyo final no tiene los últimos cambios de sus insertos se vuelve a unir (ADR-075). */
  private rejoinIfNeeded(rec: RunRecord) {
    if (rec.busy || rec.state.status !== 'done' || this.queue.isPaused(rec.state.id)) return;
    if ((this.insertRev.get(rec) ?? 0) === (this.renderedRev.get(rec) ?? 0)) return;
    this.guard(rec, () => this.post(rec));
  }

  // ---------------------------------------------------------------- detener y reanudar (hito 5, ADR-052)

  /** Se puede detener un video que aún no tiene final (en curso, esperando aprobación o con error). */
  canPause(rec: RunRecord): boolean {
    const s = rec.state;
    return !s.finalUrl && s.status !== 'done' && s.status !== 'paused';
  }

  /**
   * Detener un video: sale de la cola (sus trabajos en espera se cancelan y no entran nuevos) y queda
   * "detenido" hasta Reanudar. Lo que ya está en marcha en un proveedor termina y se conserva.
   */
  pause(rec: RunRecord) {
    if (!this.canPause(rec)) throw new Error(rec.state.finalUrl ? 'Este video ya tiene un final: no se detiene.' : 'Este video no se puede detener ahora.');
    const id = rec.state.id;
    this.queue.pauseGeneration(id);
    const working = rec.busy || rec.state.keyframes.some((k) => k.status === 'generating' || k.activity);
    this.store.log(rec, working ? 'Detenido por el usuario: termina lo que ya estaba en marcha y no sigue.' : 'Detenido por el usuario.');
    if (!working) this.markPaused(rec);
    else this.store.update(rec, (s) => ((s.status = 'paused'), (s.message = 'Deteniendo: termina lo que ya estaba en marcha…')));
  }

  /** Deja el video detenido y en un estado desde el que Reanudar sigue sin repetir nada. */
  private markPaused(rec: RunRecord) {
    const s = rec.state;
    this.store.update(rec, () => {
      s.status = 'paused';
      s.error = undefined;
      s.message = 'Detenido. Pulsa Reanudar para seguir desde donde quedó.';
      for (const k of s.keyframes) {
        if (k.status === 'generating' || (k.status === 'error' && /Detenido/.test(k.error ?? ''))) {
          k.status = k.pending?.stage === 'rewrite' && rec.keyAssets.has(k.index) ? 'ready' : 'pending';
          k.error = undefined;
        }
        if (k.pending?.stage === 'rewrite' || k.pending?.stage === 'review') k.pending = undefined;
        k.activity = undefined;
      }
      for (const c of s.clips)
        if (c.status === 'generating' || (c.status === 'error' && /Detenido/.test(c.error ?? ''))) {
          c.status = 'pending'; // conserva su task_id: al reanudar se sigue consultando
          c.error = undefined;
        }
    });
  }

  /** Reanudar un video detenido: vuelve a la cola con su prioridad y sigue desde donde quedó. */
  continue(rec: RunRecord) {
    if (rec.state.status !== 'paused') throw new Error('Este video no está detenido.');
    if (rec.busy) throw new Error('Espera a que termine lo que estaba en marcha.');
    this.queue.resumeGeneration(rec.state.id);
    this.store.log(rec, 'Reanudado por el usuario.');
    if (rec.approved) this.startPhase2(rec);
    else this.startPhase1(rec);
  }

  // ---------------------------------------------------------------- fase 1
  /**
   * Voz → tiempos → storyboard (Opus) → plan → fotogramas clave → espera aprobación. Cada paso salta lo
   * que ya está hecho (hito 5, ADR-046): al retomar tras un reinicio o al reintentar no se paga dos veces.
   */
  startPhase1(rec: RunRecord) {
    this.guard(rec, async () => {
      for (const d of ['voice', 'keyframes', 'clips', 'segments', 'prompts']) await mkdir(join(rec.dir, d), { recursive: true });
      await this.voice(rec);
      await this.timings(rec);
      await this.storyboard(rec);
      await this.keyframes(rec);
    });
  }

  /** Locución de un párrafo ya generada (voice/parrafoNN.tts.json), si coincide el texto y la voz. */
  private async savedVoice(rec: RunRecord, i: number, text: string): Promise<TtsResult | undefined> {
    const meta = join(rec.dir, 'voice', `parrafo${nn(i + 1)}.tts.json`);
    if (!existsSync(meta)) return undefined;
    try {
      const m = JSON.parse(await readFile(meta, 'utf8')) as { text: string; spoken?: string; voiceId: string; result: TtsResult };
      const path = isAbsolute(m.result.path) ? m.result.path : join(rec.dir, m.result.path);
      if (m.text !== text || m.voiceId !== rec.state.voiceId || !existsSync(path)) return undefined;
      return { ...m.result, path, ...(m.spoken && m.spoken !== text ? { spokenText: m.spoken } : {}) } as TtsResult;
    } catch {
      return undefined;
    }
  }

  /** Punto de control de la locución de un párrafo (texto, texto enviado a la voz y resultado). */
  private async saveVoice(rec: RunRecord, i: number, text: string, spoken: string, r: TtsResult) {
    await writeFile(
      join(rec.dir, 'voice', `parrafo${nn(i + 1)}.tts.json`),
      JSON.stringify({ text, spoken, voiceId: rec.state.voiceId, result: { ...r, path: relative(rec.dir, r.path) } }, null, 1),
    );
  }

  /**
   * Locución en un solo pedido (ADR-129, ADR-133): todo el texto a la voz de una vez (sin cambios de tono, velocidad ni
   * acento entre párrafos) y cortado por párrafos con la alineación, a la mitad del silencio entre uno y otro (las pausas
   * son las del propio pedido). Si pasa de 5.000 caracteres (el tope de v3), en bloques de párrafos enteros, separados
   * por la pausa de siempre. Cada bloque guarda su punto de control (`<base>.tts.json`): tras un reinicio no se paga dos veces.
   * Devuelve el tramo de cada párrafo (en el orden de `texts`) y sus palabras con tiempo absoluto.
   */
  private async wholeVoice(
    rec: RunRecord,
    o: { texts: string[]; spoken: string[]; base: string; wavOf: (i: number) => string; tts?: TtsOptions },
  ): Promise<{ parts: { wav: string; startSec: number; dur: number }[]; words: { word: string; start: number; end: number; pos: number }[]; endSec: number; record: string[] }> {
    const MAX = 5000;
    const blocks: number[][] = [];
    let cur: number[] = [];
    let len = 0;
    o.spoken.forEach((t, i) => {
      if (t.length > MAX) throw new Error(`El párrafo ${i + 1} tiene ${t.length} caracteres: un pedido a la voz admite hasta ${MAX}.`);
      if (cur.length && len + 2 + t.length > MAX) {
        blocks.push(cur);
        cur = [];
        len = 0;
      }
      len += (cur.length ? 2 : 0) + t.length;
      cur.push(i);
    });
    if (cur.length) blocks.push(cur);
    const parts: { wav: string; startSec: number; dur: number }[] = [];
    const words: { word: string; start: number; end: number; pos: number }[] = [];
    const record: string[] = [];
    let offset = 0;
    for (const [b, block] of blocks.entries()) {
      const text = block.map((i) => o.spoken[i]).join('\n\n');
      const base = blocks.length > 1 ? `${o.base}_b${b + 1}` : o.base;
      const meta = `${base}.tts.json`;
      let audio: TtsResult | undefined;
      try {
        const m = JSON.parse(await readFile(meta, 'utf8')) as { text: string; voiceId: string; result: TtsResult };
        const path = isAbsolute(m.result.path) ? m.result.path : join(rec.dir, m.result.path);
        if (m.text === text && m.voiceId === rec.state.voiceId && existsSync(path)) audio = { ...m.result, path };
      } catch {
        // sin punto de control: se pide
      }
      if (!audio) {
        audio = await this.p.tts.synthesize(text, rec.state.voiceId, base, o.tts);
        await writeFile(meta, JSON.stringify({ text, voiceId: rec.state.voiceId, result: { ...audio, path: relative(rec.dir, audio.path) } }, null, 1));
      }
      if (!audio.words?.length) throw new Error('La voz no devolvió los tiempos por palabra de la locución completa.');
      const whole = `${base}.48k.wav`;
      await toWav48k(audio.path, whole);
      const total = await durationSec(whole);
      const tokens = block.map((i) => tokenize(o.texts[i]));
      const aligned = alignWords(tokens.flat(), audio.words, total);
      const ranges = splitWholeVoice(aligned, tokens.map((t) => t.length), total);
      let k = 0;
      for (const [j, r] of ranges.entries()) {
        const i = block[j];
        await extractAudio(whole, r.start, r.end - r.start, o.wavOf(i));
        parts[i] = { wav: o.wavOf(i), startSec: offset + r.start, dur: r.end - r.start };
        for (const w of aligned.slice(k, k + tokens[j].length)) words.push({ word: w.word, start: offset + w.start, end: offset + w.end, pos: i });
        k += tokens[j].length;
        record.push(`Párrafo ${i + 1}: ${(offset + r.start).toFixed(3)}–${(offset + r.end).toFixed(3)} s`);
      }
      record.push(`Pedido ${b + 1} de ${blocks.length}: request_id ${audio.jobId ?? '—'} · ${text.length} caracteres`);
      // El bloque siguiente arranca tras la pausa de siempre (≥ 0,5 s, en un frame múltiplo de 12).
      offset = Math.ceil(((offset + total + 0.5) * FPS) / 12) * (12 / FPS);
    }
    const endSec = parts[parts.length - 1].startSec + parts[parts.length - 1].dur;
    return { parts, words, endSec, record };
  }

  private async rulesFor(ownerId: string): Promise<Rule[]> {
    try {
      return await this.db.pronunciationRule.findMany({ where: { ownerId }, select: { match: true, say: true } });
    } catch {
      return [];
    }
  }

  private async voice(rec: RunRecord) {
    const s = rec.state;
    const paras = splitParagraphs(s.text);
    if (!paras.length) throw new Error('El texto está vacío.');
    // Ya hecha (locución montada y tiempos calculados): no se vuelve a pedir, aunque falten los puntos de
    // control de los videos anteriores al hito 5.
    if (s.paragraphs.length === paras.length && s.totalFrames && rec.words?.length && existsSync(join(rec.dir, 'voice', 'voz_completa.wav'))) return;
    const saved = await Promise.all(paras.map((t, i) => this.savedVoice(rec, i, t)));
    const todo = saved.filter((x) => !x).length;
    // Reglas de pronunciación del usuario (ADR-048): cambian solo el texto que recibe la voz.
    const rules = todo ? await this.rulesFor(rec.ownerId) : [];
    // Tono del guion (ADR-049): etiqueta de ElevenLabs v3 al inicio del párrafo ("[excited] …").
    const tag = (i: number) => (s.script?.rows[i]?.voiceTag && this.p.mode !== 'mock' ? `[${s.script.rows[i].voiceTag}] ` : '');
    const spoken = paras.map((t, i) => tag(i) + applyRules(t, rules));
    if (s.voiceMode === 'whole') return this.voiceWhole(rec, paras, spoken);
    this.step(rec, 'voice', todo ? `Generando la locución (${todo} párrafo${todo > 1 ? 's' : ''})…` : 'Locución ya generada: se retoma.');
    const limit = pLimit(4);
    const audio = await Promise.all(
      paras.map((t, i) =>
        saved[i]
          ? Promise.resolve(saved[i]!)
          : limit(async () => {
              const r = await this.p.tts.synthesize(spoken[i], s.voiceId, join(rec.dir, 'voice', `parrafo${nn(i + 1)}`));
              // Punto de control: tras un reinicio esta locución no se vuelve a pedir (ADR-046).
              await this.saveVoice(rec, i, t, spoken[i], r);
              return r;
            }),
      ),
    );
    const wavs = await Promise.all(
      audio.map(async (a, i) => {
        const wav = join(rec.dir, 'voice', `parrafo${nn(i + 1)}.48k.wav`);
        await toWav48k(a.path, wav);
        return { wav, dur: await durationSec(wav) };
      }),
    );
    const starts = paragraphStarts(wavs.map((w) => w.dur));
    const end = starts[starts.length - 1] + wavs[wavs.length - 1].dur;
    const totalFrames = totalFramesFor(end);
    const voiceWav = join(rec.dir, 'voice', 'voz_completa.wav');
    await assembleVoice(
      wavs.map((w, i) => ({ wav: w.wav, startSec: starts[i] })),
      totalFrames / FPS,
      voiceWav,
    );
    rec.paraAudio = audio;
    this.store.update(rec, (st) => {
      st.paragraphs = paras.map((text, i) => ({
        index: i,
        text,
        startSec: starts[i],
        durationSec: wavs[i].dur,
        version: 1,
        spokenText: (saved[i] as (TtsResult & { spokenText?: string }) | undefined)?.spokenText ?? (spoken[i] !== text ? spoken[i] : undefined),
      }));
      st.durationSec = totalFrames / FPS;
      st.totalFrames = totalFrames;
      st.voiceUrl = this.fileUrl(rec, voiceWav);
    });
    this.store.log(rec, `Locución lista: ${end.toFixed(2)} s → ${totalFrames} frames.`);
  }

  /** Locución de un video nuevo en un solo pedido (ADR-133): los párrafos quedan con los tiempos que trae la voz. */
  private async voiceWhole(rec: RunRecord, paras: string[], spoken: string[]) {
    this.step(rec, 'voice', 'Generando la locución en un solo pedido…');
    const vdir = join(rec.dir, 'voice');
    const r = await this.wholeVoice(rec, { texts: paras, spoken, base: join(vdir, 'locucion'), wavOf: (i) => join(vdir, `parrafo${nn(i + 1)}.48k.wav`) });
    const totalFrames = totalFramesFor(r.endSec);
    const voiceWav = join(vdir, 'voz_completa.wav');
    await assembleVoice(r.parts.map((p) => ({ wav: p.wav, startSec: p.startSec })), totalFrames / FPS, voiceWav);
    // Los tiempos de cada párrafo, relativos a su inicio (los toma el paso de tiempos por palabra, como siempre).
    rec.paraAudio = r.parts.map((p, i) => ({ path: p.wav, words: r.words.filter((w) => w.pos === i).map((w) => ({ word: w.word, start: w.start - p.startSec, end: w.end - p.startSec })) }));
    this.store.update(rec, (st) => {
      st.paragraphs = paras.map((text, i) => ({
        index: i,
        text,
        startSec: r.parts[i].startSec,
        durationSec: r.parts[i].dur,
        version: 1,
        spokenText: spoken[i] !== text ? spoken[i] : undefined,
      }));
      st.durationSec = totalFrames / FPS;
      st.totalFrames = totalFrames;
      st.voiceUrl = this.fileUrl(rec, voiceWav);
    });
    await this.savePrompt(rec, 'locucion_v1.md', ['# Locución · un solo pedido', '', ...r.record, '', '## Enviado a la voz', '', spoken.join('\n\n')].join('\n'));
    this.store.log(rec, `Locución lista en un solo pedido: ${r.endSec.toFixed(2)} s → ${totalFrames} frames.`);
  }

  private async timings(rec: RunRecord) {
    if (rec.words?.length) return; // ya calculados (se retoma)
    this.step(rec, 'timings', 'Calculando los tiempos por palabra…');
    const words: TimedWord[] = [];
    const s = rec.state;
    const per = await Promise.all(
      s.paragraphs.map((p, i) => this.p.timing.wordTimes(tokenize(p.text), rec.paraAudio![i], p.durationSec)),
    );
    per.forEach((heard, i) => {
      // Alineado con el texto del video: con reglas de pronunciación la voz dice otra cosa ("I, A, A, S"),
      // pero los índices de palabras (anclas de los planos) son los del texto. Sin reglas, queda igual.
      const p = s.paragraphs[i];
      for (const w of alignWords(tokenize(p.text), heard, p.durationSec)) words.push({ word: w.word, start: w.start + p.startSec, end: w.end + p.startSec, paragraph: i });
    });
    if (!words.length) throw new Error('No se obtuvieron tiempos por palabra.');
    rec.words = words;
    await this.savePrompt(rec, 'tiempos_por_palabra.json', JSON.stringify(words, null, 1));
  }

  private askJson<T>(schema: z.ZodType<T>, system: string, user: LlmContent, label: string): Promise<T> {
    return askJson(this.p.llm, schema, system, user, label);
  }

  /**
   * Referencias del tema (temas del Estudio) listas para GPT Image: en MCP se suben una vez
   * (media_upload) y el media_id queda guardado en la copia del tema de la generación.
   */
  private async themeRefs(rec: RunRecord, index: number): Promise<string[]> {
    // Hasta 4 referencias de estilo y, en los fotogramas con texto (no en la intro), las láminas tipográficas
    // del tema detrás (ADR-094).
    const style = rec.themeRefs.filter((r) => !r.typography).slice(0, MAX_REFERENCES_IN_PROMPT);
    const sheets = index > 0 ? rec.themeRefs.filter((r) => r.typography) : [];
    const refs = [...style, ...sheets];
    let changed = false;
    for (const r of refs) {
      if (r.ref) continue;
      const abs = isAbsolute(r.path) ? r.path : join(rec.dir, r.path);
      if (!existsSync(abs)) throw new Error(`Falta la referencia del tema: ${r.path}`);
      r.ref = this.p.uploadRef ? await this.p.uploadRef(abs) : abs;
      changed = true;
    }
    if (changed) await this.store.saveTheme(rec);
    return refs.map((r) => r.ref!);
  }

  /**
   * «Colores planos» (ADR-137): manda el valor actual del tema (no la copia del video), así también se alisan los
   * fotogramas que se regeneran en videos anteriores. En MCP la imagen ya está en Higgsfield: no se toca.
   */
  private flatColors(rec: RunRecord): boolean {
    if (this.p.mode === 'mcp') return false;
    return this.themes.style(rec.state.theme)?.flatColors ?? rec.theme.flatColors ?? false;
  }

  private async flatten(rec: RunRecord, path: string, label: string) {
    if (!this.flatColors(rec)) return;
    try {
      const r = await flattenPng(path);
      this.media.dirty(path);
      this.store.log(rec, `${label}: colores planos (${r.regions} zonas, ${Math.round(r.share * 100)} % de la imagen).`);
    } catch (e) {
      this.store.log(rec, `${label}: no se pudieron aplanar los colores (${(e as Error).message}); queda la imagen tal cual.`, 'warn');
    }
  }

  private storyboardInput(rec: RunRecord): StoryboardInput {
    const s = rec.state;
    return {
      theme: s.theme,
      paragraphs: s.paragraphs,
      words: rec.words!,
      totalSec: s.durationSec!,
      clipSec: CLIP_FRAMES / FPS,
      // Guion importado (ADR-049): sin guion, el mensaje es el de siempre.
      ...(s.script?.rows.length ? { script: s.script.rows } : {}),
    };
  }

  private keyframePrompt(rec: RunRecord, index: number): string {
    const base =
      index === 0 ? introImagePrompt(rec.theme, rec.storyboard!.intro.scene) : keyframeImagePrompt(rec.theme, rec.shots![index - 1]);
    const styleRefs = Math.min(rec.themeRefs.filter((r) => !r.typography).length, MAX_REFERENCES_IN_PROMPT);
    const sheets = index > 0 ? rec.themeRefs.filter((r) => r.typography).length : 0;
    // Sin láminas, el prompt de siempre (golden); con ellas, cuáles son de estilo y qué fuente usar (ADR-094).
    return base + referenceNote(styleRefs, { first: sheets > 0 }) + typographyNote(rec.theme.typefaces?.filter((f) => f.status === 'ready') ?? [], sheets, styleRefs > 0);
  }

  private clipPrompt(rec: RunRecord, clipIndex: number): string {
    const shots = rec.shots!;
    const start = clipIndex === 1 ? 'only the style background, no text yet' : shots[clipIndex - 2].keyframe.summary;
    const base = clipVideoPrompt(rec.theme, clipIndex, shots[clipIndex - 1], start);
    // Indicación del editor al regenerar el clip (ADR-033); sin nota el prompt es el de siempre (golden).
    const note = rec.state.clips.find((c) => c.index === clipIndex)?.note?.trim();
    return note ? `${base}\n\nADDITIONAL DIRECTION FROM THE EDITOR (apply it without breaking the rules above): ${note}` : base;
  }

  /** Versiones de los fotogramas de inicio y fin de un clip. */
  private keyVersions(rec: RunRecord, clipIndex: number): [number, number] {
    const v = (i: number) => rec.state.keyframes.find((k) => k.index === i)?.version ?? 1;
    return [v(clipIndex - 1), v(clipIndex)];
  }

  /** Borrador del storyboard ya escrito por Opus (se retoma sin volver a pedirlo). */
  private async savedDraft(rec: RunRecord): Promise<Storyboard | undefined> {
    const f = join(rec.dir, 'prompts', 'storyboard_borrador.json');
    if (!existsSync(f)) return undefined;
    try {
      const b = StoryboardSchema.parse(JSON.parse(await readFile(f, 'utf8')));
      return b.shots.length ? b : undefined;
    } catch {
      return undefined;
    }
  }

  private async storyboard(rec: RunRecord) {
    const s = rec.state;
    // Ya hecho (se retoma): storyboard, planos, plan y fotogramas definidos.
    if (rec.storyboard && rec.shots?.length && rec.plan?.length && s.keyframes.length) return;
    const who = env.GENERATION_MODE === 'mock' ? 'el mock' : `${env.ANTHROPIC_MODEL} (effort ${env.ANTHROPIC_EFFORT})`;
    const words = rec.words!;
    const input = this.storyboardInput(rec);
    const system = storyboardSystemPrompt(rec.theme) + (s.script?.rows.some((r) => r.scene || r.layout) ? scriptDirectionPrompt() : '');
    const user = storyboardUserPrompt(input);
    let board = await this.savedDraft(rec);
    if (board) this.step(rec, 'storyboard', 'Storyboard ya escrito por Opus: se retoma desde la revisión.');
    else {
      this.step(rec, 'storyboard', `Diseñando el storyboard con ${who}…`);
      await this.savePrompt(rec, 'opus_system.md', system);
      await this.savePrompt(rec, 'opus_user.md', user);
      board = await this.askJson(StoryboardSchema, system, user, 'Storyboard');
      if (!board.shots.length) throw new Error('Opus devolvió un storyboard sin planos.');
      await this.savePrompt(rec, 'storyboard_borrador.json', JSON.stringify(board, null, 2));
    }

    if (env.STORYBOARD_REVIEW) {
      this.step(rec, 'storyboard', 'Revisión de dirección de arte: Opus relee el storyboard y simplifica lo sobrecargado…');
      const rs = reviewSystemPrompt(rec.theme) + (s.script?.rows.some((r) => r.scene || r.layout) ? scriptDirectionPrompt() : '');
      const ru = reviewUserPrompt(board, input);
      await this.savePrompt(rec, 'opus_revision_system.md', rs);
      try {
        const review = await this.askJson(StoryboardReviewSchema, rs, ru, 'Revisión');
        if (review.storyboard.shots.length) board = review.storyboard;
        await this.savePrompt(rec, 'revision_director.md', review.notes.map((n) => `- ${n}`).join('\n'));
        this.store.log(rec, `Revisión de dirección de arte: ${review.notes.join(' · ')}`);
      } catch (e) {
        this.store.log(rec, `La revisión del storyboard falló; se usa el borrador. ${(e as Error).message}`, 'warn');
      }
    }
    // Animación de las imágenes (ADR-080): con «según cuántas haya» el código fija video/foto en cada marco.
    if (rec.theme.usesMediaFrames) {
      const fixed = applyMediaFrameRule(board.shots, rec.theme.mediaFrameRule);
      if (fixed.length)
        this.store.log(rec, `Animación de las imágenes según cuántas haya: se ajustaron ${fixed.length} plano(s) (${fixed.map((i) => `${board!.shots[i].pfc}: ${mediaKindsLabel(board!.shots[i])}`).join(' · ')}).`);
    }
    await this.savePrompt(rec, 'storyboard.json', JSON.stringify(board, null, 2));

    // Normaliza anclas: la primera PFC va al inicio; orden y rango válidos.
    const shots = board.shots
      .map((sh) => ({ ...sh, anchorWordIndex: Math.max(0, Math.min(words.length - 1, Math.round(sh.anchorWordIndex))) }))
      .sort((a, b) => a.anchorWordIndex - b.anchorWordIndex);
    shots[0].anchorWordIndex = 0;
    if (!rec.theme.usesMediaFrames) shots.forEach((sh) => (sh.keyframe.mediaFrames = []));
    const plan = planShots(words, shots, s.paragraphs, s.totalFrames!);
    const kept = plan.map((pl) => shots[pl.shot]);
    if (kept.length < shots.length) this.store.log(rec, `Se descartaron ${shots.length - kept.length} PFC que no cabían en la línea de tiempo.`, 'warn');
    rec.storyboard = board;
    rec.plan = plan;
    rec.shots = kept;

    // Prompts de fotogramas y de clips (se guardan todos).
    const keyframes = [
      { index: 0, label: 'K00 · Intro', texts: [] as string[], prompt: this.keyframePrompt(rec, 0) },
      ...kept.map((sh, i) => ({ index: i + 1, label: `K${nn(i + 1)} · ${sh.pfc}`, texts: sh.keyframe.texts, prompt: this.keyframePrompt(rec, i + 1) })),
    ];
    const clips = kept.map((sh, i) => ({
      index: i + 1,
      title: sh.title,
      startFrame: plan[i].startFrame,
      slotEndFrame: plan[i].slotEndFrame,
      prompt: this.clipPrompt(rec, i + 1),
    }));
    for (const k of keyframes) await this.savePrompt(rec, `K${nn(k.index)}_imagen_v1.md`, k.prompt);
    for (const c of clips) await this.savePrompt(rec, `clip${nn(c.index)}_video.md`, c.prompt);
    await this.savePrompt(rec, 'plan.json', JSON.stringify(plan.map((pl, i) => ({ clip: `clip${nn(i + 1)}`, pfc: kept[i].pfc, layout: kept[i].keyframe.layout, ...pl })), null, 2),
    );
    this.store.update(rec, (st) => {
      st.keyframes = keyframes.map((k) => ({ ...k, status: 'pending', version: 1 }));
      st.clips = clips.map((c) => ({ ...c, status: 'pending', version: 1 }));
    });
    this.store.log(rec, `Storyboard: ${kept.length} clips IA para ${s.durationSec!.toFixed(1)} s de voz · ${kept.map((k) => k.keyframe.layout).join(' | ')}`);
  }

  private async keyframes(rec: RunRecord) {
    const s = rec.state;
    // Solo los que faltan (al retomar o reintentar, los que ya están listos no se vuelven a pedir).
    const targets = s.keyframes.filter((k) => k.status !== 'ready' || !rec.keyAssets.has(k.index));
    const unreviewed = s.keyframes.filter((k) => k.status === 'ready' && rec.keyAssets.has(k.index) && !k.review).map((k) => k.index);
    if (targets.length) this.step(rec, 'keyframes', `Generando ${targets.length} fotograma${targets.length > 1 ? 's' : ''} clave en paralelo…`);
    this.store.update(rec, () => targets.forEach((k) => ((k.status = 'generating'), (k.error = undefined), (k.review = undefined))));
    const intro = targets.some((k) => k.index === 0) ? await this.themeRefs(rec, 0) : [];
    const withText = targets.some((k) => k.index > 0) ? await this.themeRefs(rec, 1) : [];
    if (targets.length) await this.p.images.generate(
      targets.map((k) => ({
        key: String(k.index),
        prompt: k.prompt,
        references: k.index === 0 ? intro : withText,
        outBase: join(rec.dir, 'keyframes', `K${nn(k.index)}_v${k.version}`),
      })),
      async (r) => {
        const k = s.keyframes.find((x) => String(x.index) === r.key)!;
        if (r.path && r.ref) await this.flatten(rec, r.path, `K${nn(k.index)}`);
        if (r.path && r.ref) {
          rec.keyAssets.set(k.index, { ref: r.ref, path: r.path });
          this.store.update(rec, () => ((k.status = 'ready'), (k.url = this.fileUrl(rec, r.path!, k.version))));
        } else {
          this.store.update(rec, () => ((k.status = 'error'), (k.error = r.error)));
          this.store.log(rec, `K${nn(k.index)}: ${r.error}`, 'warn');
        }
      },
    );
    await this.reviewImages(rec, [...unreviewed, ...targets.map((k) => k.index)]);
    const bad = s.keyframes.filter((k) => k.status !== 'ready').length;
    const flagged = s.keyframes.filter((k) => k.review?.verdict === 'improve').length;
    this.step(
      rec,
      'awaiting_approval',
      bad
        ? `Revisa los fotogramas: ${bad} con error, regénéralos antes de aprobar.`
        : flagged
          ? `Fotogramas listos. Opus sugiere mejorar ${flagged}; revisa y aprueba cuando estés conforme.`
          : 'Fotogramas listos. Revísalos y aprueba para generar el video.',
    );
  }

  /** Opus mira los fotogramas generados y marca los que no están a nivel profesional. */
  private async reviewImages(rec: RunRecord, indices: number[], announce = true) {
    if (!env.IMAGE_REVIEW) return;
    const s = rec.state;
    const items = s.keyframes.filter((k) => indices.includes(k.index) && k.status === 'ready' && rec.keyAssets.has(k.index));
    if (!items.length) return;
    if (announce) this.step(rec, 'keyframes', `Opus revisa ${items.length === 1 ? 'el fotograma' : `los ${items.length} fotogramas`}…`);
    const content: Exclude<LlmContent, string> = [
      { type: 'text', text: 'Review each keyframe below (brief, then image). Return one review per keyframe, using its index.' },
    ];
    for (const k of items) {
      const jpg = join(rec.dir, 'keyframes', `_revision_K${nn(k.index)}_v${k.version}.jpg`);
      await imagePreviewJpeg(rec.keyAssets.get(k.index)!.path, jpg, 1344);
      const scene = k.index === 0 ? rec.storyboard!.intro.scene : rec.shots![k.index - 1].keyframe.scene;
      content.push({ type: 'text', text: imageReviewItemText(k.index, k.label.replace(/^K\d+ · /, ''), scene, k.texts) });
      content.push({ type: 'image', mediaType: 'image/jpeg', base64: (await readFile(jpg)).toString('base64') });
    }
    try {
      const r = await this.askJson(ImageReviewSchema, imageReviewSystemPrompt(rec.theme), content, 'Revisión visual');
      this.store.update(rec, () => {
        for (const rv of r.reviews) {
          const k = items.find((x) => x.index === rv.index);
          if (k) k.review = { verdict: rv.verdict, issues: rv.issues, revisedScene: rv.revisedScene || undefined };
        }
      });
      await this.savePrompt(rec, `revision_visual_${Date.now()}.json`, JSON.stringify(r, null, 2));
      const bad = r.reviews.filter((x) => x.verdict === 'improve');
      this.store.log(rec, `Revisión visual: ${r.reviews.length - bad.length} OK${bad.length ? ` · sugerencias en ${bad.map((x) => `K${nn(x.index)}`).join(', ')}` : ''}.`);
    } catch (e) {
      this.store.log(rec, `La revisión visual falló (no bloquea): ${(e as Error).message}`, 'warn');
    }
  }

  /** Mensaje de la pantalla de revisión según el estado de los fotogramas (sin cambiar de paso). */
  private reviewMessage(rec: RunRecord) {
    const ks = rec.state.keyframes;
    const working = ks.filter((k) => k.status === 'generating' || k.activity).length;
    const bad = ks.filter((k) => k.status === 'error').length;
    const flagged = ks.filter((k) => k.status === 'ready' && k.review?.verdict === 'improve').length;
    this.store.update(rec, (st) => {
      st.message = working
        ? `Regenerando ${working} fotograma${working > 1 ? 's' : ''} en paralelo…`
        : bad
          ? `Revisa los fotogramas: ${bad} con error, regénéralos antes de aprobar.`
          : flagged
            ? `Fotogramas listos. Opus sugiere mejorar ${flagged}; revisa y aprueba cuando estés conforme.`
            : 'Fotogramas listos. Revísalos y aprueba para generar el video.';
    });
  }

  /**
   * Regenera un fotograma durante la revisión, en paralelo con los demás. Con nota (o con la
   * sugerencia de la revisión visual) Opus reescribe el plano completo de forma coherente. Las
   * imágenes pasan por una cola con el máximo de trabajos simultáneos (IMAGE_CONCURRENCY).
   */
  regenerateKeyframe(rec: RunRecord, index: number, note?: string, useSuggestion = false) {
    const k = rec.state.keyframes.find((x) => x.index === index);
    if (!k) throw new Error(`No existe K${nn(index)}.`);
    // En un video terminado (ADR-071) la imagen nueva es una propuesta: los clips y el final no cambian hasta «Aplicar».
    const draft = rec.state.status === 'done' && rec.approved;
    if ((rec.state.status !== 'awaiting_approval' && !draft) || rec.busy)
      throw new Error('Solo se pueden regenerar fotogramas durante la revisión o con el video terminado.');
    if (draft && !rec.storyboard) throw new Error('Falta el storyboard de este video: no se puede regenerar el fotograma.');
    if (k.status === 'generating' || k.activity) throw new Error(`K${nn(index)} ya se está regenerando.`);
    if (useSuggestion && !k.review?.revisedScene) throw new Error('Este fotograma no tiene una sugerencia de Opus.');
    const review = k.review;
    let change = note?.trim();
    if (useSuggestion) change = `Use this corrected composition brief as the new scene and adapt layout, summary, texts, animation and endState to it: ${review!.revisedScene}. Problems it fixes: ${review!.issues}`;
    this.store.update(rec, () => {
      if (draft && !k.previous) {
        const asset = rec.keyAssets.get(index);
        k.previous = {
          version: k.version,
          url: k.url,
          path: asset ? relative(rec.dir, asset.path) : undefined,
          label: k.label,
          texts: [...k.texts],
          prompt: k.prompt,
          review: k.review,
          shot: index > 0 ? structuredClone(rec.shots![index - 1]) : undefined,
          introScene: index === 0 ? rec.storyboard!.intro.scene : undefined,
        };
      }
      k.status = 'generating';
      k.activity = change ? 'Opus reescribe el plano…' : 'En cola…';
      k.error = undefined;
      k.review = undefined;
      // Se guarda para retomarla sola tras un reinicio (ADR-046).
      k.pending = { change: change || undefined, revisedScene: useSuggestion ? review?.revisedScene : undefined, issues: useSuggestion ? review?.issues : undefined, stage: 'rewrite' };
    });
    if (!draft) this.reviewMessage(rec);
    else this.store.log(rec, `K${nn(index)}: se regenera como propuesta; los clips no cambian hasta aplicarla.`);
    this.runRegen(rec, index);
  }

  /** Descarta la propuesta de un fotograma (ADR-071): vuelve la versión vigente con su plano. */
  discardKeyframe(rec: RunRecord, index: number) {
    const k = rec.state.keyframes.find((x) => x.index === index);
    const prev = k?.previous;
    if (!k || !prev) throw new Error(`K${nn(index)} no tiene una propuesta sin aplicar.`);
    if (k.activity || k.status === 'generating') throw new Error(`Espera a que termine la regeneración de K${nn(index)}.`);
    if (index > 0 && prev.shot) rec.shots![index - 1] = prev.shot as Shot;
    if (index === 0 && prev.introScene !== undefined) rec.storyboard!.intro.scene = prev.introScene;
    if (prev.path) rec.keyAssets.set(index, { path: join(rec.dir, prev.path), ref: '' }); // la referencia se vuelve a preparar al usarla
    this.store.update(rec, () => {
      k.version = prev.version;
      k.url = prev.url;
      k.label = prev.label;
      k.texts = prev.texts;
      k.prompt = prev.prompt;
      k.review = prev.review;
      k.status = 'ready';
      k.error = undefined;
      k.pending = undefined;
      k.previous = undefined;
    });
    this.store.log(rec, `K${nn(index)}: propuesta descartada; vuelve la v${prev.version}.`);
  }

  /** Clips cuyos fotogramas de inicio o fin cambiaron desde que se hicieron (ADR-033). */
  private affectedClips(rec: RunRecord) {
    return rec.state.clips.filter((c) => {
      if (c.status !== 'ready' || !c.builtWith) return false;
      const [a, b] = this.keyVersions(rec, c.index);
      return c.builtWith[0] !== a || c.builtWith[1] !== b;
    });
  }

  /**
   * Aplica las propuestas de fotogramas de un video terminado (ADR-071): rehace solo los clips afectados y el
   * render; el final anterior se conserva.
   */
  applyKeyframes(rec: RunRecord) {
    const s = rec.state;
    if (s.status !== 'done' || !rec.approved || rec.busy) throw new Error('Solo se aplican propuestas de un video terminado.');
    if (s.keyframes.some((k) => k.activity || k.status === 'generating')) throw new Error('Espera a que terminen las regeneraciones en curso.');
    const bad = s.keyframes.filter((k) => k.status !== 'ready');
    if (bad.length) throw new Error(`Hay fotogramas con error (${bad.map((k) => `K${nn(k.index)}`).join(', ')}): regénéralos o descarta la propuesta.`);
    const affected = this.affectedClips(rec);
    this.store.update(rec, (st) => {
      for (const k of st.keyframes) k.previous = undefined;
      for (const c of affected) {
        c.status = 'pending';
        c.version += 1;
        c.error = undefined;
        c.taskId = undefined;
      }
    });
    if (!affected.length) return;
    this.store.log(rec, `Propuestas aplicadas: se rehacen ${affected.map((c) => `clip${nn(c.index)}`).join(', ')} y el render.`);
    this.startPhase2(rec);
  }

  /** Por qué no se pueden rehacer clips de este video ahora (o undefined). */
  private clipsBlocked(rec: RunRecord): string | undefined {
    const s = rec.state;
    if (rec.busy || !rec.approved || s.status !== 'done') return 'Solo en un video terminado que no esté trabajando.';
    const draft = s.keyframes.filter((k) => k.previous || k.activity);
    if (draft.length) return `${draft.map((k) => `K${nn(k.index)}`).join(', ')}: hay propuestas de fotograma sin aplicar; aplícalas o descártalas antes.`;
    return undefined;
  }

  /**
   * «Aplicar la regla a este video» (ADR-082): qué clips cambian al fijar la animación de las imágenes según
   * cuántas haya en la copia del tema del video. Los fotogramas no se tocan.
   */
  mediaRulePlan(rec: RunRecord): MediaRulePlan {
    const shots = rec.shots ?? [];
    const available = !!rec.theme.usesMediaFrames && shots.some((sh) => sh.keyframe.mediaFrames.length > 0);
    const fixed = structuredClone(shots);
    applyMediaFrameRule(fixed, 'byCount');
    const changes = shots
      .map((sh, i) => ({ clip: i + 1, before: mediaKindsLabel(sh), after: mediaKindsLabel(fixed[i]) }))
      .filter((c) => c.before !== c.after);
    const videoClips = fixed
      .map((sh, i) => (sh.keyframe.mediaFrames.some((m) => m.kind === 'video') ? i + 1 : 0))
      .filter((n) => n && !changes.some((c) => c.clip === n));
    return { available, rule: rec.theme.mediaFrameRule ?? 'opus', changes, videoClips, blocked: available ? this.clipsBlocked(rec) : undefined };
  }

  /**
   * Aplica la regla a un video terminado: corrige video/foto en su storyboard, deja la regla en su copia del tema
   * (así «Editar clip» y «Recrear» la respetan) y rehace solo los clips que cambian, más los que tienen marcos de
   * video si se pide (para aprovechar el prompt nuevo). Los fotogramas no se regeneran.
   */
  applyMediaRule(rec: RunRecord, alsoVideoClips: boolean): number[] {
    const plan = this.mediaRulePlan(rec);
    if (!plan.available) throw new Error('El tema de este video no usa fotos ni video en marcos.');
    if (plan.blocked) throw new Error(plan.blocked);
    const targets = [...plan.changes.map((c) => c.clip), ...(alsoVideoClips ? plan.videoClips : [])].sort((a, b) => a - b);
    applyMediaFrameRule(rec.shots!, 'byCount');
    rec.theme = { ...rec.theme, mediaFrameRule: 'byCount' };
    const clips = rec.state.clips.filter((c) => targets.includes(c.index));
    this.store.update(rec, (st) => {
      for (const c of clips) {
        c.status = 'pending';
        c.version += 1;
        c.error = undefined;
        c.taskId = undefined;
        c.note = undefined;
      }
      st.error = undefined;
    });
    void this.savePrompt(rec, `storyboard_regla_${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}.json`, JSON.stringify(rec.shots, null, 2));
    const what = plan.changes.map((c) => `clip${nn(c.clip)} ${c.before}→${c.after}`).join(', ');
    this.store.log(
      rec,
      `Animación de las imágenes según cuántas haya aplicada al video${what ? ` (${what})` : ' (la asignación ya la cumplía)'}. ${clips.length ? `Se rehacen ${clips.map((c) => `clip${nn(c.index)}`).join(', ')} y el render.` : 'No hay clips que rehacer.'}`,
    );
    if (clips.length) this.startPhase2(rec);
    return clips.map((c) => c.index);
  }

  /** Lanza (o retoma) la regeneración de un fotograma, con la prioridad de su video en la cola. */
  private runRegen(rec: RunRecord, index: number) {
    const k = rec.state.keyframes.find((x) => x.index === index)!;
    void this.work(rec, this.scope(rec), () => this.regenOne(rec, index))
      .catch((e) => {
        if (this.queue.isPaused(rec.state.id)) return; // detenido: markPaused deja el fotograma listo para reanudar
        const msg = (e as Error).message;
        this.store.update(rec, () => ((k.status = 'error'), (k.error = msg), (k.activity = undefined), (k.pending = undefined)));
        this.store.log(rec, `K${nn(index)}: ${msg}`, 'warn');
      })
      .finally(() => {
        if (this.queue.isPaused(rec.state.id)) {
          if (!rec.busy && !rec.state.keyframes.some((x) => x.activity && x.index !== index)) this.markPaused(rec);
        } else if (rec.state.status === 'awaiting_approval') this.reviewMessage(rec);
      });
  }

  private async regenOne(rec: RunRecord, index: number) {
    const s = rec.state;
    const k = s.keyframes.find((x) => x.index === index)!;
    const pend = k.pending ?? { stage: 'rewrite' as const };
    const change = pend.change;
    if (pend.stage === 'review') {
      // La imagen ya estaba hecha cuando se cortó: solo falta la revisión de Opus.
      if (env.IMAGE_REVIEW && k.status === 'ready') {
        this.store.update(rec, () => (k.activity = 'Opus revisa…'));
        await this.reviewImages(rec, [index], false);
      }
      this.store.update(rec, () => ((k.activity = undefined), (k.pending = undefined)));
      return;
    }
    if (pend.stage === 'rewrite') {
      if (change) {
        this.store.update(rec, () => (k.activity = 'Opus reescribe el plano…'));
        this.store.log(rec, `Opus reescribe K${nn(index)} para aplicar el cambio…`);
        if (index === 0) {
          rec.storyboard!.intro.scene = pend.revisedScene ?? `${rec.storyboard!.intro.scene} Change requested: ${change}`;
        } else {
          const shot = rec.shots![index - 1];
          const revised = await this.askJson(
            ShotSchema,
            reviseShotSystemPrompt(rec.theme),
            reviseShotUserPrompt({
              shot,
              previousSummary: index === 1 ? 'intro: only the style background, no text' : rec.shots![index - 2].keyframe.summary,
              nextSummary: rec.shots![index]?.keyframe.summary,
              change,
            }),
            'Reescritura del plano',
          );
          revised.anchorWordIndex = shot.anchorWordIndex; // el tiempo no cambia
          if (!rec.theme.usesMediaFrames) revised.keyframe.mediaFrames = [];
          else applyMediaFrameRule([revised], rec.theme.mediaFrameRule);
          rec.shots![index - 1] = revised;
          await this.savePrompt(rec, `K${nn(index)}_plano_v${k.version + 1}.json`, JSON.stringify(revised, null, 2));
          this.store.update(rec, () => ((k.texts = revised.keyframe.texts), (k.label = `K${nn(index)} · ${revised.pfc}`)));
        }
      }
      const prompt = this.keyframePrompt(rec, index);
      this.store.update(rec, () => ((k.version += 1), (k.prompt = prompt), (k.pending = { ...pend, stage: 'image' })));
      await this.savePrompt(rec, `K${nn(index)}_imagen_v${k.version}.md`, prompt);
    }
    // La imagen pasa por la cola global con la prioridad del video (ADR-045): "En cola…" hasta que hay hueco.
    this.store.update(rec, () => (k.activity = 'En cola · generando imagen…'));
    const references = await this.themeRefs(rec, index);
    const [r] = await this.p.images.generate([
      { key: String(index), prompt: k.prompt, references, outBase: join(rec.dir, 'keyframes', `K${nn(index)}_v${k.version}`) },
    ]);
    if (!r?.path || !r.ref) throw new Error(r?.error ?? 'No se generó la imagen.');
    if (this.flatColors(rec)) this.store.update(rec, () => (k.activity = 'Aplanando colores…'));
    await this.flatten(rec, r.path, `K${nn(index)}`);
    rec.keyAssets.set(index, { ref: r.ref, path: r.path });
    // Imagen lista: si se corta ahora, al volver solo se repite la revisión (la imagen no se paga dos veces).
    this.store.update(rec, () => ((k.status = 'ready'), (k.url = this.fileUrl(rec, r.path!, k.version)), (k.pending = { ...pend, stage: 'review' })));
    if (env.IMAGE_REVIEW) {
      this.store.update(rec, () => (k.activity = 'Opus revisa…'));
      await this.reviewImages(rec, [index], false);
    }
    this.store.update(rec, () => ((k.activity = undefined), (k.pending = undefined)));
  }

  // ---------------------------------------------------------------- rehacer audio (hito 5, ADR-048)

  /** Tramo de locución de un fotograma Ki (= clip i) con sus párrafos y palabras, para el pop-up. */
  async voiceSegment(rec: RunRecord, clipIndex: number): Promise<VoiceSegment> {
    const s = rec.state;
    const c = s.clips.find((x) => x.index === clipIndex);
    if (!c || !rec.words?.length) throw new Error('Este fotograma no tiene un tramo de locución.');
    const fromSec = c.startFrame / FPS;
    const toSec = c.slotEndFrame / FPS;
    const touched = new Set(rec.words.filter((w) => w.end > fromSec && w.start < toSec).map((w) => w.paragraph));
    const rules = await this.db.pronunciationRule.findMany({ where: { ownerId: rec.ownerId }, orderBy: { match: 'asc' } });
    const paragraphs = s.paragraphs
      .filter((p) => touched.has(p.index))
      .map((p) => ({
        index: p.index,
        text: p.text,
        version: p.version ?? 1,
        spokenText: p.spokenText,
        startSec: p.startSec,
        durationSec: p.durationSec,
        words: rec.words!.filter((w) => w.paragraph === p.index).map((w) => ({ word: w.word, start: w.start, end: w.end, inSegment: w.end > fromSec && w.start < toSec })),
      }));
    const texts = paragraphs.map((p) => p.text).join(' ');
    return {
      clipIndex,
      fromSec,
      toSec,
      voiceUrl: s.voiceUrl ?? '',
      paragraphs,
      rules: rulesIn(texts, rules).map((r) => {
        const row = rules.find((x) => x.match === r.match)!;
        return { id: row.id, match: row.match, say: row.say, note: row.note ?? undefined, createdAt: row.createdAt.toISOString() };
      }),
    };
  }

  /**
   * Rehacer la locución de un párrafo (ADR-048): con el texto corregido y/o una indicación ("pronunciaste
   * mal IAAS"), que Opus convierte en reglas de pronunciación (guardadas para los próximos videos si se
   * pide). Se vuelve a locutar el párrafo completo, se recalculan los tiempos y el plan con los mismos
   * planos (los fotogramas no se tocan) y, si el video ya estaba terminado, se rehacen el post y el render
   * (final_vN.mp4) sin volver a generar clips.
   */
  revoice(rec: RunRecord, index: number, req: RevoiceRequest) {
    const s = rec.state;
    const para = s.paragraphs.find((p) => p.index === index);
    if (!para) throw new Error(`No existe el párrafo ${index + 1}.`);
    if (rec.busy) throw new Error('La generación está trabajando.');
    const done = s.status === 'done' && rec.approved;
    if (s.status !== 'awaiting_approval' && !done) throw new Error('El audio se rehace durante la revisión de fotogramas o en un video terminado.');
    if (s.keyframes.some((k) => k.status === 'generating' || k.activity)) throw new Error('Espera a que terminen las regeneraciones en curso.');
    if (!rec.words?.length || !rec.shots?.length || !rec.plan) throw new Error('Faltan los tiempos o el plan de este video.');
    const text = (req.text ?? para.text).replace(/\s+/g, ' ').trim();
    if (text.split(' ').length < 1 || text.length < 2) throw new Error('El párrafo no puede quedar vacío.');
    const instruction = req.instruction?.trim();
    this.guard(rec, async () => {
      const before = s.status;
      const beforeMsg = s.message;
      try {
        await this.revoiceInner(rec, index, text, instruction, req, before, done);
      } catch (e) {
        if (rec.state.status !== 'voice') throw e; // ya se aplicó: el error es del post o del render
        const msg = (e as Error).message;
        this.store.log(rec, `No se pudo rehacer el audio: ${msg}`, 'warn');
        this.store.update(rec, (st) => ((st.status = before), (st.message = `No se pudo rehacer el audio: ${msg.split('\n')[0]}`)));
        void beforeMsg;
      }
    });
  }

  private async revoiceInner(rec: RunRecord, index: number, text: string, instruction: string | undefined, req: RevoiceRequest, before: RunState['status'], done: boolean) {
    const s = rec.state;
    const para = s.paragraphs.find((p) => p.index === index)!;
    {
      this.step(rec, 'voice', `Rehaciendo la locución del párrafo ${index + 1}…`);
      const saved = await this.rulesFor(rec.ownerId);
      let extra: Rule[] = [];
      let explanation = '';
      if (instruction) {
        const fix = await this.askJson(
          PronunciationFixSchema,
          pronunciationSystemPrompt(),
          pronunciationUserPrompt({ paragraph: text, spoken: para.spokenText ?? para.text, instruction, rules: rulesIn(text, saved) }),
          'Pronunciación',
        );
        extra = fix.rules.filter((r) => r.match.trim() && r.say.trim() && applyRules(text, [r]) !== text);
        explanation = fix.explanation;
        if (req.saveRules && extra.length)
          for (const r of extra)
            await this.db.pronunciationRule.upsert({
              where: { ownerId_match: { ownerId: rec.ownerId, match: r.match.trim() } },
              create: { ownerId: rec.ownerId, match: r.match.trim(), say: r.say.trim(), note: instruction.slice(0, 500) },
              update: { say: r.say.trim(), note: instruction.slice(0, 500) },
            });
        this.store.log(rec, `Pronunciación: ${explanation}${extra.length ? ` · ${extra.map((r) => `«${r.match}» → «${r.say}»`).join(', ')}${req.saveRules ? ' (guardadas para tus próximos videos)' : ''}` : ''}`);
      }
      // Las reglas nuevas mandan sobre las guardadas con la misma palabra.
      const rules = [...saved.filter((r) => !extra.some((x) => x.match.toLowerCase() === r.match.toLowerCase())), ...extra];
      // Locución en un solo pedido (ADR-133, ADR-134): se vuelve a pedir toda, también en los videos que se locutaron por
      // párrafo (así se corrigen sus cambios de tono). En MCP (Higgsfield, sin tiempos por carácter), por párrafo.
      if (!this.voiceByParagraph()) return this.revoiceWhole(rec, index, text, rules, instruction, explanation, before, done);
      const tagged = s.script?.rows[index]?.voiceTag && this.p.mode !== 'mock' ? `[${s.script.rows[index].voiceTag}] ` : '';
      const spoken = tagged + applyRules(text, rules);
      const version = (para.version ?? 1) + 1;
      const base = join(rec.dir, 'voice', `parrafo${nn(index + 1)}_v${version}`);
      const audio = await this.p.tts.synthesize(spoken, s.voiceId, base);
      await this.savePrompt(
        rec,
        `parrafo${nn(index + 1)}_locucion_v${version}.md`,
        [`# Párrafo ${index + 1} · locución v${version}`, '', `Texto: ${text}`, `Enviado a la voz: ${spoken}`, instruction ? `Indicación: ${instruction}` : '', explanation ? `Opus: ${explanation}` : '']
          .filter(Boolean)
          .join('\n'),
      );
      const wav = `${base}.48k.wav`;
      await toWav48k(audio.path, wav);
      const dur = await durationSec(wav);
      const heard = await this.p.timing.wordTimes(tokenize(text), audio, dur);

      // Nueva línea de tiempo: los demás párrafos conservan su audio y sus tiempos (desplazados).
      const durs = s.paragraphs.map((p) => (p.index === index ? dur : p.durationSec));
      const starts = paragraphStarts(durs);
      const end = starts[starts.length - 1] + durs[durs.length - 1];
      const totalFrames = totalFramesFor(end);
      const oldWords = rec.words!;
      const oldTokens = oldWords.filter((w) => w.paragraph === index).map((w) => w.word);
      const newTokens = tokenize(text);
      const relMap = mapWordIndices(oldTokens, newTokens);
      const words: TimedWord[] = [];
      const indexMap: number[] = []; // índice anterior → nuevo
      for (const p of s.paragraphs) {
        const shift = starts[p.index] - p.startSec;
        if (p.index === index) {
          const firstOld = oldWords.findIndex((w) => w.paragraph === index);
          const offset = words.length;
          oldTokens.forEach((_, k) => (indexMap[firstOld + k] = offset + relMap[k]));
          for (const w of alignWords(newTokens, heard, dur)) words.push({ word: w.word, start: w.start + starts[p.index], end: w.end + starts[p.index], paragraph: p.index });
        } else
          oldWords.forEach((w, k) => {
            if (w.paragraph !== p.index) return;
            indexMap[k] = words.length;
            words.push({ ...w, start: w.start + shift, end: w.end + shift });
          });
      }
      const shots = rec.shots!.map((sh, i) => ({ ...sh, anchorWordIndex: i === 0 ? 0 : Math.min(words.length - 1, indexMap[sh.anchorWordIndex] ?? sh.anchorWordIndex) }));
      const paragraphs = s.paragraphs.map((p) => ({ ...p, startSec: starts[p.index] }));
      const plan = planShots(words, shots, paragraphs, totalFrames);
      if (plan.length !== shots.length)
        throw new Error(
          `Con la nueva locución del párrafo ${index + 1} no caben todos los planos (${plan.length} de ${shots.length}); no se aplicó. Prueba otro texto o usa "Cambiar el texto".`,
        );

      // Se aplica: voz completa, tiempos, plan y clips (los fotogramas y los prompts no cambian).
      const voiceWav = join(rec.dir, 'voice', 'voz_completa.wav');
      await assembleVoice(
        s.paragraphs.map((p) => ({
          wav: p.index === index ? wav : join(rec.dir, 'voice', (p.version ?? 1) > 1 ? `parrafo${nn(p.index + 1)}_v${p.version}.48k.wav` : `parrafo${nn(p.index + 1)}.48k.wav`),
          startSec: starts[p.index],
        })),
        totalFrames / FPS,
        voiceWav,
      );
      await this.saveVoice(rec, index, text, spoken, audio);
      rec.words = words;
      rec.shots = shots;
      rec.plan = plan;
      rec.paraAudio = undefined;
      this.store.update(rec, (st) => {
        st.paragraphs = paragraphs.map((p) =>
          p.index === index ? { ...p, text, durationSec: dur, version, spokenText: spoken !== text ? spoken : undefined } : p,
        );
        st.text = st.paragraphs.map((p) => p.text).join('\n\n');
        st.totalFrames = totalFrames;
        st.durationSec = totalFrames / FPS;
        st.voiceUrl = this.fileUrl(rec, voiceWav, Date.now());
        st.clips.forEach((c, i) => ((c.startFrame = plan[i].startFrame), (c.slotEndFrame = plan[i].slotEndFrame)));
        // El final anterior ya no corresponde a esta locución: al aprobar (o ahora, si estaba terminado)
        // se rehacen el post y el render. El archivo anterior se conserva en la carpeta.
        st.finalUrl = undefined;
        st.finalFrames = undefined;
      });
      await this.savePrompt(rec, 'tiempos_por_palabra.json', JSON.stringify(words, null, 1));
      await this.savePrompt(rec, 'plan.json', JSON.stringify(plan.map((pl, i) => ({ clip: `clip${nn(i + 1)}`, pfc: shots[i].pfc, layout: shots[i].keyframe.layout, ...pl })), null, 2));
      this.store.log(rec, `Párrafo ${index + 1}: locución v${version} (${dur.toFixed(2)} s) → ${(totalFrames / FPS).toFixed(2)} s en total.`);
      if (done) {
        this.step(rec, 'post', 'Locución rehecha: se rehacen el post y el render (sin regenerar clips)…');
        await this.post(rec); // post y render (final_vN)
      } else if (before === 'awaiting_approval') {
        this.step(rec, 'awaiting_approval', 'Locución rehecha. Revisa los fotogramas y aprueba cuando estés conforme.');
        this.reviewMessage(rec);
      }
    }
  }

  // ---------------------------------------------------------------- dividir en dos (hito 10, T3, ADR-130)

  /** Si el clip se puede dividir en dos y dónde iría el corte (para «Editar clip»). */
  splitInfo(rec: RunRecord, index: number): ClipSplitInfo {
    const s = rec.state;
    const c = s.clips.find((x) => x.index === index);
    if (!c) throw new Error(`No existe el clip ${nn(index)}.`);
    const slotSec = (c.slotEndFrame - c.startFrame) / FPS;
    const base = { index, slotSec, minSec: SPLIT_MIN_FRAMES / FPS };
    const blocked = this.clipsBlocked(rec) ?? (this.insertJobs.get(rec)?.size ? 'Espera a que terminen los clips o insertos en marcha.' : undefined);
    if (blocked) return { ...base, available: false, reason: blocked };
    if (c.status !== 'ready') return { ...base, available: false, reason: 'El clip no está listo.' };
    if (c.slotEndFrame - c.startFrame < SPLIT_MIN_FRAMES)
      return { ...base, available: false, reason: `El tramo dura ${slotSec.toFixed(1)} s: para dos clips completos hacen falta ${(SPLIT_MIN_FRAMES / FPS).toFixed(1)} s.` };
    const point = this.splitPointOf(rec, index);
    if (!point) return { ...base, available: false, reason: 'No hay una palabra en el tramo que deje los dos clips completos.' };
    const w = rec.words![point.wordIndex];
    return { ...base, available: true, cutWord: w.word, cutSec: point.startFrame / FPS, firstSec: point.firstFrames / FPS, secondSec: point.secondFrames / FPS };
  }

  private splitPointOf(rec: RunRecord, index: number): SplitPoint | undefined {
    if (!rec.words?.length || !rec.shots?.length || !rec.state.totalFrames) return undefined;
    return pickSplitPoint({ words: rec.words, shots: rec.shots, paragraphs: rec.state.paragraphs, totalFrames: rec.state.totalFrames, clip: index });
  }

  /**
   * «Dividir en dos» (ADR-130): Opus escribe un plano intermedio en una palabra cerca de la mitad del tramo; el clip
   * pasa a ir de K(i-1) al fotograma intermedio y uno nuevo va del intermedio a Ki (que no cambia). Se corren los
   * índices de lo que viene después (archivos, BD, observaciones, logo por clip, portada, insertos), se genera el
   * fotograma intermedio, los dos clips y se vuelve a unir el final. El final anterior se conserva.
   */
  splitClip(rec: RunRecord, index: number) {
    const info = this.splitInfo(rec, index);
    if (!info.available) throw new Error(info.reason);
    const point = this.splitPointOf(rec, index)!;
    this.urgent.add(rec);
    this.guard(rec, () => this.splitInner(rec, index, point));
  }

  private async splitInner(rec: RunRecord, index: number, point: SplitPoint) {
    const s = rec.state;
    const words = rec.words!;
    const shots = rec.shots!;
    const shot = shots[index - 1];
    const endWord = index < shots.length ? shots[index].anchorWordIndex : words.length;
    const say = (a: number, b: number) => words.slice(a, b).map((w) => w.word).join(' ');
    this.step(rec, 'keyframes', `Dividiendo clip${nn(index)} en dos: Opus escribe el fotograma intermedio…`);
    let split;
    try {
      split = await this.askJson(
        ClipSplitSchema,
        splitShotSystemPrompt(rec.theme),
        splitShotUserPrompt({
          shot,
          previousSummary: index === 1 ? 'intro: only the style background, no text' : shots[index - 2].keyframe.summary,
          nextSummary: shots[index]?.keyframe.summary,
          firstNarration: say(shot.anchorWordIndex, point.wordIndex),
          secondNarration: say(point.wordIndex, endWord),
          splitWord: words[point.wordIndex].word,
        }),
        'División del clip',
      );
    } catch (e) {
      // Antes de tocar nada: el video sigue como estaba.
      this.store.log(rec, `No se pudo dividir clip${nn(index)}: ${(e as Error).message}`, 'warn');
      this.step(rec, 'done', `No se pudo dividir clip${nn(index)}; el video sigue como estaba.`);
      return;
    }
    const mid = split.intermediate;
    mid.anchorWordIndex = shot.anchorWordIndex;
    // Los textos del intermedio son parte de los del fotograma final, tal cual (nunca palabras nuevas).
    const allowed = new Set(shot.keyframe.texts.map((t) => t.trim()));
    mid.keyframe.texts = mid.keyframe.texts.filter((t) => allowed.has(t.trim()));
    if (!rec.theme.usesMediaFrames) mid.keyframe.mediaFrames = [];
    else applyMediaFrameRule([mid], rec.theme.mediaFrameRule);
    const second: Shot = { ...shot, anchorWordIndex: point.wordIndex, animation: split.second.animation, endState: split.second.endState, sound: split.second.sound };
    const newShots = [...shots.slice(0, index - 1), mid, second, ...shots.slice(index)];

    // Archivos y BD: lo que viene después corre su índice (K≥index, clip≥index+1).
    this.step(rec, 'keyframes', `Dividiendo clip${nn(index)}: reordenando fotogramas y clips…`);
    await this.store.flush(rec);
    const renamed = await this.renameForSplit(rec, index);
    await renumberForSplit(this.db, s.id, index, { shots: newShots, keyframeLabel: `K${nn(index)} · ${mid.pfc}`, keyframeTexts: mid.keyframe.texts, newClipTitle: second.title });
    await this.store.reload(rec);
    const st = rec.state;
    const plan = planShots(rec.words!, rec.shots!, st.paragraphs, st.totalFrames!);
    if (plan.length !== rec.shots!.length) throw new Error(`Tras dividir, el plan tiene ${plan.length} de ${rec.shots!.length} planos.`);
    rec.plan = plan;
    this.store.update(rec, (x) => {
      x.clips.forEach((c, i) => ((c.startFrame = plan[i].startFrame), (c.slotEndFrame = plan[i].slotEndFrame)));
      const a = x.clips.find((c) => c.index === index);
      if (a) a.title = mid.title;
    });
    await this.savePrompt(rec, `K${nn(index)}_plano_v1.json`, JSON.stringify(mid, null, 2));
    await this.savePrompt(
      rec,
      `clip${nn(index)}_division.json`,
      JSON.stringify({ corte: { palabra: words[point.wordIndex].word, segundo: point.startFrame / FPS, ...point }, explicacion: split.explanation, segundaMitad: split.second }, null, 2),
    );
    this.store.log(
      rec,
      `clip${nn(index)} dividido en «${words[point.wordIndex].word}» (${(point.startFrame / FPS).toFixed(2)} s): clip${nn(index)} va al fotograma intermedio K${nn(index)} (${(point.firstFrames / FPS).toFixed(1)} s) y clip${nn(index + 1)} de ahí a K${nn(index + 1)} (${(point.secondFrames / FPS).toFixed(1)} s). ${split.explanation} Se corrieron ${renamed} archivos.`,
    );

    // Fotograma intermedio, los dos clips y el final.
    await this.splitFinish(rec, index);
  }

  /** Lo que queda de una división: el fotograma intermedio (si falta) y los clips pendientes, el post y el final. */
  private async splitFinish(rec: RunRecord, index: number) {
    const k = rec.state.keyframes.find((x) => x.index === index);
    if (k && (k.status !== 'ready' || !rec.keyAssets.get(index))) {
      this.step(rec, 'keyframes', `Generando el fotograma intermedio K${nn(index)}…`);
      await this.regenOne(rec, index);
      if (k.status !== 'ready') throw new Error(k.error ?? `No se generó K${nn(index)}.`);
    }
    for (const c of rec.state.clips.filter((x) => x.status !== 'ready')) {
      c.prompt = this.clipPrompt(rec, c.index);
      await this.savePrompt(rec, c.version > 1 ? `clip${nn(c.index)}_video_v${c.version}.md` : `clip${nn(c.index)}_video.md`, c.prompt);
    }
    this.store.update(rec);
    await this.ensureRefs(rec);
    this.kickInserts(rec);
    await this.clips(rec);
    await this.post(rec);
  }

  /**
   * Renombra en el disco los archivos de la carpeta del video con índice corrido (K≥index, clip≥index+1), en dos
   * tiempos para no pisar ninguno, y los quita del remoto (se suben con su nombre nuevo en el próximo repaso).
   */
  private async renameForSplit(rec: RunRecord, index: number): Promise<number> {
    const moves: { from: string; to: string }[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const abs = join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile()) {
          const to = shiftIndexName(e.name, index);
          if (to !== e.name) moves.push({ from: abs, to: join(dir, to) });
        }
      }
    };
    await walk(rec.dir);
    for (const m of moves) await rename(m.from, `${m.from}.split-tmp`);
    for (const m of moves) await rename(`${m.from}.split-tmp`, m.to);
    for (const m of moves) await this.media.removed(m.from);
    this.media.dirty(rec.dir);
    return moves.length;
  }

  // ---------------------------------------------------------------- prueba de voz (hito 10, T2, ADR-129)

  /**
   * Prueba de voz: vuelve a locutar TODO el video (una copia, nunca el original) con otra forma de pedir la voz y
   * rehace el plan con los mismos planos, el post y el render (sin regenerar fotogramas ni clips; solo se paga la voz).
   * `v3-whole`: un solo pedido a v3 cortado por párrafos; `v4-linked`: un pedido por párrafo a v4, enlazados.
   */
  voiceTrial(rec: RunRecord, variant: VoiceTrialVariant, settings?: VoiceTrialSettings) {
    const s = rec.state;
    if (rec.busy) throw new Error('La generación está trabajando.');
    if (s.status !== 'done' || !rec.approved) throw new Error('La prueba de voz se hace sobre un video terminado.');
    if (this.p.mode === 'mcp') throw new Error('La prueba de voz usa la API de ElevenLabs (modo API).');
    if (!rec.words?.length || !rec.shots?.length || !rec.plan) throw new Error('Faltan los tiempos o el plan de este video.');
    this.guard(rec, () => this.voiceTrialInner(rec, variant, settings));
  }

  private async voiceTrialInner(rec: RunRecord, variant: VoiceTrialVariant, settings?: VoiceTrialSettings) {
    const s = rec.state;
    const label = voiceTrialLabel(variant);
    this.step(rec, 'voice', `Prueba de voz · ${label}: locutando todo el video…`);
    const rules = await this.rulesFor(rec.ownerId);
    const tag = (i: number) => (s.script?.rows[i]?.voiceTag && this.p.mode !== 'mock' ? `[${s.script.rows[i].voiceTag}] ` : '');
    const paras = [...s.paragraphs].sort((a, b) => a.index - b.index);
    const spoken = paras.map((p, i) => tag(i) + applyRules(p.text, rules));
    const version = Math.max(...paras.map((p) => p.version ?? 1)) + 1;
    const vdir = join(rec.dir, 'voice');
    const wavOf = (i: number) => join(vdir, `parrafo${nn(i + 1)}_v${version}.48k.wav`);
    const words: TimedWord[] = [];
    const parts: { wav: string; startSec: number; dur: number }[] = [];
    const record: string[] = [
      `# Prueba de voz · ${label}`,
      '',
      `Variante: ${variant}`,
      `Voz: ${s.voiceId}`,
      ...(variant === 'v4-linked' ? [`Ajustes: Similarity ${settings?.similarity ?? 'la de la voz'} · Stability ${settings?.stability ?? 'la de la voz'}`] : []),
      '',
    ];
    let endSec: number;

    if (variant === 'v3-whole') {
      const r = await this.wholeVoice(rec, { texts: paras.map((p) => p.text), spoken, base: join(vdir, `voz_prueba_v3_completa_v${version}`), wavOf });
      r.parts.forEach((p) => parts.push(p));
      for (const w of r.words) words.push({ word: w.word, start: w.start, end: w.end, paragraph: paras[w.pos].index });
      record.push(...r.record, '', '## Enviado a la voz', '', spoken.join('\n\n'));
      endSec = r.endSec;
    } else {
      const ids: string[] = [];
      const durs: number[] = [];
      const heard: TimedWord[][] = [];
      for (const [i, p] of paras.entries()) {
        this.step(rec, 'voice', `Prueba de voz · ${label}: párrafo ${i + 1} de ${paras.length}…`);
        const audio = await this.p.tts.synthesize(spoken[i], s.voiceId, join(vdir, `parrafo${nn(i + 1)}_v${version}`), {
          model: env.ELEVENLABS_V4_MODEL,
          previousRequestIds: ids.slice(-3),
          nextText: nextTextFor(spoken[i + 1]),
          voiceSettings: settings ? { similarityBoost: settings.similarity, stability: settings.stability } : undefined,
        });
        if (!audio.words?.length)
          throw new Error(`${env.ELEVENLABS_V4_MODEL} no devolvió los tiempos por palabra (sin ellos el video no se puede sincronizar).`);
        if (audio.jobId) ids.push(audio.jobId);
        await toWav48k(audio.path, wavOf(i));
        const dur = await durationSec(wavOf(i));
        durs.push(dur);
        heard.push(alignWords(tokenize(p.text), audio.words, dur).map((w) => ({ ...w, paragraph: p.index })));
        record.push(`Párrafo ${i + 1}: request_id ${audio.jobId ?? '—'} · enlazado con ${ids.slice(-4, -1).join(', ') || '(ninguno)'} · ${dur.toFixed(2)} s`, `  ${spoken[i]}`);
        await this.saveVoice(rec, p.index, p.text, spoken[i], audio);
      }
      const starts = paragraphStarts(durs);
      for (const [i] of paras.entries()) {
        parts.push({ wav: wavOf(i), startSec: starts[i], dur: durs[i] });
        for (const w of heard[i]) words.push({ ...w, start: w.start + starts[i], end: w.end + starts[i] });
      }
      endSec = starts[starts.length - 1] + durs[durs.length - 1];
    }

    // Mismos planos (el texto no cambia, así que las anclas son las mismas palabras); nuevo plan.
    const totalFrames = totalFramesFor(endSec);
    const paragraphs = paras.map((p, i) => ({ ...p, startSec: parts[i].startSec }));
    const plan = planShots(words, rec.shots!, paragraphs, totalFrames);
    if (plan.length !== rec.shots!.length)
      throw new Error(`Con esta locución no caben todos los planos (${plan.length} de ${rec.shots!.length}); no se aplicó.`);
    const voiceWav = join(vdir, 'voz_completa.wav');
    await assembleVoice(
      parts.map((p) => ({ wav: p.wav, startSec: p.startSec })),
      totalFrames / FPS,
      voiceWav,
    );
    rec.words = words;
    rec.plan = plan;
    rec.paraAudio = undefined;
    this.store.update(rec, (st) => {
      st.paragraphs = paragraphs.map((p, i) => ({
        ...p,
        durationSec: parts[i].dur,
        version,
        spokenText: spoken[i] !== p.text ? spoken[i] : undefined,
      }));
      st.totalFrames = totalFrames;
      st.durationSec = totalFrames / FPS;
      st.voiceUrl = this.fileUrl(rec, voiceWav, Date.now());
      st.clips.forEach((c, i) => ((c.startFrame = plan[i].startFrame), (c.slotEndFrame = plan[i].slotEndFrame)));
      st.finalUrl = undefined;
      st.finalFrames = undefined;
    });
    await this.savePrompt(rec, `voz_prueba_${variant}_v${version}.md`, record.join('\n'));
    await this.savePrompt(rec, 'tiempos_por_palabra.json', JSON.stringify(words, null, 1));
    await this.savePrompt(rec, 'plan.json', JSON.stringify(plan.map((pl, i) => ({ clip: `clip${nn(i + 1)}`, pfc: rec.shots![i].pfc, layout: rec.shots![i].keyframe.layout, ...pl })), null, 2));
    this.store.log(rec, `Prueba de voz · ${label}: ${(totalFrames / FPS).toFixed(2)} s en total (antes ${(s.durationSec ?? 0).toFixed(2)} s). Se rehacen el post y el render, sin regenerar clips.`);
    this.step(rec, 'post', `Prueba de voz · ${label}: rehaciendo el post y el render…`);
    await this.post(rec);
  }

  /** En MCP (Higgsfield, sin tiempos por carácter) la locución solo se puede pedir por párrafo. */
  private voiceByParagraph(): boolean {
    return this.p.mode === 'mcp';
  }

  /**
   * «Rehacer la locución» (ADR-134): vuelve a pedir toda la locución del video en un solo pedido, con la misma voz y el
   * mismo texto (y las reglas de pronunciación), para quitar los cambios de tono, velocidad y acento entre párrafos de
   * los videos que se locutaron por párrafo. Los fotogramas y los clips no cambian; se rehacen el post y el final.
   */
  revoiceAll(rec: RunRecord) {
    const s = rec.state;
    if (rec.busy) throw new Error('La generación está trabajando.');
    if (this.p.mode === 'mcp') throw new Error('La locución en un solo pedido usa la API de ElevenLabs (modo API).');
    const done = s.status === 'done' && rec.approved;
    if (s.status !== 'awaiting_approval' && !done) throw new Error('La locución se rehace durante la revisión de fotogramas o en un video terminado.');
    if (s.keyframes.some((k) => k.status === 'generating' || k.activity)) throw new Error('Espera a que terminen las regeneraciones en curso.');
    if (!rec.words?.length || !rec.shots?.length || !rec.plan) throw new Error('Faltan los tiempos o el plan de este video.');
    this.guard(rec, async () => {
      const before = s.status;
      try {
        await this.revoiceWhole(rec, null, '', await this.rulesFor(rec.ownerId), undefined, '', before, done);
      } catch (e) {
        if (rec.state.status !== 'voice') throw e; // ya se aplicó: el error es del post o del render
        const msg = (e as Error).message;
        this.store.log(rec, `No se pudo rehacer la locución: ${msg}`, 'warn');
        this.store.update(rec, (st) => ((st.status = before), (st.message = `No se pudo rehacer la locución: ${msg.split('\n')[0]}`)));
      }
    });
  }

  /**
   * «Rehacer audio» de un video con la locución en un solo pedido (ADR-133): se vuelve a pedir TODA la locución (con el
   * texto corregido del párrafo y las reglas de pronunciación), para que el tono siga igual en todos los párrafos. Los
   * planos se mantienen (sus anclas pasan al texto nuevo), se recalcula el plan y, si el video estaba terminado, se
   * rehacen el post y el final sin regenerar clips.
   */
  private async revoiceWhole(rec: RunRecord, index: number | null, text: string, rules: Rule[], instruction: string | undefined, explanation: string, before: RunState['status'], done: boolean) {
    const s = rec.state;
    const paras = [...s.paragraphs].sort((a, b) => a.index - b.index);
    const texts = paras.map((p) => (index !== null && p.index === index ? text : p.text));
    const tag = (i: number) => (s.script?.rows[i]?.voiceTag && this.p.mode !== 'mock' ? `[${s.script.rows[i].voiceTag}] ` : '');
    const spoken = texts.map((t, i) => tag(i) + applyRules(t, rules));
    const version = Math.max(...paras.map((p) => p.version ?? 1)) + 1;
    const vdir = join(rec.dir, 'voice');
    this.step(rec, 'voice', 'Rehaciendo toda la locución en un solo pedido…');
    const r = await this.wholeVoice(rec, { texts, spoken, base: join(vdir, `locucion_v${version}`), wavOf: (i) => join(vdir, `parrafo${nn(i + 1)}_v${version}.48k.wav`) });
    const totalFrames = totalFramesFor(r.endSec);

    // Palabras nuevas y anclas de los planos: los demás párrafos tienen las mismas palabras (mismo orden); el corregido
    // se empareja con el texto anterior (LCS), como en «Rehacer audio» por párrafo.
    const oldWords = rec.words!;
    const words: TimedWord[] = r.words.map((w) => ({ word: w.word, start: w.start, end: w.end, paragraph: paras[w.pos].index }));
    const indexMap: number[] = [];
    let offset = 0;
    for (const p of paras) {
      const firstOld = oldWords.findIndex((w) => w.paragraph === p.index);
      const oldTokens = oldWords.filter((w) => w.paragraph === p.index).map((w) => w.word);
      const count = words.filter((w) => w.paragraph === p.index).length;
      if (p.index === index) {
        const relMap = mapWordIndices(oldTokens, tokenize(text));
        oldTokens.forEach((_, k) => (indexMap[firstOld + k] = offset + relMap[k]));
      } else oldTokens.forEach((_, k) => (indexMap[firstOld + k] = offset + Math.min(k, count - 1)));
      offset += count;
    }
    const shots = rec.shots!.map((sh, i) => ({ ...sh, anchorWordIndex: i === 0 ? 0 : Math.min(words.length - 1, indexMap[sh.anchorWordIndex] ?? sh.anchorWordIndex) }));
    const paragraphs = paras.map((p, i) => ({ ...p, startSec: r.parts[i].startSec }));
    const plan = planShots(words, shots, paragraphs, totalFrames);
    if (plan.length !== shots.length)
      throw new Error(`Con la nueva locución no caben todos los planos (${plan.length} de ${shots.length}); no se aplicó. Prueba otro texto o usa "Cambiar el texto".`);

    const voiceWav = join(vdir, 'voz_completa.wav');
    await assembleVoice(r.parts.map((p) => ({ wav: p.wav, startSec: p.startSec })), totalFrames / FPS, voiceWav);
    rec.words = words;
    rec.shots = shots;
    rec.plan = plan;
    rec.paraAudio = undefined;
    this.store.update(rec, (st) => {
      st.paragraphs = paragraphs.map((p, i) => ({ ...p, text: texts[i], durationSec: r.parts[i].dur, version, spokenText: spoken[i] !== texts[i] ? spoken[i] : undefined }));
      st.text = st.paragraphs.map((p) => p.text).join('\n\n');
      st.totalFrames = totalFrames;
      st.durationSec = totalFrames / FPS;
      st.voiceUrl = this.fileUrl(rec, voiceWav, Date.now());
      st.clips.forEach((c, i) => ((c.startFrame = plan[i].startFrame), (c.slotEndFrame = plan[i].slotEndFrame)));
      st.finalUrl = undefined;
      st.finalFrames = undefined;
      st.voiceMode = 'whole';
    });
    const why = index === null ? 'Rehacer la locución' : `Rehacer audio del párrafo ${index + 1}`;
    await this.savePrompt(
      rec,
      `locucion_v${version}.md`,
      [`# Locución v${version} · un solo pedido (${why})`, '', instruction ? `Indicación: ${instruction}` : '', explanation ? `Opus: ${explanation}` : '', ...r.record, '', '## Enviado a la voz', '', spoken.join('\n\n')]
        .filter((l) => l !== '')
        .join('\n'),
    );
    await this.savePrompt(rec, 'tiempos_por_palabra.json', JSON.stringify(words, null, 1));
    await this.savePrompt(rec, 'plan.json', JSON.stringify(plan.map((pl, i) => ({ clip: `clip${nn(i + 1)}`, pfc: shots[i].pfc, layout: shots[i].keyframe.layout, ...pl })), null, 2));
    this.store.log(rec, `Locución v${version} en un solo pedido (${why}): ${(totalFrames / FPS).toFixed(2)} s en total (antes ${((rec.state.durationSec ?? 0)).toFixed(2)} s).`);
    if (done) {
      this.step(rec, 'post', 'Locución rehecha: se rehacen el post y el render (sin regenerar clips)…');
      await this.post(rec);
    } else if (before === 'awaiting_approval') {
      this.step(rec, 'awaiting_approval', 'Locución rehecha. Revisa los fotogramas y aprueba cuando estés conforme.');
      this.reviewMessage(rec);
    }
  }

  // ---------------------------------------------------------------- insertos (hito 6, ADR-073)

  private insertsDir(rec: RunRecord) {
    return join(rec.dir, 'inserts');
  }

  /**
   * Agrega un inserto (ADR-073): un clip generado del fotograma Kn al mismo Kn (en cualquier posición) o un
   * video subido como portada o cierre (solo al principio o al final), con pausa en la voz o un texto nuevo
   * locutado. Se puede agregar mientras se generan los clips (ADR-075): su trabajo corre por la cola en
   * paralelo y el final se vuelve a unir cuando está listo.
   */
  addInsert(rec: RunRecord, req: InsertRequest, upload?: { path: string; meta: Awaited<ReturnType<typeof probeVideo>> }): InsertState {
    const s = rec.state;
    this.assertInsertable(rec);
    const n = s.clips.length;
    if (!Number.isInteger(req.after) || req.after < 0 || req.after > n) throw new Error('Posición no válida.');
    if (req.kind === 'upload' && req.after !== 0 && req.after !== n) throw new Error('Un video subido solo va al principio (portada) o al final (cierre).');
    const text = req.voice === 'text' ? req.text?.replace(/\s+/g, ' ').trim() : undefined;
    if (req.voice === 'text' && !text) throw new Error('Escribe el texto que se locuta durante el inserto.');
    const id = (s.inserts ?? []).reduce((m, x) => Math.max(m, x.id), 0) + 1;
    const ins: InsertState = { id, kind: req.kind, after: req.after, status: 'pending', version: 1, voice: req.voice, text };
    if (req.kind === 'generated') ins.note = req.note?.trim() || undefined;
    else {
      if (!upload) throw new Error('Falta el video.');
      const m = upload.meta;
      const start = Math.max(0, Math.min(req.trimStart ?? 0, m.durationSec));
      const end = Math.max(start, Math.min(req.trimEnd ?? m.durationSec, m.durationSec));
      const frames = Math.floor((end - start) * FPS + 1e-6);
      if (frames < FPS / 2) throw new Error('El tramo elegido dura menos de medio segundo.');
      ins.upload = {
        fileName: `${relative(rec.dir, upload.path)}`,
        width: m.width,
        height: m.height,
        fps: m.fps,
        durationSec: m.durationSec,
        hasAudio: m.hasAudio,
        trimStart: start,
        trimEnd: end,
        fit: req.fit ?? 'contain',
        keepAudio: !!req.keepAudio && m.hasAudio,
      };
      ins.deliveredFrames = frames;
      // Listo ya, salvo que falte su locución.
      ins.status = req.voice === 'text' ? 'pending' : 'ready';
      // Transición animada con el clip vecino (ADR-074/075): 2 s, solo de este inserto.
      if (req.transition) ins.transition = { status: 'pending', version: 1 };
    }
    this.store.update(rec, (st) => {
      st.inserts = [...(st.inserts ?? []), ins];
      const clips = (ins.kind === 'generated' ? 1 : 0) + (ins.transition ? 1 : 0);
    });
    const where = req.after === 0 ? 'al principio' : req.after === n ? 'al final' : `entre clip${nn(req.after)} y clip${nn(req.after + 1)}`;
    this.store.log(rec, `Inserto ${id} (${ins.kind === 'generated' ? 'clip generado' : 'video subido'}) ${where}${ins.voice === 'text' ? ', con locución propia' : ', con pausa en la voz'}.`);
    if (!this.kickInserts(rec)) this.insertsChanged(rec);
    return ins;
  }

  /** Se agregan o cambian insertos en un video aprobado (con sus clips en marcha o terminado; ADR-075). */
  private assertInsertable(rec: RunRecord) {
    if (!rec.approved || !rec.plan || !rec.state.clips.length) throw new Error('Los insertos se agregan cuando el video ya tiene sus clips en marcha (después de aprobar los fotogramas).');
    if (rec.state.status === 'paused') throw new Error('El video está detenido: reanúdalo primero.');
  }

  /** Regenera un inserto generado (con otra indicación, si se da) y vuelve a unir el final. */
  regenerateInsert(rec: RunRecord, id: number, note?: string) {
    const ins = rec.state.inserts?.find((x) => x.id === id);
    if (!ins || ins.kind !== 'generated') throw new Error('Solo se regeneran los insertos generados.');
    this.assertInsertable(rec);
    if (this.insertJobs.get(rec)?.has(`x${id}`)) throw new Error('Este inserto ya se está generando.');
    this.store.update(rec, (st) => {
      ins.status = 'pending';
      ins.version += 1;
      ins.error = undefined;
      ins.taskId = undefined;
      if (note !== undefined) ins.note = note.trim() || undefined;
    });
    this.store.log(rec, `Regenerando el inserto ${id}${ins.note ? ` con la indicación: ${ins.note}` : ''}.`);
    this.kickInserts(rec);
  }

  /**
   * Transición de un video subido (ADR-074/075): la agrega o la regenera (con una indicación opcional), o la
   * quita (sin costo). Después se vuelve a unir el final.
   */
  insertTransition(rec: RunRecord, id: number, o: { note?: string; remove?: boolean; enabled?: boolean }) {
    const ins = rec.state.inserts?.find((x) => x.id === id);
    if (!ins || ins.kind !== 'upload') throw new Error('Solo los videos subidos llevan transición.');
    this.assertInsertable(rec);
    // Activar o desactivar (ADR-086): no gasta; la transición se conserva y el final se vuelve a unir. Si se está
    // generando, termina igual y queda guardada.
    if (o.enabled !== undefined) {
      if (!ins.transition) throw new Error('Este inserto no tiene transición: agrégala primero.');
      if ((ins.transition.enabled !== false) === o.enabled) return;
      this.store.update(rec, () => (ins.transition!.enabled = o.enabled ? undefined : false));
      this.store.log(rec, `Inserto ${id}: transición ${o.enabled ? 'activada' : 'desactivada (se conserva)'}.`);
      this.insertsChanged(rec);
      return;
    }
    if (this.insertJobs.get(rec)?.has(`t${id}`)) throw new Error('La transición de este inserto ya se está generando.');
    if (o.remove) {
      if (!ins.transition) throw new Error('Este inserto no tiene transición.');
      this.store.update(rec, () => (ins.transition = undefined));
      this.store.log(rec, `Inserto ${id}: transición quitada.`);
      this.insertsChanged(rec);
      return;
    }
    this.store.update(rec, (st) => {
      ins.transition = { status: 'pending', version: (ins.transition?.version ?? 0) + 1, note: o.note?.trim() || undefined };
    });
    this.store.log(rec, `Inserto ${id}: transición en cola${ins.transition!.note ? ` con la indicación: ${ins.transition!.note}` : ''}.`);
    this.kickInserts(rec);
  }

  /** Quita un inserto y vuelve a unir el final (sin costo). */
  removeInsert(rec: RunRecord, id: number) {
    const s = rec.state;
    if (!s.inserts?.some((x) => x.id === id)) throw new Error('Inserto no encontrado.');
    const jobs = this.insertJobs.get(rec);
    if (jobs?.has(`x${id}`) || jobs?.has(`t${id}`)) throw new Error('Este inserto se está generando: espera a que termine para quitarlo.');
    this.store.update(rec, (st) => (st.inserts = st.inserts!.filter((x) => x.id !== id)));
    this.store.log(rec, `Inserto ${id} quitado: se vuelve a unir el final.`);
    this.insertsChanged(rec);
  }

  /**
   * Lanza, sin esperar, el trabajo pendiente de cada inserto (ADR-075): su locución, su clip generado y su
   * transición, cada uno por su lado y por la cola global (en paralelo con los clips del video). La
   * transición de la portada solo necesita el K00; la del cierre, que el último clip esté listo. Devuelve si
   * lanzó algo.
   */
  private kickInserts(rec: RunRecord): boolean {
    const s = rec.state;
    if (!rec.approved || !rec.plan || !s.inserts?.length || this.queue.isPaused(s.id)) return false;
    let jobs = this.insertJobs.get(rec);
    if (!jobs) this.insertJobs.set(rec, (jobs = new Map()));
    let started = false;
    const start = (key: string, fn: () => Promise<void>) => {
      started = true;
      const p = this.work(rec, this.scope(rec), fn)
        .catch((e) => {
          if (!(e instanceof PausedError)) this.store.log(rec, `Inserto: ${(e as Error).message}`, 'warn');
        })
        .finally(() => {
          jobs!.delete(key);
          this.insertsChanged(rec);
        });
      jobs!.set(key, p);
    };
    for (const ins of s.inserts) {
      const needsVoice = ins.voice === 'text' && !!ins.text && !ins.voiceSec;
      const needsClip = ins.kind === 'generated' && (ins.status === 'pending' || ins.status === 'generating');
      if ((needsVoice || needsClip) && ins.status !== 'error' && !jobs.has(`x${ins.id}`)) start(`x${ins.id}`, () => this.insertJob(rec, ins));
      const t = ins.transition;
      if (t && (t.status === 'pending' || t.status === 'generating') && !jobs.has(`t${ins.id}`) && this.transitionCanStart(rec, ins))
        start(`t${ins.id}`, () => this.transitionJob(rec, ins));
    }
    return started;
  }

  /**
   * Video terminado con clips regenerándose cuando la API se detuvo (ADR-091): lo enviado a MiniMax se sigue
   * consultando (task_id) y lo demás vuelve a la cola, con prioridad. Si es antiguo (más de 24 h), quedan con
   * error para regenerarlos.
   */
  private resumeClips(rec: RunRecord) {
    const s = rec.state;
    const busy = s.clips.filter((c) => c.status === 'pending' || c.status === 'generating');
    if (this.resumable.has(s.id)) {
      this.store.log(rec, `Retomada tras un reinicio de la API: ${busy.map((c) => `clip${nn(c.index)}`).join(', ')} se ${busy.length > 1 ? 'siguen' : 'sigue'} regenerando.`, 'warn');
      this.urgent.add(rec);
      for (const c of busy) this.kickClip(rec, c);
      return;
    }
    this.store.update(rec, () => busy.forEach((c) => ((c.status = 'error'), (c.error = 'Interrumpido por un reinicio de la API; regénéralo.'))));
  }

  /** Video terminado con insertos en marcha cuando la API se detuvo (ADR-075): se siguen o quedan con error. */
  private resumeInserts(rec: RunRecord) {
    const s = rec.state;
    // Transiciones hechas antes de ADR-076: se recortan otra vez, ahora por el tramo con movimiento (solo
    // ffmpeg, sin costo), y el final se vuelve a unir.
    const stale = (s.inserts ?? []).filter((x) => x.transition?.status === 'ready' && !this.media.has(transitionCut(rec.dir, x.id, x.transition.version)));
    if (stale.length) {
      this.store.log(rec, `${stale.length === 1 ? 'La transición se recorta' : 'Las transiciones se recortan'} otra vez por el tramo con movimiento (ADR-076): se vuelve a unir el final.`);
      this.insertsChanged(rec);
    }
    const busy = (s.inserts ?? []).filter((x) => x.status === 'generating' || x.transition?.status === 'generating' || x.transition?.status === 'pending' || (x.status === 'pending' && x.kind === 'generated'));
    if (!busy.length) return;
    if (this.resumable.delete(s.id)) {
      this.store.log(rec, `Retomada tras un reinicio de la API: ${busy.length} inserto(s) en marcha se siguen (lo enviado se sigue consultando).`, 'warn');
      this.kickInserts(rec);
      return;
    }
    this.store.update(rec, () => {
      for (const x of busy) {
        if (x.status === 'generating' || x.status === 'pending') ((x.status = 'error'), (x.error = 'Interrumpido por un reinicio de la API; regénéralo.'));
        if (x.transition && x.transition.status !== 'ready' && x.transition.status !== 'error')
          ((x.transition.status = 'error'), (x.transition.error = 'Interrumpida por un reinicio de la API; regénérala.'));
      }
    });
  }

  /** Un inserto quedó listo, cambió o se quitó: el final se vuelve a unir ahora o al terminar lo que esté en marcha. */
  private insertsChanged(rec: RunRecord) {
    this.insertRev.set(rec, (this.insertRev.get(rec) ?? 0) + 1);
    this.rejoinIfNeeded(rec);
  }

  private transitionCanStart(rec: RunRecord, ins: InsertState) {
    if (!transitionFirst(ins)) return true;
    const last = rec.state.clips[rec.state.clips.length - 1];
    if (!last || last.status !== 'ready') return false;
    return rec.clipRaw.has(last.index) || this.media.has(join(rec.dir, 'clips', `clip${nn(last.index)}_ia_v${last.version}.mp4`));
  }

  /** Fotograma de un clip como referencia para MiniMax (se sube si hace falta). */
  private async frameAsset(rec: RunRecord, index: number) {
    const k = rec.state.keyframes.find((x) => x.index === index)!;
    const a: { path: string; ref?: string } = rec.keyAssets.get(index) ?? { path: join(rec.dir, 'keyframes', `K${nn(index)}_v${k.version}.png`) };
    if (a.ref) return { path: a.path, ref: a.ref };
    if (!existsSync(a.path)) throw new Error(`Falta el archivo de K${nn(index)}; regénéralo.`);
    const ref = this.p.uploadRef ? await this.p.uploadRef(a.path) : a.path;
    const asset = { path: a.path, ref };
    rec.keyAssets.set(index, asset);
    return asset;
  }

  /**
   * Fotogramas de inicio y fin de la transición de un video subido (ADR-074): en la portada, su último cuadro
   * (recortado y ajustado como en el final) y el K00 (inicio del clip01); en el cierre, el último cuadro que
   * muestra el último clip y el primer cuadro del video.
   */
  private async transitionFrames(rec: RunRecord, ins: InsertState) {
    const up = ins.upload!;
    const src = join(rec.dir, up.fileName);
    const dir = this.insertsDir(rec);
    const asset = async (png: string) => ({ path: png, ref: this.p.uploadRef ? await this.p.uploadRef(png) : png });
    if (!transitionFirst(ins)) {
      const png = join(dir, `ins${ins.id}_ultimo.png`);
      await videoFrameAt(src, Math.max(up.trimStart, up.trimEnd - 1.5 / Math.max(1, up.fps)), up.fit, png);
      return { start: await asset(png), end: await this.frameAsset(rec, 0) };
    }
    const n = rec.state.clips.length;
    const last = rec.state.clips[n - 1];
    const raw = rec.clipRaw.get(last.index) ?? join(rec.dir, 'clips', `clip${nn(last.index)}_ia_v${last.version}.mp4`);
    const plan = rec.plan![n - 1];
    const delivered = last.deliveredFrames ?? Math.floor((await durationSec(raw)) * FPS + 1e-3);
    const shown = Math.min(delivered, plan.slotEndFrame - plan.startFrame);
    const lastPng = join(dir, `ins${ins.id}_clip_anterior.png`);
    await clipFrame(raw, shown - 1, lastPng);
    const firstPng = join(dir, `ins${ins.id}_primero.png`);
    await videoFrameAt(src, up.trimStart, up.fit, firstPng);
    return { start: await asset(lastPng), end: await asset(firstPng) };
  }

  /** Locución y clip generado de un inserto. */
  private async insertJob(rec: RunRecord, ins: InsertState) {
    const s = rec.state;
    await mkdir(this.insertsDir(rec), { recursive: true });
    try {
      if (ins.voice === 'text' && ins.text && !ins.voiceSec) {
        const rules = await this.rulesFor(rec.ownerId);
        const r = await this.p.tts.synthesize(applyRules(ins.text, rules), s.voiceId, join(this.insertsDir(rec), `ins${ins.id}_voz`));
        const wav = join(this.insertsDir(rec), `ins${ins.id}_voz.48k.wav`);
        await toWav48k(r.path, wav);
        const dur = await durationSec(wav);
        // Tiempos por palabra para los subtítulos; sin ellos, repartidos a lo largo de la locución.
        const tokens = ins.text.split(/\s+/).filter(Boolean);
        const words = r.words?.length ? r.words : tokens.map((w, i) => ({ word: w, start: (i / tokens.length) * dur, end: ((i + 1) / tokens.length) * dur }));
        this.store.update(rec, () => {
          ins.voiceSec = dur;
          ins.voiceWords = words.map((w) => ({ word: w.word, start: w.start, end: w.end }));
          if (ins.kind === 'upload') ins.status = 'ready';
        });
        this.store.log(rec, `Inserto ${ins.id}: locución de ${dur.toFixed(2)} s.`);
      }
      if (ins.kind !== 'generated' || ins.status === 'ready') return;
      if (this.queue.isPaused(s.id)) throw new PausedError();
      const k = s.keyframes.find((kk) => kk.index === ins.after)!;
      const summary = ins.after === 0 ? 'only the style background, no text' : rec.shots![ins.after - 1].keyframe.summary;
      const prompt = insertClipPrompt(rec.theme, summary, k.texts, ins.note);
      await this.savePrompt(rec, `inserto${ins.id}_video_v${ins.version}.md`, prompt);
      const frame = await this.frameAsset(rec, ins.after);
      this.store.update(rec, () => ((ins.status = 'generating'), (ins.error = undefined)));
      await this.p.video.generate(
        [
          {
            key: `x${ins.id}`,
            prompt,
            start: frame,
            end: frame,
            outPath: join(this.insertsDir(rec), `ins${ins.id}_ia_v${ins.version}.mp4`),
            resumeTaskId: ins.taskId,
            onSubmitted: async (taskId: string) => {
              this.store.update(rec, () => (ins.taskId = taskId));
              await this.store.flush(rec);
            },
          },
        ],
        async (r) => {
          if (r.path) {
            const delivered = Math.floor((await durationSec(r.path)) * FPS + 1e-3);
            this.store.update(rec, () => ((ins.status = 'ready'), (ins.deliveredFrames = delivered), (ins.url = this.fileUrl(rec, r.path!, ins.version))));
            this.store.log(rec, `Inserto ${ins.id} listo (${delivered} f).`);
          } else throw new Error(r.error ?? 'MiniMax no entregó el clip.');
        },
      );
    } catch (e) {
      if (e instanceof PausedError) throw e;
      const msg = (e as Error).message;
      this.store.update(rec, () => ((ins.status = 'error'), (ins.error = msg), transientInfo(msg) ? undefined : (ins.taskId = undefined)));
      throw new Error(`inserto ${ins.id}: ${msg}`);
    }
  }

  /**
   * Transición de un video subido (ADR-075/076): Opus mira los dos cuadros y escribe la coreografía (qué
   * elemento sale y cuál entra, solo desplazándose; ADR-077), MiniMax anima ~5 s y se usa el tramo con movimiento,
   * acelerado a 2 s.
   */
  private async transitionJob(rec: RunRecord, ins: InsertState) {
    const t = ins.transition!;
    await mkdir(this.insertsDir(rec), { recursive: true });
    try {
      if (this.queue.isPaused(rec.state.id)) throw new PausedError();
      const closing = transitionFirst(ins);
      const mode = closing ? 'closing' : 'opening';
      const f = await this.transitionFrames(rec, ins);
      this.store.update(rec, () => ((t.status = 'generating'), (t.error = undefined)));
      // Una tarea ya enviada se sigue consultando: no hace falta otro prompt.
      let prompt = '';
      if (!t.taskId) {
        this.store.log(rec, `Inserto ${ins.id}: Opus prepara la coreografía de la transición…`);
        const content: Exclude<LlmContent, string> = [{ type: 'text', text: transitionPlanUserText(mode, t.note) }];
        for (const [name, png] of [['inicio', f.start.path], ['fin', f.end.path]] as const) {
          const jpg = join(this.insertsDir(rec), `ins${ins.id}_transicion_${name}.jpg`);
          await imagePreviewJpeg(png, jpg, 1344);
          content.push({ type: 'image', mediaType: 'image/jpeg', base64: (await readFile(jpg)).toString('base64') });
        }
        const plan = await this.askJson(TransitionPlanSchema, transitionPlanSystemPrompt(rec.theme), content, 'Coreografía de la transición');
        await this.savePrompt(rec, `inserto${ins.id}_transicion_v${t.version}_coreografia.json`, JSON.stringify(plan, null, 2));
        prompt = transitionClipPrompt(rec.theme, mode, plan.choreography, t.note);
        await this.savePrompt(rec, `inserto${ins.id}_transicion_v${t.version}.md`, prompt);
      }
      this.store.log(rec, `Inserto ${ins.id}: generando la transición ${closing ? 'del último clip al cierre' : 'de la portada al clip01'}…`);
      const raw = join(this.insertsDir(rec), `ins${ins.id}_transicion_v${t.version}.mp4`);
      await this.p.video.generate(
        [
          {
            key: `t${ins.id}`,
            prompt,
            start: f.start,
            end: f.end,
            outPath: raw,
            resumeTaskId: t.taskId,
            onSubmitted: async (taskId: string) => {
              this.store.update(rec, () => (t.taskId = taskId));
              await this.store.flush(rec);
            },
          },
        ],
        async (r) => {
          if (!r.path) throw new Error(r.error ?? 'MiniMax no entregó la transición.');
          await this.cutTransition(rec, ins, r.path);
          this.store.update(rec, () => (t.status = 'ready'));
        },
      );
    } catch (e) {
      if (e instanceof PausedError) throw e;
      const msg = (e as Error).message;
      this.store.update(rec, () => ((t.status = 'error'), (t.error = msg), transientInfo(msg) ? undefined : (t.taskId = undefined)));
      throw new Error(`transición del inserto ${ins.id}: ${msg}`);
    }
  }

  /**
   * Recorta de la transición en bruto el tramo con movimiento y lo acelera a 2 s (ADR-076). Devuelve los
   * frames del recorte.
   */
  private async cutTransition(rec: RunRecord, ins: InsertState, raw: string) {
    const t = ins.transition!;
    const d = await motionCurve(raw);
    const w = transitionWindow(d, transitionFirst(ins));
    const out = Math.min(TRANSITION_FRAMES, w.frames);
    const cut = transitionCut(rec.dir, ins.id, t.version);
    await cutClip(raw, w.from, w.frames, cut, out);
    this.store.update(rec, () => ((t.deliveredFrames = out), (t.url = this.fileUrl(rec, cut, t.version))));
    const speed = w.frames / out;
    this.store.log(
      rec,
      `Inserto ${ins.id}: transición de ${(out / FPS).toFixed(1)} s con el movimiento de ${(w.from / FPS).toFixed(1)} a ${((w.from + w.frames) / FPS).toFixed(1)} s de los ${(d.length / FPS).toFixed(1)} s de MiniMax${speed > 1.01 ? ` (acelerado ×${speed.toFixed(1)})` : ''}.`,
    );
    return out;
  }

  /** Espera los trabajos de insertos en marcha (y lanza los que ya pueden empezar, como la transición del cierre). */
  private async waitInserts(rec: RunRecord) {
    this.kickInserts(rec);
    const jobs = this.insertJobs.get(rec);
    if (!jobs?.size) return;
    const clips = [...jobs.keys()].filter((k) => k.startsWith('c')).length;
    const other = jobs.size - clips;
    const what = [clips ? `${clips} clip${clips > 1 ? 's' : ''} regenerándose` : '', other ? `${other} trabajo${other > 1 ? 's' : ''} de insertos` : ''].filter(Boolean).join(' y ');
    this.step(rec, 'post', `Esperando ${what} para unir el final…`);
    while (jobs.size) await Promise.allSettled([...jobs.values()]);
    if (this.queue.isPaused(rec.state.id)) throw new PausedError();
  }

  /** Composición del final con los insertos listos (ADR-073). */
  private composition(rec: RunRecord): Composition {
    const s = rec.state;
    const voiceFrames = s.totalFrames ?? 0;
    if (!s.inserts?.length || !rec.plan) return { totalFrames: videoFrames(rec.plan, voiceFrames), gaps: [] };
    const cues = rec.words?.length ? buildCues(s.paragraphs, rec.words, voiceFrames / FPS) : [];
    return compose(rec.plan, voiceFrames, s.inserts, cues);
  }

  /** Segmentos de los insertos (el clip o el video subido y, si su locución dura más, un congelado). */
  private async postInserts(rec: RunRecord, comp: Composition): Promise<FinalSegment[]> {
    const s = rec.state;
    const dir = join(rec.dir, 'segments');
    const out: FinalSegment[] = [];
    for (const g of comp.gaps)
      for (const gi of g.inserts) {
        const ins = s.inserts!.find((x) => x.id === gi.id)!;
        const own = Math.min(ins.deliveredFrames ?? 0, gi.frames);
        const upload = ins.kind === 'upload' ? ins.upload! : undefined;
        const src = upload ? join(rec.dir, upload.fileName) : join(this.insertsDir(rec), `ins${ins.id}_ia_v${ins.version}.mp4`);
        if (!existsSync(src)) throw new Error(`Falta el archivo del inserto ${ins.id}: quítalo y vuelve a agregarlo.`);
        const name = `ins${String(ins.id).padStart(2, '0')}`;
        const seg: Segment = { name, kind: 'clip', clip: -ins.id, startFrame: 0, endFrame: own };
        const mode = upload ? undefined : clipSound(s, {});
        const raw = upload ? `${upload.fileName}|${upload.trimStart}|${upload.fit}` : src.split('/').pop()!;
        const key = segmentKey(seg, raw, upload ? (upload.keepAudio ? 'upload-audio' : 'none') : soundKey(mode!, s.soundGainDb ?? 0));
        if ((await segmentStatus(dir, seg, key)) !== 'ready')
          await this.queue.runScoped('ffmpeg', 'post', name, async () => {
            const wav = soundWav(dir, seg);
            const dur = own / FPS;
            if (upload) {
              if (upload.keepAudio) {
                const tmp = join(dir, `${name}_audio_src.wav`);
                await extractAudio(src, upload.trimStart, dur, tmp);
                const lufs = await clipLoudness(tmp, dur);
                if (lufs !== null) await renderModelSound(tmp, dur, modelSoundGainDb(lufs, env.MODEL_SOUND_LUFS, env.MODEL_SOUND_MAX_GAIN_DB), wav);
                else await renderSilence(dur, wav);
                this.store.update(rec, () => (ins.soundLufs = lufs));
              } else await renderSilence(dur, wav);
              await encodeUploadSegment(src, { trimStart: upload.trimStart, frames: own, fit: upload.fit }, join(dir, `${name}.mp4`), wav);
            } else {
              const fake = { index: 100 + ins.id, soundMode: undefined } as unknown as ClipState;
              await this.renderClipSound(rec, fake, mode!, src, own, wav);
              this.store.update(rec, () => (ins.soundLufs = fake.soundLufs));
              await encodeClipSegment(src, own, join(dir, `${name}.mp4`), wav);
            }
            await writeSegmentKey(dir, seg, key);
            this.store.log(rec, `${name}: inserto de ${own} f${upload ? ` (${upload.fit === 'contain' ? 'con bandas' : upload.fit === 'cover' ? 'recortado' : 'estirado'})` : ''}`);
          });
        if (upload && !ins.url) this.store.update(rec, () => (ins.url = this.fileUrl(rec, join(dir, `${name}.mp4`), Date.now())));
        // Transición del video subido (ADR-074): antes del video en el cierre, después en la portada.
        const tFrames = transitionFrames(ins);
        let tSeg: Segment | undefined;
        if (upload && tFrames) {
          const t = ins.transition!;
          // Solo los 2 s animados (ADR-075), ya recortados al llegar.
          const traw = transitionCut(rec.dir, ins.id, t.version);
          if (!existsSync(traw)) {
            // Una transición de antes de ADR-075 (5 s enteros): se recortan sus 2 s del lado del video vecino.
            const full = join(this.insertsDir(rec), `ins${ins.id}_transicion_v${t.version}.mp4`);
            if (!existsSync(full)) throw new Error(`Falta la transición del inserto ${ins.id}: regénérala o quítala.`);
            await this.cutTransition(rec, ins, full);
          }
          tSeg = { name: `${name}t`, kind: 'clip', clip: -ins.id, startFrame: 0, endFrame: tFrames };
          const tmode = clipSound(s, {});
          // El recorte puede rehacerse con el mismo nombre: su fecha entra en la clave.
          const tkey = segmentKey(tSeg, `${traw.split('/').pop()!}|${Math.round(statSync(traw).mtimeMs)}`, soundKey(tmode, s.soundGainDb ?? 0));
          if ((await segmentStatus(dir, tSeg, tkey)) !== 'ready')
            await this.queue.runScoped('ffmpeg', 'post', tSeg.name, async () => {
              const wav = soundWav(dir, tSeg!);
              const fake = { index: 200 + ins.id, soundMode: undefined } as unknown as ClipState;
              await this.renderClipSound(rec, fake, tmode, traw, tFrames, wav);
              await encodeClipSegment(traw, tFrames, join(dir, `${tSeg!.name}.mp4`), wav);
              await writeSegmentKey(dir, tSeg!, tkey);
              this.store.log(rec, `${tSeg!.name}: transición de ${tFrames} f`);
            });
        }
        const first = tSeg && transitionFirst(ins);
        if (first) out.push({ ...tSeg!, finalStart: gi.startFrame, insert: ins.id });
        out.push({ ...seg, finalStart: gi.startFrame + (first ? tFrames : 0), upload: !!upload, insert: ins.id });
        if (tSeg && !first) out.push({ ...tSeg, finalStart: gi.startFrame + own, insert: ins.id });
        const all = own + tFrames;
        const lastSeg = tSeg && !first ? tSeg : seg;
        const lastLen = lastSeg === seg ? own : tFrames;
        if (gi.frames > all) {
          // La locución del inserto dura más que su video: se congela el último frame.
          const fz: Segment = { name: `${name}ex`, kind: 'freeze', clip: -ins.id, startFrame: all, endFrame: gi.frames };
          const fkey = segmentKey(fz, `${raw}|${lastSeg.name}|${tFrames}`, '', { ...lastSeg, startFrame: 0, endFrame: lastLen });
          if (!(await segmentReady(dir, fz, fkey)))
            await this.queue.runScoped('ffmpeg', 'post', fz.name, async () => {
              const png = join(dir, `${fz.name}_frame.png`);
              await clipFrame(join(dir, `${lastSeg.name}.mp4`), lastLen - 1, png);
              await encodeFreeze(png, gi.frames - all, join(dir, `${fz.name}.mp4`));
              await writeSegmentKey(dir, fz, fkey);
            });
          out.push({ ...fz, finalStart: gi.startFrame + all, insert: ins.id });
        }
      }
    return out;
  }

  /** Orden del final: los insertos de cada punto y después los segmentos del clip siguiente, ya corridos. */
  private orderSegments(rec: RunRecord, clipSegs: Segment[], insertSegs: FinalSegment[], comp: Composition): FinalSegment[] {
    const n = rec.state.clips.length;
    const out: FinalSegment[] = [];
    for (let p = 0; p <= n; p++) {
      const g = comp.gaps.find((x) => x.after === p);
      if (g) for (const gi of g.inserts) out.push(...insertSegs.filter((x) => x.insert === gi.id));
      if (p < n) for (const sg of clipSegs.filter((x) => x.clip === p)) out.push({ ...sg, finalStart: sg.startFrame + clipShift(comp, p + 1) });
    }
    return out;
  }

  /** Pistas a su volumen: la locución de cada inserto y el audio de los videos subidos. */
  private insertOverlays(rec: RunRecord, comp: Composition, segments: FinalSegment[]) {
    const dir = join(rec.dir, 'segments');
    const out: { wav: string; startFrame: number; volume: number }[] = [];
    for (const g of comp.gaps)
      for (const gi of g.inserts) {
        const ins = rec.state.inserts!.find((x) => x.id === gi.id)!;
        if (ins.voice === 'text' && ins.voiceSec)
          out.push({ wav: join(this.insertsDir(rec), `ins${ins.id}_voz.48k.wav`), startFrame: gi.startFrame + Math.round(INSERT_VOICE_LEAD * FPS), volume: 1 });
        const seg = segments.find((x) => x.insert === ins.id && x.upload);
        if (seg && ins.upload?.keepAudio) out.push({ wav: join(dir, `${seg.name}_sound.wav`), startFrame: seg.finalStart, volume: 1 });
      }
    return out;
  }

  // ---------------------------------------------------------------- fase 2
  /**
   * Aprobar una corrección sin cambios (ningún fotograma cambió, todos los clips listos y con final): el
   * video vuelve a quedar terminado sin llamar a ningún proveedor, así que sirve también en otro modo.
   */
  isNoopApproval(rec: RunRecord): boolean {
    const s = rec.state;
    return (
      s.status === 'awaiting_approval' &&
      !!s.finalUrl &&
      s.clips.length > 0 &&
      s.clips.every((c) => c.status === 'ready') &&
      s.keyframes.every((k) => k.status === 'ready' && !k.activity) &&
      s.clips.every((c) => {
        if (!c.builtWith) return true;
        const [a, b] = this.keyVersions(rec, c.index);
        return c.builtWith[0] === a && c.builtWith[1] === b;
      })
    );
  }

  approve(rec: RunRecord) {
    const notReady = rec.state.keyframes.filter((k) => k.status !== 'ready');
    if (rec.state.status !== 'awaiting_approval') throw new Error('La generación no está esperando aprobación.');
    if (notReady.length) throw new Error(`Faltan fotogramas: ${notReady.map((k) => `K${nn(k.index)}`).join(', ')}.`);
    if (rec.state.keyframes.some((k) => k.activity)) throw new Error('Espera a que terminen las regeneraciones en curso.');
    // Corrección (ADR-033): solo se rehacen los clips cuyos fotogramas de inicio o fin cambiaron.
    const affected = this.affectedClips(rec);
    rec.approved = true;
    this.store.update(rec, (s) => s.keyframes.forEach((k) => (k.previous = undefined))); // propuestas (ADR-071): quedan aprobadas
    if (affected.length) {
      this.store.update(rec, (s) => {
        for (const c of affected) {
          c.status = 'pending';
          c.version += 1;
          c.error = undefined;
          c.taskId = undefined;
        }
      });
      this.store.log(rec, `Corrección: se rehacen ${affected.map((c) => `clip${nn(c.index)}`).join(', ')} (cambiaron sus fotogramas).`);
    }
    const pending = rec.state.clips.filter((c) => c.status !== 'ready');
    if (!pending.length && rec.state.finalUrl) {
      // Sin cambios en los fotogramas: el video queda como estaba, sin gastar nada.
      this.step(rec, 'done', 'Sin cambios: los fotogramas no cambiaron y el video sigue igual.');
      return;
    }
    this.startPhase2(rec);
  }

  /**
   * Corregir un video terminado (ADR-033): vuelve a la revisión de fotogramas, donde se regeneran los
   * que haga falta (con nota). Al aprobar solo se rehacen los clips afectados y el render.
   */
  reopen(rec: RunRecord) {
    const s = rec.state;
    if (rec.busy) throw new Error('La generación está trabajando.');
    if (!['done', 'error'].includes(s.status) || !rec.approved) throw new Error('Solo se puede corregir un video que ya pasó la aprobación.');
    if (!rec.storyboard || !rec.shots || !s.keyframes.length) throw new Error('Falta el storyboard de este video: no se puede corregir.');
    if (s.keyframes.some((k) => k.status !== 'ready' || !rec.keyAssets.has(k.index))) throw new Error('Faltan fotogramas de este video; no se puede corregir.');
    this.store.update(rec, (st) => {
      // Los clips antiguos (sin registro) se consideran hechos con los fotogramas actuales.
      for (const c of st.clips) if (c.status === 'ready' && !c.builtWith) c.builtWith = this.keyVersions(rec, c.index);
      st.error = undefined;
    });
    rec.approved = false;
    this.step(rec, 'awaiting_approval', 'Corrección: regenera los fotogramas que quieras y aprueba; solo se rehacen los clips afectados.');
  }

  /** Regenera un clip suelto de un video terminado (con una indicación opcional) y vuelve a renderizar. */
  regenerateClip(rec: RunRecord, index: number, note?: string) {
    const s = rec.state;
    const c = s.clips.find((x) => x.index === index);
    if (!c) throw new Error(`No existe el clip ${nn(index)}.`);
    if (!rec.approved || !rec.plan) throw new Error('Solo se regeneran clips de un video que ya pasó la aprobación.');
    const draft = s.keyframes.filter((k) => (k.index === index - 1 || k.index === index) && (k.previous || k.activity));
    if (draft.length) throw new Error(`${draft.map((k) => `K${nn(k.index)}`).join(' y ')} tiene${draft.length > 1 ? 'n' : ''} una propuesta sin aplicar: aplícala o descártala antes de regenerar el clip.`);
    // Video con error (sin final al día): como antes, se retoma todo lo pendiente.
    if (s.status === 'error') {
      if (rec.busy) throw new Error('La generación está trabajando.');
      this.bumpClip(rec, c, note);
      this.startPhase2(rec);
      return;
    }
    // Video con final (ADR-091): cada clip se regenera por su lado, en la cola con la prioridad más alta, y se
    // pueden regenerar varios a la vez; el final se vuelve a unir una vez cuando terminan.
    if (!['done', 'clips', 'post', 'render'].includes(s.status) || !s.finalUrl) throw new Error('Solo se regeneran clips de un video que ya pasó la aprobación.');
    if (c.status === 'pending' || c.status === 'generating' || this.insertJobs.get(rec)?.has(`c${index}`)) throw new Error(`El clip${nn(index)} ya se está regenerando.`);
    const prev = { version: c.version, url: c.url, deliveredFrames: c.deliveredFrames, builtWith: c.builtWith, note: c.note, ssimStart: c.ssimStart, ssimEnd: c.ssimEnd };
    this.bumpClip(rec, c, note);
    this.urgent.add(rec);
    this.kickClip(rec, c, prev);
  }

  private bumpClip(rec: RunRecord, c: ClipState, note?: string) {
    this.store.update(rec, (st) => {
      c.status = 'pending';
      c.version += 1;
      c.error = undefined;
      c.taskId = undefined;
      c.note = note?.trim() || undefined;
      st.error = undefined;
    });
    this.store.log(rec, `Regenerando clip${nn(c.index)}${c.note ? ` con la indicación: ${c.note}` : ''} (en cola, con prioridad).`);
  }

  /**
   * Regeneración de un clip de un video con final (ADR-091), como un trabajo aparte (igual que los insertos,
   * ADR-075): el clip va a MiniMax con la prioridad más alta y, al llegar, su post; después se vuelve a unir el
   * final (una sola vez si hay varios en marcha). Si falla, el clip vuelve a la versión anterior.
   */
  private kickClip(rec: RunRecord, c: ClipState, prev?: Partial<ClipState>) {
    let jobs = this.insertJobs.get(rec);
    if (!jobs) this.insertJobs.set(rec, (jobs = new Map()));
    const key = `c${c.index}`;
    if (jobs.has(key)) return;
    const p = this.work(rec, { ...this.scope(rec), priority: URGENT_PRIORITY }, () => this.clipJob(rec, c))
      .catch((e) => {
        const msg = (e as Error).message;
        if (e instanceof PausedError) return;
        this.store.update(rec, () => {
          if (prev?.version && prev.url) Object.assign(c, { ...prev, status: 'ready', taskId: undefined, error: undefined });
          else ((c.status = 'error'), (c.error = msg));
        });
        this.store.log(rec, `clip${nn(c.index)}: la regeneración falló (${msg})${prev?.url ? '; queda la versión anterior' : ''}.`, 'warn');
      })
      .finally(() => {
        jobs!.delete(key);
        this.insertsChanged(rec);
      });
    jobs.set(key, p);
  }

  private async clipJob(rec: RunRecord, c: ClipState) {
    c.prompt = this.clipPrompt(rec, c.index);
    await this.savePrompt(rec, c.version > 1 ? `clip${nn(c.index)}_video_v${c.version}.md` : `clip${nn(c.index)}_video.md`, c.prompt);
    this.store.update(rec);
    await this.ensureRefs(rec);
    this.store.update(rec, () => ((c.status = 'generating'), (c.error = undefined), (c.builtWith = this.keyVersions(rec, c.index))));
    await this.p.video.generate([this.clipRequest(rec, c)], (r) => this.clipArrived(rec, c, r));
    if (c.status !== 'ready') throw new Error(c.error ?? 'MiniMax no entregó el clip.');
    // Su post ya empezó al llegar (postClipEarly); se espera aquí para que la unión lo encuentre hecho.
    await this.postClip(rec, rec.state.clips.indexOf(c));
  }

  /** Reintenta desde donde falló. */
  retry(rec: RunRecord) {
    if (rec.state.status !== 'error') throw new Error('Solo se puede reintentar una generación con error.');
    this.store.update(rec, (s) => (s.error = undefined));
    // Sigue desde donde falló: lo que ya está hecho (locución, storyboard, fotogramas, clips) no se repite.
    if (rec.approved) this.startPhase2(rec);
    else this.startPhase1(rec);
  }

  private startPhase2(rec: RunRecord) {
    this.guard(rec, async () => {
      // Un fotograma que quedó sin imagen (p. ej. el intermedio de una división que falló, ADR-130) se genera antes.
      for (const k of rec.state.keyframes.filter((x) => x.status !== 'ready' && !x.activity && !rec.keyAssets.get(x.index))) {
        this.step(rec, 'keyframes', `Generando K${nn(k.index)}…`);
        await this.regenOne(rec, k.index);
      }
      // Los prompts de clip dependen de dos planos vecinos: se recalculan con la versión final aprobada.
      for (const c of rec.state.clips.filter((x) => x.status !== 'ready')) {
        c.prompt = this.clipPrompt(rec, c.index);
        // Cada versión regenerada guarda su propio prompt (la v1 conserva el nombre de siempre).
        await this.savePrompt(rec, c.version > 1 ? `clip${nn(c.index)}_video_v${c.version}.md` : `clip${nn(c.index)}_video.md`, c.prompt);
      }
      this.store.update(rec);
      await this.ensureRefs(rec);
      // Los insertos corren por su lado (ADR-075): el final incluye los que estén listos y se vuelve a unir con los demás.
      this.kickInserts(rec);
      await this.clips(rec);
      await this.post(rec);
    });
  }

  /** Tras restaurar una generación, los fotogramas pueden no tener referencia remota: se suben. */
  private async ensureRefs(rec: RunRecord) {
    const needed = new Set(rec.state.clips.filter((c) => c.status !== 'ready').flatMap((c) => [c.index - 1, c.index]));
    for (const x of rec.state.inserts ?? []) if (x.kind === 'generated' && x.status !== 'ready') needed.add(x.after);
    for (const k of rec.state.keyframes) {
      if (!needed.has(k.index)) continue;
      const path = rec.keyAssets.get(k.index)?.path ?? join(rec.dir, 'keyframes', `K${nn(k.index)}_v${k.version}.png`);
      if (rec.keyAssets.get(k.index)?.ref) continue;
      if (!existsSync(path)) throw new Error(`Falta el archivo de K${nn(k.index)}; regénéralo.`);
      this.store.log(rec, `Subiendo K${nn(k.index)} para usarlo en los clips…`);
      const ref = this.p.uploadRef ? await this.p.uploadRef(path) : path;
      rec.keyAssets.set(k.index, { ref, path });
    }
    this.store.update(rec);
  }

  private async clips(rec: RunRecord) {
    const s = rec.state;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const own = this.insertJobs.get(rec);
      const todo = s.clips.filter((c) => c.status !== 'ready' && !own?.has(`c${c.index}`));
      if (!todo.length) break;
      if (this.queue.isPaused(s.id)) throw new PausedError();
      if (attempt > 1) {
        this.store.log(rec, `Reintentando ${todo.length} clip(s) fallido(s)…`, 'warn');
        // Los que fallaron por la red conservan su task_id y su versión (se siguen consultando, no se pagan
        // dos veces); los que fallaron en el proveedor se envían como versión nueva.
        this.store.update(rec, () => todo.forEach((c) => !c.taskId && (c.version += 1)));
      }
      const resumed = todo.filter((c) => c.taskId).length;
      this.step(
        rec,
        'clips',
        `Generando ${todo.length} clip${todo.length > 1 ? 's' : ''} de video en paralelo${resumed ? ` (${resumed} ya enviado${resumed > 1 ? 's' : ''}: se siguen consultando)` : ''}…`,
      );
      this.store.update(rec, () => todo.forEach((c) => ((c.status = 'generating'), (c.error = undefined), (c.builtWith = this.keyVersions(rec, c.index)))));
      await this.p.video.generate(
        todo.map((c) => this.clipRequest(rec, c)),
        async (r) => this.clipArrived(rec, s.clips.find((x) => String(x.index) === r.key)!, r),
      );
    }
    const failed = s.clips.filter((c) => c.status !== 'ready' && !this.insertJobs.get(rec)?.has(`c${c.index}`));
    if (failed.length) throw new Error(`Fallaron ${failed.length} clip(s): ${failed.map((c) => `clip${nn(c.index)}`).join(', ')}. Pulsa Reintentar.`);
  }

  private clipRequest(rec: RunRecord, c: ClipState) {
    return {
      key: String(c.index),
      prompt: c.prompt,
      start: rec.keyAssets.get(c.index - 1)!,
      end: rec.keyAssets.get(c.index)!,
      outPath: join(rec.dir, 'clips', `clip${nn(c.index)}_ia_v${c.version}.mp4`),
      // Hito 5 (ADR-046): un clip ya enviado se sigue consultando; el task_id se guarda al enviarlo.
      resumeTaskId: c.taskId,
      onSubmitted: async (taskId: string) => {
        this.store.update(rec, () => (c.taskId = taskId));
        await this.store.flush(rec);
      },
    };
  }

  private clipArrived(rec: RunRecord, c: ClipState, r: { path?: string; error?: string }) {
    if (r.path) {
      rec.clipRaw.set(c.index, r.path);
      this.store.update(rec, () => ((c.status = 'ready'), (c.url = this.fileUrl(rec, r.path!, c.version))));
      this.store.log(rec, `clip${nn(c.index)} listo.`);
      // Hito 6 (ADR-056): su post empieza ya, mientras los demás clips se siguen generando.
      this.lastClipAt.set(rec, Date.now());
      this.postClipEarly(rec, rec.state.clips.indexOf(c));
      // El cierre con transición necesita el último clip (ADR-075): se adelanta en cuanto llega.
      this.kickInserts(rec);
    } else {
      // Un fallo definitivo de la tarea (no de la red) la descarta: el próximo intento envía una nueva.
      this.store.update(rec, () => ((c.status = 'error'), (c.error = r.error), transientInfo(r.error ?? '') ? undefined : (c.taskId = undefined)));
      this.store.log(rec, `clip${nn(c.index)}: ${r.error}`, 'warn');
    }
  }

  /**
   * Post de un clip (hito 6, ADR-055/056): su segmento y, si no llena su hueco, su congelado. Se lanza en
   * cuanto el clip llega, mientras los demás se siguen generando, por la cola de ffmpeg y con la prioridad
   * del video. El segmento se codifica ya con la calidad del final; el congelado sale del último frame en
   * bruto del clip. Lo que ya está hecho con la misma clave (versión del clip, frames, sonido) no se repite.
   */
  private postClip(rec: RunRecord, i: number): Promise<void> {
    const c = rec.state.clips[i];
    const raw = rec.clipRaw.get(c.index) ?? join(rec.dir, 'clips', `clip${nn(c.index)}_ia_v${c.version}.mp4`);
    let jobs = this.posting.get(rec);
    if (!jobs) this.posting.set(rec, (jobs = new Map()));
    const id = `${i}:${raw}`;
    const running = jobs.get(id);
    if (running) return running;
    const job = this.postClipInner(rec, i, raw).finally(() => jobs.delete(id));
    jobs.set(id, job);
    return job;
  }

  private async postClipInner(rec: RunRecord, i: number, raw: string) {
    const s = rec.state;
    const c = s.clips[i];
    const dir = join(rec.dir, 'segments');
    const hasRaw = existsSync(raw);
    const delivered = hasRaw ? Math.floor((await durationSec(raw)) * FPS + 1e-3) : c.deliveredFrames;
    if (!delivered) throw new Error(`Falta el clip${nn(c.index)} en bruto: regénéralo.`);
    if (c.deliveredFrames !== delivered) this.store.update(rec, () => (c.deliveredFrames = delivered));
    const [clipSeg, freezeSeg] = clipSegments(rec.plan!, i, delivered);
    const rawName = raw.split('/').pop()!;
    const work: Promise<void>[] = [];
    const mode = clipSound(s, c);
    const clipKey = segmentKey(clipSeg, rawName, soundKey(mode, s.soundGainDb ?? 0));
    const status = await segmentStatus(dir, clipSeg, clipKey);
    if (status !== 'ready') {
      if (!hasRaw) throw new Error(`Falta el clip${nn(c.index)} en bruto: regénéralo.`);
      work.push(
        this.queue.runScoped('ffmpeg', 'post', clipSeg.name, async () => {
          const frames = clipSeg.endFrame - clipSeg.startFrame;
          const out = join(dir, `${clipSeg.name}.mp4`);
          const label = await this.renderClipSound(rec, c, mode, raw, frames, soundWav(dir, clipSeg));
          if (status === 'sound') {
            // Solo cambió el sonido (ADR-059): se cambia la pista sin recodificar el video.
            const tmp = join(dir, `${clipSeg.name}.tmp.mp4`);
            await remuxSegmentSound(out, soundWav(dir, clipSeg), frames, FPS, tmp);
            await rename(tmp, out);
            await writeSegmentKey(dir, clipSeg, clipKey);
            this.store.log(rec, `${clipSeg.name}: sonido cambiado · ${label}`);
            return;
          }
          await encodeClipSegment(raw, frames, out, soundWav(dir, clipSeg));
          await writeSegmentKey(dir, clipSeg, clipKey);
          this.store.log(rec, `${clipSeg.name}: ${frames} f · ${label}`);
          const [a, b] = await Promise.all([
            ssimAgainst(out, 0, rec.keyAssets.get(c.index - 1)!.path),
            ssimAgainst(out, 'last', rec.keyAssets.get(c.index)!.path),
          ]);
          this.store.update(rec, () => ((c.ssimStart = a), (c.ssimEnd = b)));
        }),
      );
    }
    if (freezeSeg) {
      const freezeKey = segmentKey(freezeSeg, rawName, '', clipSeg);
      if (!(await segmentReady(dir, freezeSeg, freezeKey))) {
        if (!hasRaw) throw new Error(`Falta el clip${nn(c.index)} en bruto: regénéralo.`);
        work.push(
          this.queue.runScoped('ffmpeg', 'post', freezeSeg.name, async () => {
            // El congelado repite el último frame que muestra el clip (el de su hueco), tomado del clip en bruto.
            const frames = freezeSeg.endFrame - freezeSeg.startFrame;
            const png = join(dir, `${freezeSeg.name}_frame.png`);
            await clipFrame(raw, clipSeg.endFrame - clipSeg.startFrame - 1, png);
            await encodeFreeze(png, frames, join(dir, `${freezeSeg.name}.mp4`));
            await writeSegmentKey(dir, freezeSeg, freezeKey);
            this.store.log(rec, `${freezeSeg.name}: congelado de ${frames} f`);
          }),
        );
      }
    }
    await Promise.all(work);
  }

  /**
   * WAV del sonido de un clip (hito 6, ADR-059) y una etiqueta para el registro:
   * - del modelo: el audio nativo de MiniMax normalizado a MODEL_SOUND_LUFS (± el ajuste del video), con
   *   limitador y fundidos; si el clip no trae sonido, silencio;
   * - sintetizado: los SFX de siempre (ADR-006), colocados en los picos de movimiento;
   * - sin sonido: silencio.
   */
  private async renderClipSound(rec: RunRecord, c: ClipState, mode: SoundMode, raw: string, frames: number, wav: string): Promise<string> {
    const dur = frames / FPS;
    if (mode === 'synth') {
      const curve = (await motionCurve(raw)).slice(0, frames);
      const log = await renderSfx(planSfx(motionPeaks(curve), dur, rec.theme.sfx), dur, wav, 7 + c.index);
      return `SFX ${log.join(' ')}`;
    }
    if (mode === 'model') {
      const lufs = await clipLoudness(raw, dur);
      this.store.update(rec, () => (c.soundLufs = lufs));
      if (lufs !== null) {
        const gain = modelSoundGainDb(lufs, env.MODEL_SOUND_LUFS, env.MODEL_SOUND_MAX_GAIN_DB, rec.state.soundGainDb ?? 0);
        await renderModelSound(raw, dur, gain, wav);
        return `sonido del modelo ${lufs} LUFS → ${gain > 0 ? '+' : ''}${gain} dB`;
      }
      await renderSilence(dur, wav);
      return 'el modelo no trajo sonido: silencio';
    }
    await renderSilence(dur, wav);
    return c.soundMode === 'mute' ? 'silenciado' : 'sin sonido';
  }

  /** Lanza el post de un clip recién llegado sin esperarlo; si falla, el post del final lo repite. */
  private postClipEarly(rec: RunRecord, i: number) {
    if (!rec.plan) return;
    this.postClip(rec, i).catch((e) => {
      if (!(e instanceof PausedError)) this.store.log(rec, `Post de clip${nn(i + 1)}: ${(e as Error).message} (se reintenta al final).`, 'warn');
    });
  }

  /**
   * Post (hito 6, ADR-055/056): espera el post de los clips que ya se lanzó al llegar cada uno, hace lo
   * que falte (solo lo que cambió: otra versión del clip, otro largo u otro sonido) y une el final. Al
   * corregir un clip, rehacer el audio o cambiar la música solo se recodifica lo que cambia.
   */
  private async post(rec: RunRecord) {
    const s = rec.state;
    this.step(rec, 'post', 'Terminando el post de los clips (solo lo que falta)…');
    this.holdEnd(rec);
    for (;;) {
      // Los insertos y los clips que se regeneran por su lado (ADR-091) se esperan para unir un solo final.
      await this.waitInserts(rec);
      const rev = this.insertRev.get(rec) ?? 0;
      await Promise.all(s.clips.map((_, i) => this.postClip(rec, i)));
      const segments = segmentsFor(rec.plan!, (i) => s.clips[i].deliveredFrames!);
      // Insertos (ADR-073): sus segmentos y la composición del final (dónde se corta el video y la voz).
      const comp = this.composition(rec);
      const insertSegs = await this.postInserts(rec, comp);
      const ordered = this.orderSegments(rec, segments, insertSegs, comp);
      await this.savePrompt(rec, 'segmentos.json', JSON.stringify(ordered, null, 2));
      await this.render(rec, ordered, comp);
      this.renderedRev.set(rec, rev);
      // Si un inserto cambió mientras se unía, se vuelve a unir con él (ADR-075).
      if ((this.insertRev.get(rec) ?? 0) === rev && !this.insertJobs.get(rec)?.size) break;
      this.step(rec, 'post', 'Cambiaron los clips o los insertos mientras se unía el final: se vuelve a unir…');
    }
    this.urgent.delete(rec);
    this.finish(rec);
  }

  /**
   * Cierre del video (ADR-157): el último clip se ve entero y queda quieto END_HOLD antes de terminar, aunque la voz
   * termine antes. Los planes nuevos ya lo traen (planTimeline); esto lo aplica a los de antes y con los frames que
   * entregó el clip, en cada unión del final (también al rehacer la locución, cambiar la música o regenerar un clip).
   */
  private holdEnd(rec: RunRecord) {
    const s = rec.state;
    if (!rec.plan?.length) return;
    const last = s.clips[s.clips.length - 1];
    const held = holdLastClip(rec.plan, s.totalFrames ?? 0, last?.deliveredFrames ?? undefined);
    if (held === rec.plan) return;
    const end = held[held.length - 1].slotEndFrame;
    rec.plan = held;
    this.store.update(rec, () => {
      if (last) last.slotEndFrame = end;
    });
    this.store.log(rec, `Cierre: el último clip se ve entero y queda ${(end - (s.totalFrames ?? 0)) > 0 ? `${((end - (s.totalFrames ?? 0)) / FPS).toFixed(2)} s después de la voz` : 'dentro de la voz'} (ADR-157).`);
  }

  /**
   * Final (hito 6, ADR-055): une los segmentos sin recodificar el video y mezcla voz 1.0 · sonido de los
   * clips 0.3 · música 0.1 compensada por su sonoridad (ADR-044). El primer final es final.mp4; cada
   * corrección o cambio de música deja uno nuevo (final_v2.mp4…) y conserva los anteriores.
   */
  private async render(rec: RunRecord, segments: FinalSegment[], comp: Composition) {
    const s = rec.state;
    const m = await this.music.resolve(s.musicTrack);
    if (s.musicTrack && !m) this.store.log(rec, `No se encontró la música «${s.musicTrack}» en la carpeta; el render va sin música.`, 'warn');
    const label = m ? `música «${m.name.replace(/\.[^.]+$/, '')}» ${m.volume}${m.gainDb ? ` (${m.gainDb > 0 ? '+' : ''}${m.gainDb} dB)` : ''}` : 'sin música';
    const modes = new Set(s.clips.map((c) => clipSound(s, c)));
    const sound = [...modes].map((m) => SOUND_LABEL[m]).join(' / ');
    this.step(rec, 'render', `Final: unión sin recodificar · voz 1.0 · sonido ${sound} 0.3 · ${label}…`);
    const dir = join(rec.dir, 'segments');
    let out = join(rec.dir, 'final.mp4');
    for (let v = 2; existsSync(out); v++) out = join(rec.dir, `final_v${v}.mp4`);
    let joinMs = 0;
    const got = await this.queue.runScoped('ffmpeg', 'render', out.split('/').pop()!, async () => {
      const t0 = Date.now();
      // Con insertos, la voz se corta en cada punto de inserción y entra un hueco del largo del inserto.
      let voiceWav = join(rec.dir, 'voice', 'voz_completa.wav');
      if (comp.gaps.length) {
        const withGaps = join(rec.dir, 'voice', 'voz_con_insertos.wav');
        await voiceWithGaps(voiceWav, comp.gaps.map((g) => ({ cutSec: g.cutSec, gapSec: g.frames / FPS })), withGaps);
        voiceWav = withGaps;
      }
      await assembleFinal({
        segments: segments.map((sg) => join(dir, `${sg.name}.mp4`)),
        listFile: join(dir, 'concat.txt'),
        voiceWav,
        sounds: segments.filter((sg) => sg.kind === 'clip' && !sg.upload).map((sg) => ({ wav: join(dir, `${sg.name}_sound.wav`), startFrame: sg.finalStart })),
        overlays: this.insertOverlays(rec, comp, segments),
        music: m?.path,
        musicVolume: m?.volume,
        totalFrames: comp.totalFrames,
        output: out,
      });
      joinMs = Date.now() - t0;
      // Verificación sin decodificar (ADR-057): contar decodificando un final de minutos tardaba más que la unión.
      const start = await videoStartTime(out);
      if (Math.abs(start) > 0.001) this.store.log(rec, `Atención: el video del final empieza en ${start.toFixed(3)} s y no en 0.`, 'warn');
      return countPackets(out);
    });
    await this.writeSubtitles(rec, out);
    const last = this.lastClipAt.get(rec);
    this.lastClipAt.delete(rec);
    this.store.log(
      rec,
      `Final unido en ${(joinMs / 1000).toFixed(1)} s (${out.split('/').pop()})${last ? ` · listo ${((Date.now() - last) / 1000).toFixed(1)} s después del último clip` : ''}.`,
    );
    this.store.update(rec, (st) => {
      st.finalUrl = this.fileUrl(rec, out, Date.now());
      st.finalFrames = got;
    });
  }

  /**
   * Subtítulos del final (hito 6, ADR-061): `final_vN.vtt` y `.srt` junto al MP4, con el texto del video y
   * los tiempos por palabra vigentes. Se rehacen con cada final (rehacer el audio, cambiar la música…).
   */
  private async writeSubtitles(rec: RunRecord, finalPath: string) {
    if (!rec.words?.length) return;
    const cues = finalCues({ paragraphs: rec.state.paragraphs, words: rec.words, voiceFrames: rec.state.totalFrames ?? 0, plan: rec.plan, inserts: rec.state.inserts });
    const base = finalPath.replace(/\.mp4$/, '');
    await writeFile(`${base}.vtt`, toVtt(cues));
    await writeFile(`${base}.srt`, toSrt(cues));
  }

  private finish(rec: RunRecord) {
    const s = rec.state;
    const got = s.finalFrames ?? 0;
    const want = this.composition(rec).totalFrames;
    const hold = videoFrames(rec.plan, s.totalFrames ?? 0) - (s.totalFrames ?? 0);
    const extra = want - (s.totalFrames ?? 0) - hold;
    if (got !== want) this.store.log(rec, `Atención: el final tiene ${got} frames y debía tener ${want}${extra || hold ? ` (voz ${s.totalFrames}${hold ? ` + cierre ${hold}` : ''}${extra ? ` + insertos ${extra}` : ''})` : ''}.`, 'warn');
    const parts = [hold ? `${(hold / FPS).toFixed(1)} s de cierre tras la voz` : '', extra ? `${(extra / FPS).toFixed(1)} s de insertos` : ''].filter(Boolean);
    this.step(rec, 'done', `Video listo: ${(got / FPS).toFixed(3)} s (${got} frames), ${parts.length ? `la locución más ${parts.join(' y ')}` : 'igual que la locución'}.`);
  }

  /**
   * Cambiar la música de un video terminado (hito 5, ADR-044): solo se vuelve a renderizar, sin costo de
   * proveedores, y queda un final nuevo (final_vN.mp4). Si faltara algún segmento, se rehace el post
   * (SFX, normalización y congelados, también solo con ffmpeg).
   */
  /**
   * Volver a unir el final sin cambiar nada (ADR-158): para aplicar a un video terminado una corrección del montaje
   * (p. ej. el cierre de ADR-157) sin costo. Solo ffmpeg: se rehacen los segmentos que cambian y queda un final_vN.mp4.
   */
  rejoin(rec: RunRecord) {
    const s = rec.state;
    if (rec.busy) throw new Error('La generación está trabajando.');
    if (s.status !== 'done' || !rec.approved || !rec.plan) throw new Error('Solo se vuelve a unir un video terminado.');
    this.store.log(rec, 'Volver a unir el final (solo ffmpeg, sin costo).');
    this.guard(rec, async () => {
      await this.post(rec);
    });
  }

  changeMusic(rec: RunRecord, track: string | null) {
    const s = rec.state;
    if (rec.busy) throw new Error('La generación está trabajando.');
    if (s.status !== 'done' || !rec.approved || !rec.plan) throw new Error('Solo se cambia la música de un video terminado.');
    if (track && !this.music.pathOf(track)) throw new Error(`El track «${track}» no está en la carpeta de música.`);
    if ((s.musicTrack ?? null) === track) throw new Error('El video ya tiene esa música.');
    const before = s.musicTrack ?? null;
    this.store.update(rec, (st) => (st.musicTrack = track));
    this.store.log(rec, `Música: ${before ?? 'sin música'} → ${track ?? 'sin música'} (solo se vuelve a renderizar).`);
    this.guard(rec, async () => {
      // Solo se une de nuevo: los segmentos que ya están hechos se reutilizan (los de antes del hito 6 se
      // rehacen una vez, solo con ffmpeg).
      await this.post(rec);
    });
  }
  /**
   * Sonido de un video terminado (hito 6, ADR-059): del modelo, sintetizado o sin sonido, y el ajuste del
   * sonido del modelo en dB. Solo ffmpeg: se rehacen los WAV de los clips afectados, se cambia la pista de
   * sus segmentos sin recodificar el video y se une el final (final_vN.mp4).
   */
  changeSound(rec: RunRecord, o: { mode?: SoundMode; gainDb?: number }) {
    const s = rec.state;
    this.assertDone(rec);
    const mode = o.mode ?? s.soundMode ?? 'synth';
    const gain = o.gainDb ?? s.soundGainDb ?? 0;
    if (mode === (s.soundMode ?? 'synth') && gain === (s.soundGainDb ?? 0)) throw new Error('El video ya tiene ese sonido.');
    const label = (m: SoundMode, g: number) => `${SOUND_LABEL[m]}${m === 'model' && g ? ` ${g > 0 ? '+' : ''}${g} dB` : ''}`;
    this.store.log(rec, `Sonido: ${label(s.soundMode ?? 'synth', s.soundGainDb ?? 0)} → ${label(mode, gain)} (solo ffmpeg).`);
    this.store.update(rec, (st) => ((st.soundMode = mode), (st.soundGainDb = gain || undefined)));
    this.guard(rec, () => this.post(rec));
  }

  /**
   * Sonido de un clip de un video terminado (ADR-059): 'mute' (silenciar), 'synth' (SFX sintetizados) o
   * null (el del video). Para un clip cuyo sonido trae música o habla, sin regenerarlo: solo ffmpeg.
   */
  changeClipSound(rec: RunRecord, index: number, mode: ClipSoundMode | null) {
    const c = rec.state.clips.find((x) => x.index === index);
    if (!c) throw new Error(`No existe el clip ${nn(index)}.`);
    this.assertDone(rec);
    if ((c.soundMode ?? null) === mode) throw new Error('El clip ya tiene ese sonido.');
    const label = (m: ClipSoundMode | null) => (m === 'mute' ? 'silenciado' : m === 'synth' ? 'sintetizado' : 'el del video');
    this.store.log(rec, `clip${nn(index)}: sonido ${label(c.soundMode ?? null)} → ${label(mode)} (solo ffmpeg).`);
    this.store.update(rec, () => (c.soundMode = mode ?? undefined));
    this.guard(rec, () => this.post(rec));
  }

  private assertDone(rec: RunRecord) {
    if (rec.busy) throw new Error('La generación está trabajando.');
    if (rec.state.status !== 'done' || !rec.approved || !rec.plan) throw new Error('Solo se cambia el sonido de un video terminado.');
  }

}

export { toApiSchema };
export type { Shot };
