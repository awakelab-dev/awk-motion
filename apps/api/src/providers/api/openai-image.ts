import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import pLimit from 'p-limit';
import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from '@wilox/shared';
import { fetchJson, retryRateLimited } from '../http.js';
import type { ImagePort, ImageRequest, ImageResult, OnItem } from '../ports.js';

/** GPT Image 2.5 vía API de OpenAI, directo a 2560×1440 (múltiplos de 16, sin recorte). */
export class OpenAiImages implements ImagePort {
  constructor(
    private apiKey: string,
    private model: string,
    private quality: string,
    private concurrency: number,
  ) {}

  async generate(requests: ImageRequest[], onItem?: OnItem<ImageResult>): Promise<ImageResult[]> {
    const limit = pLimit(Math.max(1, this.concurrency));
    return Promise.all(
      requests.map((req) =>
        limit(async () => {
          let result: ImageResult;
          try {
            // Un 429 (imágenes por minuto del nivel de la cuenta) espera y reintenta sin perder la imagen.
            const r = await retryRateLimited(() =>
              req.references?.length ? this.edit(req) :
              fetchJson<{ data: { b64_json?: string; url?: string }[]; usage?: Record<string, unknown> }>('https://api.openai.com/v1/images/generations', {
                method: 'POST',
                headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
                body: JSON.stringify({
                  model: this.model,
                  prompt: req.prompt,
                  size: `${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`,
                  quality: this.quality,
                  output_format: 'png',
                  n: 1,
                }),
                timeoutMs: 600_000,
              }),
            2);
            const item = r.data?.[0];
            if (!item?.b64_json) throw new Error('OpenAI no devolvió la imagen en base64.');
            const path = `${req.outBase}.png`;
            await writeFile(path, Buffer.from(item.b64_json, 'base64'));
            result = { key: req.key, path, ref: path, usage: r.usage };
          } catch (e) {
            result = { key: req.key, error: (e as Error).message };
          }
          await onItem?.(result);
          return result;
        }),
      ),
    );
  }

  /** Con referencias de estilo (temas del Estudio): /images/edits con las imágenes adjuntas (ADR-019). */
  private async edit(req: ImageRequest) {
    const form = new FormData();
    form.set('model', this.model);
    form.set('prompt', req.prompt);
    form.set('size', `${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`);
    form.set('quality', this.quality);
    form.set('output_format', 'png');
    form.set('n', '1');
    for (const path of req.references!) {
      const type = /\.jpe?g$/i.test(path) ? 'image/jpeg' : 'image/png';
      form.append('image[]', new Blob([await readFile(path)], { type }), basename(path));
    }
    const res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(600_000),
    });
    if (!res.ok) throw new Error(`OpenAI /images/edits: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as { data: { b64_json?: string; url?: string }[]; usage?: Record<string, unknown> };
  }
}
