import type { VoiceOption } from '@wilox/shared';
import { alignWords, type WordTime } from '../../pipeline/align.js';
import { download, sleep } from '../http.js';
import type {
  ImagePort,
  ImageRequest,
  ImageResult,
  OnItem,
  TimingPort,
  TtsPort,
  TtsResult,
  VideoPort,
  VideoRequest,
  VideoResult,
} from '../ports.js';
import type { HiggsfieldClient } from './higgsfield-client.js';

interface BatchJob {
  index: number;
  job_id?: string;
  status?: string;
  error?: string;
}
interface WaitJob {
  index: number;
  job_id: string;
  status: string;
  result_url?: string;
  error?: string;
}

const TERMINAL_OK = new Set(['completed', 'succeeded', 'success']);
const TERMINAL_BAD = new Set(['failed', 'error', 'cancelled', 'canceled', 'nsfw', 'rejected']);

export interface HiggsfieldConfig {
  declinedPresetId: string;
  imageResolution: string;
  imageQuality: string;
  imageVariant: string;
  whisperModel: string;
  clipSeconds: number;
}

/** Operaciones comunes: enviar lotes de ≤12, esperar con jobs_wait y descargar. */
class Jobs {
  constructor(private hf: HiggsfieldClient) {}

  /**
   * Envía en lotes de ≤12. Si Higgsfield "recomienda un preset" en lugar de crear el trabajo, pide
   * reenviar ese índice con un declined_preset_id nuevo (cambia según el prompt, p. ej. "DROWN IN MUSIC"):
   * se reenvían solo esos índices con el id que indica, hasta 3 veces. Un envío rechazado no gasta créditos.
   */
  async submit(tool: string, params: Record<string, unknown>[]): Promise<BatchJob[]> {
    const out: BatchJob[] = [];
    for (let i = 0; i < params.length; i += 12) {
      let pending = params.slice(i, i + 12).map((p, k) => ({ index: i + k, params: { ...p, use_unlim: false } as Record<string, unknown> }));
      for (let round = 0; round < 4 && pending.length; round++) {
        let jobs: BatchJob[] = [];
        let raw = '';
        try {
          const r = await this.hf.call<{ jobs?: BatchJob[]; errors?: BatchJob[]; failed?: BatchJob[] }>(tool, { requests: pending }, 180_000);
          jobs = [...(r.jobs ?? []), ...(r.errors ?? []), ...(r.failed ?? [])];
          raw = JSON.stringify(r);
        } catch (e) {
          // Si ningún trabajo entra, el conector responde con error ("Submitted 0/N"): se analiza igual.
          raw = (e as Error).message;
        }
        const retry: typeof pending = [];
        for (const req of pending) {
          const j = jobs.find((x) => x.index === req.index);
          if (j?.job_id) {
            out.push(j);
            continue;
          }
          const declined = declinedPresetFor(req.index, j, raw);
          if (declined && round < 3 && declined !== req.params.declined_preset_id) {
            retry.push({ index: req.index, params: { ...req.params, declined_preset_id: declined } });
            continue;
          }
          out.push({ index: req.index, error: j?.error ?? `Higgsfield no aceptó el trabajo: ${raw.slice(0, 400)}` });
        }
        pending = retry;
      }
    }
    return out.sort((a, b) => a.index - b.index);
  }

  /** Espera trabajos (long-poll de 15 s) y llama a onDone en cuanto cada uno termina. */
  async waitAll(jobs: { index: number; job_id: string }[], maxMs: number, onDone: (j: WaitJob) => Promise<void>) {
    const pending = new Map(jobs.map((j) => [j.job_id, j]));
    const deadline = Date.now() + maxMs;
    while (pending.size && Date.now() < deadline) {
      const group = [...pending.values()].slice(0, 12);
      let r: { jobs?: WaitJob[]; poll_after_seconds?: number };
      try {
        r = await this.hf.call('jobs_wait', { jobs: group, timeout_seconds: 15 }, 60_000);
      } catch {
        await sleep(5000);
        continue;
      }
      for (const j of r.jobs ?? []) {
        const st = (j.status ?? '').toLowerCase();
        if (TERMINAL_OK.has(st) || TERMINAL_BAD.has(st)) {
          pending.delete(j.job_id);
          await onDone(j);
        }
      }
      if (pending.size && r.poll_after_seconds) await sleep(Math.min(10, r.poll_after_seconds) * 1000);
    }
    for (const j of pending.values()) await onDone({ ...j, status: 'failed', error: 'Tiempo de espera agotado' });
  }

  static ok(j: WaitJob) {
    return TERMINAL_OK.has((j.status ?? '').toLowerCase()) && !!j.result_url;
  }
}

export class HiggsfieldTts implements TtsPort, TimingPort {
  private jobs: Jobs;
  constructor(
    private hf: HiggsfieldClient,
    private cfg: HiggsfieldConfig,
  ) {
    this.jobs = new Jobs(hf);
  }

  async listVoices(): Promise<VoiceOption[]> {
    const out: VoiceOption[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r = await this.hf.call<{
        voices: { voice_id: string; voice_type: string; name: string; gender?: string | null; preview_url?: string }[];
        has_more?: boolean;
        next_cursor?: string;
      }>('list_voices', { size: 100, ...(cursor ? { cursor } : {}) });
      for (const v of r.voices ?? [])
        out.push({ id: v.voice_id, name: v.name, type: v.voice_type, previewUrl: v.preview_url, description: v.gender ?? undefined });
      if (!r.has_more || !r.next_cursor) break;
      cursor = r.next_cursor;
    }
    return out;
  }

  private voiceType = new Map<string, string>();

  async synthesize(text: string, voiceId: string, outBase: string): Promise<TtsResult> {
    if (!this.voiceType.size) (await this.listVoices()).forEach((v) => this.voiceType.set(v.id, v.type ?? 'preset'));
    const voice_type = this.voiceType.get(voiceId) ?? 'element';
    const [job] = await this.jobs.submit('generate_audio_batch', [
      { model: 'text2speech_v2', variant: 'elevenlabs', prompt: text, voice_type, voice_id: voiceId },
    ]);
    if (!job.job_id) throw new Error(job.error ?? 'Higgsfield no creó el trabajo de voz.');
    let result: WaitJob | undefined;
    await this.jobs.waitAll([{ index: 0, job_id: job.job_id }], 10 * 60_000, async (j) => {
      result = j;
    });
    if (!result || !Jobs.ok(result)) throw new Error(`TTS falló: ${result?.error ?? result?.status}`);
    const ext = result.result_url!.split('?')[0].split('.').pop() || 'mp3';
    const path = `${outBase}.${ext}`;
    await download(result.result_url!, path);
    return { path, remoteUrl: result.result_url, jobId: job.job_id };
  }

  /** faster-whisper en el sandbox de Higgsfield; el texto fuente manda sobre la transcripción. */
  async wordTimes(sourceWords: string[], audio: TtsResult, durationSec: number): Promise<WordTime[]> {
    if (!audio.remoteUrl) throw new Error('No hay URL remota del audio para transcribir.');
    const py = [
      'import json',
      'from faster_whisper import WhisperModel',
      `m=WhisperModel(${JSON.stringify(this.cfg.whisperModel)},device="cpu",compute_type="int8")`,
      'segs,_=m.transcribe("a.audio",language="es",word_timestamps=True)',
      'print("WORDS_JSON="+json.dumps([{"word":w.word.strip(),"start":round(w.start,3),"end":round(w.end,3)} for s in segs for w in s.words]))',
    ].join('\n');
    const cmd = `cd /home/user && curl -sSfL -o a.audio ${shellQuote(audio.remoteUrl)} && python3 - <<'PY'\n${py}\nPY`;
    const r = await this.hf.call<{ exit_code?: number; stdout?: string; stderr?: string }>(
      'sandbox_exec',
      { command: cmd, timeout_seconds: 120 },
      200_000,
    );
    const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('WORDS_JSON='));
    if (!line) throw new Error(`whisper no devolvió tiempos: ${(r.stderr ?? '').slice(-500)}`);
    const heard = JSON.parse(line.slice('WORDS_JSON='.length)) as WordTime[];
    return alignWords(sourceWords, heard, durationSec);
  }
}

export class HiggsfieldImages implements ImagePort {
  private jobs: Jobs;
  constructor(
    hf: HiggsfieldClient,
    private cfg: HiggsfieldConfig,
  ) {
    this.jobs = new Jobs(hf);
  }

  async generate(requests: ImageRequest[], onItem?: OnItem<ImageResult>): Promise<ImageResult[]> {
    const results = new Map<string, ImageResult>();
    const finish = async (r: ImageResult) => {
      results.set(r.key, r);
      await onItem?.(r);
    };
    const submitted = await this.jobs.submit(
      'generate_image_batch',
      requests.map((r) => ({
        model: 'gpt_image_2_5',
        prompt: r.prompt,
        aspect_ratio: '16:9',
        resolution: this.cfg.imageResolution,
        quality: this.cfg.imageQuality,
        variant: this.cfg.imageVariant,
        ...(r.references?.length ? { medias: r.references.map((value) => ({ role: 'image_references', value })) } : {}),
      })),
    );
    const live: { index: number; job_id: string }[] = [];
    for (const s of submitted) {
      if (s.job_id) live.push({ index: s.index, job_id: s.job_id });
      else await finish({ key: requests[s.index].key, error: s.error ?? 'No se pudo enviar' });
    }
    await this.jobs.waitAll(live, 20 * 60_000, async (j) => {
      const req = requests[j.index];
      if (!Jobs.ok(j)) return finish({ key: req.key, error: j.error ?? `Estado ${j.status}` });
      try {
        const path = `${req.outBase}.png`;
        await download(j.result_url!, path);
        await finish({ key: req.key, path, ref: j.job_id });
      } catch (e) {
        await finish({ key: req.key, error: (e as Error).message });
      }
    });
    return requests.map((r) => results.get(r.key) ?? { key: r.key, error: 'Sin resultado' });
  }
}

export class HiggsfieldVideo implements VideoPort {
  private jobs: Jobs;
  constructor(
    hf: HiggsfieldClient,
    private cfg: HiggsfieldConfig,
  ) {
    this.jobs = new Jobs(hf);
  }

  async generate(requests: VideoRequest[], onItem?: OnItem<VideoResult>): Promise<VideoResult[]> {
    const results = new Map<string, VideoResult>();
    const finish = async (r: VideoResult) => {
      results.set(r.key, r);
      await onItem?.(r);
    };
    const submitted = await this.jobs.submit(
      'generate_video_batch',
      requests.map((r) => ({
        model: 'minimax_h3',
        prompt: r.prompt,
        aspect_ratio: '16:9',
        resolution: '2K',
        duration: this.cfg.clipSeconds,
        declined_preset_id: this.cfg.declinedPresetId,
        medias: [
          { role: 'start_image', value: r.start.ref },
          { role: 'end_image', value: r.end.ref },
        ],
      })),
    );
    const live: { index: number; job_id: string }[] = [];
    for (const s of submitted) {
      if (s.job_id) live.push({ index: s.index, job_id: s.job_id });
      else await finish({ key: requests[s.index].key, error: s.error ?? 'No se pudo enviar' });
    }
    await this.jobs.waitAll(live, 45 * 60_000, async (j) => {
      const req = requests[j.index];
      if (!Jobs.ok(j)) return finish({ key: req.key, error: j.error ?? `Estado ${j.status}`, jobId: j.job_id });
      try {
        await download(j.result_url!, req.outPath);
        await finish({ key: req.key, path: req.outPath, jobId: j.job_id });
      } catch (e) {
        await finish({ key: req.key, error: (e as Error).message, jobId: j.job_id });
      }
    });
    return requests.map((r) => results.get(r.key) ?? { key: r.key, error: 'Sin resultado' });
  }
}

/** Busca el declined_preset_id que Higgsfield pide para un índice (en el trabajo o en el texto del error). */
export function declinedPresetFor(index: number, job: BatchJob | undefined, raw: string): string | undefined {
  const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
  const inJob = job ? JSON.stringify(job).match(new RegExp(`declined_preset_id\\W{0,5}${UUID}`, 'i')) : null;
  if (inJob) return inJob[1];
  for (const line of raw.split(/\n|\\n/)) {
    const m = line.match(new RegExp(`index\\W{0,3}${index}\\b.*?declined_preset_id\\W{0,5}${UUID}`, 'i'));
    if (m) return m[1];
  }
  return undefined;
}

function shellQuote(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
