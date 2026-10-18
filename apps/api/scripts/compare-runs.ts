/**
 * Compara dos generaciones (hito 4 · T6, ADR-039): típicamente el mismo texto en modo MCP y en modo API.
 * Lee la BD (Generation, GenerationJob, Clip, Keyframe) y escribe una tabla en markdown.
 *
 *   pnpm compare:runs <id A> <id B>            → imprime la tabla
 *   pnpm compare:runs <id A> <id B> --out f.md → además la guarda en ese archivo (relativo a la raíz)
 *
 * Tiempos: "fase 1" va del primer trabajo al último antes de la aprobación (locución, tiempos, Opus,
 * fotogramas y su revisión); "fase 2" va del primer clip al final del video (clips, SFX, congelados y
 * render). La espera de la aprobación humana no cuenta.
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDb, loadRootEnv, REPO_ROOT, type Db } from '@wilox/db';

loadRootEnv();

const args = process.argv.slice(2);
const ids = args.filter((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out');
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : undefined;

const min = (ms: number) => `${(ms / 60000).toFixed(1)} min`;
const usd = (n: number | undefined) => (n === undefined ? '—' : `US$ ${n.toFixed(2)}`);

interface Summary {
  id: string;
  mode: string;
  theme: string;
  voiceId: string;
  status: string;
  durationSec?: number;
  totalFrames?: number;
  finalFrames?: number;
  exact: string;
  keyframes: number;
  keyframeRegens: number;
  clips: number;
  clipRegens: number;
  deliveredFrames: string;
  ssimStart: string;
  ssimEnd: string;
  phase1Ms?: number;
  phase2Ms?: number;
  totalMs?: number;
  byKind: Record<string, { n: number; failed: number; usd: number; ms: number }>;
  usd: number;
}

/** USD de un trabajo (hito 11, ADR-145, sin créditos): el anotado o, en los de Higgsfield sin USD, sus créditos a la tarifa del plan Ultra. */
const CREDIT_USD = Number(process.env.PRICE_HIGGSFIELD_CREDIT_USD) || 302.5 / 6000;
const jobUsd = (j: { costUsd: unknown; credits: number | null }) => (Number(j.costUsd ?? 0) > 0 ? Number(j.costUsd) : (j.credits ?? 0) * CREDIT_USD);

async function summarize(db: Db, id: string): Promise<Summary> {
  const g = await db.generation.findUnique({ where: { id }, include: { clips: true, keyframes: true, jobs: { orderBy: { startedAt: 'asc' } } } });
  if (!g) throw new Error(`No existe la generación ${id}`);
  const jobs = g.jobs;
  const byKind: Summary['byKind'] = {};
  for (const j of jobs) {
    const k = (byKind[j.kind] ??= { n: 0, failed: 0, usd: 0, ms: 0 });
    k.n += 1;
    if (j.status === 'failed') k.failed += 1;
    k.usd += jobUsd(j);
    k.ms += j.durationMs ?? (j.finishedAt ? j.finishedAt.getTime() - j.startedAt.getTime() : 0);
  }
  const firstVideo = jobs.find((j) => j.kind === 'video');
  const before = firstVideo ? jobs.filter((j) => j.startedAt < firstVideo.startedAt) : jobs;
  const end = (j: (typeof jobs)[number]) => (j.finishedAt ?? j.startedAt).getTime();
  const phase1Ms = before.length ? Math.max(...before.map(end)) - before[0].startedAt.getTime() : undefined;
  const phase2Ms = firstVideo && g.status === 'done' ? g.updatedAt.getTime() - firstVideo.startedAt.getTime() : undefined;
  const cost = jobs.reduce((s, j) => s + jobUsd(j), 0);
  const dfs = g.clips.map((c) => c.deliveredFrames).filter((x): x is number => x != null);
  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? `${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3)} (mín ${Math.min(...v).toFixed(3)})` : '—';
  };
  return {
    id,
    mode: g.mode.toUpperCase(),
    theme: g.themeName ?? g.themeKey,
    voiceId: g.voiceId,
    status: g.status,
    durationSec: g.durationSec ?? undefined,
    totalFrames: g.totalFrames ?? undefined,
    finalFrames: g.finalFrames ?? undefined,
    exact: g.totalFrames != null && g.finalFrames != null ? (g.totalFrames === g.finalFrames ? `sí (${g.finalFrames} f)` : `NO (${g.finalFrames} de ${g.totalFrames} f)`) : '—',
    keyframes: g.keyframes.length,
    keyframeRegens: g.keyframes.reduce((s, k) => s + Math.max(0, k.version - 1), 0),
    clips: g.clips.length,
    clipRegens: g.clips.reduce((s, c) => s + Math.max(0, c.version - 1), 0),
    deliveredFrames: dfs.length ? [...new Set(dfs)].join(', ') : '—',
    ssimStart: avg(g.clips.map((c) => c.ssimStart)),
    ssimEnd: avg(g.clips.map((c) => c.ssimEnd)),
    phase1Ms,
    phase2Ms,
    totalMs: g.status === 'done' ? g.updatedAt.getTime() - g.createdAt.getTime() : undefined,
    byKind,
    usd: cost,
  };
}

function table(a: Summary, b: Summary): string {
  const kinds = ['tts', 'timing', 'llm', 'image', 'upload', 'video'];
  const label: Record<string, string> = { tts: 'Locución', timing: 'Tiempos por palabra', llm: 'Opus', image: 'Fotogramas', upload: 'Subidas', video: 'Clips' };
  const kind = (s: Summary, k: string) => {
    const x = s.byKind[k];
    if (!x) return '—';
    const parts = [`${x.n}${x.failed ? ` (${x.failed} fallidos)` : ''}`];
    if (x.usd) parts.push(usd(x.usd));
    return parts.join(' · ');
  };
  const rows: [string, string, string][] = [
    ['Generación', `\`${a.id}\``, `\`${b.id}\``],
    ['Modo', a.mode, b.mode],
    ['Tema · voz', `${a.theme} · ${a.voiceId}`, `${b.theme} · ${b.voiceId}`],
    ['Estado', a.status, b.status],
    ['Duración de la voz', a.durationSec ? `${a.durationSec.toFixed(2)} s` : '—', b.durationSec ? `${b.durationSec.toFixed(2)} s` : '—'],
    ['Final = voz (frames)', a.exact, b.exact],
    ['Fotogramas (regenerados)', `${a.keyframes} (${a.keyframeRegens})`, `${b.keyframes} (${b.keyframeRegens})`],
    ['Clips (regenerados)', `${a.clips} (${a.clipRegens})`, `${b.clips} (${b.clipRegens})`],
    ['Frames entregados por clip', a.deliveredFrames, b.deliveredFrames],
    ['SSIM inicio (media)', a.ssimStart, b.ssimStart],
    ['SSIM fin (media)', a.ssimEnd, b.ssimEnd],
    ['Fase 1 (hasta la aprobación)', a.phase1Ms ? min(a.phase1Ms) : '—', b.phase1Ms ? min(b.phase1Ms) : '—'],
    ['Fase 2 (clips → final)', a.phase2Ms ? min(a.phase2Ms) : '—', b.phase2Ms ? min(b.phase2Ms) : '—'],
    ['Total con la espera de aprobación', a.totalMs ? min(a.totalMs) : '—', b.totalMs ? min(b.totalMs) : '—'],
    ...kinds.map((k) => [label[k], kind(a, k), kind(b, k)] as [string, string, string]),
    ['Costo total (USD)', usd(a.usd), usd(b.usd)],
  ];
  return ['| | A | B |', '|---|---|---|', ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

async function main() {
  if (ids.length !== 2) {
    console.log('Uso: pnpm compare:runs <id A> <id B> [--out docs/08_mcp_vs_api_tabla.md]');
    process.exit(1);
  }
  const db = createDb();
  try {
    const [a, b] = await Promise.all(ids.map((id) => summarize(db, id)));
    const md = table(a, b);
    console.log(`\n${md}\n`);
    if (out) {
      await writeFile(resolve(REPO_ROOT, out), `${md}\n`);
      console.log(`Guardada en ${out}`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(`✖ ${e.message}`);
  process.exit(1);
});
