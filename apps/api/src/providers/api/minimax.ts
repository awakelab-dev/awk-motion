import { readFile } from 'node:fs/promises';
import pLimit from 'p-limit';
import { imageToJpeg2k } from '../../media/ffmpeg.js';
import { download, fetchJson, retry, sleep } from '../http.js';
import type { OnItem, VideoPort, VideoRequest, VideoResult } from '../ports.js';

interface QueryResponse {
  task?: { task_id: string; status: string; content?: { url?: string }; error?: { message?: string }; usage?: Record<string, unknown> };
  base_resp?: { status_code: number; status_msg: string };
}

/**
 * MiniMax H3 vía API v2: POST /v2/video_generation con first_frame/last_frame,
 * polling en /v2/query/video_generation/{task_id}. Verificado con claves reales (ADR-037): acepta los
 * frames como data URL y entrega 124 frames a 24 fps (5,167 s), igual que Higgsfield.
 */
export class MiniMaxVideo implements VideoPort {
  constructor(
    private apiKey: string,
    private model: string,
    private baseUrl: string,
    private seconds: number,
    private concurrency: number,
  ) {}

  private get headers() {
    return { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' };
  }

  private async dataUrl(path: string): Promise<string> {
    const jpg = path.replace(/\.(png|jpg|jpeg|webp)$/i, '') + '.send.jpg';
    await imageToJpeg2k(path, jpg);
    return `data:image/jpeg;base64,${(await readFile(jpg)).toString('base64')}`;
  }

  private async submit(req: VideoRequest): Promise<string> {
    const body = {
      model: this.model,
      content: [
        { type: 'text', text: req.prompt },
        { type: 'image_url', image_url: { url: await this.dataUrl(req.start.path) }, role: 'first_frame' },
        { type: 'image_url', image_url: { url: await this.dataUrl(req.end.path) }, role: 'last_frame' },
      ],
      duration: this.seconds,
      resolution: '2K',
      ratio: 'adaptive',
    };
    const created = await retry(() =>
      fetchJson<{ task_id?: string; base_resp?: { status_code: number; status_msg: string } }>(
        `${this.baseUrl}/v2/video_generation`,
        { method: 'POST', headers: this.headers, body: JSON.stringify(body), timeoutMs: 180_000 },
      ),
    2);
    if (!created.task_id)
      throw new Error(`MiniMax no creó la tarea: ${created.base_resp?.status_msg ?? JSON.stringify(created)} (${created.base_resp?.status_code ?? 's/c'})`);
    await req.onSubmitted?.(created.task_id);
    return created.task_id;
  }

  /**
   * Un clip: envía la tarea (o retoma la que ya se envió, hito 5) y la consulta hasta que termina.
   * El task_id se entrega con onSubmitted antes de esperar, para no pedirlo dos veces tras un reinicio.
   */
  private async one(req: VideoRequest): Promise<VideoResult> {
    const taskId = req.resumeTaskId ?? (await this.submit(req));
    const created = { task_id: taskId };
    const deadline = Date.now() + 40 * 60_000;
    while (Date.now() < deadline) {
      await sleep(10_000);
      let q: QueryResponse;
      try {
        q = await fetchJson<QueryResponse>(`${this.baseUrl}/v2/query/video_generation/${created.task_id}`, { headers: this.headers });
      } catch {
        continue; // error transitorio de red: se reintenta en el siguiente ciclo
      }
      const st = q.task?.status;
      if (st === 'succeeded') {
        const url = q.task?.content?.url;
        if (!url) throw new Error('MiniMax terminó sin URL de descarga.');
        await download(url, req.outPath);
        return { key: req.key, path: req.outPath, jobId: created.task_id, usage: q.task?.usage };
      }
      if (st === 'failed' || st === 'cancelled') throw new Error(`MiniMax: tarea ${st}. ${q.task?.error?.message ?? ''}`);
    }
    throw new Error('MiniMax: se agotó el tiempo de espera (40 min).');
  }

  async generate(requests: VideoRequest[], onItem?: OnItem<VideoResult>): Promise<VideoResult[]> {
    const limit = pLimit(Math.max(1, this.concurrency));
    return Promise.all(
      requests.map((req) =>
        limit(async () => {
          let r: VideoResult;
          try {
            r = await this.one(req);
          } catch (e) {
            r = { key: req.key, error: (e as Error).message };
          }
          await onItem?.(r);
          return r;
        }),
      ),
    );
  }
}
