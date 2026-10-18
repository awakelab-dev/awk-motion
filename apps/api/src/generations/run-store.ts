import { Inject, Injectable, Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BehaviorSubject } from 'rxjs';
import type { Db } from '@wilox/db';
import type { RunLogEntry, RunState, ThemeStyle } from '@wilox/shared';
import { env, repoPath } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { promptMeta } from '../persistence/prompt-meta.js';
import { markInterrupted, type RunData } from '../persistence/run-data.js';
import { loadRun, persistRun, type WriteCache } from '../persistence/run-persistence.js';
import { MediaService } from '../storage/media.service.js';
import type { TtsResult } from '../providers/ports.js';

/**
 * Estado de una generación. Mientras trabaja vive en memoria (SSE, colas, busy); cada cambio se
 * escribe en la BD en serie (hito 3, ADR-031). Ya no se escriben state.json ni internal.json.
 */
export interface RunRecord extends RunData {
  subject: BehaviorSubject<RunState>;
  busy: boolean;
  paraAudio?: TtsResult[];
  /** Siempre hay proyecto (hito 4, ADR-035). */
  projectId: string;
  parentId: string | null;
  /** Escritura en la BD en curso (en serie; la última versión gana). */
  saving?: Promise<void>;
  dirty?: boolean;
  /** Entradas del log que aún no están en la BD. */
  pendingLogs: RunLogEntry[];
  cache: WriteCache;
}

/** runs/<id>/theme.json (hito 2) */
export interface RunThemeFile {
  style: ThemeStyle;
  references: { path: string; ref?: string; typography?: boolean }[];
}

@Injectable()
export class RunStore {
  private readonly logger = new Logger('RunStore');
  private runs = new Map<string, RunRecord>();
  private loading = new Map<string, Promise<RunRecord | undefined>>();
  /** Lo fija el PipelineService: retoma una generación restaurada que estaba trabajando (ADR-046). */
  onRestore?: (rec: RunRecord) => void;
  readonly root = join(repoPath(env.STORAGE_DIR), 'runs');

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly media: MediaService,
  ) {}

  /** Carpeta absoluta a partir de la ruta relativa guardada en la BD (runs/<id>). */
  dirOf(relDir: string) {
    return join(repoPath(env.STORAGE_DIR), relDir);
  }

  private newRecord(d: RunData, extra: { projectId: string; parentId: string | null }): RunRecord {
    return {
      ...d,
      ...extra,
      subject: new BehaviorSubject(structuredClone(d.state)),
      busy: false,
      pendingLogs: [],
      cache: new Map(),
    };
  }

  create(
    state: RunState,
    dir: string,
    theme: RunThemeFile,
    opts: { ownerId: string; projectId: string; parentId?: string | null },
  ): RunRecord {
    const rec = this.newRecord(
      {
        state: { ...state, projectId: opts.projectId, parentId: opts.parentId ?? null },
        dir,
        ownerId: opts.ownerId,
        theme: theme.style,
        themeRefs: theme.references,
        approved: false,
        keyAssets: new Map(),
        clipRaw: new Map(),
      },
      { projectId: opts.projectId, parentId: opts.parentId ?? null },
    );
    this.runs.set(state.id, rec);
    this.schedule(rec);
    return rec;
  }

  /** La copia del tema (con los media_id de sus referencias ya subidas) va en la fila de la generación. */
  async saveTheme(rec: RunRecord) {
    this.schedule(rec);
    await this.flush(rec);
  }

  /** La generación si está en memoria (sin restaurarla). */
  peek(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  /**
   * Quita de memoria una generación sin trabajos (hito 8, ADR-093): su carpeta va a salir de la caché local;
   * si se vuelve a pedir, se restaura desde la BD y su carpeta se baja al trabajar en ella.
   */
  release(id: string): boolean {
    const rec = this.runs.get(id);
    if (!rec) return true;
    if (rec.busy || rec.saving || rec.dirty || rec.subject.observed) return false;
    this.runs.delete(id);
    return true;
  }

  /** Todas las generaciones en memoria. */
  all(): RunRecord[] {
    return [...this.runs.values()];
  }

  /** Devuelve la generación; si no está en memoria (la API se reinició), la restaura desde la BD. */
  async get(id: string): Promise<RunRecord | undefined> {
    const inMem = this.runs.get(id);
    if (inMem) return inMem;
    if (!/^[\w-]+$/.test(id)) return undefined;
    let p = this.loading.get(id);
    if (!p) {
      p = this.restore(id).finally(() => this.loading.delete(id));
      this.loading.set(id, p);
    }
    return p;
  }

  private async restore(id: string): Promise<RunRecord | undefined> {
    try {
      const d = await loadRun(this.db, id, (rel) => this.dirOf(rel));
      if (!d) return undefined;
      const rec = this.newRecord(d, { projectId: d.projectId, parentId: d.parentId });
      this.runs.set(id, rec);
      // Hito 5 (ADR-046): en el mismo modo, lo que estaba en marcha se retoma solo (PipelineService.resume).
      // En otro modo no se puede retomar (las referencias de Higgsfield no sirven en API y al revés).
      if (this.onRestore && d.state.mode === env.GENERATION_MODE) {
        rec.subject.next(structuredClone(rec.state));
        this.onRestore(rec);
      } else if (markInterrupted(rec)) {
        this.log(rec, 'Generación restaurada tras un reinicio de la API: lo que estaba en marcha quedó para reintentar.', 'warn');
      } else rec.subject.next(structuredClone(rec.state));
      return rec;
    } catch (e) {
      this.logger.warn(`No se pudo restaurar ${id}: ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * Vuelve a leer la generación de la BD sobre el mismo registro (tras un cambio hecho directamente en la BD, como
   * correr los índices al dividir un clip, ADR-130). Quien la mira sigue suscrito.
   */
  async reload(rec: RunRecord) {
    await this.flush(rec);
    const d = await loadRun(this.db, rec.state.id, (rel) => this.dirOf(rel));
    if (!d) throw new Error(`No se pudo volver a leer ${rec.state.id}.`);
    Object.assign(rec, { state: d.state, words: d.words, storyboard: d.storyboard, plan: d.plan, shots: d.shots, keyAssets: d.keyAssets, clipRaw: d.clipRaw, approved: d.approved });
    rec.cache.clear();
    rec.subject.next(structuredClone(rec.state));
  }

  /** Escribe la generación en la BD en serie: si llegan cambios mientras escribe, vuelve a escribir la última versión. */
  private schedule(rec: RunRecord) {
    rec.dirty = true;
    if (rec.saving) return;
    rec.saving = (async () => {
      let failures = 0;
      while (rec.dirty) {
        rec.dirty = false;
        const logs = rec.pendingLogs.splice(0);
        const snapshot: RunData = {
          ...rec,
          state: structuredClone(rec.state),
          keyAssets: new Map(rec.keyAssets),
          clipRaw: new Map(rec.clipRaw),
          themeRefs: rec.themeRefs.map((r) => ({ ...r })),
        };
        try {
          await persistRun(this.db, snapshot, {
            relDir: `runs/${rec.state.id}`,
            projectId: rec.projectId,
            parentId: rec.parentId,
            newLogs: logs,
            cache: rec.cache,
          });
          failures = 0;
        } catch (e) {
          // La próxima escritura reescribe todo (la caché ya no es fiable) y reintenta el log.
          rec.cache.clear();
          rec.pendingLogs.unshift(...logs);
          failures += 1;
          this.logger.error(`No se pudo guardar ${rec.state.id} en la BD (intento ${failures}): ${(e as Error).message}`);
          if (failures >= 3) break; // el próximo cambio lo vuelve a intentar
          await new Promise((r) => setTimeout(r, 1000 * failures));
          rec.dirty = true;
        }
      }
    })().finally(() => {
      rec.saving = undefined;
      if (rec.dirty) this.schedule(rec);
    });
  }

  /**
   * Mueve a otro proyecto las generaciones que ya están en memoria (al eliminar un proyecto moviendo
   * sus videos a "Sin clasificar", ADR-035): así una escritura posterior no devuelve el proyecto viejo.
   */
  async reassignProject(fromId: string, toId: string) {
    const moved = [...this.runs.values()].filter((r) => r.projectId === fromId);
    for (const rec of moved) {
      rec.projectId = toId;
      this.update(rec, (s) => (s.projectId = toId));
    }
    await Promise.all(moved.map((r) => this.flush(r)));
  }

  async flush(rec: RunRecord) {
    while (rec.saving) await rec.saving;
  }

  /** Espera a que todas las generaciones en memoria estén escritas (apagado ordenado). */
  async flushAll() {
    await Promise.all([...this.runs.values()].map((r) => this.flush(r)));
  }

  /** Aplica cambios, emite por SSE y los guarda en la BD (en serie). */
  update(rec: RunRecord, patch?: (s: RunState) => void) {
    patch?.(rec.state);
    rec.subject.next(structuredClone(rec.state));
    this.schedule(rec);
    // Los archivos nuevos de la carpeta se suben al remoto poco después (hito 8, ADR-093).
    this.media.dirty(rec.dir);
  }

  log(rec: RunRecord, message: string, level: RunLogEntry['level'] = 'info') {
    const entry = { at: new Date().toISOString(), level, message };
    rec.pendingLogs.push(entry);
    this.update(rec, (s) => {
      s.log.push(entry);
      if (s.log.length > 300) s.log.splice(0, s.log.length - 300);
    });
  }

  /** Guarda un prompt: archivo en prompts/ (norma del proyecto y entregable) y fila Prompt. */
  async savePrompt(rec: RunRecord, name: string, content: string) {
    await mkdir(join(rec.dir, 'prompts'), { recursive: true });
    await writeFile(join(rec.dir, 'prompts', name), content);
    const { kind, version } = promptMeta(name);
    try {
      await this.flush(rec);
      await this.db.prompt.upsert({
        where: { generationId_name: { generationId: rec.state.id, name } },
        create: { generationId: rec.state.id, name, kind, version, content },
        update: { content, kind, version },
      });
    } catch (e) {
      this.logger.warn(`Prompt ${name} de ${rec.state.id} guardado solo en archivo: ${(e as Error).message}`);
    }
  }
}
