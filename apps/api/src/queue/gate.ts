import { basename } from 'node:path';
import type { ImageResult, Providers, VideoResult } from '../providers/ports.js';
import type { QueueService, Resource } from './queue.service.js';
import { transientInfo } from './transient.js';

/** Recurso de la cola de cada puerto según el modo (sin recurso, el puerto no pasa por la cola). */
export interface GateResources {
  tts?: Resource;
  timing?: Resource;
  image?: Resource;
  video?: Resource;
  llm?: Resource;
  /** Los clips de este recurso se pueden retomar por su task_id tras un reinicio. */
  videoResumable?: boolean;
}

export function gateResources(mode: Providers['mode']): GateResources {
  if (mode === 'mcp') return { tts: 'higgsfield', timing: 'higgsfield', image: 'higgsfield', video: 'higgsfield', llm: 'anthropic' };
  // API y mock usan los mismos recursos (el mock sirve para probar la cola sin gastar).
  return { tts: 'elevenlabs', image: 'openai', video: 'minimax', llm: 'anthropic', videoResumable: true };
}

const stem = (p: string) => basename(p).replace(/\.[^.]+$/, '');

/** Error que lleva el resultado fallido de un puerto que no lanza (imágenes, clips) para reintentarlo. */
class ResultError extends Error {}

/**
 * Pasa cada llamada a un proveedor por la cola global (hito 5, ADR-045), con la prioridad del ámbito
 * actual (video o Estudio). Las imágenes y los clips se piden de a uno, así cada uno ocupa su hueco
 * del recurso y compite por prioridad con los de los demás videos.
 */
export function gate(p: Providers, q: QueueService, res: GateResources = gateResources(p.mode)): Providers {
  return {
    ...p,
    tts: {
      listVoices: () => p.tts.listVoices(),
      synthesize: (text, voiceId, outBase, opts) => q.runScoped(res.tts, 'tts', stem(outBase), () => p.tts.synthesize(text, voiceId, outBase, opts)),
    },
    timing: {
      wordTimes: (words, audio, dur) => q.runScoped(res.timing, 'timing', stem(audio.path), () => p.timing.wordTimes(words, audio, dur)),
    },
    llm: {
      structured: (system, user, schema, meta) => q.runScoped(res.llm, 'llm', meta?.label ?? 'Opus', () => p.llm.structured(system, user, schema, meta)),
    },
    images: {
      generate: (requests, onItem) =>
        Promise.all(
          requests.map(async (req) => {
            let r: ImageResult;
            try {
              r = await q.runScoped(res.image, 'image', stem(req.outBase), async () => {
                const [x] = await p.images.generate([req]);
                if (!x) throw new Error('El proveedor no devolvió la imagen.');
                if (x.error && transientInfo(x.error)) throw new ResultError(x.error);
                return x;
              });
            } catch (e) {
              r = { key: req.key, error: (e as Error).message };
            }
            await onItem?.(r);
            return r;
          }),
        ),
    },
    video: {
      generate: (requests, onItem) =>
        Promise.all(
          requests.map(async (req) => {
            let r: VideoResult;
            // Si el clip ya se envió (task_id), un reintento lo sigue consultando en vez de pedirlo otra vez.
            let submitted = req.resumeTaskId;
            try {
              r = await q.runScoped(
                res.video,
                'video',
                stem(req.outPath),
                async (task) => {
                  const [x] = await p.video.generate([
                    {
                      ...req,
                      resumeTaskId: submitted,
                      onSubmitted: async (id) => {
                        submitted = id;
                        await task.setExternalId(id);
                        await req.onSubmitted?.(id);
                      },
                    },
                  ]);
                  if (!x) throw new Error('El proveedor no devolvió el clip.');
                  if (x.error && transientInfo(x.error)) throw new ResultError(x.error);
                  return x;
                },
                { resumable: !!res.videoResumable },
              );
            } catch (e) {
              r = { key: req.key, error: (e as Error).message };
            }
            await onItem?.(r);
            return r;
          }),
        ),
    },
  };
}
