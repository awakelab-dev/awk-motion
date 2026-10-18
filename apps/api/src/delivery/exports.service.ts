import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Db } from '@wilox/db';
import { EXPORT_COMPRESSIONS, isOriginalQuality, type ExportEstimate, type ExportQuality } from '@wilox/shared';
import { env, repoPath } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { ffmpeg, ffprobe } from '../media/ffmpeg.js';
import { MediaService } from '../storage/media.service.js';
import { QueueService } from '../queue/queue.service.js';

/**
 * Versiones reducidas del final para las descargas (hito 7, ADR-084): resolución (1440p original, 1080p,
 * 720p, 480p) y compresión (H.264 CRF 18 / 23 / 28, preset slow, AAC 128 kbps). El original no se toca: la
 * versión reducida se codifica al pedirla, por la cola de ffmpeg, y queda en `exports/` junto al final para
 * reutilizarla si se pide igual. Al hacer un final nuevo, las del final anterior se borran (la próxima vez).
 */
export const EXPORT_FORMAT = 1;
const AUDIO_BPS = 128_000;
/** Las muestras dejan fuera los fotogramas clave (ADR-084): factor medido con dos finales reales (±3 %). */
const KEYFRAME_FACTOR = 1.12;
const SAMPLES = 6;
const SAMPLE_SEC = 2;

export const crfOf = (q: ExportQuality) => EXPORT_COMPRESSIONS.find((c) => c.id === q.compression)!.crf;
export const tag = (q: ExportQuality) => `${q.height}p_${q.compression}`;

/** Video de una versión reducida: escala (sin escalar si es 1440p) y H.264 con su CRF. */
const videoArgs = (q: ExportQuality) => [
  ...(q.height === 1440 ? [] : ['-vf', `scale=-2:${q.height}:flags=lanczos`]),
  '-c:v',
  'libx264',
  '-preset',
  'slow',
  '-crf',
  String(crfOf(q)),
  '-pix_fmt',
  'yuv420p',
  '-profile:v',
  'high',
];

/** Argumentos de ffmpeg para una versión reducida del final. */
export function exportArgs(input: string, q: ExportQuality, out: string): string[] {
  return ['-i', input, '-map', '0:v:0', '-map', '0:a:0?', ...videoArgs(q), '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', out];
}

/** Una muestra de 2 s (solo video) para estimar el peso. */
export const sampleArgs = (input: string, q: ExportQuality, t: number, out: string) => ['-ss', t.toFixed(3), '-t', String(SAMPLE_SEC), '-i', input, '-an', ...videoArgs(q), out];

/** ffmpeg con avance (0–1) según el tiempo codificado frente a la duración. */
export function runWithProgress(args: string[], durationSec: number, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-nostats', '-progress', 'pipe:1', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let buf = '';
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) {
        const m = l.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m && durationSec > 0) onProgress(Math.min(0.99, Number(m[1]) / 1e6 / durationSec));
      }
    });
    p.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg (versión reducida) salió con código ${code}\n${err}`))));
  });
}

interface Source {
  id: string;
  ownerId: string;
  dir: string;
  final: string;
  base: string;
  durationSec: number;
  size: number;
  mtimeMs: number;
}

@Injectable()
export class ExportsService {
  private readonly jobs = new Map<string, Promise<string>>();
  private readonly progress = new Map<string, number>();
  private readonly estimates = new Map<string, Promise<ExportEstimate>>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly queue: QueueService,
    private readonly media: MediaService,
  ) {}

  private async source(id: string, _ownerId: string): Promise<Source> {
    // Hito 11 (ADR-142): el acceso lo comprueba quien llama; el trabajo de ffmpeg se anota al dueño del video.
    const g = await this.db.generation.findFirst({ where: { id }, select: { id: true, ownerId: true, dir: true, finalPath: true, finalFrames: true, totalFrames: true } });
    if (!g) throw new NotFoundException('Video no encontrado.');
    if (!g.finalPath) throw new BadRequestException('El video aún no tiene final.');
    const dir = join(repoPath(env.STORAGE_DIR), g.dir);
    const final = join(dir, g.finalPath);
    // Si la carpeta del video salió de la caché local, se baja el final (hito 8, ADR-093).
    await this.media.ensure(final);
    if (!existsSync(final)) throw new NotFoundException('No se encontró el archivo del final.');
    const st = await stat(final);
    return { id: g.id, ownerId: g.ownerId, dir, final, base: basename(g.finalPath, '.mp4'), durationSec: (g.finalFrames ?? g.totalFrames ?? 0) / 24, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  }

  private fileOf(s: Source, q: ExportQuality) {
    return join(s.dir, 'exports', `${s.base}_${tag(q)}.mp4`);
  }

  private keyOf(s: Source, q: ExportQuality) {
    return JSON.stringify({ format: EXPORT_FORMAT, size: s.size, mtimeMs: s.mtimeMs, q: tag(q) });
  }

  /** La versión ya hecha y vigente (o undefined). */
  private async cached(s: Source, q: ExportQuality): Promise<string | undefined> {
    const f = this.fileOf(s, q);
    await this.media.ensure(f, `${f}.json`);
    if (!existsSync(f) || !existsSync(`${f}.json`)) return undefined;
    return (await readFile(`${f}.json`, 'utf8')) === this.keyOf(s, q) ? f : undefined;
  }

  /** Avance (0–1) de una versión que se está codificando; 1 si ya está. */
  progressOf(id: string, q: ExportQuality): number {
    return this.progress.get(`${id}:${tag(q)}`) ?? 0;
  }

  /** Archivo del video para una descarga: el final tal cual o su versión reducida (se codifica si hace falta). */
  async ensure(id: string, ownerId: string, q: ExportQuality | undefined): Promise<string> {
    const s = await this.source(id, ownerId);
    if (isOriginalQuality(q)) return s.final;
    const hit = await this.cached(s, q!);
    if (hit) return hit;
    const k = `${id}:${tag(q!)}`;
    let job = this.jobs.get(k);
    if (!job) {
      job = this.encode(s, q!, k).finally(() => this.jobs.delete(k));
      this.jobs.set(k, job);
    }
    return job;
  }

  private async encode(s: Source, q: ExportQuality, k: string): Promise<string> {
    this.progress.set(k, 0);
    const out = this.fileOf(s, q);
    await mkdir(join(s.dir, 'exports'), { recursive: true });
    await this.cleanup(s);
    const tmp = `${out}.tmp.mp4`;
    await this.queue.run({ resource: 'ffmpeg', kind: 'export', target: `${s.base} ${tag(q)}`, ownerId: s.ownerId, generationId: s.id, priority: Date.now() }, async () => {
      await runWithProgress(exportArgs(s.final, q, tmp), s.durationSec, (p) => this.progress.set(k, p));
    });
    await rename(tmp, out);
    await writeFile(`${out}.json`, this.keyOf(s, q));
    this.media.dirty(out);
    this.progress.set(k, 1);
    return out;
  }

  /** Borra las versiones reducidas de finales anteriores (y restos a medias si no hay nada en marcha). */
  private async cleanup(s: Source) {
    const dir = join(s.dir, 'exports');
    const mine = new RegExp(`^${s.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d+p_|estimaciones|muestra)`);
    const busy = [...this.jobs.keys(), ...this.estimates.keys()].some((k) => k.startsWith(`${s.id}:`));
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (!mine.test(f) || (!busy && f.endsWith('.tmp.mp4'))) {
        await rm(join(dir, f), { force: true });
        await this.media.removed(join(dir, f));
      }
    }
  }

  /**
   * Peso estimado (ADR-084). Exacto si es el original o ya está hecha. Si no, se codifican 6 muestras de 2 s con
   * la opción elegida y se comparan con los mismos tramos del original (paquete a paquete, sin decodificar): la
   * proporción × el video original, corregida por los fotogramas clave, más el audio a 128 kbps.
   */
  async estimate(id: string, ownerId: string, q: ExportQuality): Promise<ExportEstimate> {
    const s = await this.source(id, ownerId);
    return (await this.peek(s, q)) ?? this.sampled(s, q);
  }

  /** Lo que se sabe sin codificar: el original, la versión ya hecha o una estimación guardada. */
  private async peek(s: Source, q: ExportQuality): Promise<ExportEstimate | undefined> {
    if (isOriginalQuality(q)) return { bytes: s.size, exact: true };
    const hit = await this.cached(s, q);
    if (hit) return { bytes: (await stat(hit)).size, exact: true };
    const saved = await this.savedEstimates(s);
    const b = saved[this.keyOf(s, q)];
    return b ? { bytes: b, exact: false } : undefined;
  }

  private estimatesFile(s: Source) {
    return join(s.dir, 'exports', `${s.base}_estimaciones.json`);
  }

  private async savedEstimates(s: Source): Promise<Record<string, number>> {
    const f = this.estimatesFile(s);
    await this.media.ensure(f);
    try {
      return existsSync(f) ? (JSON.parse(await readFile(f, 'utf8')) as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  private sampled(s: Source, q: ExportQuality): Promise<ExportEstimate> {
    const key = this.keyOf(s, q);
    const k = `${s.id}:${key}`;
    let job = this.estimates.get(k);
    if (!job) {
      job = this.sample(s, q)
        .then(async (bytes) => {
          await writeFile(this.estimatesFile(s), JSON.stringify({ ...(await this.savedEstimates(s)), [key]: bytes }));
          this.media.dirty(this.estimatesFile(s));
          return { bytes, exact: false };
        })
        .finally(() => this.estimates.delete(k));
      this.estimates.set(k, job);
    }
    return job;
  }

  /**
   * Peso de varios videos (descarga del proyecto): lo ya conocido se suma tal cual; de los demás se muestrean como
   * mucho dos (los más pesados) y su proporción frente al original se aplica al resto.
   */
  async estimateMany(ids: string[], ownerId: string, q: ExportQuality): Promise<ExportEstimate> {
    if (!ids.length) return { bytes: 0, exact: true };
    const srcs = await Promise.all(ids.map((id) => this.source(id, ownerId).catch(() => undefined)));
    let bytes = 0;
    let exact = true;
    const unknown: Source[] = [];
    for (const s of srcs) {
      if (!s) continue;
      const k = await this.peek(s, q);
      if (k) (bytes += k.bytes), (exact &&= k.exact);
      else unknown.push(s);
    }
    if (!unknown.length) return { bytes, exact };
    unknown.sort((a, b) => b.size - a.size);
    const probes = unknown.slice(0, 2);
    let pb = 0;
    let ps = 0;
    for (const s of probes) {
      pb += (await this.sampled(s, q)).bytes;
      ps += s.size;
    }
    const ratio = ps ? pb / ps : 0.5;
    for (const s of unknown.slice(2)) bytes += Math.round(s.size * ratio);
    return { bytes: bytes + pb, exact: false };
  }

  private async sample(s: Source, q: ExportQuality): Promise<number> {
    await mkdir(join(s.dir, 'exports'), { recursive: true });
    await this.cleanup(s);
    return this.queue.run({ resource: 'ffmpeg', kind: 'estimate', target: `${s.base} ${tag(q)}`, ownerId: s.ownerId, generationId: s.id, priority: Date.now() }, async () => {
      const { stdout } = await ffprobe(['-select_streams', 'v', '-show_entries', 'packet=pts_time,size', '-of', 'csv=p=0', s.final]);
      const pk = stdout
        .toString()
        .trim()
        .split('\n')
        .map((l) => l.split(','))
        .map(([t, b]) => [Number(t), Number(b)] as const)
        .filter(([t, b]) => Number.isFinite(t) && Number.isFinite(b))
        .sort((a, b) => a[0] - b[0]);
      const original = pk.reduce((n, [, b]) => n + b, 0);
      const dur = s.durationSec || (pk.at(-1)?.[0] ?? 0);
      const tmp = join(s.dir, 'exports', `${s.base}_muestra.tmp.mp4`);
      let num = 0;
      let den = 0;
      try {
        for (let i = 0; i < SAMPLES; i++) {
          const t = Math.max(0, (dur - SAMPLE_SEC) * ((i + 0.5) / SAMPLES));
          await ffmpeg(sampleArgs(s.final, q, t, tmp));
          const { stdout: so } = await ffprobe(['-select_streams', 'v', '-show_entries', 'packet=size', '-of', 'csv=p=0', tmp]);
          const sizes = so.toString().trim().split('\n').map(Number).filter((n) => n > 0);
          if (sizes.length < 2) continue;
          // Sin el primer fotograma (clave) en los dos lados: el sesgo se corrige con KEYFRAME_FACTOR.
          num += sizes.reduce((a, b) => a + b, 0) - Math.max(...sizes);
          const win = pk.filter(([pt]) => pt >= t && pt < t + SAMPLE_SEC).map(([, b]) => b);
          den += win.slice(1, sizes.length).reduce((a, b) => a + b, 0);
        }
      } finally {
        await rm(tmp, { force: true });
      }
      const ratio = den > 0 ? num / den : 0.5;
      return Math.round(original * ratio * KEYFRAME_FACTOR + (AUDIO_BPS / 8) * dur);
    });
  }
}
