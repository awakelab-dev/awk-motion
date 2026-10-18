import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Almacenamiento remoto de los medios (hito 8, ADR-093). */
export interface Remote {
  readonly name: string;
  /** `cacheControl`: solo para lo publicado (hito 9, ADR-101). */
  put(key: string, file: string, contentType: string, o?: { cacheControl?: string }): Promise<{ etag?: string }>;
  get(key: string, file: string): Promise<void>;
  head(key: string): Promise<{ size: number } | undefined>;
  delete(keys: string[]): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  /** Todas las claves bajo un prefijo, con su tamaño (verificación de la migración). */
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  /** URL firmada para el navegador; sin ella, la API baja el archivo y lo sirve. */
  url?(key: string, o: { ttlSec: number; downloadName?: string; contentType?: string }): Promise<string>;
}

/** Remoto en una carpeta local (MEDIA_DRIVER=dir): para probar la caché sin S3. */
export class DirRemote implements Remote {
  readonly name = 'dir';
  constructor(private readonly root: string) {}

  private path(key: string) {
    if (key.split('/').includes('..')) throw new Error(`Clave inválida: ${key}`);
    return join(this.root, key);
  }

  async put(key: string, file: string) {
    const to = this.path(key);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(file, to);
    return {};
  }

  async get(key: string, file: string) {
    await mkdir(dirname(file), { recursive: true });
    await copyFile(this.path(key), file);
  }

  async head(key: string) {
    const s = await stat(this.path(key)).catch(() => undefined);
    return s?.isFile() ? { size: s.size } : undefined;
  }

  async delete(keys: string[]) {
    for (const k of keys) await rm(this.path(k), { force: true });
  }

  async copy(from: string, to: string) {
    const dst = this.path(to);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(this.path(from), dst);
  }

  async list(prefix: string) {
    const base = this.path(prefix.replace(/\/+$/, ''));
    const out: { key: string; size: number }[] = [];
    const entries = await readdir(base, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile()) continue;
      const abs = join(e.parentPath, e.name);
      out.push({ key: abs.slice(this.root.length + 1).split('\\').join('/'), size: (await stat(abs)).size });
    }
    return out;
  }
}
