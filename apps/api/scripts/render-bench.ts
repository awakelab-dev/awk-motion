/**
 * Antes y después del render (hito 6 · T1, ADR-055), con los clips que ya tiene un video: no llama a
 * ningún proveedor ni gasta créditos. Solo ffmpeg, con la misma concurrencia que la cola
 * (QUEUE_FFMPEG_CONCURRENCY).
 *
 *   pnpm render:bench <id del video>              → mide y compara la calidad en 5 clips
 *   pnpm render:bench <id> --calidad 0            → sin medir la calidad (más rápido)
 *
 * Antes (hitos 1 a 5): cada clip a CRF 14 con sus SFX, congelados a CRF 14 desde el clip ya comprimido y
 * un render final que recodifica todo a CRF 16. Después (hito 6): segmentos ya a CRF 16 (los parámetros
 * del final), congelados desde el frame en bruto y un final que une sin recodificar y solo mezcla el
 * audio. Los SFX se sintetizan una vez y sirven para los dos.
 *
 * Deja todo en storage/bench/<id>/<hora>/ (antes/, despues/, informe.md). El video no se toca.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pLimit from 'p-limit';
import { createDb } from '@wilox/db';
import { FPS, type ThemeStyle } from '@wilox/shared';
import { env, repoPath } from '../src/config/env.js';
import {
  assembleFinal,
  clipFrame,
  countFrames,
  durationSec,
  encodeClipSegment,
  encodeFreeze,
  FIT_2K,
  freeze,
  lastFrame,
  normalizeClip,
  renderFinal,
  run,
} from '../src/media/ffmpeg.js';
import { motionCurve, motionPeaks } from '../src/media/motion.js';
import { planSfx, renderSfx } from '../src/media/sfx.js';
import { MusicService } from '../src/music/music.service.js';
import { segmentsFor, type PlannedClip, type Segment } from '../src/pipeline/timeline.js';

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const QUALITY_CLIPS = Number(opt('calidad', '5'));
if (!id) {
  console.error('Uso: pnpm render:bench <id del video> [--calidad 5]');
  process.exit(1);
}

const nn = (i: number) => String(i).padStart(2, '0');
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = Date.now();
  const r = await fn();
  return [r, Date.now() - t];
}

/** SSIM y PSNR de la ventana de un clip en el final frente al clip en bruto normalizado. */
async function quality(final: string, raw: string, seg: Segment): Promise<{ ssim?: number; psnr?: number }> {
  const n = seg.endFrame - seg.startFrame;
  const { stderr } = await run(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-an',
    '-t',
    (seg.endFrame / FPS + 0.5).toFixed(3),
    '-i',
    final,
    '-an',
    '-i',
    raw,
    '-lavfi',
    `[0:v]trim=start_frame=${seg.startFrame}:end_frame=${seg.endFrame},setpts=PTS-STARTPTS,format=yuv420p,split[a1][a2];` +
      `[1:v]${FIT_2K},fps=${FPS},trim=end_frame=${n},setpts=PTS-STARTPTS,format=yuv420p,split[b1][b2];[a1][b1]ssim;[a2][b2]psnr`,
    '-f',
    'null',
    '-',
  ]);
  const ssim = stderr.match(/All:([0-9.]+)/)?.[1];
  const psnr = stderr.match(/average:([0-9.inf]+)/)?.[1];
  return { ssim: ssim ? Number(ssim) : undefined, psnr: psnr ? Number(psnr) : undefined };
}

async function main() {
  const db = createDb();
  const g = await db.generation.findUnique({ where: { id }, include: { clips: { orderBy: { index: 'asc' } } } });
  if (!g) throw new Error(`No existe el video ${id}.`);
  if (!g.plan || !g.totalFrames) throw new Error('El video no tiene plan: no llegó a los clips.');
  const runDir = repoPath(join(env.STORAGE_DIR, g.dir));
  const plan = g.plan as unknown as PlannedClip[];
  const theme = (g.themeCopy as { style: ThemeStyle }).style;
  const voiceWav = join(runDir, 'voice', 'voz_completa.wav');
  if (!existsSync(voiceWav)) throw new Error(`Falta ${voiceWav}.`);

  // Clips en bruto vigentes (la versión de la BD o, si no está, la más alta en disco).
  const clipsDir = join(runDir, 'clips');
  const files = await readdir(clipsDir);
  const raws: string[] = [];
  for (const c of g.clips) {
    const want = `clip${nn(c.index)}_ia_v${c.version}.mp4`;
    const alt = files.filter((f) => f.startsWith(`clip${nn(c.index)}_ia_v`)).sort((a, b) => Number(b.match(/_v(\d+)/)![1]) - Number(a.match(/_v(\d+)/)![1]))[0];
    const f = files.includes(want) ? want : alt;
    if (!f) throw new Error(`Falta el clip ${c.index} en ${clipsDir}.`);
    raws.push(join(clipsDir, f));
  }
  const delivered = await Promise.all(raws.map(async (r) => Math.floor((await durationSec(r)) * FPS + 1e-3)));
  const segments = segmentsFor(plan, (i) => delivered[i]);
  const music = await new MusicService(db).resolve(g.musicTrack);
  const conc = env.QUEUE_FFMPEG_CONCURRENCY;
  const limit = pLimit(conc);

  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const out = repoPath(join(env.STORAGE_DIR, 'bench', id!, stamp));
  const A = join(out, 'antes');
  const B = join(out, 'despues');
  await mkdir(A, { recursive: true });
  await mkdir(B, { recursive: true });
  console.log(`Video ${id}: ${g.clips.length} clips, ${segments.length} segmentos, ${g.totalFrames} frames (${(g.totalFrames / FPS).toFixed(2)} s).`);
  console.log(`ffmpeg en paralelo: ${conc} · música: ${music ? `${music.name} ${music.volume}` : 'sin música'} · salida: ${out}\n`);

  // SFX (iguales en los dos)
  const clipSegs = segments.filter((s) => s.kind === 'clip');
  const [, sfxMs] = await timed(() =>
    Promise.all(
      clipSegs.map((s) =>
        limit(async () => {
          const frames = s.endFrame - s.startFrame;
          const curve = (await motionCurve(raws[s.clip])).slice(0, frames);
          await renderSfx(planSfx(motionPeaks(curve), frames / FPS, theme.sfx), frames / FPS, join(out, `${s.name}_sound.wav`), 7 + s.clip + 1);
        }),
      ),
    ),
  );
  console.log(`SFX sintetizados (iguales en los dos): ${secs(sfxMs)}`);

  // ── Antes ──
  console.log('Antes: clips a CRF 14, congelados desde el clip comprimido y render que recodifica todo…');
  const [, aPost] = await timed(async () => {
    await Promise.all(clipSegs.map((s) => limit(() => normalizeClip(raws[s.clip], join(out, `${s.name}_sound.wav`), s.endFrame - s.startFrame, join(A, `${s.name}.mp4`)))));
    await Promise.all(
      segments
        .filter((s) => s.kind === 'freeze')
        .map((s) =>
          limit(async () => {
            const png = join(A, `${s.name}_frame.png`);
            await lastFrame(join(A, `${s.name.replace(/ex$/, '')}.mp4`), png);
            await freeze(png, s.endFrame - s.startFrame, join(A, `${s.name}.mp4`));
          }),
        ),
    );
  });
  const aFinal = join(A, 'final.mp4');
  const [, aRender] = await timed(() =>
    renderFinal({ segments: segments.map((s) => join(A, `${s.name}.mp4`)), voiceWav, music: music?.path, musicVolume: music?.volume, totalFrames: g.totalFrames!, output: aFinal }),
  );
  console.log(`  post ${secs(aPost)} · render ${secs(aRender)}`);

  // ── Después ──
  console.log('Después: segmentos a CRF 16 (calidad del final), congelados desde el frame en bruto y unión sin recodificar…');
  const perClip = new Map<number, number>();
  const [, bPost] = await timed(() =>
    Promise.all(
      segments.map((s) =>
        limit(async () => {
          const t = Date.now();
          const frames = s.endFrame - s.startFrame;
          if (s.kind === 'clip') await encodeClipSegment(raws[s.clip], frames, join(B, `${s.name}.mp4`), join(out, `${s.name}_sound.wav`));
          else {
            const c = clipSegs.find((x) => x.clip === s.clip)!;
            const png = join(B, `${s.name}_frame.png`);
            await clipFrame(raws[s.clip], c.endFrame - c.startFrame - 1, png);
            await encodeFreeze(png, frames, join(B, `${s.name}.mp4`));
          }
          perClip.set(s.clip, Math.max(perClip.get(s.clip) ?? 0, Date.now() - t));
        }),
      ),
    ),
  );
  const bFinal = join(B, 'final.mp4');
  const [, bJoin] = await timed(() =>
    assembleFinal({
      segments: segments.map((s) => join(B, `${s.name}.mp4`)),
      listFile: join(B, 'concat.txt'),
      voiceWav,
      sounds: clipSegs.map((s) => ({ wav: join(out, `${s.name}_sound.wav`), startFrame: s.startFrame })),
      music: music?.path,
      musicVolume: music?.volume,
      totalFrames: g.totalFrames!,
      output: bFinal,
    }),
  );
  const slowestClip = Math.max(...perClip.values());
  console.log(`  post ${secs(bPost)} · unión ${secs(bJoin)}`);

  // ── Verificación ──
  const [fa, fb] = await Promise.all([countFrames(aFinal), countFrames(bFinal)]);
  const [sa, sb] = await Promise.all([stat(aFinal), stat(bFinal)]);
  const sample = QUALITY_CLIPS > 0 ? [...new Set(Array.from({ length: Math.min(QUALITY_CLIPS, clipSegs.length) }, (_, k) => Math.round((k * (clipSegs.length - 1)) / Math.max(1, Math.min(QUALITY_CLIPS, clipSegs.length) - 1))))] : [];
  const qa: { ssim?: number; psnr?: number }[] = [];
  const qb: { ssim?: number; psnr?: number }[] = [];
  if (sample.length) console.log(`Calidad frente al clip en bruto en ${sample.length} clips…`);
  for (const k of sample) {
    const s = clipSegs[k];
    const x = await quality(aFinal, raws[s.clip], s);
    const y = await quality(bFinal, raws[s.clip], s);
    qa.push(x);
    qb.push(y);
  }
  const avg = (q: { ssim?: number; psnr?: number }[], k: 'ssim' | 'psnr') => {
    const v = q.map((x) => x[k]).filter((x): x is number => x !== undefined && Number.isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
  };
  const f4 = (n?: number, d = 4) => (n === undefined ? '—' : n.toFixed(d));

  const rows = [
    ['', 'Antes (hitos 1–5)', 'Después (hito 6)'],
    ['Post de todos los clips y congelados', secs(aPost), secs(bPost)],
    ['Render / unión final', secs(aRender), secs(bJoin)],
    ['Total tras tener todos los clips (+ SFX)', secs(aPost + aRender + sfxMs), secs(bPost + bJoin + sfxMs)],
    ['Tras el último clip con el post incremental (T2, estimado)', '—', `≈ ${secs(slowestClip + bJoin)} (su post ${secs(slowestClip)} + unión)`],
    ['Frames del final (locución: ' + g.totalFrames + ')', `${fa}${fa === g.totalFrames ? ' ✓' : ' ✗'}`, `${fb}${fb === g.totalFrames ? ' ✓' : ' ✗'}`],
    ['Peso del final', mb(sa.size), mb(sb.size)],
    ['Compresiones del video', '2 (CRF 14 y CRF 16)', '1 (CRF 16)'],
    ...(sample.length
      ? [
          [`SSIM frente al clip en bruto (${sample.length} clips)`, f4(avg(qa, 'ssim')), f4(avg(qb, 'ssim'))],
          [`PSNR frente al clip en bruto (dB)`, f4(avg(qa, 'psnr'), 2), f4(avg(qb, 'psnr'), 2)],
        ]
      : []),
  ];
  const table = rows.map((r, i) => `| ${r.join(' | ')} |${i === 0 ? '\n|---|---|---|' : ''}`).join('\n');
  const report = `# Render: antes y después · ${id}\n\n${g.clips.length} clips, ${segments.length} segmentos, ${g.totalFrames} frames (${(g.totalFrames / FPS).toFixed(2)} s). ffmpeg en paralelo: ${conc}. ${new Date().toISOString()}\n\n${table}\n\nArchivos: antes/final.mp4 y despues/final.mp4.\n`;
  await writeFile(join(out, 'informe.md'), report);
  console.log(`\n${table}\n\nInforme: ${join(out, 'informe.md')}`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
