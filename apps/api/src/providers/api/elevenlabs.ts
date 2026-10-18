import { writeFile } from 'node:fs/promises';
import type { VoiceOption } from '@wilox/shared';
import { wordsFromCharAlignment, type WordTime } from '../../pipeline/align.js';
import { fetchJson, sleep } from '../http.js';
import type { TimingPort, TtsOptions, TtsPort, TtsResult } from '../ports.js';

const BASE = 'https://api.elevenlabs.io';

interface WithTimestamps {
  audio_base64: string;
  alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
  normalized_alignment?: WithTimestamps['alignment'];
}

/**
 * Qué hacer con el historial de ElevenLabs tras cada locución (ADR-040): `delete` (por defecto) la borra
 * con DELETE /v1/history/{id}; `zero` pide retención cero (`enable_logging=false`, solo cuentas
 * Enterprise; si la API lo rechaza, se vuelve a `delete`); `keep` la deja en el historial.
 */
export type ElevenLabsHistoryMode = 'delete' | 'zero' | 'keep';

/**
 * ElevenLabs v3: voz + tiempos por carácter en una sola llamada (/with-timestamps). Verificado con
 * claves reales (ADR-037): eleven_v3 devuelve alignment y normalized_alignment.
 */
export class ElevenLabsTts implements TtsPort, TimingPort {
  /** La cuenta rechazó enable_logging=false: el resto de la sesión se borra del historial. */
  private zeroUnsupported = false;
  /** Ya se avisó en el log de que la clave no puede borrar del historial. */
  private warnedPermission = false;

  constructor(
    private apiKey: string,
    private model: string,
    private historyMode: ElevenLabsHistoryMode = 'delete',
  ) {}

  private get headers() {
    return { 'xi-api-key': this.apiKey, 'content-type': 'application/json' };
  }

  async listVoices(): Promise<VoiceOption[]> {
    const out: VoiceOption[] = [];
    let token: string | undefined;
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({ page_size: '100', ...(token ? { next_page_token: token } : {}) });
      const r = await fetchJson<{
        voices: { voice_id: string; name: string; preview_url?: string; category?: string; labels?: Record<string, string> }[];
        has_more?: boolean;
        next_page_token?: string;
      }>(`${BASE}/v2/voices?${q}`, { headers: this.headers });
      for (const v of r.voices) {
        const labels = v.labels ? Object.values(v.labels).filter(Boolean).join(' · ') : '';
        out.push({ id: v.voice_id, name: v.name, previewUrl: v.preview_url, description: [v.category, labels].filter(Boolean).join(' · ') });
      }
      if (!r.has_more || !r.next_page_token) break;
      token = r.next_page_token;
    }
    return out;
  }

  private async request(text: string, voiceId: string, zero: boolean, opts?: TtsOptions) {
    const q = new URLSearchParams({ output_format: 'mp3_44100_128', ...(zero ? { enable_logging: 'false' } : {}) });
    const payload: Record<string, unknown> = { text, model_id: opts?.model ?? this.model };
    // Enlace con las locuciones anteriores (prueba de voz, ADR-129): ElevenLabs admite hasta 3 request_id.
    if (opts?.previousRequestIds?.length) payload.previous_request_ids = opts.previousRequestIds.slice(-3);
    if (opts?.nextText) payload.next_text = opts.nextText;
    // Ajustes de la voz para este pedido (ADR-131); los que no se dan quedan como los tiene la voz.
    const vs = opts?.voiceSettings;
    if (vs && (vs.similarityBoost !== undefined || vs.stability !== undefined))
      payload.voice_settings = { ...(vs.similarityBoost !== undefined ? { similarity_boost: vs.similarityBoost } : {}), ...(vs.stability !== undefined ? { stability: vs.stability } : {}) };
    const res = await fetch(`${BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?${q}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    });
    const body = await res.text();
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} en ElevenLabs /with-timestamps: ${body.slice(0, 800)}`), { status: res.status });
    const cost = res.headers.get('character-cost');
    return {
      r: JSON.parse(body) as WithTimestamps,
      credits: cost !== null && cost !== '' ? Number(cost) : undefined,
      requestId: res.headers.get('request-id') ?? undefined,
      historyItemId: res.headers.get('history-item-id') ?? undefined,
    };
  }

  /** Reintenta errores de red y 5xx (3 intentos); un 4xx no se reintenta: repetirlo daría lo mismo. */
  private async requestRetry(text: string, voiceId: string, zero: boolean, opts?: TtsOptions) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request(text, voiceId, zero, opts);
      } catch (e) {
        const status = (e as { status?: number }).status ?? 0;
        if ((status >= 400 && status < 500) || attempt >= 2) throw e;
        await sleep(3000 * 2 ** attempt);
      }
    }
  }

  /**
   * Borra la locución del historial de ElevenLabs (ADR-040). Usa la cabecera history-item-id o, si no
   * llega, busca en /v1/history el elemento con el mismo request_id. Nunca hace fallar la generación.
   */
  async removeFromHistory(o: { requestId?: string; historyItemId?: string; voiceId: string; sinceUnix: number }): Promise<'deleted' | 'not-found' | string> {
    try {
      let id = o.historyItemId;
      for (let attempt = 0; !id && o.requestId && attempt < 3; attempt++) {
        if (attempt) await sleep(2000); // el historial puede tardar un instante en reflejar la locución
        const q = new URLSearchParams({ page_size: '50', voice_id: o.voiceId, date_after_unix: String(o.sinceUnix - 120) });
        const h = await fetchJson<{ history?: { history_item_id: string; request_id?: string }[] }>(`${BASE}/v1/history?${q}`, { headers: this.headers });
        id = h.history?.find((x) => x.request_id === o.requestId)?.history_item_id;
      }
      if (!id) return 'not-found';
      const res = await fetch(`${BASE}/v1/history/${encodeURIComponent(id)}`, { method: 'DELETE', headers: this.headers, signal: AbortSignal.timeout(30_000) });
      if (res.ok) return 'deleted';
      const body = (await res.text()).slice(0, 200);
      // Sin permiso (ADR-120): se avisa una vez en el log; la generación sigue.
      if ((res.status === 401 || res.status === 403) && !this.warnedPermission) {
        this.warnedPermission = true;
        console.warn(`[ElevenLabs] No se pudo borrar la locución del historial (HTTP ${res.status}): la clave necesita speech_history_read y speech_history_write. ${body}`);
      }
      return `HTTP ${res.status}: ${body}`;
    } catch (e) {
      return (e as Error).message.slice(0, 200);
    }
  }

  async synthesize(text: string, voiceId: string, outBase: string, opts?: TtsOptions): Promise<TtsResult> {
    const sinceUnix = Math.floor(Date.now() / 1000);
    const wantZero = this.historyMode === 'zero' && !this.zeroUnsupported;
    let res: Awaited<ReturnType<ElevenLabsTts['request']>>;
    let zeroUsed = wantZero;
    try {
      res = await this.requestRetry(text, voiceId, wantZero, opts);
    } catch (e) {
      // Retención cero solo existe en Enterprise: si la rechaza (4xx), se pide normal y se borra después.
      const status = (e as { status?: number }).status ?? 0;
      if (!wantZero || status < 400 || status >= 500) throw e;
      this.zeroUnsupported = true;
      zeroUsed = false;
      res = await this.requestRetry(text, voiceId, false, opts);
    }
    const { r, credits, requestId, historyItemId } = res;
    const path = `${outBase}.mp3`;
    await writeFile(path, Buffer.from(r.audio_base64, 'base64'));
    const al = r.alignment ?? r.normalized_alignment;
    const words = al
      ? wordsFromCharAlignment(al.characters, al.character_start_times_seconds, al.character_end_times_seconds)
      : undefined;
    const history = zeroUsed ? 'zero-retention' : this.historyMode === 'keep' ? 'kept' : await this.removeFromHistory({ requestId, historyItemId, voiceId, sinceUnix });
    return { path, words, jobId: requestId, usage: { ...(credits !== undefined ? { credits } : {}), history }, ...(opts?.model ? { model: opts.model } : {}) };
  }

  async wordTimes(_source: string[], audio: TtsResult): Promise<WordTime[]> {
    if (!audio.words?.length) throw new Error('ElevenLabs no devolvió la alineación por caracteres (modelo sin soporte de timestamps).');
    return audio.words;
  }
}
