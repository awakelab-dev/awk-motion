import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isOriginalQuality, ORIGINAL_QUALITY, type ExportQuality, type LogoSettings } from '@wilox/shared';
import { MediaService } from '../storage/media.service.js';
import { QueueService } from '../queue/queue.service.js';
import { burnFilter, logoRuns, renderLogo, type LogoRun } from './burn.js';
import { DeliveryService } from './delivery.service.js';
import { crfOf, runWithProgress, tag } from './exports.service.js';

/** Cambia si cambia cómo se dibuja el logo: las versiones ya hechas se rehacen. */
export const BURN_FORMAT = 1;

interface Plan {
  final: string;
  base: string;
  dir: string;
  durationSec: number;
  logo: { content: Buffer; mime: 'image/png' | 'image/svg+xml' };
  settings: LogoSettings;
  runs: LogoRun[];
  q: ExportQuality;
  sig: string;
}

/**
 * Versiones del final con el logo del proyecto dibujado (hito 9, T2, ADR-102), en la calidad elegida. Se codifican
 * por la cola de ffmpeg (como las versiones reducidas de ADR-084) y quedan en `exports/` junto al final con una
 * huella de lo que dibujan (logo, ajustes, esquinas por clip y calidad): si algo cambia, la huella cambia y se
 * rehace; las de otra huella del mismo final y calidad se borran.
 */
@Injectable()
export class LogoBurnService {
  private readonly jobs = new Map<string, Promise<string>>();
  private readonly progress = new Map<string, number>();

  constructor(
    private readonly delivery: DeliveryService,
    private readonly queue: QueueService,
    private readonly media: MediaService,
  ) {}

  /** Lo que se dibujaría hoy (o undefined si el proyecto no tiene logo). */
  private async plan(id: string, ownerId: string, quality: ExportQuality | undefined): Promise<Plan | undefined> {
    const q = quality ?? ORIGINAL_QUALITY;
    const f = await this.delivery.finalFile(id, ownerId, { local: false });
    const logo = await this.delivery.logoFile(f.projectId, ownerId);
    if (!logo) return undefined;
    const v = await this.delivery.video(id, ownerId);
    const runs = logoRuns(v.clips, v.clipCorners, v.settings.corner, v.durationSec);
    const content = await readFile(logo.path);
    const mime = logo.mime as Plan['logo']['mime'];
    const sig = createHash('sha1')
      .update(JSON.stringify({ v: BURN_FORMAT, logo: createHash('sha1').update(content).digest('hex'), mime, settings: v.settings, runs, q: tag(q) }))
      .digest('hex')
      .slice(0, 12);
    return { final: f.path, base: basename(f.path, '.mp4'), dir: dirname(f.path), durationSec: v.durationSec, logo: { content, mime }, settings: v.settings, runs, q, sig };
  }

  /** Huella de lo que se dibujaría hoy (para saber si una publicación con logo quedó atrás). */
  async signature(id: string, ownerId: string, q: ExportQuality): Promise<string | undefined> {
    return (await this.plan(id, ownerId, q))?.sig;
  }

  progressOf(id: string, q: ExportQuality): number {
    return this.progress.get(`${id}:${tag(q)}`) ?? 0;
  }

  private fileOf(p: Plan) {
    return join(p.dir, 'exports', `${p.base}_${tag(p.q)}_logo-${p.sig}.mp4`);
  }

  /**
   * El final con el logo dibujado en la calidad pedida (se codifica si hace falta). undefined si el proyecto no
   * tiene logo: quien lo pide usa el video sin logo.
   */
  async ensure(id: string, ownerId: string, q: ExportQuality): Promise<{ path: string; sig: string } | undefined> {
    const p = await this.plan(id, ownerId, q);
    if (!p) return undefined;
    const out = this.fileOf(p);
    await this.media.ensure(out, `${out}.json`, p.final);
    const st = await stat(p.final);
    const key = JSON.stringify({ format: BURN_FORMAT, size: st.size, mtimeMs: Math.round(st.mtimeMs), sig: p.sig });
    if (existsSync(out) && existsSync(`${out}.json`) && (await readFile(`${out}.json`, 'utf8')) === key) return { path: out, sig: p.sig };
    const k = `${id}:${tag(q)}`;
    let job = this.jobs.get(k);
    if (!job) {
      job = this.encode(id, ownerId, p, out, key, k).finally(() => this.jobs.delete(k));
      this.jobs.set(k, job);
    }
    return { path: await job, sig: p.sig };
  }

  private async encode(id: string, ownerId: string, p: Plan, out: string, key: string, k: string): Promise<string> {
    this.progress.set(k, 0);
    const exports = join(p.dir, 'exports');
    await mkdir(exports, { recursive: true });
    // Las versiones con logo de otra huella (mismo final y calidad) ya no sirven.
    const prefix = `${p.base}_${tag(p.q)}_logo-`;
    for (const f of await readdir(exports).catch(() => [] as string[]))
      if (f.startsWith(prefix) && !f.startsWith(basename(out))) {
        await rm(join(exports, f), { force: true });
        await this.media.removed(join(exports, f));
      }
    const height = p.q.height;
    const width = Math.round((height * 16) / 9 / 2) * 2;
    const layer = await renderLogo(p.logo.content, p.logo.mime, p.settings, width);
    const png = `${out}.logo.tmp.png`;
    // Temporal en .part: no se sube y la limpieza de las versiones reducidas no lo toca mientras se codifica.
    const tmp = `${out}.burn.part`;
    await writeFile(png, layer.png);
    const filter = burnFilter({ runs: p.runs, layer, settings: p.settings, videoWidth: width, videoHeight: height, scale: height !== 1440 });
    const crf = isOriginalQuality(p.q) ? crfOf({ height: 1440, compression: 'high' }) : crfOf(p.q);
    const args = [
      '-i', p.final,
      '-loop', '1', '-framerate', '24', '-t', p.durationSec.toFixed(3), '-i', png,
      '-filter_complex', filter,
      '-map', '[v]', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', '-f', 'mp4', tmp,
    ];
    try {
      await this.queue.run({ resource: 'ffmpeg', kind: 'export', target: `${p.base} ${tag(p.q)} con logo`, ownerId, generationId: id, priority: Date.now() }, async () => {
        await runWithProgress(args, p.durationSec, (x) => this.progress.set(k, x));
      });
      await rename(tmp, out);
      await writeFile(`${out}.json`, key);
      this.media.dirty(out);
    } finally {
      await rm(png, { force: true });
      await rm(tmp, { force: true });
    }
    this.progress.set(k, 1);
    return out;
  }
}
