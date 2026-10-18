/**
 * pnpm queue:bench (hito 5, ADR-047): prueba de aceptación de la producción por lotes contra la API en
 * marcha (pnpm dev), en el modo que tenga (mock o API).
 *
 *   pnpm queue:bench [--videos 6] [--projects 2] [--theme dark] [--single | --ref-min 8.7] [--correct] [--fail]
 *
 * - Crea 2 proyectos ("Lote <hora> A/B") y lanza los videos seguidos, alternando proyecto, sin esperar.
 * - Aprueba cada video en cuanto queda esperando aprobación (como si lo revisaras al instante).
 * - --correct: cuando el video 1 queda esperando aprobación, corrige K01 con una nota mientras los
 *   demás se procesan; después lo aprueba. Comprueba en la cola que se atendió antes que los trabajos
 *   pendientes de los videos posteriores.
 * - --fail (solo mock): el video 3 lleva la marca [mock:fallar]; queda con error y se reintenta.
 * - --single: antes del lote, hace un video solo para medir el tiempo de referencia; --ref-min usa
 *   un tiempo conocido (8,7 min en API según docs/08).
 * - Puedes reiniciar la API en mitad del lote (Ctrl+C y pnpm dev): el script espera y sigue.
 * Al final: tiempo del lote frente a hacerlos uno tras otro, finales = locución, trabajos pagados dos
 * veces (debe ser 0) y, en mock, los envíos de clips.
 * Credenciales: BENCH_EMAIL y BENCH_PASSWORD (o se piden en la terminal).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb } from '@wilox/db';
import { env, repoPath } from '../src/config/env.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const N = Number(opt('videos', '6'));
const P = Number(opt('projects', '2'));
const THEME = opt('theme', 'dark')!;
const BASE = opt('base', `http://localhost:${env.PORT}`)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TEXTS = [
  'Las infecciones asociadas a la atención de salud son un desafío para todos los equipos clínicos.\n\nPrevenirlas protege a los pacientes y al personal en cada turno.',
  'La higiene de manos es la medida más simple y eficaz para cortar la transmisión.\n\nSe realiza antes y después de cada contacto con el paciente.',
  'Los elementos de protección personal se eligen según el riesgo de cada procedimiento.\n\nUsarlos bien es tan importante como tenerlos disponibles.',
  'La limpieza y desinfección del entorno reduce los reservorios de microorganismos.\n\nSuperficies, equipos y ropa siguen protocolos definidos.',
  'Los dispositivos invasivos aumentan el riesgo de infección si no se manejan con técnica aséptica.\n\nCada día se evalúa si siguen siendo necesarios.',
  'La vigilancia epidemiológica permite detectar brotes a tiempo.\n\nCon datos confiables, el equipo toma mejores decisiones.',
  'La educación continua mantiene al equipo actualizado en las mejores prácticas.\n\nCada capacitación suma seguridad para el paciente.',
  'El aislamiento oportuno evita que un agente se propague dentro del hospital.\n\nLa señalética y la comunicación son clave.',
];

async function ask(q: string): Promise<string> {
  process.stdout.write(q);
  return new Promise((res) => process.stdin.once('data', (d) => res(d.toString().trim())));
}

let cookie = '';
async function call<T>(path: string, init: RequestInit = {}, tries = 200): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`${BASE}/api${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', origin: env.WEB_ORIGIN, ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${path}: ${text.slice(0, 300)}`), { status: res.status });
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (e) {
      const st = (e as { status?: number }).status;
      if (st && st < 500) throw e;
      if (i >= tries) throw e;
      if (i === 0) console.log(`  … la API no responde (${(e as Error).message.split('\n')[0]}); espero y sigo`);
      await sleep(3000); // reinicio de la API en mitad del lote: se espera y se sigue
    }
  }
}

interface Run {
  id: string;
  status: string;
  message: string;
  totalFrames?: number;
  finalFrames?: number;
  keyframes: { index: number; status: string; version: number; activity?: string }[];
}
interface Track {
  n: number;
  id: string;
  project: string;
  launched: number;
  approved?: number;
  done?: number;
  corrected?: number;
  retried?: boolean;
  last?: Run;
}

async function runVideos(texts: string[], projects: string[], label: string): Promise<{ tracks: Track[]; ms: number }> {
  const t0 = Date.now();
  const tracks: Track[] = [];
  for (const [i, text] of texts.entries()) {
    const project = projects[i % projects.length];
    const r = await call<Run>('/generations', { method: 'POST', body: JSON.stringify({ text, theme: THEME, projectId: project }) });
    tracks.push({ n: i + 1, id: r.id, project, launched: Date.now() });
    console.log(`  ${label} ${i + 1} lanzado: ${r.id}`);
  }
  let lastLine = '';
  for (;;) {
    for (const t of tracks) {
      if (t.done) continue;
      const r = await call<Run>(`/generations/${t.id}`);
      t.last = r;
      if (r.status === 'awaiting_approval' && !t.approved) {
        const regenerating = r.keyframes.some((k) => k.status === 'generating' || k.activity);
        if (flag('correct') && t.n === 1 && label === 'video' && !t.corrected) {
          t.corrected = Date.now();
          console.log(`  video 1: corrijo K01 mientras los demás se procesan…`);
          await call(`/generations/${t.id}/keyframes/1/regenerate`, { method: 'POST', body: JSON.stringify({ note: 'Corrección de prueba del lote: el título más grande y centrado.' }) });
          continue;
        }
        if (!regenerating && r.keyframes.every((k) => k.status === 'ready')) {
          try {
            await call(`/generations/${t.id}/approve`, { method: 'POST' });
            t.approved = Date.now();
          } catch (e) {
            console.log(`  ${label} ${t.n}: aún no se puede aprobar (${(e as Error).message.slice(0, 120)})`);
          }
        }
      }
      if (r.status === 'error' && !t.retried && flag('fail')) {
        console.log(`  ${label} ${t.n} con error (${r.message}); reintento`);
        t.retried = true;
        await call(`/generations/${t.id}/retry`, { method: 'POST' });
      } else if (r.status === 'error' && t.retried) {
        console.log(`  ${label} ${t.n} volvió a fallar: ${r.message}`);
        t.done = Date.now();
      }
      if (r.status === 'done') t.done = Date.now();
    }
    const line = tracks.map((t) => `${t.n}:${t.last?.status ?? '?'}`).join(' ');
    if (line !== lastLine) {
      console.log(`  [${((Date.now() - t0) / 60000).toFixed(1)} min] ${line}`);
      lastLine = line;
    }
    if (tracks.every((t) => t.done)) break;
    await sleep(3000);
  }
  return { tracks, ms: Date.now() - t0 };
}

async function main() {
  const email = process.env.BENCH_EMAIL ?? (await ask('Email: '));
  const password = process.env.BENCH_PASSWORD ?? (await ask('Contraseña: '));
  process.stdin.pause();
  await call('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  const info = await call<{ mode: string }>('/info');
  console.log(`Modo ${info.mode.toUpperCase()} · ${N} videos en ${P} proyectos · tema ${THEME}`);
  const stamp = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
  const projects: string[] = [];
  for (let i = 0; i < P; i++) {
    const p = await call<{ id: string }>('/projects', { method: 'POST', body: JSON.stringify({ name: `Lote ${stamp} ${String.fromCharCode(65 + i)}` }) });
    projects.push(p.id);
  }

  let refMs = opt('ref-min') ? Number(opt('ref-min')) * 60_000 : undefined;
  if (flag('single')) {
    console.log('\nReferencia: un video solo…');
    const single = await runVideos([TEXTS[TEXTS.length - 1]], projects, 'referencia');
    refMs = single.ms;
    console.log(`  un video solo: ${(refMs / 60000).toFixed(2)} min`);
  }

  const texts = Array.from({ length: N }, (_, i) => {
    const t = TEXTS[i % TEXTS.length];
    return flag('fail') && i === 2 ? `${t} [mock:fallar]` : t;
  });
  const mockFile = join(repoPath(env.STORAGE_DIR), 'mock', 'tasks.json');
  const submissions = () => (existsSync(mockFile) ? (JSON.parse(readFileSync(mockFile, 'utf8')) as { submissions: number }).submissions : 0);
  const before = submissions();
  console.log(`\nLote de ${N} videos…`);
  const batch = await runVideos(texts, projects, 'video');

  const db = createDb();
  const ids = batch.tracks.map((t) => t.id);
  console.log('\n──────── Resultado ────────');
  console.log(`Lote: ${(batch.ms / 60000).toFixed(2)} min para ${N} videos (aprobando al instante).`);
  if (refMs) {
    const seq = refMs * N;
    console.log(`Uno tras otro: ≈ ${(seq / 60000).toFixed(2)} min (${N} × ${(refMs / 60000).toFixed(2)} min) → el lote tarda el ${Math.round((batch.ms / seq) * 100)} %.`);
  }
  for (const t of batch.tracks) {
    const r = t.last!;
    const ok = r.status === 'done' && r.finalFrames === r.totalFrames;
    console.log(
      `  ${t.n}. ${t.id} · ${r.status}${r.status === 'done' ? ` · final ${r.finalFrames}/${r.totalFrames} f ${ok ? '✓' : '✗'}` : ` · ${r.message}`} · ${((t.done! - t.launched) / 60000).toFixed(2)} min${t.retried ? ' · reintentado' : ''}`,
    );
  }

  // Trabajos pagados dos veces: el mismo archivo (locución, fotograma o clip de una versión) con más de un éxito.
  const dup = await db.$queryRaw<{ generationId: string; target: string; n: bigint }[]>`
    SELECT "generationId", "target", count(*) AS n FROM "GenerationJob"
    WHERE "generationId" = ANY(${ids}) AND "status" = 'succeeded' AND "kind" IN ('tts', 'image', 'video')
    GROUP BY 1, 2 HAVING count(*) > 1`;
  console.log(dup.length ? `Pagados dos veces: ${dup.map((d) => `${d.generationId} ${d.target} ×${d.n}`).join(', ')} ✗` : 'Pagados dos veces: ninguno ✓');

  if (flag('correct')) {
    const v1 = batch.tracks[0].id;
    const fix = await db.queueTask.findMany({ where: { generationId: v1, kind: { in: ['llm', 'image'] }, target: { in: ['Reescritura del plano', 'K01_v2'] } }, orderBy: { createdAt: 'asc' } });
    for (const f of fix) {
      if (!f.startedAt) continue;
      const overtaken = await db.queueTask.count({
        where: { resource: f.resource, generationId: { in: ids.slice(1) }, createdAt: { lt: f.createdAt }, OR: [{ startedAt: { gt: f.startedAt } }, { startedAt: null }] },
      });
      const jumped = await db.queueTask.count({
        where: { resource: f.resource, generationId: { in: ids.slice(1) }, createdAt: { lt: f.createdAt }, startedAt: { gt: f.createdAt, lt: f.startedAt } },
      });
      const waited = ((f.startedAt.getTime() - f.createdAt.getTime()) / 1000).toFixed(1);
      console.log(
        `Corrección del video 1 · ${f.target} (${f.resource}): esperó ${waited} s; se atendió antes que ${overtaken} trabajo(s) pendientes de videos posteriores; ${jumped} la adelantaron ${jumped ? '✗' : '✓'}`,
      );
    }
  }

  if (info.mode === 'mock') {
    const sent = submissions() - before;
    const clips = await db.clip.count({ where: { generationId: { in: ids } } });
    const extra = await db.clipVersion.count({ where: { clip: { generationId: { in: ids } }, version: { gt: 1 } } });
    console.log(`Mock: ${sent} envíos de clips para ${clips} clips${extra ? ` y ${extra} versiones regeneradas` : ''} ${sent === clips + extra ? '✓' : '✗'}`);
  }
  await db.$disconnect();
}

await main();
process.exit(0);
