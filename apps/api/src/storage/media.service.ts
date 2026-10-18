import { Inject, Injectable, Logger, NotFoundException, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Response } from 'express';
import pLimit from 'p-limit';
import type { Db } from '@wilox/db';
import { env, repoPath } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { contentType, evictable, keyOfRel, mediaPrefix, relOfKey, unitOfRel } from './keys.js';
import { DirRemote, type Remote } from './remote.js';
import { S3Remote } from './s3-remote.js';

interface Known {
  size: number;
  mtime: number;
}

/** Un archivo recién escrito no se sube hasta que lleva este tiempo sin cambiar (ffmpeg puede seguir escribiendo). */
const SETTLE_MS = 8_000;
/** Cada cuánto se suben las carpetas con cambios y se revisa todo el almacenamiento. */
const DIRTY_EVERY_MS = 15_000;
const SWEEP_EVERY_MS = 60 * 60_000;
/** La fecha de uso de una carpeta se escribe en la BD como mucho cada 10 min. */
const USED_WRITE_MS = 10 * 60_000;

/**
 * Medios en un almacenamiento remoto con el disco del servidor como caché de trabajo (hito 8, ADR-093).
 *
 * El código sigue leyendo y escribiendo archivos en `storage/` (ffmpeg y archiver necesitan archivos
 * locales). Este servicio:
 * - **sube** lo nuevo o cambiado de cada carpeta (video, tema, proyecto, lote) poco después de escribirse
 *   (`dirty`) y en un repaso cada hora; `StoredObject` dice qué está a salvo (misma clave, tamaño y fecha);
 * - **baja** lo que falte antes de usarlo: la carpeta entera de un video antes de trabajar en él (`hydrate`)
 *   o archivos sueltos (`ensure`) para descargas, portadas y el link para compartir;
 * - **sirve** al navegador desde la caché o, si no está, con una URL firmada (`serve`);
 * - **libera** la caché: la carpeta de un video sin usar hace `MEDIA_CACHE_DAYS` días (y la de un lote tras
 *   `MEDIA_BATCH_CACHE_HOURS`) se borra del disco solo si todo está subido (`evict`). Temas, logos y fuentes
 *   se quedan siempre en el disco.
 * Con MEDIA_DRIVER=none todo esto no hace nada: el disco es el único almacenamiento, como hasta el hito 7.
 */
@Injectable()
export class MediaService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Medios');
  readonly root = repoPath(env.STORAGE_DIR);
  readonly prefix = mediaPrefix(env.MEDIA_ENV, env.MEDIA_ROOT);
  private readonly remote?: Remote;
  /** Clave → tamaño y fecha de lo que ya está subido (copia en memoria de StoredObject). */
  private readonly index = new Map<string, Known>();
  private loaded?: Promise<void>;
  private readonly dirtyUnits = new Set<string>();
  private readonly syncing = new Map<string, Promise<boolean>>();
  private readonly hydrating = new Map<string, Promise<void>>();
  /** Bajadas en curso por clave remota. */
  private readonly downloading = new Map<string, Promise<void>>();
  private readonly evicting = new Map<string, Promise<void>>();
  private readonly refs = new Map<string, number>();
  private readonly lastUsed = new Map<string, number>();
  private readonly lastUsedWritten = new Map<string, number>();
  private readonly guards: ((unit: string) => boolean)[] = [];
  private readonly io = pLimit(env.MEDIA_UPLOAD_CONCURRENCY);
  private timers: NodeJS.Timeout[] = [];

  constructor(@Inject(DB) private readonly db: Db) {
    if (env.MEDIA_DRIVER === 'dir') this.remote = new DirRemote(repoPath(env.MEDIA_DIR!));
    if (env.MEDIA_DRIVER === 's3') this.remote = new S3Remote(env.AWS_S3_BUCKET!, env.AWS_REGION!, env.MEDIA_S3_ENDPOINT);
  }

  get enabled() {
    return !!this.remote;
  }

  get driver() {
    return this.remote?.name ?? 'none';
  }

  async onApplicationBootstrap() {
    if (!this.remote) return;
    await this.load();
    this.logger.log(`Almacenamiento remoto ${this.remote.name} (${this.prefix}): ${this.index.size} archivo(s) ya subidos.`);
    // Temas, logos y fuentes siempre en el disco (p. ej. tras montar un servidor nuevo).
    void this.restoreResident().catch((e) => this.logger.warn(`No se pudieron bajar temas y logos: ${(e as Error).message}`));
    this.timers.push(setInterval(() => void this.flushDirty(), DIRTY_EVERY_MS));
    this.timers.push(setInterval(() => void this.housekeeping(), SWEEP_EVERY_MS));
    this.timers.push(setTimeout(() => void this.housekeeping(), 60_000));
    for (const t of this.timers) t.unref();
  }

  onModuleDestroy() {
    for (const t of this.timers) clearInterval(t);
  }

  private load() {
    this.loaded ??= (async () => {
      const rows = await this.db.storedObject.findMany({ where: { key: { startsWith: this.prefix } }, select: { key: true, size: true, mtimeMs: true } });
      for (const r of rows) this.index.set(r.key, { size: Number(r.size), mtime: r.mtimeMs });
    })();
    return this.loaded;
  }

  // ─── rutas ──────────────────────────────────────────────────────────────────────────────────────────

  rel(abs: string): string | undefined {
    const r = relative(this.root, resolve(abs));
    if (!r || r.startsWith('..') || r.includes(`..${sep}`)) return undefined;
    return r.split(sep).join('/');
  }

  key(abs: string): string | undefined {
    const r = this.rel(abs);
    return r ? keyOfRel(r, this.prefix) : undefined;
  }

  private unitAbs(unit: string) {
    return join(this.root, unit);
  }

  private unitOf(abs: string): string | undefined {
    const r = this.rel(abs);
    return r ? unitOfRel(r) : undefined;
  }

  /** Condición extra para sacar una carpeta de la caché (p. ej. que el video no esté trabajando). */
  addEvictGuard(fn: (unit: string) => boolean) {
    this.guards.push(fn);
  }

  // ─── subir ──────────────────────────────────────────────────────────────────────────────────────────

  /** Algo cambió en esta ruta (archivo o carpeta): su carpeta se sube en el próximo repaso (≈ 15 s). */
  dirty(abs: string) {
    if (!this.remote) return;
    const u = this.unitOf(abs);
    if (u) {
      this.dirtyUnits.add(u);
      this.used(abs);
    }
  }

  private async flushDirty() {
    const units = [...this.dirtyUnits];
    this.dirtyUnits.clear();
    for (const u of units) {
      const ok = await this.syncUnit(u).catch((e) => {
        this.logger.warn(`${u}: no se pudo subir (${(e as Error).message}); se reintenta.`);
        return false;
      });
      if (!ok) this.dirtyUnits.add(u);
    }
  }

  /** Sube lo nuevo o cambiado de una carpeta. true = todo lo que hay en el disco está a salvo. */
  syncUnit(unit: string): Promise<boolean> {
    if (!this.remote) return Promise.resolve(true);
    const running = this.syncing.get(unit);
    if (running) return running.then(() => this.syncUnit(unit));
    const p = this.syncInner(unit).finally(() => this.syncing.delete(unit));
    this.syncing.set(unit, p);
    return p;
  }

  private async syncInner(unit: string): Promise<boolean> {
    await this.load();
    const dir = this.unitAbs(unit);
    if (!existsSync(dir)) return true;
    const files = await walk(dir);
    let safe = true;
    await Promise.all(
      files.map((f) =>
        this.io(async () => {
          const key = this.key(f);
          if (!key) return;
          const st = await stat(f).catch(() => undefined);
          if (!st?.isFile()) return;
          const known = this.index.get(key);
          if (known && known.size === st.size && Math.abs(known.mtime - st.mtimeMs) < 1) return;
          if (Date.now() - st.mtimeMs < SETTLE_MS) {
            safe = false;
            return;
          }
          try {
            const r = await this.remote!.put(key, f, contentType(f));
            // Si el archivo cambió mientras se subía, queda para la próxima vuelta.
            const after = await stat(f).catch(() => undefined);
            if (!after || after.size !== st.size || after.mtimeMs !== st.mtimeMs) {
              safe = false;
              return;
            }
            await this.db.storedObject.upsert({
              where: { key },
              create: { key, size: BigInt(st.size), mtimeMs: st.mtimeMs, etag: r.etag ?? null },
              update: { size: BigInt(st.size), mtimeMs: st.mtimeMs, etag: r.etag ?? null, uploadedAt: new Date() },
            });
            this.index.set(key, { size: st.size, mtime: st.mtimeMs });
          } catch (e) {
            safe = false;
            this.logger.warn(`No se pudo subir ${key}: ${(e as Error).message}`);
          }
        }),
      ),
    );
    return safe;
  }

  // ─── bajar ──────────────────────────────────────────────────────────────────────────────────────────

  /** Antes de trabajar en una carpeta (un video): baja lo que falte y la marca como usada. */
  async hydrate(absDir: string): Promise<void> {
    if (!this.remote) return;
    const unit = this.unitOf(absDir);
    if (!unit) return;
    this.used(absDir);
    await this.evicting.get(unit);
    const running = this.hydrating.get(unit);
    if (running) return running;
    const p = this.hydrateInner(unit).finally(() => this.hydrating.delete(unit));
    this.hydrating.set(unit, p);
    return p;
  }

  private async hydrateInner(unit: string) {
    await this.load();
    const kp = keyOfRel(`${unit}/x`, this.prefix)!.slice(0, -1);
    const missing = [...this.index.keys()].filter((k) => k.startsWith(kp)).filter((k) => !existsSync(join(this.root, relOfKey(k, this.prefix)!)));
    if (!missing.length) return;
    const t0 = Date.now();
    await Promise.all(missing.map((k) => this.io(() => this.download(k))));
    this.logger.log(`${unit}: ${missing.length} archivo(s) bajados en ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
    await this.db.mediaDir.updateMany({ where: { dir: unit }, data: { evictedAt: null, lastUsedAt: new Date() } }).catch(() => undefined);
  }

  /**
   * Baja un archivo del remoto. Una sola bajada a la vez por archivo (ADR-096, cierre): con varias peticiones
   * a la vez (p. ej. las miniaturas de la portada, que necesitan el final) todas esperan la misma, en vez de
   * escribir a la vez el mismo `.part` y que ffmpeg lea un archivo a medias.
   */
  private download(key: string): Promise<void> {
    let p = this.downloading.get(key);
    if (!p) {
      p = this.downloadInner(key).finally(() => this.downloading.delete(key));
      this.downloading.set(key, p);
    }
    return p;
  }

  private async downloadInner(key: string) {
    const abs = join(this.root, relOfKey(key, this.prefix)!);
    if (existsSync(abs)) return;
    const tmp = `${abs}.${randomBytes(4).toString('hex')}.part`;
    await mkdir(dirname(abs), { recursive: true });
    try {
      await this.remote!.get(key, tmp);
      const k = this.index.get(key);
      // La misma fecha que el original: así no se vuelve a subir.
      if (k) await utimes(tmp, new Date(), new Date(k.mtime));
      await rename(tmp, abs);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** Baja los archivos sueltos que falten (descargas, portadas, link para compartir). */
  async ensure(...abs: (string | undefined)[]): Promise<void> {
    if (!this.remote) return;
    await this.load();
    const todo = abs.filter((a): a is string => !!a && !existsSync(a));
    for (const a of abs) if (a) this.used(a);
    const units = new Set<string>();
    await Promise.all(
      todo.map((a) =>
        this.io(async () => {
          const k = this.key(a);
          if (!k || !this.index.has(k)) return;
          await this.download(k);
          const u = this.unitOf(a);
          if (u && evictable(u)) units.add(u);
        }),
      ),
    );
    // La carpeta vuelve a estar (en parte) en el disco: puede volver a salir cuando deje de usarse.
    if (units.size) await this.db.mediaDir.updateMany({ where: { dir: { in: [...units] }, evictedAt: { not: null } }, data: { evictedAt: null, lastUsedAt: new Date() } }).catch(() => undefined);
  }

  /** Está en el disco o en el remoto. */
  has(abs: string): boolean {
    if (existsSync(abs)) return true;
    const k = this.remote ? this.key(abs) : undefined;
    return !!k && this.index.has(k);
  }

  /** Tamaño en bytes (del disco o, si no está, del remoto). */
  async size(abs: string): Promise<number | undefined> {
    const s = await stat(abs).catch(() => undefined);
    if (s) return s.size;
    const k = this.remote ? this.key(abs) : undefined;
    return k ? this.index.get(k)?.size : undefined;
  }

  /**
   * Sirve un archivo al navegador: desde la caché si está (sin costo de transferencia de S3); si no, con una
   * URL firmada de corta duración (o, si el remoto no las da, bajándolo primero).
   */
  async serve(res: Response, abs: string, o: { download?: string | boolean; headers?: Record<string, string> } = {}) {
    const name = typeof o.download === 'string' ? o.download : undefined;
    if (!existsSync(abs) && this.remote) {
      const k = this.key(abs);
      if (!k || !this.index.has(k)) throw new NotFoundException();
      this.used(abs);
      if (this.remote.url) {
        const url = await this.remote.url(k, { ttlSec: env.MEDIA_URL_TTL_SEC, downloadName: o.download ? (name ?? abs.split(sep).pop()) : undefined, contentType: contentType(abs) });
        res.setHeader('cache-control', 'private, no-store');
        res.redirect(302, url);
        return;
      }
      await this.ensure(abs);
    }
    if (!existsSync(abs)) throw new NotFoundException();
    this.used(abs);
    if (o.download) res.download(abs, name ?? abs.split(sep).pop()!, { headers: o.headers }, (err) => err && !res.headersSent && res.status(404).end());
    else res.sendFile(abs, { dotfiles: 'deny', headers: o.headers }, (err) => err && !res.headersSent && res.status(404).end());
  }

  // ─── borrar y mover ─────────────────────────────────────────────────────────────────────────────────

  /** El código borró a propósito un archivo o una carpeta: se borra también del remoto. */
  async removed(abs: string) {
    if (!this.remote) return;
    await this.load();
    const k = this.key(abs);
    const dirKey = this.key(join(abs, 'x'))?.slice(0, -1);
    const keys = [...this.index.keys()].filter((x) => x === k || (dirKey && x.startsWith(dirKey)));
    if (!keys.length) return;
    try {
      await this.remote.delete(keys);
      await this.db.storedObject.deleteMany({ where: { key: { in: keys } } });
      for (const x of keys) this.index.delete(x);
      const unit = this.unitOf(abs);
      if (unit && this.rel(abs) === unit) await this.db.mediaDir.deleteMany({ where: { dir: unit } });
    } catch (e) {
      this.logger.warn(`No se pudo borrar del remoto ${k ?? dirKey}: ${(e as Error).message}`);
    }
  }

  /** El código movió una carpeta (un tema a la papelera): se mueve también en el remoto. */
  async moved(fromAbs: string, toAbs: string) {
    if (!this.remote) return;
    await this.load();
    const from = this.key(join(fromAbs, 'x'))?.slice(0, -1);
    const to = this.key(join(toAbs, 'x'))?.slice(0, -1);
    if (!from || !to) return;
    for (const k of [...this.index.keys()].filter((x) => x.startsWith(from))) {
      try {
        const nk = to + k.slice(from.length);
        await this.remote.copy(k, nk);
        const v = this.index.get(k)!;
        await this.db.storedObject.upsert({ where: { key: nk }, create: { key: nk, size: BigInt(v.size), mtimeMs: v.mtime }, update: { size: BigInt(v.size), mtimeMs: v.mtime } });
        this.index.set(nk, v);
        await this.remote.delete([k]);
        await this.db.storedObject.deleteMany({ where: { key: k } });
        this.index.delete(k);
      } catch (e) {
        this.logger.warn(`No se pudo mover ${k} en el remoto: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Copia una carpeta (duplicar un video o un proyecto, hito 9, T3e, ADR-107) sin pasar los archivos por el servidor
   * cuando se puede: lo que ya está en el remoto se copia dentro del remoto (CopyObject, misma clave relativa) y lo que
   * está en el disco se copia en el disco con su fecha (así no se vuelve a subir). Lo que solo está en el disco y aún no
   * subido se sube en el próximo repaso. `skip` (ruta relativa a la carpeta) deja fuera lo que no se copia.
   */
  async copyTree(fromAbs: string, toAbs: string, o: { skip?: (rel: string) => boolean } = {}): Promise<{ files: number; bytes: number }> {
    const temp = (rel: string) => /\.part$|\.tmp(\.[a-z0-9]+)?$/i.test(rel);
    const done = new Set<string>();
    let files = 0;
    let bytes = 0;
    // 1) En el remoto: sin transferencia por el servidor.
    if (this.remote) {
      await this.load();
      const from = this.key(join(fromAbs, 'x'))?.slice(0, -1);
      const to = this.key(join(toAbs, 'x'))?.slice(0, -1);
      if (from && to) {
        const entries = [...this.index.entries()].filter(([k]) => k.startsWith(from));
        await Promise.all(
          entries.map(([k, v]) =>
            this.io(async () => {
              const rel = k.slice(from.length);
              if (o.skip?.(rel) || temp(rel)) return;
              const nk = to + rel;
              await this.remote!.copy(k, nk);
              await this.db.storedObject.upsert({ where: { key: nk }, create: { key: nk, size: BigInt(v.size), mtimeMs: v.mtime }, update: { size: BigInt(v.size), mtimeMs: v.mtime } });
              this.index.set(nk, v);
              done.add(rel);
              files += 1;
              bytes += v.size;
            }),
          ),
        );
      }
    }
    // 2) En el disco: la caché del duplicado (con la misma fecha) y lo que aún no estaba subido.
    if (existsSync(fromAbs))
      for (const f of await walk(fromAbs)) {
        const rel = relative(fromAbs, f).split(sep).join('/');
        if (o.skip?.(rel) || temp(rel)) continue;
        const st = await stat(f).catch(() => undefined);
        if (!st?.isFile()) continue;
        const dst = join(toAbs, rel);
        await mkdir(dirname(dst), { recursive: true });
        await copyFile(f, dst);
        await utimes(dst, st.atime, st.mtime);
        if (!done.has(rel)) {
          files += 1;
          bytes += st.size;
        }
      }
    if (existsSync(toAbs)) this.dirty(toAbs);
    return { files, bytes };
  }

  // ─── publicaciones (hito 9, ADR-101) ────────────────────────────────────────────────────────────────

  /** Prefijo público: wilox-motion/<entorno>/publico/ (fuera del espejo de storage/: no es caché). */
  get publicPrefix() {
    return `${this.prefix}publico/`;
  }

  /** Lo publicado va al remoto (S3) y se sirve desde MEDIA_PUBLIC_BASE; si no, se queda en el disco y lo sirve la API. */
  get publicRemote() {
    return this.remote?.name === 's3' && !!env.MEDIA_PUBLIC_BASE;
  }

  /** Carpeta local de una publicación (sin S3 público, o mientras se prepara). */
  publicDir(token: string) {
    return join(this.root, 'publico', token);
  }

  /** URL pública y estable de un archivo publicado. */
  publicUrl(token: string, name: string) {
    if (this.publicRemote) return `${env.MEDIA_PUBLIC_BASE!.replace(/\/+$/, '')}/${this.publicPrefix}${token}/${name}`;
    return `${env.WEB_ORIGIN.replace(/\/+$/, '')}/api/publico/${token}/${name}`;
  }

  /**
   * Publica un archivo con un nombre fijo. Con S3 público lo sube con Cache-Control corto (MEDIA_PUBLIC_MAX_AGE_SEC):
   * sobrescribir la misma clave (un final nuevo) o borrarla (despublicar) se nota por CloudFront en ese plazo, sin
   * invalidaciones. Sin S3 público, lo copia a `storage/publico/<token>/`.
   */
  async publishFile(token: string, name: string, file: string) {
    if (this.publicRemote) {
      await this.remote!.put(`${this.publicPrefix}${token}/${name}`, file, contentType(name), { cacheControl: `public, max-age=${env.MEDIA_PUBLIC_MAX_AGE_SEC}` });
      return;
    }
    const to = join(this.publicDir(token), name);
    if (resolve(to) === resolve(file)) return;
    await mkdir(dirname(to), { recursive: true });
    const tmp = `${to}.${randomBytes(4).toString('hex')}.part`;
    await copyFile(file, tmp);
    await rename(tmp, to);
  }

  /** Borra un archivo publicado (p. ej. los subtítulos de un video que ya no los tiene). */
  async unpublishFile(token: string, name: string) {
    if (this.remote?.name === 's3') await this.remote.delete([`${this.publicPrefix}${token}/${name}`]).catch(() => undefined);
    await rm(join(this.publicDir(token), name), { force: true });
  }

  /** Despublica: borra la carpeta pública (en el remoto y en el disco). */
  async unpublish(token: string) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new Error(`Token de publicación inválido: ${token}`);
    if (this.remote?.name === 's3') {
      const keys = (await this.remote.list(`${this.publicPrefix}${token}/`)).map((o) => o.key);
      if (keys.length) await this.remote.delete(keys);
    }
    await rm(this.publicDir(token), { recursive: true, force: true });
  }

  /** Carpetas publicadas que existen (remoto y disco), para borrar las que ya no tienen fila. */
  async publishedTokens(): Promise<Set<string>> {
    const out = new Set<string>();
    if (this.remote?.name === 's3')
      for (const o of await this.remote.list(this.publicPrefix)) {
        const t = o.key.slice(this.publicPrefix.length).split('/')[0];
        if (t) out.add(t);
      }
    for (const d of await readdir(join(this.root, 'publico'), { withFileTypes: true }).catch(() => [])) if (d.isDirectory()) out.add(d.name);
    return out;
  }

  // ─── uso y caché ────────────────────────────────────────────────────────────────────────────────────

  /** Mientras fn corre, la carpeta no sale de la caché. */
  async use<T>(absDir: string, fn: () => Promise<T>): Promise<T> {
    const u = this.unitOf(absDir);
    if (!u || !this.remote) return fn();
    this.refs.set(u, (this.refs.get(u) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const n = (this.refs.get(u) ?? 1) - 1;
      if (n > 0) this.refs.set(u, n);
      else this.refs.delete(u);
    }
  }

  used(abs: string) {
    if (!this.remote) return;
    const u = this.unitOf(abs);
    if (!u || !evictable(u)) return;
    const now = Date.now();
    this.lastUsed.set(u, now);
    if (now - (this.lastUsedWritten.get(u) ?? 0) < USED_WRITE_MS) return;
    this.lastUsedWritten.set(u, now);
    void this.db.mediaDir
      .upsert({ where: { dir: u }, create: { dir: u, lastUsedAt: new Date(now) }, update: { lastUsedAt: new Date(now) } })
      .catch(() => undefined);
  }

  /** Repaso de cada hora: sube lo que falte de todas las carpetas y libera la caché. */
  async housekeeping() {
    if (!this.remote) return;
    try {
      const r = await this.sweep();
      if (r.pending) this.logger.warn(`Repaso: ${r.pending} carpeta(s) con archivos sin subir (se reintenta).`);
      await this.evict();
    } catch (e) {
      this.logger.warn(`Repaso del almacenamiento: ${(e as Error).message}`);
    }
  }

  /** Sube todo lo que esté en el disco y no en el remoto (al arrancar, cada hora y en la migración). */
  async sweep(o: { onUnit?: (unit: string, ok: boolean) => void } = {}): Promise<{ units: number; pending: number }> {
    let units = 0;
    let pending = 0;
    for (const top of ['projects', 'themes', 'runs', 'downloads', 'fuentes']) {
      const base = join(this.root, top);
      if (!existsSync(base)) continue;
      const names = top === 'fuentes' ? [''] : (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
      for (const n of names) {
        const unit = n ? `${top}/${n}` : top;
        units++;
        const ok = await this.syncUnit(unit);
        if (!ok) pending++;
        if (evictable(unit) && !(await this.db.mediaDir.findUnique({ where: { dir: unit } })))
          await this.db.mediaDir.create({ data: { dir: unit, lastUsedAt: new Date() } }).catch(() => undefined);
        o.onUnit?.(unit, ok);
      }
    }
    return { units, pending };
  }

  /** Saca de la caché las carpetas que llevan tiempo sin usarse, solo si todo lo suyo está subido. */
  async evict(o: { force?: boolean; only?: string } = {}): Promise<{ units: number; bytes: number }> {
    if (!this.remote) return { units: 0, bytes: 0 };
    // Hasta que Leonardo confirme la migración (MEDIA_EVICT=true), nada sale del disco (ADR-096).
    if (!env.MEDIA_EVICT && !o.force) return { units: 0, bytes: 0 };
    const now = Date.now();
    // `only`: una sola carpeta (prueba de cierre del hito 8, `pnpm storage:migrate --evict runs/<id>`).
    const rows = await this.db.mediaDir.findMany({ where: { evictedAt: null, ...(o.only ? { dir: o.only } : {}) } });
    let units = 0;
    let bytes = 0;
    for (const r of rows) {
      const last = Math.max(r.lastUsedAt.getTime(), this.lastUsed.get(r.dir) ?? 0);
      const ttl = r.dir.startsWith('downloads/') ? env.MEDIA_BATCH_CACHE_HOURS * 3600_000 : env.MEDIA_CACHE_DAYS * 86_400_000;
      if (!o.force && now - last < ttl) continue;
      if (this.refs.get(r.dir) || this.hydrating.has(r.dir) || this.guards.some((g) => !g(r.dir))) continue;
      const dir = this.unitAbs(r.dir);
      if (!existsSync(dir)) {
        await this.db.mediaDir.update({ where: { dir: r.dir }, data: { evictedAt: new Date() } });
        continue;
      }
      if (!(await this.syncUnit(r.dir))) continue;
      const files = await walk(dir);
      // Solo si cada archivo (salvo los temporales) está en el remoto con el mismo tamaño.
      let size = 0;
      let ok = true;
      for (const f of files) {
        const s = await stat(f).catch(() => undefined);
        if (!s) continue;
        size += s.size;
        const k = this.key(f);
        if (k && this.index.get(k)?.size !== s.size) ok = false;
      }
      if (!ok || this.refs.get(r.dir)) continue;
      const p = (async () => {
        await rm(dir, { recursive: true, force: true });
        await this.db.mediaDir.update({ where: { dir: r.dir }, data: { evictedAt: new Date() } });
      })();
      this.evicting.set(r.dir, p);
      await p.finally(() => this.evicting.delete(r.dir));
      units++;
      bytes += size;
    }
    if (units) this.logger.log(`Caché: ${units} carpeta(s) fuera del disco (${(bytes / 1e9).toFixed(2)} GB liberados).`);
    return { units, bytes };
  }

  /** Temas, logos y fuentes se quedan siempre en el disco: si faltan (servidor nuevo), se bajan. */
  private async restoreResident() {
    const resident = [...this.index.keys()].filter((k) => {
      const r = relOfKey(k, this.prefix);
      return r && !evictable(unitOfRel(r) ?? '') && !existsSync(join(this.root, r));
    });
    if (!resident.length) return;
    await Promise.all(resident.map((k) => this.io(() => this.download(k))));
    this.logger.log(`${resident.length} archivo(s) de temas, logos y fuentes bajados del remoto.`);
  }

  /** Archivos de `storage/` que se suben (los de las carpetas espejadas), con su clave. */
  private async localFiles(): Promise<{ abs: string; key: string; size: number; mtime: number }[]> {
    const out: { abs: string; key: string; size: number; mtime: number }[] = [];
    for (const top of ['projects', 'themes', 'runs', 'downloads', 'fuentes']) {
      for (const f of await walk(join(this.root, top))) {
        const key = this.key(f);
        if (!key) continue;
        const st = await stat(f).catch(() => undefined);
        if (st?.isFile()) out.push({ abs: f, key, size: st.size, mtime: st.mtimeMs });
      }
    }
    return out;
  }

  /** Lo que falta subir (sin subir nada): archivos y bytes, por carpeta de primer nivel. */
  async pending(): Promise<{ files: number; bytes: number; total: { files: number; bytes: number }; byTop: Record<string, { files: number; bytes: number }> }> {
    await this.load();
    const all = await this.localFiles();
    const byTop: Record<string, { files: number; bytes: number }> = {};
    let files = 0;
    let bytes = 0;
    let tb = 0;
    for (const f of all) {
      tb += f.size;
      const k = this.index.get(f.key);
      if (k && k.size === f.size && Math.abs(k.mtime - f.mtime) < 1) continue;
      files++;
      bytes += f.size;
      const top = this.rel(f.abs)!.split('/')[0];
      byTop[top] ??= { files: 0, bytes: 0 };
      byTop[top].files++;
      byTop[top].bytes += f.size;
    }
    return { files, bytes, total: { files: all.length, bytes: tb }, byTop };
  }

  /**
   * Verificación de la migración (ADR-096): cada archivo del disco contra el remoto (que exista y tenga el
   * mismo tamaño) y contra StoredObject. Deja un informe en `storage/_migracion/` (no se sube).
   */
  async verify(): Promise<{ ok: boolean; local: number; remote: number; missing: string[]; sizeMismatch: string[]; notIndexed: string[]; report: string }> {
    if (!this.remote) throw new Error('MEDIA_DRIVER=none: no hay remoto que verificar.');
    await this.load();
    const local = await this.localFiles();
    const remote = new Map((await this.remote.list(this.prefix)).map((r) => [r.key, r.size]));
    const missing: string[] = [];
    const sizeMismatch: string[] = [];
    const notIndexed: string[] = [];
    for (const f of local) {
      const size = remote.get(f.key);
      if (size === undefined) missing.push(f.key);
      else if (size !== f.size) sizeMismatch.push(f.key);
      else if (this.index.get(f.key)?.size !== f.size) notIndexed.push(f.key);
    }
    const ok = !missing.length && !sizeMismatch.length;
    const dir = join(this.root, '_migracion');
    await mkdir(dir, { recursive: true });
    const report = join(dir, `informe_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const bytes = local.reduce((n, f) => n + f.size, 0);
    await writeFile(
      report,
      JSON.stringify({ at: new Date().toISOString(), driver: this.remote.name, prefix: this.prefix, ok, local: { files: local.length, bytes }, remote: { files: remote.size }, missing, sizeMismatch, notIndexed }, null, 2),
    );
    return { ok, local: local.length, remote: remote.size, missing, sizeMismatch, notIndexed, report };
  }

  /** Para la verificación de la migración: claves del remoto con su tamaño. */
  listRemote() {
    if (!this.remote) return Promise.resolve([]);
    return this.remote.list(this.prefix);
  }

  indexed(): ReadonlyMap<string, Known> {
    return this.index;
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isFile()) out.push(join(e.parentPath, e.name));
  return out;
}
