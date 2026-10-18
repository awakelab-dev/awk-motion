/**
 * pnpm elevenlabs:purge: limpia el historial de ElevenLabs.
 *
 * Modo Wilox (ADR-120): borra las locuciones que generó Wilox Motion y que quedaron en el historial porque el borrado
 * automático falló (ADR-040; la clave no tenía `speech_history_write`).
 *   (sin flag)  solo cuenta: cuántas locuciones de Wilox siguen en el historial
 *   --borrar    las borra
 * Solo toca elementos cuyo `request_id` es el de un trabajo de locución de Wilox (`GenerationJob.externalId`); lo que
 * se haga a mano en la web de ElevenLabs no se toca.
 *
 * Modo voz (hito 10, ADR-127): todas las locuciones de una voz (de Wilox y hechas a mano en la web), conservando las
 * N más recientes.
 *   --voz "<nombre o voice_id>" [--conservar N]   solo lista: cuántas hay, cuáles se conservan y cuáles se borrarían
 *   … --borrar                                      borra las que no se conservan
 * La voz se busca por su nombre en las voces de la cuenta; si no aparece, se pasa su voice_id (el comando lista los
 * voice_id del historial para encontrarlo). Las de Wilox que se borran quedan marcadas en la BD como `deleted`.
 *
 * La clave necesita `speech_history_read` y `speech_history_write`.
 */
import { createDb, Prisma } from '@wilox/db';
import { env } from '../src/config/env.js';

/** Solo para pruebas con una API simulada. */
const BASE = process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io';
const args = process.argv.slice(2);
const apply = args.includes('--borrar');
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const voiceArg = arg('--voz');
const keepArg = arg('--conservar');
if (!env.ELEVENLABS_API_KEY) {
  console.error('Falta ELEVENLABS_API_KEY en el .env.');
  process.exit(1);
}
if (args.includes('--voz') && !voiceArg) {
  console.error('Falta la voz: --voz "Karla Chilena" (o su voice_id).');
  process.exit(1);
}
const keep = keepArg === undefined ? 0 : Number(keepArg);
if (!Number.isInteger(keep) || keep < 0) {
  console.error('--conservar debe ser un número entero ≥ 0.');
  process.exit(1);
}
const headers = { 'xi-api-key': env.ELEVENLABS_API_KEY };
const db = createDb(env.DATABASE_URL);

interface HistoryItem {
  history_item_id: string;
  request_id?: string;
  voice_id?: string;
  voice_name?: string;
  date_unix?: number;
  text?: string;
}

const permission = (status: number, body: string) =>
  status === 401 || status === 403 ? ` (¿falta un permiso en la clave? ${/missing the permission (\w+)/.exec(body)?.[1] ?? body.slice(0, 160)})` : '';

const fmtDate = (unix?: number) =>
  unix ? new Date(unix * 1000).toLocaleString('es-CL', { timeZone: process.env.TZ || 'America/Fortaleza', dateStyle: 'short', timeStyle: 'short' }) : 'sin fecha';
const snippet = (t?: string) => (t ?? '').replace(/\s+/g, ' ').slice(0, 60);

/** Recorre el historial de la cuenta (opcionalmente solo de una voz). */
async function readHistory(voiceId?: string): Promise<HistoryItem[]> {
  const out: HistoryItem[] = [];
  let after: string | undefined;
  for (let page = 0; page < 200; page++) {
    const q = new URLSearchParams({
      page_size: '1000',
      ...(voiceId ? { voice_id: voiceId } : {}),
      ...(after ? { start_after_history_item_id: after } : {}),
    });
    const res = await fetch(`${BASE}/v1/history?${q}`, { headers, signal: AbortSignal.timeout(60_000) });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} al leer el historial${permission(res.status, body)}`);
    const h = JSON.parse(body) as { history: HistoryItem[]; has_more?: boolean; last_history_item_id?: string };
    out.push(...h.history);
    if (!h.has_more || !h.last_history_item_id) break;
    after = h.last_history_item_id;
  }
  return out;
}

/** Borra elementos del historial; corta al primer error de permisos. Devuelve los borrados. */
async function deleteItems(items: HistoryItem[]): Promise<HistoryItem[]> {
  const done: HistoryItem[] = [];
  let failed = 0;
  for (const [n, it] of items.entries()) {
    const res = await fetch(`${BASE}/v1/history/${encodeURIComponent(it.history_item_id)}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(30_000) });
    if (res.ok) done.push(it);
    else {
      failed++;
      const body = await res.text();
      console.log(`  ✗ ${it.history_item_id}: HTTP ${res.status}${permission(res.status, body)}`);
      if (res.status === 401 || res.status === 403) break;
    }
    if ((n + 1) % 100 === 0) console.log(`  … ${n + 1} de ${items.length}`);
  }
  console.log(`Borradas: ${done.length}${failed ? ` · con error: ${failed}` : ''}.`);
  return done;
}

/** Marca como borrados en la BD los trabajos de locución de Wilox de esos request_id. */
async function markDeleted(requestIds: string[]) {
  if (!requestIds.length) return 0;
  const jobs = await db.generationJob.findMany({
    where: { kind: 'tts', provider: 'elevenlabs', externalId: { in: requestIds } },
    select: { id: true, usage: true },
  });
  for (const j of jobs) {
    await db.generationJob.update({ where: { id: j.id }, data: { usage: { ...((j.usage ?? {}) as Record<string, unknown>), history: 'deleted' } as Prisma.InputJsonValue } });
  }
  return jobs.length;
}

/** voice_id de una voz por su nombre (voces de la cuenta) o el valor tal cual si ya parece un voice_id. */
async function resolveVoice(v: string): Promise<{ id: string; name?: string } | undefined> {
  const q = new URLSearchParams({ page_size: '100', search: v });
  const res = await fetch(`${BASE}/v2/voices?${q}`, { headers, signal: AbortSignal.timeout(30_000) });
  if (res.ok) {
    const r = (await res.json()) as { voices: { voice_id: string; name: string }[] };
    const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
    const exact = r.voices.filter((x) => norm(x.name) === norm(v));
    const hit = exact.length === 1 ? exact[0] : r.voices.length === 1 ? r.voices[0] : r.voices.find((x) => x.voice_id === v);
    if (hit) return { id: hit.voice_id, name: hit.name };
    if (r.voices.length > 1) {
      console.log(`Hay varias voces que coinciden con «${v}»:`);
      for (const x of r.voices) console.log(`  · ${x.name} → ${x.voice_id}`);
      return undefined;
    }
  }
  if (/^[A-Za-z0-9]{16,32}$/.test(v)) return { id: v };
  return undefined;
}

/** Ayuda para encontrar el voice_id: los del historial, con su nombre cuando la API lo da. */
async function listHistoryVoices() {
  const all = await readHistory();
  const by = new Map<string, { names: Set<string>; n: number; last: number }>();
  for (const it of all) {
    const k = it.voice_id ?? '(sin voice_id)';
    const e = by.get(k) ?? { names: new Set<string>(), n: 0, last: 0 };
    e.n++;
    if (it.voice_name) e.names.add(it.voice_name);
    e.last = Math.max(e.last, it.date_unix ?? 0);
    by.set(k, e);
  }
  console.log(`Voces en el historial (${all.length} elementos):`);
  for (const [id, e] of [...by].sort((a, b) => b[1].n - a[1].n))
    console.log(`  · ${id} · ${e.n} locuciones · última ${fmtDate(e.last)} · ${[...e.names].join(', ') || 'sin nombre en la API'}`);
  console.log('\nRepite con --voz <voice_id>.');
}

async function purgeVoice() {
  const voice = await resolveVoice(voiceArg!);
  if (!voice) {
    console.log(`No encontré la voz «${voiceArg}» en las voces de la cuenta.`);
    await listHistoryVoices();
    process.exitCode = 1;
    return;
  }
  const items = (await readHistory(voice.id)).filter((x) => !x.voice_id || x.voice_id === voice.id);
  items.sort((a, b) => (b.date_unix ?? 0) - (a.date_unix ?? 0));
  const kept = items.slice(0, keep);
  const doomed = items.slice(keep);

  const wiloxIds = new Set(
    (
      await db.generationJob.findMany({
        where: { kind: 'tts', provider: 'elevenlabs', externalId: { in: items.map((x) => x.request_id).filter((x): x is string => !!x) } },
        select: { externalId: true },
      })
    ).map((j) => j.externalId!),
  );
  const isWilox = (x: HistoryItem) => !!x.request_id && wiloxIds.has(x.request_id);
  const origin = (list: HistoryItem[]) => {
    const w = list.filter(isWilox).length;
    return `${w} de Wilox · ${list.length - w} hechas a mano`;
  };

  console.log(`Voz: ${voice.name ?? '(sin nombre)'} · ${voice.id}`);
  console.log(`En el historial: ${items.length} locuciones (${origin(items)}).`);
  if (!items.length) return;
  console.log(`Se conservan las ${kept.length} más recientes (${origin(kept)})${kept.length ? `: del ${fmtDate(kept[kept.length - 1].date_unix)} al ${fmtDate(kept[0].date_unix)}` : ''}.`);
  console.log(`Se ${apply ? 'borran' : 'borrarían'} ${doomed.length} (${origin(doomed)})${doomed.length ? `: del ${fmtDate(doomed[doomed.length - 1].date_unix)} al ${fmtDate(doomed[0].date_unix)}` : ''}.`);

  if (!apply) {
    const show = (label: string, list: HistoryItem[]) => {
      if (!list.length) return;
      console.log(`\n${label}`);
      for (const x of list.slice(0, 5)) console.log(`  · ${fmtDate(x.date_unix)} · ${isWilox(x) ? 'Wilox' : 'a mano'} · ${snippet(x.text)}`);
      if (list.length > 5) console.log(`  … y ${list.length - 5} más`);
    };
    show('Las más antiguas que se conservan:', kept.slice(-5).reverse());
    show('Las más recientes que se borrarían:', doomed);
    console.log(doomed.length ? `\nPara borrarlas: pnpm elevenlabs:purge --voz "${voiceArg}" --conservar ${keep} --borrar` : '\nNada que borrar.');
    return;
  }
  if (!doomed.length) {
    console.log('Nada que borrar.');
    return;
  }
  const done = await deleteItems(doomed);
  const marked = await markDeleted(done.filter(isWilox).map((x) => x.request_id!));
  if (marked) console.log(`Marcadas como borradas en la BD: ${marked} locuciones de Wilox.`);
}

async function purgeWilox() {
  // Trabajos de locución de Wilox que no quedaron borrados.
  const jobs = await db.generationJob.findMany({
    where: { kind: 'tts', provider: 'elevenlabs', externalId: { not: null } },
    select: { id: true, externalId: true, usage: true },
  });
  const pending = new Set<string>();
  for (const j of jobs) {
    const h = (j.usage as { history?: string } | null)?.history;
    if (h === 'deleted' || h === 'zero-retention' || h === 'kept') continue;
    pending.add(j.externalId!);
  }
  console.log(`Locuciones de Wilox sin borrar según la base: ${pending.size} (de ${jobs.length}).`);
  if (!pending.size) return;

  const all = await readHistory();
  const found = all.filter((x) => x.request_id && pending.has(x.request_id));
  console.log(`Historial revisado: ${all.length} elementos; de Wilox: ${found.length}.`);
  if (!apply) {
    for (const f of found.slice(0, 10)) console.log(`  · ${snippet(f.text)}`);
    if (found.length > 10) console.log(`  … y ${found.length - 10} más`);
    console.log(found.length ? '\nPara borrarlas: pnpm elevenlabs:purge --borrar' : '\nNada que borrar.');
    return;
  }
  const done = await deleteItems(found);
  await markDeleted(done.map((x) => x.request_id!));
  // Las que ya no están en el historial (borradas a mano en la web) quedan como antes en la base: no se pueden confirmar.
}

try {
  if (voiceArg) await purgeVoice();
  else await purgeWilox();
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
