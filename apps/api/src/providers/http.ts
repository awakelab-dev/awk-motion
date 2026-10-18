import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch con timeout y mensaje de error legible. */
export async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 120_000, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${new URL(url).host}${new URL(url).pathname}: ${text.slice(0, 800)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Respuesta no JSON de ${url}: ${text.slice(0, 300)}`);
  }
}

export async function download(url: string, out: string, timeoutMs = 300_000): Promise<string> {
  await mkdir(dirname(out), { recursive: true });
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} al descargar ${url}`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(out));
      return out;
    } catch (e) {
      last = e;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Reintenta una operación con espera exponencial. */
export async function retry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 3000): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await sleep(baseMs * 2 ** i);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** ¿Error por límite de peticiones (HTTP 429 o rate limit en el mensaje)? */
export const isRateLimit = (e: unknown) => /\bHTTP 429\b|rate.?limit/i.test(String((e as Error)?.message ?? e));

/**
 * Como retry, pero ante un 429 espera más y lo intenta más veces (OpenAI limita las imágenes por minuto
 * según el nivel de la cuenta: en el nivel 1, 5 por minuto). Los demás errores, `attempts` veces.
 */
export async function retryRateLimited<T>(fn: () => Promise<T>, attempts = 2, baseMs = 3000, rateAttempts = 5, rateWaitMs = 20_000): Promise<T> {
  let errors = 0;
  let limited = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (isRateLimit(e)) {
        limited += 1;
        if (limited >= rateAttempts) throw e;
        await sleep(rateWaitMs * limited);
      } else {
        errors += 1;
        if (errors >= attempts) throw e;
        await sleep(baseMs * 2 ** (errors - 1));
      }
    }
  }
}
