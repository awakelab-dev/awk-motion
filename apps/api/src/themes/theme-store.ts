import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { copyFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BehaviorSubject } from 'rxjs';
import {
  isBaseThemeId,
  THEME_ID_RE,
  type StoredTheme,
  type ThemeBrief,
  type ThemeDetail,
  type ThemeInfo,
  type ThemeReference,
  type ThemeStyle,
} from '@wilox/shared';
import type { Db } from '@wilox/db';
import { BASE_THEMES } from '@wilox/styles';
import { env, repoPath } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { ffmpeg } from '../media/ffmpeg.js';
import { promptMeta } from '../persistence/prompt-meta.js';
import { loadThemes, persistTheme } from '../persistence/theme-persistence.js';
import { MediaService } from '../storage/media.service.js';

interface Entry {
  theme: StoredTheme;
  subject: BehaviorSubject<ThemeDetail>;
  /** Escritura en la BD en curso (en serie por tema; la última versión gana). */
  saving?: Promise<void>;
  dirty?: boolean;
  /** Pruebas que ya tienen fila (a las nuevas se les guarda la copia del tema). */
  knownTests: Set<number>;
}

/** Slug ASCII para ids de tema: "Acuarela Médica" → "acuarela-medica". */
export function slugify(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'tema';
}

/**
 * Temas del Estudio. Hito 3 (ADR-029): la fuente de verdad es la BD (Theme, ThemeReference, ThemeTest,
 * Prompt); los archivos (referencias, pruebas, miniatura) siguen en storage/themes/<id>/. Al arrancar se
 * cargan todos en memoria (son pocos) para que el Estudio siga siendo síncrono, y cada cambio se escribe
 * en la BD en serie. Ya no se escribe theme.json.
 * También es el registro único de temas: resuelve los 3 base (código, comunes a todos) y los del Estudio,
 * cada uno visible solo para su dueño.
 */
@Injectable()
export class ThemeStore implements OnModuleInit {
  private readonly logger = new Logger('ThemeStore');
  private readonly entries = new Map<string, Entry>();
  readonly root = join(repoPath(env.STORAGE_DIR), 'themes');

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly media: MediaService,
  ) {
    mkdirSync(this.root, { recursive: true });
  }

  async onModuleInit() {
    const themes = await loadThemes(this.db);
    for (const theme of themes) this.entries.set(theme.id, this.newEntry(theme, true));
    this.logger.log(`${themes.length} tema(s) del Estudio cargados desde la base de datos.`);
  }

  private newEntry(theme: StoredTheme, known: boolean): Entry {
    return { theme, subject: new BehaviorSubject(this.toDetail(theme)), knownTests: new Set(known ? theme.tests.map((t) => t.n) : []) };
  }

  dir(id: string) {
    return join(this.root, id);
  }

  fileUrl(id: string, rel: string, v?: number | string) {
    return `/api/themes/${id}/files/${rel.split('\\').join('/')}${v !== undefined ? `?v=${v}` : ''}`;
  }

  // ---------------------------------------------------------------- lectura

  /** ThemeStyle de cualquier tema (base o del Estudio), o undefined si no existe. */
  style(id: string): ThemeStyle | undefined {
    if (isBaseThemeId(id)) return BASE_THEMES[id];
    return this.entry(id)?.theme.style;
  }

  stored(id: string): StoredTheme | undefined {
    return this.entry(id)?.theme;
  }

  /** Base: todos. Del Estudio: solo su dueño. */
  canAccess(id: string, userId: string): boolean {
    if (isBaseThemeId(id)) return true;
    const t = this.stored(id);
    return !!t && t.ownerId === userId;
  }

  /** Rutas absolutas de las referencias de un tema del Estudio. */
  referencePaths(id: string): string[] {
    const t = this.stored(id);
    return t ? t.references.map((r) => join(this.dir(id), 'referencias', r.file)).filter((p) => existsSync(p)) : [];
  }

  /** Láminas tipográficas listas de un tema del Estudio (ADR-094), en el orden de sus fuentes. */
  typographyPaths(id: string): string[] {
    const t = this.stored(id);
    return (t?.style.typefaces ?? [])
      .filter((f) => f.status === 'ready' && f.sheet)
      .map((f) => join(this.dir(id), 'tipografias', f.sheet!))
      .filter((p) => existsSync(p));
  }

  private entry(id: string): Entry | undefined {
    if (!THEME_ID_RE.test(id) || isBaseThemeId(id)) return undefined;
    return this.entries.get(id);
  }

  baseDetail(id: keyof typeof BASE_THEMES): ThemeDetail {
    const style = BASE_THEMES[id];
    return { id, origin: 'base', readOnly: true, status: 'saved', version: 1, style, references: [], tests: [] };
  }

  toDetail(t: StoredTheme): ThemeDetail {
    const thumb = join(this.dir(t.id), 'miniatura.png');
    return {
      id: t.id,
      origin: 'custom',
      readOnly: false,
      status: t.status,
      version: t.version,
      style: t.style,
      brief: t.brief,
      references: t.references.map((r) => ({ ...r, url: this.fileUrl(t.id, `referencias/${r.file}`) })),
      tests: t.tests,
      basedOn: t.basedOn,
      thumbnailUrl: existsSync(thumb) ? this.fileUrl(t.id, 'miniatura.png', t.updatedAt) : undefined,
      thumbnailTest: t.thumbnailTest,
      proposalNotes: t.proposalNotes,
      activity: t.activity,
      updatedAt: t.updatedAt,
    };
  }

  detail(id: string): ThemeDetail | undefined {
    if (isBaseThemeId(id)) return this.baseDetail(id);
    const e = this.entry(id);
    return e ? this.toDetail(e.theme) : undefined;
  }

  subject(id: string) {
    return this.entry(id)?.subject;
  }

  /** Mis temas (Estudio): los 3 base primero y después los del usuario, del más reciente al más antiguo. */
  list(ownerId: string): ThemeDetail[] {
    const custom = [...this.entries.values()]
      .filter((e) => e.theme.ownerId === ownerId)
      .map((e) => this.toDetail(e.theme))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return [...(Object.keys(BASE_THEMES) as (keyof typeof BASE_THEMES)[]).map((id) => this.baseDetail(id)), ...custom];
  }

  /** Selector del Composer: base + temas guardados del usuario (los borradores no aparecen). */
  composerList(ownerId: string): ThemeInfo[] {
    return this.list(ownerId)
      .filter((d) => d.status === 'saved')
      .map((d) => ({ ...d.style.info, origin: d.origin, thumbnailUrl: d.thumbnailUrl }));
  }

  /**
   * Selector del Composer en un proyecto de otro dueño (hito 11, ADR-142): los del usuario y, después, los temas
   * guardados del dueño del proyecto (marcados con su nombre; se usan, no se editan).
   */
  composerListFor(userId: string, projectOwnerId: string, ownerName: string): ThemeInfo[] {
    const mine = this.composerList(userId);
    if (projectOwnerId === userId) return mine;
    const owner = this.composerList(projectOwnerId)
      .filter((t) => t.origin === 'custom')
      .map((t) => ({ ...t, ownerName }));
    return [...mine, ...owner];
  }

  // ---------------------------------------------------------------- escritura

  private newId(name: string) {
    let id = '';
    do id = `${slugify(name)}-${randomUUID().slice(0, 6)}`;
    while (this.entries.has(id) || existsSync(this.dir(id)));
    return id;
  }

  /** Copia del ThemeStyle de las pruebas que aún no tienen fila (theme.snapshot.json si ya existe). */
  private snapshotsFor(e: Entry): Map<number, ThemeStyle> {
    const out = new Map<number, ThemeStyle>();
    for (const t of e.theme.tests) {
      if (e.knownTests.has(t.n)) continue;
      const f = join(this.dir(e.theme.id), 'pruebas', String(t.n).padStart(3, '0'), 'theme.snapshot.json');
      try {
        out.set(t.n, existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as ThemeStyle) : structuredClone(e.theme.style));
      } catch {
        out.set(t.n, structuredClone(e.theme.style));
      }
    }
    return out;
  }

  /** Escribe el tema en la BD en serie: si llegan cambios mientras se escribe, se escribe otra vez la última versión. */
  private schedule(e: Entry, opts: { deletedAt?: Date; dir?: string } = {}) {
    e.dirty = true;
    if (e.saving) return;
    e.saving = (async () => {
      while (e.dirty) {
        e.dirty = false;
        const snap = structuredClone(e.theme);
        const snapshots = this.snapshotsFor(e);
        try {
          await persistTheme(this.db, snap, {
            ownerId: snap.ownerId!,
            dir: opts.dir ?? `themes/${snap.id}`,
            snapshots,
            deletedAt: opts.deletedAt,
          });
          for (const n of snapshots.keys()) e.knownTests.add(n);
        } catch (err) {
          this.logger.error(`No se pudo guardar el tema ${snap.id} en la BD: ${(err as Error).message}`);
        }
      }
    })().finally(() => {
      e.saving = undefined;
      if (e.dirty) this.schedule(e, opts);
    });
  }

  /** Aplica cambios, emite por SSE y los guarda en la BD (en serie). */
  update(id: string, patch?: (t: StoredTheme) => void, opts: { styleChanged?: boolean } = {}): StoredTheme {
    const e = this.entry(id);
    if (!e) throw new Error('Tema no encontrado.');
    patch?.(e.theme);
    if (opts.styleChanged) e.theme.version += 1;
    e.theme.style.info.id = id;
    e.theme.updatedAt = new Date().toISOString();
    e.subject.next(this.toDetail(e.theme));
    this.schedule(e);
    // Los archivos nuevos del tema (referencias, pruebas, miniatura) se suben al remoto (hito 8, ADR-093).
    this.media.dirty(this.dir(id));
    return e.theme;
  }

  /** Espera a que el tema quede escrito en la BD. */
  async flush(id: string) {
    const e = this.entries.get(id);
    while (e?.saving) await e.saving;
  }

  /**
   * Guarda un prompt del Estudio: archivo (norma del proyecto) y fila Prompt. Con `test`, en
   * pruebas/NNN/prompts/; sin él, en propuestas/ (propuestas de Opus).
   */
  async savePrompt(id: string, test: number | undefined, name: string, content: string) {
    const dir = test === undefined ? join(this.dir(id), 'propuestas') : join(this.dir(id), 'pruebas', String(test).padStart(3, '0'), 'prompts');
    mkdirSync(dir, { recursive: true });
    await writeFile(join(dir, name), content);
    const { kind, version } = promptMeta(name);
    try {
      if (test === undefined) {
        await this.flush(id);
        await this.db.prompt.upsert({
          where: { themeId_name: { themeId: id, name } },
          create: { themeId: id, name, kind, version, content },
          update: { content, kind, version },
        });
      } else {
        await this.flush(id);
        const row = await this.db.themeTest.findUnique({ where: { themeId_n: { themeId: id, n: test } }, select: { id: true } });
        if (!row) throw new Error(`la prueba ${test} aún no está en la BD`);
        await this.db.prompt.upsert({
          where: { themeTestId_name: { themeTestId: row.id, name } },
          create: { themeTestId: row.id, name, kind, version, content },
          update: { content, kind, version },
        });
      }
    } catch (err) {
      this.logger.warn(`Prompt ${name} de ${id} guardado solo en archivo: ${(err as Error).message}`);
    }
  }

  private createEntry(theme: StoredTheme): StoredTheme {
    for (const d of ['referencias', 'pruebas']) mkdirSync(join(this.dir(theme.id), d), { recursive: true });
    this.entries.set(theme.id, this.newEntry(theme, false));
    return this.update(theme.id);
  }

  /** Nuevo borrador desde el formulario. El ThemeStyle inicial es un esqueleto: Opus lo propone después. */
  create(brief: ThemeBrief, ownerId: string): StoredTheme {
    const id = this.newId(brief.name);
    const now = new Date().toISOString();
    return this.createEntry({
      id,
      ownerId,
      status: 'draft',
      version: 1,
      createdAt: now,
      updatedAt: now,
      brief,
      style: emptyStyle(id, brief),
      references: [],
      tests: [],
    });
  }

  /** Duplica un tema (base o propio) como borrador nuevo del usuario: estilo, brief y referencias; sin pruebas. */
  duplicate(sourceId: string, ownerId: string): StoredTheme {
    const src = this.canAccess(sourceId, ownerId) ? this.detail(sourceId) : undefined;
    if (!src) throw new Error('Tema no encontrado.');
    const name = `${src.style.info.name} (copia)`.slice(0, 60);
    const id = this.newId(name);
    const now = new Date().toISOString();
    const style = structuredClone(src.style);
    style.info = { ...style.info, id, name };
    const brief: ThemeBrief = src.brief
      ? { ...structuredClone(src.brief), name }
      : { name, description: src.style.info.description, imageryMode: src.style.usesMediaFrames ? 'photos' : 'objects' };
    mkdirSync(join(this.dir(id), 'referencias'), { recursive: true });
    if (src.origin === 'custom') {
      const from = join(this.dir(sourceId), 'referencias');
      if (existsSync(from)) cpSync(from, join(this.dir(id), 'referencias'), { recursive: true });
      // Las tipografías y sus láminas (ADR-094) van con la copia.
      const typo = join(this.dir(sourceId), 'tipografias');
      if (existsSync(typo)) cpSync(typo, join(this.dir(id), 'tipografias'), { recursive: true });
    } else delete style.typefaces;
    return this.createEntry({
      id,
      ownerId,
      status: 'draft',
      version: 1,
      createdAt: now,
      updatedAt: now,
      brief,
      style,
      references: (src.origin === 'custom' ? this.stored(sourceId)!.references : []).map((r) => ({ ...r, url: undefined })),
      basedOn: sourceId,
      tests: [],
    });
  }

  /** Borrar = marcar deletedAt y mover la carpeta a storage/themes/_papelera/ (recuperable a mano). Los base no se pueden borrar. */
  async remove(id: string) {
    if (isBaseThemeId(id)) throw new Error('Los temas base no se pueden borrar.');
    const e = this.entry(id);
    if (!e) throw new Error('Tema no encontrado.');
    await this.flush(id);
    const trash = join(this.root, '_papelera');
    mkdirSync(trash, { recursive: true });
    const moved = `${id}-${Date.now()}`;
    if (existsSync(this.dir(id))) renameSync(this.dir(id), join(trash, moved));
    await this.media.moved(this.dir(id), join(trash, moved));
    this.schedule(e, { deletedAt: new Date(), dir: `themes/_papelera/${moved}` });
    await this.flush(id);
    e.subject.complete();
    this.entries.delete(id);
  }

  /** Guarda las imágenes de referencia normalizadas a JPEG (lado mayor ≤ 2048 px). */
  async addReferences(id: string, files: { name: string; data: Buffer }[]): Promise<StoredTheme> {
    const t = this.stored(id);
    if (!t) throw new Error('Tema no encontrado.');
    const dir = join(this.dir(id), 'referencias');
    mkdirSync(dir, { recursive: true });
    const added: ThemeReference[] = [];
    let n = t.references.reduce((m, r) => Math.max(m, Number(r.file.match(/\d+/)?.[0] ?? 0)), 0);
    for (const f of files) {
      n += 1;
      const tmp = join(dir, `_subida_${randomUUID().slice(0, 8)}`);
      const file = `ref_${String(n).padStart(2, '0')}.jpg`;
      await writeFile(tmp, f.data);
      try {
        await ffmpeg([
          '-i',
          tmp,
          '-vf',
          "scale='if(gt(iw,ih),min(2048,iw),-2)':'if(gt(iw,ih),-2,min(2048,ih))',format=yuvj420p",
          '-frames:v',
          '1',
          '-update',
          '1',
          '-q:v',
          '3',
          join(dir, file),
        ]);
      } catch (e) {
        throw new Error(`No se pudo leer la imagen "${f.name}": ${(e as Error).message.split('\n')[0]}`);
      } finally {
        await rm(tmp, { force: true });
      }
      added.push({ file, originalName: f.name.slice(0, 120) });
    }
    return this.update(id, (x) => x.references.push(...added));
  }

  async removeReference(id: string, file: string): Promise<StoredTheme> {
    const t = this.stored(id);
    if (!t) throw new Error('Tema no encontrado.');
    if (!t.references.some((r) => r.file === file)) throw new Error('Referencia no encontrada.');
    const dir = join(this.dir(id), 'referencias');
    const trash = join(dir, '_quitadas');
    mkdirSync(trash, { recursive: true });
    if (existsSync(join(dir, file))) await rename(join(dir, file), join(trash, `${Date.now()}_${file}`));
    return this.update(id, (x) => (x.references = x.references.filter((r) => r.file !== file)));
  }

  /** Copia el frame A de una prueba como miniatura del tema. */
  async setThumbnail(id: string, framePath: string, test: number) {
    await copyFile(framePath, join(this.dir(id), 'miniatura.png'));
    this.update(id, (t) => (t.thumbnailTest = test));
  }
}

/** Esqueleto de ThemeStyle para un borrador recién creado (antes de la propuesta de Opus). */
export function emptyStyle(id: string, brief: ThemeBrief): ThemeStyle {
  return {
    info: { id, name: brief.name, description: brief.description.slice(0, 120), swatches: [] },
    videoBible: '',
    imageBible: '',
    clipBible: '',
    avoid: '',
    soundHint: '',
    usesMediaFrames: brief.imageryMode === 'photos',
    directorNotes: '',
    imagery: '',
    sfx: { opener: 'whoosh', accents: ['pop', 'sparkle', 'tick'], hit: 'impact' },
  };
}
