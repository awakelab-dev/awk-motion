/**
 * Pruebas cortas del modo API con claves reales (hito 4 · T4, ADR-037). Una llamada mínima por
 * proveedor, con el mismo código que usa el pipeline, para resolver los puntos pendientes de
 * decisiones.md y medir tiempos y costos reales antes de lanzar un video completo.
 *
 *   pnpm api:probe elevenlabs [--voice <voice_id>] [--list-voices] [--history delete|zero|keep]
 *   pnpm api:probe openai     [--refs a.jpg b.png …]
 *   pnpm api:probe minimax    [--run <id de generación>]
 *   pnpm api:probe anthropic
 *
 * - No necesita GENERATION_MODE=api: lee las claves del .env y la app puede seguir en modo MCP.
 * - Guarda todo en storage/probes/<fecha>-<proveedor>/ (archivos, respuestas sin claves y report.json).
 * - Los precios de referencia (USD) son los públicos de septiembre de 2026; se pueden sobrescribir con PRICE_* en .env.
 */
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { env, repoPath } from '../src/config/env.js';
import { countFrames, durationSec, ffprobe, ssimAgainst } from '../src/media/ffmpeg.js';
import { fetchJson } from '../src/providers/http.js';
import { ElevenLabsTts } from '../src/providers/api/elevenlabs.js';
import { MiniMaxVideo } from '../src/providers/api/minimax.js';
import { OpenAiImages } from '../src/providers/api/openai-image.js';

const args = process.argv.slice(2);
const provider = args.find((a) => !a.startsWith('--'));
const flag = (name: string) => args.includes(name);
const argValue = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const argList = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return [];
  const out: string[] = [];
  for (const a of args.slice(i + 1)) {
    if (a.startsWith('--')) break;
    out.push(a);
  }
  return out;
};

const STORAGE = repoPath(env.STORAGE_DIR);
/** Generación de referencia (la Dark del hito 1): de ahí salen fotogramas y prompts reales. */
const DEFAULT_RUN = '20260924-103824-dark-906f57';
const TEXT_ES = 'Bienvenido al Módulo 1 del curso Infecciones Asociadas a la Atención de Salud. Al finalizar serás capaz de reconocer sus factores epidemiológicos.';

/** Precios públicos de referencia (septiembre de 2026); PRICE_* en .env los sustituye. */
const num = (k: string) => (process.env[k] ? Number(process.env[k]) : undefined);
const PRICES = {
  minimaxPerSecond2k: num('PRICE_MINIMAX_PER_SECOND_2K') ?? 0.13, // platform.minimax.io · pay-as-you-go · MiniMax-H3 2K
  openaiTextInPerM: num('PRICE_OPENAI_TEXT_INPUT_PER_MTOK') ?? 5, // gpt-image-2.5-sunburst
  openaiImageInPerM: num('PRICE_OPENAI_IMAGE_INPUT_PER_MTOK') ?? 8,
  openaiImageOutPerM: num('PRICE_OPENAI_IMAGE_OUTPUT_PER_MTOK') ?? 30,
  anthropicInPerM: env.PRICE_ANTHROPIC_INPUT_PER_MTOK ?? 4, // Opus 5.5
  anthropicOutPerM: env.PRICE_ANTHROPIC_OUTPUT_PER_MTOK ?? 20,
};

const usd = (n: number | undefined) => (n === undefined || Number.isNaN(n) ? '—' : `US$ ${n.toFixed(4)}`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const line = (k: string, v: unknown) => console.log(`  ${k.padEnd(30)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);
/** "fetch failed" no dice nada: la causa real (ENOTFOUND, ECONNRESET, certificado…) va en e.cause. */
const causeOf = (e: unknown) => {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  return [err?.message ?? String(e), err?.cause?.code, err?.cause?.message].filter(Boolean).join(' · ');
};
/** Nunca se escriben claves en los informes. */
const redact = (s: string) => s.replace(/(sk-|xi-|eyJ)[\w.-]{10,}/g, '[clave]');

async function outDir(name: string) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const dir = join(STORAGE, 'probes', `${stamp}-${name}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function saveReport(dir: string, report: Record<string, unknown>) {
  await writeFile(join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)));
  console.log(`\n  Informe: ${join(dir, 'report.json').replace(repoPath('.') + '/', '')}`);
}

function need(key: 'ELEVENLABS_API_KEY' | 'OPENAI_API_KEY' | 'MINIMAX_API_KEY' | 'ANTHROPIC_API_KEY'): string {
  const v = env[key];
  if (!v) throw new Error(`Falta ${key} en el .env de la raíz.`);
  return v;
}

/** Última versión de un fotograma de una generación (K01_v2.png si existe, si no K01_v1.png…). */
function keyframe(runDir: string, index: number): string {
  const nn = String(index).padStart(2, '0');
  const dir = join(runDir, 'keyframes');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => new RegExp(`^K${nn}(_v\\d+)?\\.png$`).test(f)) : [];
  const v = (f: string) => Number(f.match(/_v(\d+)/)?.[1] ?? 0);
  const f = files.sort((a, b) => v(b) - v(a))[0];
  if (!f) throw new Error(`No encuentro K${nn} en ${dir}`);
  return join(dir, f);
}

async function videoInfo(file: string) {
  const { stdout } = await ffprobe(['-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', file]);
  const streams = (JSON.parse(stdout.toString()) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string }[] }).streams;
  const v = streams.find((s) => s.codec_type === 'video');
  return {
    width: v?.width,
    height: v?.height,
    fps: v?.r_frame_rate,
    codec: v?.codec_name,
    audio: streams.some((s) => s.codec_type === 'audio'),
    frames: await countFrames(file),
    durationSec: await durationSec(file),
  };
}

// ───────────────────────────────────────────────────────────── ElevenLabs

interface Subscription {
  tier?: string;
  character_count?: number;
  character_limit?: number;
  currency?: string;
}

async function probeElevenLabs() {
  const key = need('ELEVENLABS_API_KEY');
  const headers = { 'xi-api-key': key, 'content-type': 'application/json' };
  const dir = await outDir('elevenlabs');
  const report: Record<string, unknown> = { provider: 'elevenlabs', model: env.ELEVENLABS_MODEL };
  console.log(`\n▶ ElevenLabs · modelo ${env.ELEVENLABS_MODEL}`);

  const sub = await fetchJson<Subscription>('https://api.elevenlabs.io/v1/user/subscription', { headers }).catch((e: Error) => ({ error: e.message }) as Subscription & { error: string });
  report.subscriptionBefore = sub;
  line('Plan', `${sub.tier ?? '?'} · ${sub.character_count ?? '?'} / ${sub.character_limit ?? '?'} caracteres usados`);

  const voices = await fetchJson<{ voices: { voice_id: string; name: string; category?: string; labels?: Record<string, string> }[] }>(
    'https://api.elevenlabs.io/v2/voices?page_size=100',
    { headers },
  );
  report.voices = voices.voices.map((v) => ({ id: v.voice_id, name: v.name, category: v.category, labels: v.labels }));
  const spanish = voices.voices.filter((v) => /es|spanish|latin|chile|mex|argent/i.test(JSON.stringify(v.labels ?? {}) + v.name));
  const shown = flag('--list-voices') ? voices.voices : spanish.length ? spanish : voices.voices.slice(0, 15);
  console.log(`  Voces de tu cuenta (${voices.voices.length}; ${flag('--list-voices') ? 'todas' : spanish.length ? 'las que parecen en español' : 'las 15 primeras'}):`);
  for (const v of shown) console.log(`    ${v.voice_id}  ${v.name}${v.labels ? ` · ${Object.values(v.labels).filter(Boolean).join(' · ')}` : ''}`);

  const voiceId = argValue('--voice') ?? env.ELEVENLABS_DEFAULT_VOICE_ID ?? (spanish[0] ?? voices.voices[0])?.voice_id;
  if (!voiceId) throw new Error('La cuenta no tiene voces.');
  const voiceName = voices.voices.find((v) => v.voice_id === voiceId)?.name ?? voiceId;
  line('Voz de la prueba', `${voiceName} (${voiceId})`);

  // La locución se pide con el mismo código que el pipeline (incluido el historial, ADR-040).
  const mode = (argValue('--history') as 'delete' | 'zero' | 'keep' | undefined) ?? env.ELEVENLABS_HISTORY;
  const tts = new ElevenLabsTts(key, env.ELEVENLABS_MODEL, mode);
  const t0 = Date.now();
  const r = await tts.synthesize(TEXT_ES, voiceId, join(dir, 'voz'));
  const ms = Date.now() - t0;
  const dur = await durationSec(r.path);
  const words = r.words ?? [];
  await writeFile(join(dir, 'alignment.json'), JSON.stringify({ words }, null, 2));
  const sub2 = await fetchJson<Subscription>('https://api.elevenlabs.io/v1/user/subscription', { headers }).catch(() => undefined);
  const charged = sub2?.character_count !== undefined && sub.character_count !== undefined ? sub2.character_count - sub.character_count : undefined;
  const credits = Number(r.usage?.credits);
  Object.assign(report, {
    voiceId,
    voiceName,
    text: TEXT_ES,
    textChars: TEXT_ES.length,
    audioSec: dur,
    ms,
    requestId: r.jobId,
    words: words.length,
    sourceWords: TEXT_ES.split(/\s+/).length,
    lastWordEndSec: words.at(-1)?.end,
    credits: Number.isFinite(credits) ? credits : undefined,
    historyMode: mode,
    history: r.usage?.history,
    charactersCharged: charged,
    subscriptionAfter: sub2,
  });

  console.log('\n  RESULTADO ElevenLabs');
  line('Tiempo', secs(ms));
  line('Audio', `${dur.toFixed(2)} s (voz.mp3)`);
  line('Palabras con tiempo', `${words.length} de ${TEXT_ES.split(/\s+/).length} (última termina en ${words.at(-1)?.end?.toFixed(2) ?? '—'} s)`);
  if (words.length) line('Primeras palabras', words.slice(0, 5).map((w) => `${w.word}@${w.start.toFixed(2)}`).join('  '));
  if (Number.isFinite(credits)) line('Créditos (character-cost)', `${credits}${env.PRICE_ELEVENLABS_CREDIT_USD !== undefined ? ` · ${usd(credits * env.PRICE_ELEVENLABS_CREDIT_USD)}` : ' (falta PRICE_ELEVENLABS_CREDIT_USD para el USD)'}`);
  const historyLabel: Record<string, string> = {
    deleted: 'BORRADA del historial',
    'zero-retention': 'retención cero (no se guardó)',
    kept: 'se deja en el historial (ELEVENLABS_HISTORY=keep)',
    'not-found': 'NO encontrada en el historial (no se pudo borrar)',
  };
  line(`Historial (${mode})`, historyLabel[String(r.usage?.history)] ?? `ERROR al borrar: ${String(r.usage?.history)}`);
  await saveReport(dir, report);
}

// ───────────────────────────────────────────────────────────── OpenAI (GPT Image)

/** Costo por tokens (gpt-image-2.5: texto e imagen de entrada, imagen de salida). */
function openAiCost(usage: Record<string, unknown> | undefined): number | undefined {
  if (!usage) return undefined;
  const u = usage as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { text_tokens?: number; image_tokens?: number } };
  const text = u.input_tokens_details?.text_tokens ?? (u.input_tokens_details ? 0 : (u.input_tokens ?? 0));
  const img = u.input_tokens_details?.image_tokens ?? 0;
  return (text * PRICES.openaiTextInPerM + img * PRICES.openaiImageInPerM + (u.output_tokens ?? 0) * PRICES.openaiImageOutPerM) / 1e6;
}

/** Referencias de un tema del Estudio (ADR-019) o, si ningún tema tiene, dos fotogramas de las generaciones de referencia. */
function styleReferences(): { paths: string[]; source: string } {
  const given = argList('--refs');
  if (given.length) return { paths: given.map((p) => repoPath(p)), source: 'argumento --refs' };
  const themes = join(STORAGE, 'themes');
  for (const t of existsSync(themes) ? readdirSync(themes).filter((d) => !d.startsWith('_')) : []) {
    const dir = join(themes, t, 'referencias');
    const refs = existsSync(dir) ? readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)) : [];
    if (refs.length) return { paths: refs.slice(0, 4).map((f) => join(dir, f)), source: `tema del Estudio ${t}` };
  }
  const paths = [
    [DEFAULT_RUN, 2],
    ['20260924-095606-pastel-5817e7', 1],
  ]
    .map(([id, k]) => {
      try {
        return keyframe(join(STORAGE, 'runs', String(id)), Number(k));
      } catch {
        return undefined;
      }
    })
    .filter((p): p is string => !!p);
  return { paths, source: 'ningún tema del Estudio tiene referencias: se usan K02 de la Dark y K01 de la Pastel de referencia' };
}

async function probeOpenAi() {
  const key = need('OPENAI_API_KEY');
  const dir = await outDir('openai');
  const report: Record<string, unknown> = { provider: 'openai', model: env.IMAGE_MODEL, quality: env.IMAGE_QUALITY };
  console.log(`\n▶ OpenAI · ${env.IMAGE_MODEL} · calidad ${env.IMAGE_QUALITY} · 2560×1440`);
  const promptFile = join(STORAGE, 'runs', DEFAULT_RUN, 'prompts', 'K01_imagen_v1.md');
  const prompt = existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : 'A clean 16:9 educational title card that reads exactly "MÓDULO 1" in bold sans-serif, glossy 3D glass bacteria, deep midnight-blue background with cyan accents.';
  report.prompt = existsSync(promptFile) ? `K01_imagen_v1.md de ${DEFAULT_RUN}` : 'prompt corto de prueba';
  const images = new OpenAiImages(key, env.IMAGE_MODEL, env.IMAGE_QUALITY, 1);

  // 1) Generación (el mismo código que el pipeline; se añaden las cabeceras de límites con una consulta aparte)
  try {
    const lim = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(env.IMAGE_MODEL)}`, { headers: { authorization: `Bearer ${key}` } });
    report.modelAccess = { status: lim.status, body: (await lim.text()).slice(0, 300) };
    line('Acceso al modelo', lim.status === 200 ? 'SÍ' : `NO (HTTP ${lim.status})`);
  } catch (e) {
    report.modelAccess = { error: causeOf(e) };
    line('Acceso al modelo', `sin respuesta: ${causeOf(e)}`);
  }

  const t0 = Date.now();
  const [gen] = await images.generate([{ key: 'gen', prompt, outBase: join(dir, 'generacion') }]);
  const genMs = Date.now() - t0;
  const genInfo = gen.path ? await videoInfo(gen.path).catch(() => undefined) : undefined;
  report.generation = { ms: genMs, error: gen.error, usage: gen.usage, size: genInfo && `${genInfo.width}x${genInfo.height}`, costUsd: openAiCost(gen.usage) };

  // 2) Edición con referencias de estilo (/v1/images/edits, ADR-019)
  const refs = styleReferences();
  report.references = refs;
  let edit: Awaited<ReturnType<OpenAiImages['generate']>>[number] | undefined;
  let editMs = 0;
  if (refs.paths.length) {
    const t1 = Date.now();
    [edit] = await images.generate([{ key: 'edit', prompt, references: refs.paths, outBase: join(dir, 'con_referencias') }]);
    editMs = Date.now() - t1;
    const editInfo = edit.path ? await videoInfo(edit.path).catch(() => undefined) : undefined;
    report.edit = { ms: editMs, error: edit.error, usage: edit.usage, size: editInfo && `${editInfo.width}x${editInfo.height}`, costUsd: openAiCost(edit.usage) };
  }

  console.log('\n  RESULTADO OpenAI');
  line('Generación', gen.error ? `ERROR: ${gen.error.slice(0, 300)}` : `OK · ${secs(genMs)} · ${genInfo?.width}x${genInfo?.height} (generacion.png)`);
  if (!gen.error) line('  uso / costo', `${JSON.stringify(gen.usage)} · ${usd(openAiCost(gen.usage))}`);
  line('Referencias', `${refs.paths.map((p) => basename(p)).join(', ') || 'ninguna'} (${refs.source})`);
  if (edit) {
    line('/images/edits', edit.error ? `ERROR: ${edit.error.slice(0, 300)}` : `OK · ${secs(editMs)} (con_referencias.png)`);
    if (!edit.error) line('  uso / costo', `${JSON.stringify(edit.usage)} · ${usd(openAiCost(edit.usage))}`);
  }
  await saveReport(dir, report);
}

// ───────────────────────────────────────────────────────────── MiniMax

async function probeMiniMax() {
  const key = need('MINIMAX_API_KEY');
  const runId = argValue('--run') ?? DEFAULT_RUN;
  const runDir = join(STORAGE, 'runs', runId);
  const dir = await outDir('minimax');
  const start = keyframe(runDir, 0);
  const end = keyframe(runDir, 1);
  const promptFile = join(runDir, 'prompts', 'clip01_video.md');
  const prompt = existsSync(promptFile)
    ? readFileSync(promptFile, 'utf8')
    : 'Smooth motion-graphics transition from the first frame to the last frame; lands EXACTLY on the provided end frame composition. No camera shake at the end.';
  const report: Record<string, unknown> = {
    provider: 'minimax',
    model: env.MINIMAX_VIDEO_MODEL,
    baseUrl: env.MINIMAX_BASE_URL,
    seconds: env.CLIP_SECONDS,
    run: runId,
    frames: { start: basename(start), end: basename(end) },
    prompt: existsSync(promptFile) ? `clip01_video.md de ${runId}` : 'prompt corto de prueba',
    framesSentAs: 'data URL JPEG (ADR-001)',
  };
  console.log(`\n▶ MiniMax · ${env.MINIMAX_VIDEO_MODEL} · 2K · ${env.CLIP_SECONDS} s · ${basename(start)} → ${basename(end)} de ${runId}`);
  console.log('  Enviando con los fotogramas incrustados como data URL… (el clip suele tardar 5–10 min; no cierres la Terminal)');

  const video = new MiniMaxVideo(key, env.MINIMAX_VIDEO_MODEL, env.MINIMAX_BASE_URL, env.CLIP_SECONDS, 1);
  const t0 = Date.now();
  const timer = setInterval(() => console.log(`  … ${Math.round((Date.now() - t0) / 60000)} min`), 60_000);
  const [r] = await video.generate([{ key: 'clip01', prompt, start: { ref: start, path: start }, end: { ref: end, path: end }, outPath: join(dir, 'clip01_ia.mp4') }]);
  clearInterval(timer);
  const ms = Date.now() - t0;
  report.ms = ms;
  report.taskId = r.jobId;
  if (r.error || !r.path) {
    report.error = r.error;
    console.log('\n  RESULTADO MiniMax');
    line('Clip', `ERROR tras ${secs(ms)}: ${r.error}`);
    line('Siguiente paso', /image|url|base64|frame/i.test(r.error ?? '') ? 'data URL rechazada → subir los frames con la file API (mm_file://)' : 'revisar el error');
    await saveReport(dir, report);
    return;
  }
  const task = r.jobId
    ? await fetchJson<{ task?: Record<string, unknown> }>(`${env.MINIMAX_BASE_URL}/v2/query/video_generation/${r.jobId}`, { headers: { authorization: `Bearer ${key}` } }).catch(() => undefined)
    : undefined;
  const info = await videoInfo(r.path);
  const ssimStart = await ssimAgainst(r.path, 0, start);
  const ssimEnd = await ssimAgainst(r.path, 'last', end);
  const usage = (task?.task?.usage ?? {}) as { output_seconds?: number; total_seconds?: number };
  const billedSec = usage.output_seconds ?? usage.total_seconds ?? info.durationSec;
  Object.assign(report, { task: task?.task, video: info, ssimStart, ssimEnd, billedSec, costUsd: billedSec * PRICES.minimaxPerSecond2k });

  console.log('\n  RESULTADO MiniMax');
  line('Clip', `OK · ${secs(ms)} (clip01_ia.mp4) · task ${r.jobId}`);
  line('Frames como data URL', 'ACEPTADOS');
  line('Frames entregados', `${info.frames} a ${info.fps} fps = ${info.durationSec.toFixed(3)} s (Higgsfield: 124 f / 5,167 s)`);
  line('Resolución / audio', `${info.width}x${info.height} · ${info.codec} · audio nativo: ${info.audio ? 'sí' : 'no'}`);
  line('SSIM inicio / fin', `${ssimStart?.toFixed(3) ?? '—'} / ${ssimEnd?.toFixed(3) ?? '—'} (umbral observado ≥ 0,98)`);
  line('Uso facturado', `${JSON.stringify(task?.task?.usage ?? null)}`);
  line('Costo estimado', `${usd(billedSec * PRICES.minimaxPerSecond2k)} (${billedSec} s × US$ ${PRICES.minimaxPerSecond2k}/s)`);
  await saveReport(dir, report);
}

// ───────────────────────────────────────────────────────────── Anthropic

async function probeAnthropic() {
  const key = need('ANTHROPIC_API_KEY');
  const dir = await outDir('anthropic');
  const client = new Anthropic({ apiKey: key });
  console.log(`\n▶ Anthropic · ${env.ANTHROPIC_MODEL}`);
  const t0 = Date.now();
  const msg = await client.messages.create({ model: env.ANTHROPIC_MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'Responde solo: OK' }] });
  const ms = Date.now() - t0;
  const cost = (msg.usage.input_tokens * PRICES.anthropicInPerM + msg.usage.output_tokens * PRICES.anthropicOutPerM) / 1e6;
  console.log('\n  RESULTADO Anthropic');
  line('Respuesta / tiempo', `${msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')} · ${secs(ms)}`);
  line('Uso', msg.usage);
  line('Costo (precio de lista)', `${usd(cost)} (US$ ${PRICES.anthropicInPerM}/M entrada, US$ ${PRICES.anthropicOutPerM}/M salida)`);
  await saveReport(dir, { provider: 'anthropic', model: env.ANTHROPIC_MODEL, id: msg.id, ms, usage: msg.usage, costUsd: cost });
}

const PROBES: Record<string, () => Promise<void>> = { elevenlabs: probeElevenLabs, openai: probeOpenAi, minimax: probeMiniMax, anthropic: probeAnthropic };

async function main() {
  const fn = provider ? PROBES[provider] : undefined;
  if (!fn) {
    console.log('Uso: pnpm api:probe <elevenlabs|openai|minimax|anthropic> [opciones]');
    process.exit(1);
  }
  await fn();
}

main().catch((e: Error) => {
  console.error(`\n✖ ${redact(causeOf(e))}`);
  process.exit(1);
});
