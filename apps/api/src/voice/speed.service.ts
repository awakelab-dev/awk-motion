import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '@wilox/db';
import { clampSpeed, FPS, VOICE_SAMPLE_TEXT, type AuthUser, type ProjectVoice, type SpeedBatchResponse, type SpeedCandidate, type ToV4Response, type ToV4Status, type VoiceModel } from '@wilox/shared';
import { AccessService } from '../access/access.service.js';
import { env, repoPath } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { DeliveryService } from '../delivery/delivery.service.js';
import { RunStore } from '../generations/run-store.js';
import { stretchAudio, toWav48k } from '../media/ffmpeg.js';
import { PipelineService } from '../pipeline/pipeline.service.js';
import { PROVIDERS, type Providers } from '../providers/ports.js';
import { PublicationsService } from '../publications/publications.service.js';
import { TrashService } from '../trash/trash.service.js';
import { projectSeed, voiceOf } from './project-voice.js';
import { sameSpeed, speedText } from './speed.js';

/**
 * Voz del proyecto (hito 13a): la velocidad de la narración (T2, ADR-178: la del proyecto para los videos nuevos, la
 * muestra para elegirla y «Cambiar velocidad» de uno o varios videos ya hechos, sin pedir voz ni clips) y «Pasar a v4»
 * un proyecto en v3 (T3, ADR-179).
 */
@Injectable()
export class SpeedService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Voz');
  private readonly samples = new Map<string, Promise<string>>();
  /**
   * Videos que esperan para pasar a v4 (T3, decisión A: encolados detrás de lo que estén haciendo, sin bloquear): se
   * revisan cada 20 s y pasan en cuanto se puede. Solo en memoria: tras un reinicio, «Pasar los que faltan» del
   * proyecto los vuelve a poner (así un video que falla no se cobra una y otra vez sin que nadie lo pida).
   */
  private readonly pendingV4 = new Map<string, { projectId: string; seed: number; speed: number }>();
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly store: RunStore,
    private readonly pipeline: PipelineService,
    private readonly delivery: DeliveryService,
    private readonly publications: PublicationsService,
    private readonly trash: TrashService,
    private readonly access: AccessService,
    @Inject(PROVIDERS) private readonly providers: Providers,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tickV4(), 20_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ─── Pasar a v4 (T3, ADR-179) ───────────────────────────────────────────────────────────────────────

  /** Videos del proyecto que siguen en v3 (los del modo en que corre la API), en orden de creación. */
  private async v3Videos(projectId: string) {
    const rows = await this.db.generation.findMany({
      where: { projectId, trashedAt: null, deletedAt: null, mode: this.providers.mode },
      select: { id: true, text: true, voiceModel: true, paragraphs: { select: { text: true, spokenText: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.filter((g) => !this.trash.isHidden(g.id) && (this.store.peek(g.id) ? this.store.peek(g.id)!.state.voiceModel : g.voiceModel) !== 'v4');
  }

  /** Lo que costaría y qué videos esperarían si se pasa el proyecto a v4 ahora. */
  async v4Status(projectId: string, user: AuthUser): Promise<ToV4Status> {
    const access = await this.access.project(projectId, user);
    const p = await this.db.project.findUnique({ where: { id: projectId }, select: { voiceModel: true, voiceSpeed: true } });
    if (!p) throw new NotFoundException('Proyecto no encontrado.');
    const list = await this.v3Videos(projectId);
    const published = await this.publications.publishedUses(list.map((g) => g.id));
    const waiting: ToV4Status['waiting'] = [];
    for (const g of list) {
      const rec = await this.store.get(g.id);
      const why = this.pendingV4.has(g.id) ? 'Esperando su turno para pasar a v4.' : rec ? this.pipeline.revoiceBlocked(rec) : 'No se encontró.';
      if (why) waiting.push({ id: g.id, title: this.delivery.videoTitle(g.text), reason: why });
    }
    return {
      model: voiceOf(p).model,
      v3Videos: list.length,
      chars: list.reduce((n, g) => n + g.paragraphs.reduce((m, x) => m + (x.spokenText ?? x.text).length, 0), 0),
      published: published.size,
      waiting,
      canConvert: access.role === 'owner' && this.providers.mode !== 'mcp',
    };
  }

  /**
   * Pasa el proyecto a v4 (solo el dueño; irreversible): el proyecto queda en v4 a la velocidad elegida y la locución de
   * todos sus videos en v3 se rehace en v4 por párrafo (en la cola, como «Rehacer la locución» de varios). Los que ahora
   * no se pueden (clips en curso, aún sin terminar) esperan y pasan solos después. Con el proyecto ya en v4, pasa los que
   * falten.
   */
  async toV4(projectId: string, user: AuthUser, speed: number, confirmed: boolean): Promise<ToV4Response> {
    const access = await this.access.project(projectId, user);
    this.access.requireOwner(access.role, 'voice-v4');
    if (this.providers.mode === 'mcp') throw new BadRequestException('La voz v4 usa la API de ElevenLabs (modo API).');
    const sp = clampSpeed(speed);
    const list = await this.v3Videos(projectId);
    const published = await this.publications.publishedUses(list.map((g) => g.id));
    if (published.size && !confirmed)
      throw new ConflictException({
        code: 'confirm',
        title: published.size === 1 ? 'Hay un video publicado' : `Hay ${published.size} videos publicados`,
        message: `${published.size === 1 ? 'Uno de los videos está publicado' : `${published.size} de los videos están publicados`}. Al pasarlos a v4, quienes los ven —el curso del cliente— oirán la voz nueva en cuanto termine cada uno.`,
        action: 'Pasar a v4 de todos modos',
      });
    const seed = await projectSeed(this.db, projectId);
    const p = await this.db.project.update({ where: { id: projectId }, data: { voiceModel: 'v4', voiceSpeed: sp }, select: { voiceModel: true, voiceSpeed: true } });
    const out: ToV4Response = { started: [], waiting: [], voice: voiceOf(p) };
    for (const g of list) {
      const title = this.delivery.videoTitle(g.text);
      const rec = await this.store.get(g.id);
      if (!rec) continue;
      const why = this.pipeline.revoiceBlocked(rec);
      if (why) {
        this.pendingV4.set(g.id, { projectId, seed, speed: sp });
        out.waiting.push({ id: g.id, title, reason: why });
        continue;
      }
      try {
        this.pipeline.toV4(rec, seed, sp);
        this.store.log(rec, `Pasar a v4 desde el proyecto (velocidad ${speedText(sp)}).`);
        out.started.push(g.id);
      } catch (e) {
        this.pendingV4.set(g.id, { projectId, seed, speed: sp });
        out.waiting.push({ id: g.id, title, reason: (e as Error).message });
      }
    }
    this.logger.log(`Proyecto ${projectId} en v4 a ${speedText(sp)}: ${out.started.length} video(s) en marcha, ${out.waiting.length} esperando.`);
    return out;
  }

  /** Los que esperaban pasan a v4 en cuanto terminan lo que estaban haciendo. */
  private async tickV4() {
    for (const [id, w] of [...this.pendingV4]) {
      try {
        const rec = await this.store.get(id);
        if (!rec || rec.state.voiceModel === 'v4' || rec.projectId !== w.projectId || this.trash.isHidden(id)) {
          this.pendingV4.delete(id);
          continue;
        }
        if (this.pipeline.revoiceBlocked(rec)) continue;
        this.pendingV4.delete(id);
        this.pipeline.toV4(rec, w.seed, w.speed);
        this.store.log(rec, `Pasar a v4: le tocaba su turno (velocidad ${speedText(w.speed)}).`);
      } catch (e) {
        this.pendingV4.delete(id);
        this.logger.warn(`No se pudo pasar ${id} a v4: ${(e as Error).message}`);
      }
    }
  }

  /** Cambia la velocidad del proyecto: vale para sus videos nuevos (los hechos se cambian con «Cambiar velocidad»). */
  async setProjectSpeed(projectId: string, speed: number): Promise<ProjectVoice> {
    const v = clampSpeed(speed);
    const p = await this.db.project.update({ where: { id: projectId }, data: { voiceSpeed: v }, select: { voiceModel: true, voiceSpeed: true } }).catch(() => undefined);
    if (!p) throw new NotFoundException('Proyecto no encontrado.');
    return voiceOf(p);
  }

  /**
   * Muestra de la voz a una velocidad: una frase fija pedida una sola vez por voz y versión (se guarda en
   * `storage/muestras-voz/`) y estirada a la velocidad elegida (también guardada). Devuelve la ruta del WAV.
   */
  async sample(voiceId: string | undefined, model: VoiceModel, speed: number): Promise<string> {
    const voice = voiceId || this.providers.defaultVoiceId();
    if (!voice) throw new BadRequestException('No hay una voz por defecto: elige una voz.');
    const v4 = model === 'v4' && this.providers.mode !== 'mcp';
    const sp = clampSpeed(speed);
    const dir = join(repoPath(env.STORAGE_DIR), 'muestras-voz');
    const base = join(dir, `${voice.replace(/[^\w-]/g, '_')}_${v4 ? 'v4' : 'v3'}_${this.providers.mode}`);
    const raw = `${base}.48k.wav`;
    const out = sameSpeed(sp) ? raw : `${base}_x${Math.round(sp * 100)}.wav`;
    if (existsSync(out)) return out;
    const key = out;
    let p = this.samples.get(key);
    if (!p) {
      p = (async () => {
        await mkdir(dir, { recursive: true });
        if (!existsSync(raw)) {
          const a = await this.providers.tts.synthesize(VOICE_SAMPLE_TEXT, voice, `${base}_recibida`, v4 ? { model: env.ELEVENLABS_V4_MODEL, seed: 1 } : undefined);
          await toWav48k(a.path, `${raw}.tmp.wav`);
          await rename(`${raw}.tmp.wav`, raw);
          this.logger.log(`Muestra de voz ${voice} (${v4 ? 'v4' : 'v3'}) pedida una vez y guardada.`);
        }
        if (out !== raw) {
          await stretchAudio(raw, sp, `${out}.tmp.wav`);
          await rename(`${out}.tmp.wav`, out);
        }
        return out;
      })().finally(() => this.samples.delete(key));
      this.samples.set(key, p);
    }
    return p;
  }

  /** «Cambiar velocidad» de un video (con el aviso de siempre si está publicado). */
  async changeVideo(id: string, userId: string, speed: number, confirmed: boolean) {
    const rec = await this.store.get(id);
    if (!rec) throw new NotFoundException('Video no encontrado.');
    const why = this.pipeline.speedBlocked(rec);
    if (why) throw new BadRequestException(why);
    await this.publications.guardVideo(id, userId, confirmed);
    try {
      this.pipeline.changeSpeed(rec, clampSpeed(speed));
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    return rec.state;
  }

  /** Videos del proyecto, en orden de creación, con su velocidad y si se puede cambiar ahora. */
  async candidates(projectId: string): Promise<SpeedCandidate[]> {
    if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new NotFoundException('Proyecto no encontrado.');
    const project = await this.db.project.findFirst({ where: { id: projectId, deletedAt: null }, select: { id: true } });
    if (!project) throw new NotFoundException('Proyecto no encontrado.');
    const rows = await this.db.generation.findMany({
      where: { projectId, trashedAt: null, deletedAt: null },
      select: { id: true, text: true, createdAt: true, status: true, approved: true, mode: true, voiceModel: true, voiceSpeed: true, finalFrames: true, totalFrames: true, durationSec: true },
      orderBy: { createdAt: 'asc' },
    });
    const visible = rows.filter((g) => !this.trash.isHidden(g.id));
    const published = await this.publications.publishedUses(visible.map((g) => g.id));
    return visible.map((g) => {
      const live = this.store.peek(g.id);
      const status = live?.state.status ?? g.status;
      const approved = live?.approved ?? g.approved;
      const reason =
        g.mode === 'mcp' || this.providers.mode === 'mcp'
          ? 'Solo en modo API.'
          : g.mode !== this.providers.mode
            ? `Video del modo ${g.mode.toUpperCase()}; la API corre en ${this.providers.mode.toUpperCase()}.`
            : live?.busy
              ? 'Está trabajando.'
              : status !== 'awaiting_approval' && (status !== 'done' || !approved)
                ? 'Aún no está terminado.'
                : undefined;
      return {
        id: g.id,
        title: this.delivery.videoTitle(g.text),
        createdAt: g.createdAt.toISOString(),
        durationSec: live?.state.durationSec ?? g.durationSec ?? (g.finalFrames ?? g.totalFrames ?? 0) / FPS,
        speed: (live ? live.state.voiceSpeed : g.voiceSpeed) ?? 1,
        voiceModel: (live ? live.state.voiceModel : g.voiceModel) === 'v4' ? 'v4' : 'v3',
        published: published.has(g.id),
        available: !reason,
        ...(reason ? { reason } : {}),
      };
    });
  }

  /** Arranca los marcados (sin costo). Si alguno está publicado, primero una sola confirmación para todos. */
  async start(projectId: string, ids: string[], speed: number, confirmed: boolean): Promise<SpeedBatchResponse> {
    const sp = clampSpeed(speed);
    const wanted = new Set(ids);
    const chosen = (await this.candidates(projectId)).filter((c) => wanted.has(c.id));
    if (!chosen.length) throw new BadRequestException('Marca al menos un video del proyecto.');
    const pub = chosen.filter((c) => c.available && c.published && !sameSpeed(c.speed / sp));
    if (pub.length && !confirmed)
      throw new ConflictException({
        code: 'confirm',
        title: pub.length === 1 ? 'Hay un video publicado' : `Hay ${pub.length} videos publicados`,
        message: `${pub.length === 1 ? 'Uno de los videos marcados está publicado' : `${pub.length} de los videos marcados están publicados`}. Si cambias su velocidad, quienes los ven —el curso del cliente— verán la nueva versión en unos minutos.`,
        action: 'Cambiar de todos modos',
      });
    const out: SpeedBatchResponse = { started: [], skipped: [] };
    for (const c of chosen) {
      if (!c.available) {
        out.skipped.push({ id: c.id, title: c.title, reason: c.reason ?? 'No se puede ahora.' });
        continue;
      }
      if (sameSpeed(c.speed / sp)) {
        out.skipped.push({ id: c.id, title: c.title, reason: `Ya está a ${speedText(sp)}.` });
        continue;
      }
      try {
        const rec = await this.store.get(c.id);
        if (!rec || rec.projectId !== projectId) throw new Error('Video no encontrado.');
        this.pipeline.changeSpeed(rec, sp);
        this.store.log(rec, `Cambiar velocidad a ${speedText(sp)} desde el proyecto (varios videos a la vez).`);
        out.started.push(c.id);
      } catch (e) {
        out.skipped.push({ id: c.id, title: c.title, reason: (e as Error).message });
      }
    }
    return out;
  }
}
