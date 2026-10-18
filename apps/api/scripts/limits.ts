/**
 * pnpm api:limits (hito 5, ADR-045): capacidad configurada de cada recurso de la cola y las cabeceras de
 * límites que devuelve cada proveedor con una llamada gratuita (no genera nada ni gasta créditos).
 * Sirve para ajustar los QUEUE_* del .env al plan o tier real de cada cuenta.
 */
import { env } from '../src/config/env.js';

const LIMIT = /ratelimit|rate-limit|concurren|retry-after|quota|tier/i;

async function headers(name: string, url: string, init: RequestInit) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const found = [...res.headers.entries()].filter(([k]) => LIMIT.test(k));
    console.log(`\n${name}: HTTP ${res.status}`);
    if (!found.length) console.log('  (sin cabeceras de límites en esta llamada)');
    for (const [k, v] of found) console.log(`  ${k}: ${v}`);
  } catch (e) {
    console.log(`\n${name}: ${(e as Error).message}`);
  }
}

console.log('Capacidad configurada (simultáneos · por minuto):');
const rows: [string, number | undefined, number | undefined][] = [
  ['ElevenLabs', env.QUEUE_ELEVENLABS_CONCURRENCY, env.QUEUE_ELEVENLABS_PER_MIN],
  ['Opus (Anthropic)', env.QUEUE_ANTHROPIC_CONCURRENCY, env.QUEUE_ANTHROPIC_PER_MIN],
  ['OpenAI imágenes', env.QUEUE_OPENAI_CONCURRENCY, env.QUEUE_OPENAI_PER_MIN],
  ['MiniMax', env.QUEUE_MINIMAX_CONCURRENCY ?? env.MINIMAX_CONCURRENCY, env.QUEUE_MINIMAX_PER_MIN],
  ['Higgsfield (MCP)', env.QUEUE_HIGGSFIELD_CONCURRENCY, undefined],
  ['ffmpeg (Mac)', env.QUEUE_FFMPEG_CONCURRENCY, undefined],
];
for (const [n, c, m] of rows) console.log(`  ${n.padEnd(18)} ${String(c).padStart(3)} · ${m ?? '—'}`);

if (env.OPENAI_API_KEY) await headers('OpenAI (GET /v1/models)', 'https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` } });
if (env.ANTHROPIC_API_KEY)
  await headers('Anthropic (POST /v1/messages/count_tokens, gratis)', 'https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.ANTHROPIC_MODEL, messages: [{ role: 'user', content: 'hola' }] }),
  });
if (env.ELEVENLABS_API_KEY) await headers('ElevenLabs (GET /v1/models)', 'https://api.elevenlabs.io/v1/models', { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY } });
if (env.MINIMAX_API_KEY) console.log('\nMiniMax: no publica cabeceras de límites; la cola baja la concurrencia sola si responde con un límite (1002/1039 o 429).');
console.log('\nLos valores del .env son topes: ante un 429 la cola baja la concurrencia, respeta Retry-After y la recupera sola.');
