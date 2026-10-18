/**
 * ¿Un error de proveedor es transitorio (vale la pena reintentar más tarde)? 429, 408, 5xx (529
 * overloaded de Anthropic), cortes de red y los códigos de límite de MiniMax. Un 4xx de contenido o
 * de parámetros es definitivo: repetirlo daría lo mismo. Devuelve el Retry-After si lo hay.
 */
export interface TransientInfo {
  retryAfterMs?: number;
}

const NET = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|TimeoutError|timed? ?out|aborted|overloaded|rate.?limit|too many requests|temporarily unavailable|connection error/i;

function header(e: unknown, name: string): string | undefined {
  const h = (e as { headers?: unknown })?.headers;
  if (!h) return undefined;
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name) ?? undefined;
  const v = (h as Record<string, unknown>)[name];
  return typeof v === 'string' ? v : undefined;
}

export function retryAfterMs(e: unknown): number | undefined {
  const explicit = (e as { retryAfterMs?: number })?.retryAfterMs;
  if (typeof explicit === 'number') return explicit;
  const v = header(e, 'retry-after');
  if (!v) return undefined;
  const sec = Number(v);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** Fallos del propio trabajo en el proveedor (no de la red): nunca se reintentan con la misma tarea. */
const PERMANENT = /MiniMax: tarea (failed|cancelled)|MiniMax terminó sin URL|se agotó el tiempo de espera \(40 min\)/;

export function transientInfo(e: unknown): TransientInfo | undefined {
  const msg = typeof e === 'string' ? e : String((e as Error)?.message ?? e);
  if (PERMANENT.test(msg)) return undefined;
  const raw = (e as { status?: unknown })?.status;
  const st = typeof raw === 'number' ? raw : Number(msg.match(/\bHTTP (\d{3})\b/)?.[1] ?? 0);
  const after = typeof e === 'string' ? undefined : retryAfterMs(e);
  if (st === 429 || st === 408 || st === 425 || (st >= 500 && st <= 599)) return { retryAfterMs: after };
  if (/MiniMax no creó la tarea[^\n]*\b(1000|1001|1002|1039)\b/.test(msg)) return { retryAfterMs: after };
  if (!st && NET.test(msg)) return { retryAfterMs: after };
  return undefined;
}

/** Espera creciente con un poco de azar: 15 s, 30 s, 1 min… hasta 5 min. */
export function backoffMs(attempt: number): number {
  const base = Math.min(5 * 60_000, 15_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}
