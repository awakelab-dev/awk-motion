import { basename } from 'node:path';
import { recordJob, type JobKind, type JobRecord } from '../jobs/job-scope.js';
import type { ImagePort, LlmPort, Providers, TimingPort, TtsPort, VideoPort } from './ports.js';

/** Proveedor, modelo y precio de cada puerto (lo que se anota en GenerationJob). */
export interface PortInfo {
  provider: string;
  model: string;
  /** Créditos de Higgsfield por trabajo (fijos o según el uso, p. ej. la locución por caracteres). */
  credits?: number | ((usage: Record<string, unknown>) => number | undefined);
  /** USD por trabajo (o calculado a partir del uso). */
  costUsd?: number | ((usage: Record<string, unknown>) => number | undefined);
}

export interface InstrumentInfo {
  tts: PortInfo;
  /** Sin timing: los tiempos salen de la misma llamada de voz (no se anota aparte). */
  timing?: PortInfo;
  image: PortInfo;
  video: PortInfo;
  llm: PortInfo;
  /** USD por crédito (para dar también el costo en USD de los trabajos de Higgsfield). */
  creditUsd?: number;
}

const stem = (p: string) => basename(p).replace(/\.[^.]+$/, '');
const round = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 1e6) / 1e6);

function job(kind: JobKind, info: PortInfo, creditUsd: number | undefined, target: string, startedAt: Date, extra: Partial<JobRecord>): JobRecord {
  const usage = extra.usage ?? {};
  const costFromUsage = typeof info.costUsd === 'function' ? info.costUsd(usage) : info.costUsd;
  const credits = extra.credits ?? (typeof info.credits === 'function' ? info.credits(usage) : info.credits);
  const costUsd = extra.costUsd ?? costFromUsage ?? (credits !== undefined && creditUsd !== undefined ? credits * creditUsd : undefined);
  return { kind, target, provider: info.provider, model: info.model, startedAt, finishedAt: new Date(), ...extra, credits, costUsd: round(costUsd), usage: extra.usage };
}

/**
 * Envuelve los puertos para anotar cada trabajo (hito 3, ADR-031) sin tocar el pipeline ni los
 * proveedores: una locución, un tiempo por palabra, una imagen, un clip o una llamada a Opus = una fila.
 */
export function instrument(p: Providers, info: InstrumentInfo): Providers {
  const c = info.creditUsd;
  const tts: TtsPort = {
    listVoices: () => p.tts.listVoices(),
    async synthesize(text, voiceId, outBase, opts) {
      const t0 = new Date();
      const usage = { characters: text.length, voiceId };
      // Otro modelo (prueba de voz, ADR-129): se anota el que se usó.
      const model = opts?.model ? { model: opts.model } : {};
      try {
        const r = await p.tts.synthesize(text, voiceId, outBase, opts);
        recordJob(job('tts', info.tts, c, stem(outBase), t0, { ...model, externalId: r.jobId, usage: { ...usage, ...(r.usage ?? {}) }, url: r.remoteUrl }));
        return r;
      } catch (e) {
        recordJob(job('tts', info.tts, c, stem(outBase), t0, { ...model, usage, error: (e as Error).message }));
        throw e;
      }
    },
  };
  const timing: TimingPort = {
    async wordTimes(words, audio, dur) {
      if (!info.timing) return p.timing.wordTimes(words, audio, dur);
      const t0 = new Date();
      const usage = { words: words.length, seconds: dur };
      try {
        const r = await p.timing.wordTimes(words, audio, dur);
        recordJob(job('timing', info.timing, c, stem(audio.path), t0, { usage }));
        return r;
      } catch (e) {
        recordJob(job('timing', info.timing, c, stem(audio.path), t0, { usage, error: (e as Error).message }));
        throw e;
      }
    },
  };
  const images: ImagePort = {
    async generate(requests, onItem) {
      const t0 = new Date();
      const byKey = new Map(requests.map((r) => [r.key, r]));
      const seen = new Set<string>();
      const note = (r: { key: string; path?: string; ref?: string; error?: string; usage?: Record<string, unknown> }) => {
        const req = byKey.get(r.key);
        if (!req || seen.has(r.key)) return;
        seen.add(r.key);
        const externalId = r.ref && !r.ref.startsWith('/') && !/^[A-Za-z]:\\/.test(r.ref) ? r.ref : undefined;
        const usage = { ...(r.usage ?? {}), promptChars: req.prompt.length, references: req.references?.length ?? 0 };
        recordJob(job('image', info.image, c, stem(req.outBase), t0, { externalId, usage, error: r.path ? undefined : (r.error ?? 'sin resultado') }));
      };
      const out = await p.images.generate(requests, async (r) => {
        note(r);
        await onItem?.(r);
      });
      out.forEach(note);
      return out;
    },
  };
  const video: VideoPort = {
    async generate(requests, onItem) {
      const t0 = new Date();
      const byKey = new Map(requests.map((r) => [r.key, r]));
      const seen = new Set<string>();
      const note = (r: { key: string; path?: string; error?: string; jobId?: string; usage?: Record<string, unknown> }) => {
        const req = byKey.get(r.key);
        if (!req || seen.has(r.key)) return;
        seen.add(r.key);
        recordJob(
          job('video', info.video, c, stem(req.outPath), t0, { externalId: r.jobId, usage: { promptChars: req.prompt.length, ...(r.usage ?? {}) }, error: r.path ? undefined : (r.error ?? 'sin resultado') }),
        );
      };
      const out = await p.video.generate(requests, async (r) => {
        note(r);
        await onItem?.(r);
      });
      out.forEach(note);
      return out;
    },
  };
  const llm: LlmPort = {
    async structured(system, user, schema, meta) {
      const t0 = new Date();
      let usage: Record<string, unknown> = {};
      let id: string | undefined;
      const target = meta?.label ?? 'Opus';
      try {
        const r = await p.llm.structured(system, user, schema, {
          ...meta,
          onUsage: (u) => {
            id = u.id;
            usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens };
            meta?.onUsage?.(u);
          },
        });
        recordJob(job('llm', info.llm, c, target, t0, { externalId: id, usage }));
        return r;
      } catch (e) {
        recordJob(job('llm', info.llm, c, target, t0, { externalId: id, usage, error: (e as Error).message }));
        throw e;
      }
    },
  };
  return { ...p, tts, timing, images, video, llm };
}
