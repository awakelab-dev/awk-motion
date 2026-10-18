import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import pLimit from 'p-limit';
import type { Db } from '@wilox/db';
import type { MusicListResponse, MusicTrackInfo } from '@wilox/shared';
import { env, repoPath } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { durationSec, integratedLoudness } from '../media/ffmpeg.js';
import { musicGainDb, musicVolume } from './gain.js';

const AUDIO = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);

/** Track resuelto para el render: archivo, volumen (0.1 con la ganancia de sonoridad) y ganancia aplicada. */
export interface ResolvedMusic {
  name: string;
  path: string;
  volume: number;
  gainDb: number;
}

/**
 * Música de fondo (hito 5, ADR-044). La lista sale de la carpeta (assets/music/ o MUSIC_DIR): un track
 * nuevo aparece sin tocar código. La duración y la sonoridad (LUFS) se miden una vez y se guardan en
 * MusicTrack; si el archivo cambia (tamaño o fecha), se vuelven a medir.
 */
@Injectable()
export class MusicService implements OnModuleInit {
  private readonly logger = new Logger('Music');
  private readonly measuring = new Map<string, Promise<MusicTrackInfo | undefined>>();
  private readonly limit = pLimit(2);

  constructor(@Inject(DB) private readonly db: Db) {}

  /** Carpeta de los tracks. */
  get dir() {
    return env.MUSIC_DIR ? repoPath(env.MUSIC_DIR) : dirname(repoPath(env.MUSIC_PATH));
  }

  /** Track por defecto (MUSIC_PATH) y referencia de volumen. */
  get defaultTrack(): string | null {
    const name = basename(env.MUSIC_PATH);
    return existsSync(join(this.dir, name)) ? name : null;
  }

  onModuleInit() {
    // Mide en segundo plano los tracks nuevos para que el selector abra al instante.
    void this.list().catch((e) => this.logger.warn(`No se pudo leer la música: ${(e as Error).message}`));
  }

  /** Nombre válido de un archivo de la carpeta (sin rutas). */
  private valid(name: string) {
    return !!name && name === basename(name) && !name.startsWith('.') && AUDIO.has(extname(name).toLowerCase());
  }

  /** Ruta del track si existe en la carpeta. */
  pathOf(name: string): string | undefined {
    if (!this.valid(name)) return undefined;
    const p = join(this.dir, name);
    return existsSync(p) ? p : undefined;
  }

  private async measure(name: string): Promise<MusicTrackInfo | undefined> {
    const path = join(this.dir, name);
    const st = await stat(path);
    const row = await this.db.musicTrack.findUnique({ where: { name } });
    if (row && Number(row.sizeBytes) === st.size && Math.abs(row.mtimeMs - st.mtimeMs) < 1)
      return { name, title: name.replace(/\.[^.]+$/, ''), durationSec: row.durationSec, lufs: row.lufs ?? undefined, gainDb: 0 };
    const [dur, lufs] = await this.limit(() => Promise.all([durationSec(path), integratedLoudness(path).catch(() => undefined)]));
    if (!Number.isFinite(dur) || dur <= 0) throw new Error(`No se pudo leer la duración de ${name}`);
    const data = { sizeBytes: BigInt(st.size), mtimeMs: st.mtimeMs, durationSec: dur, lufs: lufs ?? null, measuredAt: new Date() };
    await this.db.musicTrack.upsert({ where: { name }, create: { name, ...data }, update: data });
    this.logger.log(`${name}: ${dur.toFixed(1)} s${lufs !== undefined ? ` · ${lufs.toFixed(1)} LUFS` : ''}`);
    return { name, title: name.replace(/\.[^.]+$/, ''), durationSec: dur, lufs, gainDb: 0 };
  }

  private one(name: string) {
    let p = this.measuring.get(name);
    if (!p) {
      p = this.measure(name)
        .catch((e) => {
          this.logger.warn(`Track ${name} ignorado: ${(e as Error).message}`);
          return undefined;
        })
        .finally(() => this.measuring.delete(name));
      this.measuring.set(name, p);
    }
    return p;
  }

  /** Tracks de la carpeta, por nombre, con duración, LUFS y la ganancia que se les aplica. */
  async list(): Promise<MusicTrackInfo[]> {
    if (!existsSync(this.dir)) return [];
    const names = (await readdir(this.dir)).filter((n) => this.valid(n)).sort((a, b) => a.localeCompare(b, 'es'));
    const tracks = (await Promise.all(names.map((n) => this.one(n)))).filter((t): t is MusicTrackInfo => !!t);
    const ref = tracks.find((t) => t.name === this.defaultTrack)?.lufs;
    return tracks.map((t) => ({ ...t, gainDb: this.gain(t.lufs, ref) }));
  }

  private gain(lufs: number | undefined, ref: number | undefined) {
    return env.MUSIC_NORMALIZE ? musicGainDb(lufs, ref, env.MUSIC_MAX_GAIN_DB) : 0;
  }

  /** Lista para el selector, empezando en el track del último video del usuario (o en MUSIC_PATH). */
  async forUser(ownerId: string): Promise<MusicListResponse> {
    const tracks = await this.list();
    const last = await this.db.generation.findFirst({ where: { ownerId }, orderBy: { createdAt: 'desc' }, select: { musicTrack: true } });
    const def = this.defaultTrack;
    let initial: string | null = def;
    if (last) initial = last.musicTrack === null ? null : tracks.some((t) => t.name === last.musicTrack) ? last.musicTrack : def;
    return { tracks, defaultTrack: def, initial };
  }

  /**
   * Track del video para el render. null = "Sin música". Si el archivo ya no está en la carpeta, el
   * render sigue sin música (y se avisa en el log de la generación).
   */
  async resolve(name: string | null | undefined): Promise<ResolvedMusic | undefined> {
    if (!name) return undefined;
    const path = this.pathOf(name);
    if (!path) return undefined;
    const tracks = await this.list();
    const t = tracks.find((x) => x.name === name);
    const gainDb = t?.gainDb ?? 0;
    return { name, path, gainDb, volume: musicVolume(gainDb) };
  }
}
