import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '@wilox/db';
import { clampSpeed, FPS, VOICE_SAMPLE_TEXT, type ProjectVoice, type SpeedBatchResponse, type SpeedCandidate, type VoiceModel } from '@wilox/shared';
import { env, repoPath } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { DeliveryService } from '../delivery/delivery.service.js';
import { RunStore } from '../generations/run-store.js';
import { stretchAudio, toWav48k } from '../media/ffmpeg.js';
import { PipelineService } from '../pipeline/pipeline.service.js';
import { PROVIDERS, type Providers } from '../providers/ports.js';
import { PublicationsService } from '../publications/publications.service.js';
import { TrashService } from '../trash/trash.service.js';
import { voiceOf } from './project-voice.js';
import { sameSpeed, speedText } from './speed.js';

/**
 * Velocidad de la narración (hito 13a, T2, ADR-178): la del proyecto (para los videos nuevos), la muestra para elegirla y
 * «Cambiar velocidad» de uno o varios videos ya hechos (sin pedir voz ni clips).
 */
@Injectable()
export class SpeedService {
  private readonly logger = new Logger('Velocidad');
  private readonly samples = new Map<string, Promise<string>>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly store: RunStore,
    private readonly pipeline: PipelineService,
    private readonly delivery: DeliveryService,
    private readonly publications: PublicationsService,
    private readonly trash: TrashService,
    @Inject(PROVIDERS) private readonly providers: Providers,
  ) {}

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
