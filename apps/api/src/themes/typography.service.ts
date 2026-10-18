import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { MAX_TYPEFACES, SPECIMEN_FORMAT, type Typeface, type TypefaceRole } from '@wilox/shared';
import { env, repoPath } from '../config/env.js';
import { MediaService } from '../storage/media.service.js';
import { ThemeStore } from './theme-store.js';
import { defaultWeights, googleFont, renderSpecimen, slugOf, validateFont, type FontFile } from './typography.js';

/**
 * Tipografías del tema (hito 8, A2, ADR-094): el usuario escribe las fuentes ("Roboto, Oswald") o sube su
 * .ttf/.otf; la API baja cada fuente de Google Fonts (caché compartida en `storage/fuentes/google/`), copia
 * los pesos al tema (`tipografias/fuentes/`) y dibuja su lámina (`tipografias/<fuente>.png`). Las láminas van
 * a GPT Image en los fotogramas con texto (pruebas del tema y videos nuevos), detrás de las referencias de
 * estilo. Cambiar las tipografías sube la versión del tema; no llama a Opus ni deja el tema pendiente.
 */
@Injectable()
export class TypographyService {
  private readonly logger = new Logger('Tipografías');
  private readonly cache = join(repoPath(env.STORAGE_DIR), 'fuentes', 'google');
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly themes: ThemeStore,
    private readonly media: MediaService,
  ) {}

  private faces(id: string): Typeface[] {
    return this.themes.stored(id)?.style.typefaces ?? [];
  }

  private dir(id: string) {
    return join(this.themes.dir(id), 'tipografias');
  }

  /** La versión del tema sube cuando cambia lo que llega a los prompts (una lámina lista, un rol, quitar una fuente). */
  private set(id: string, fn: (list: Typeface[]) => Typeface[], bump = false) {
    this.themes.update(id, (t) => (t.style.typefaces = fn(structuredClone(t.style.typefaces ?? []))), { styleChanged: bump });
  }

  private patch(id: string, family: string, p: Partial<Typeface>) {
    const bump = p.status === 'ready' || (p.role !== undefined && p.status === undefined);
    this.set(id, (list) => list.map((f) => (f.family === family ? { ...f, ...p, updatedAt: new Date().toISOString() } : f)), bump);
  }

  /** "Roboto, Oswald": agrega las fuentes que falten (las que ya están no se tocan) y dibuja sus láminas. */
  add(id: string, text: string) {
    const names = [...new Set(splitFamilies(text))];
    if (!names.length) throw new BadRequestException('Escribe al menos una fuente (p. ej. «Roboto, Oswald»).');
    if (names.some((n) => n.length < 2 || n.length > 60 || !/^[\p{L}\p{N} &'.-]+$/u.test(n))) throw new BadRequestException('Nombre de fuente no válido.');
    const current = this.faces(id);
    const fresh = names.filter((n) => !current.some((f) => f.family.toLowerCase() === n.toLowerCase()));
    if (!fresh.length) throw new BadRequestException('Esas fuentes ya están en el tema.');
    if (current.length + fresh.length > MAX_TYPEFACES) throw new BadRequestException(`Hasta ${MAX_TYPEFACES} fuentes por tema: quita alguna antes.`);
    // Rol por defecto: una sola fuente para todo; con varias, la primera para titulares y las demás para el texto.
    const total = current.length + fresh.length;
    const now = new Date().toISOString();
    this.set(id, (list) => [
      ...list,
      ...fresh.map((family, i): Typeface => {
        const role: TypefaceRole = total === 1 ? 'both' : current.length === 0 && i === 0 ? 'headings' : 'body';
        return { family, source: 'google', role, weights: defaultWeights(role), files: [], status: 'generating', updatedAt: now };
      }),
    ]);
    for (const family of fresh) this.kick(id, family);
  }

  /** Cambia el rol o los pesos de una fuente y vuelve a dibujar su lámina. */
  update(id: string, family: string, o: { role?: TypefaceRole; weights?: number[] }) {
    const f = this.faces(id).find((x) => x.family === family);
    if (!f) throw new BadRequestException('Esa fuente no está en el tema.');
    if (f.status === 'generating') throw new BadRequestException('Espera a que termine la lámina.');
    const weights = o.weights ? [...new Set(o.weights)].sort((a, b) => a - b) : f.weights;
    if (!weights.length || weights.length > 4 || weights.some((w) => w % 100 || w < 100 || w > 900)) throw new BadRequestException('Elige de 1 a 4 pesos (100 a 900).');
    if (f.source === 'upload' && weights.some((w) => !f.files.some((x) => x.weight === w))) throw new BadRequestException('Con una fuente subida, sube el archivo de cada peso.');
    const redraw = JSON.stringify(weights) !== JSON.stringify([...f.weights].sort((a, b) => a - b));
    this.patch(id, family, { role: o.role ?? f.role, weights, ...(redraw ? { status: 'generating' as const, error: undefined } : {}) });
    if (redraw) this.kick(id, family);
  }

  /** Vuelve a bajar y dibujar (p. ej. tras un error de red). */
  retry(id: string, family: string) {
    const f = this.faces(id).find((x) => x.family === family);
    if (!f) throw new BadRequestException('Esa fuente no está en el tema.');
    if (f.status === 'generating') return;
    this.patch(id, family, { status: 'generating', error: undefined });
    this.kick(id, family);
  }

  /** Sube un .ttf u .otf propio (un archivo por peso) para una fuente que no está en Google Fonts. */
  async upload(id: string, o: { family: string; weight: number; fileName: string; data: string }) {
    const ext = extname(o.fileName).toLowerCase();
    if (ext !== '.ttf' && ext !== '.otf') throw new BadRequestException('Sube un archivo .ttf u .otf.');
    if (o.weight % 100 || o.weight < 100 || o.weight > 900) throw new BadRequestException('Peso no válido.');
    const family = o.family.trim().replace(/\s+/g, ' ');
    if (family.length < 2 || family.length > 60) throw new BadRequestException('Nombre de fuente no válido.');
    const buf = Buffer.from(o.data.replace(/^data:[^,]+,/, ''), 'base64');
    if (!buf.length || buf.length > 15 * 1024 * 1024) throw new BadRequestException('El archivo está vacío o pesa más de 15 MB.');
    const current = this.faces(id).find((f) => f.family.toLowerCase() === family.toLowerCase());
    if (!current && this.faces(id).length >= MAX_TYPEFACES) throw new BadRequestException(`Hasta ${MAX_TYPEFACES} fuentes por tema: quita alguna antes.`);
    if (current && current.source !== 'upload') throw new BadRequestException(`«${current.family}» viene de Google Fonts: quítala antes de subir la tuya con ese nombre.`);
    const file = `${slugOf(family)}-${o.weight}${ext}`;
    const dest = join(this.dir(id), 'fuentes', file);
    await mkdir(join(this.dir(id), 'fuentes'), { recursive: true });
    await writeFile(dest, buf);
    try {
      validateFont(dest);
    } catch (e) {
      await rm(dest, { force: true });
      throw new BadRequestException((e as Error).message);
    }
    const now = new Date().toISOString();
    if (current) {
      const files = [...current.files.filter((x) => x.weight !== o.weight), { weight: o.weight, file }];
      this.patch(id, current.family, { files, weights: [...new Set([...current.weights, o.weight])].sort((a, b) => a - b).slice(-4), status: 'generating', error: undefined });
      this.kick(id, current.family);
    } else {
      const role: TypefaceRole = this.faces(id).length ? 'body' : 'both';
      this.set(id, (list) => [...list, { family, source: 'upload', role, weights: [o.weight], files: [{ weight: o.weight, file }], status: 'generating', updatedAt: now }]);
      this.kick(id, family);
    }
  }

  /** Quita una fuente del tema (sus archivos y su lámina). */
  async remove(id: string, family: string) {
    const f = this.faces(id).find((x) => x.family === family);
    if (!f) throw new BadRequestException('Esa fuente no está en el tema.');
    this.set(id, (list) => list.filter((x) => x.family !== family), f.status === 'ready');
    const paths = [...f.files.map((x) => join(this.dir(id), 'fuentes', x.file)), ...(f.sheet ? [join(this.dir(id), f.sheet)] : [])];
    for (const p of paths) {
      await rm(p, { force: true });
      await this.media.removed(p);
    }
  }

  /** Al arrancar la API: las láminas que quedaron a medias se vuelven a dibujar. */
  recover(id: string) {
    for (const f of this.faces(id)) {
      if (this.running.has(`${id}:${f.family}`)) continue;
      if (f.status === 'generating') this.kick(id, f.family);
      // Lámina de un formato anterior (sin la fila de letras clave): se vuelve a dibujar con los mismos archivos.
      else if (f.status === 'ready' && (f.format ?? 1) < SPECIMEN_FORMAT) {
        this.patch(id, f.family, { status: 'generating' });
        this.kick(id, f.family);
      }
    }
  }

  private kick(id: string, family: string) {
    const key = `${id}:${family}`;
    if (this.running.has(key)) return;
    const p = this.draw(id, family)
      .catch((e) => {
        this.logger.warn(`${id} · ${family}: ${(e as Error).message}`);
        this.patch(id, family, { status: 'error', error: (e as Error).message });
      })
      .finally(() => this.running.delete(key));
    this.running.set(key, p);
  }

  private async draw(id: string, family: string) {
    const f = this.faces(id).find((x) => x.family === family);
    if (!f) return;
    const fontsDir = join(this.dir(id), 'fuentes');
    await mkdir(fontsDir, { recursive: true });
    let files: FontFile[];
    let stored = f.files;
    if (f.source === 'google') {
      // Pesos pedidos o los más cercanos que tenga la familia (Oswald no tiene 800: queda en 700).
      const got = await googleFont(f.family, f.weights, this.cache);
      stored = [];
      for (const g of got) {
        const file = `${slugOf(f.family)}-${g.weight}.ttf`;
        await copyFile(g.path, join(fontsDir, file));
        stored.push({ weight: g.weight, file });
      }
      this.media.dirty(this.cache);
    }
    files = stored.filter((x) => f.weights.includes(x.weight) || f.source === 'google').map((x) => ({ weight: x.weight, path: join(fontsDir, x.file) }));
    files = files.filter((x) => existsSync(x.path));
    if (!files.length) throw new Error('No hay archivos de la fuente para dibujar la lámina.');
    const sheet = `${slugOf(f.family)}.png`;
    await renderSpecimen(f.family, files, join(this.dir(id), sheet));
    const weights = files.map((x) => x.weight).sort((a, b) => a - b);
    this.patch(id, family, { files: stored, weights, sheet, format: SPECIMEN_FORMAT, status: 'ready', error: undefined });
    this.logger.log(`${id}: lámina de ${f.family} (${weights.join(', ')}).`);
  }
}

/**
 * Nombres de fuentes escritos por el usuario: separados por comas, punto y coma, saltos de línea o "y"/"e"/"and"/"&"
 * ("Poppins y Roboto"). Si un nombre viene todo en minúsculas se pasa a mayúscula inicial, como los nombra
 * Google Fonts ("open sans" → "Open Sans").
 */
export function splitFamilies(text: string): string[] {
  return text
    .split(/\s*(?:[,;\n]|\s(?:y|e|and|&)\s)\s*/i)
    .map((x) => x.trim().replace(/\s+/g, ' ').replace(/^["'«“]+|["'»”.]+$/g, ''))
    .filter(Boolean)
    .map((x) => (x === x.toLowerCase() ? x.replace(/(^|\s)(\p{L})/gu, (_m, sp: string, c: string) => sp + c.toUpperCase()) : x));
}
