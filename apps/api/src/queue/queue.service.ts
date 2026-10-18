import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { Db } from '@wilox/db';
import { env } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { currentScope } from '../jobs/job-scope.js';
import { Capacity, type CapacitySnapshot, type Outcome } from './capacity.js';
import { backoffMs, transientInfo } from './transient.js';

export type Resource = 'elevenlabs' | 'anthropic' | 'openai' | 'minimax' | 'higgsfield' | 'ffmpeg';
export const RESOURCES: Resource[] = ['elevenlabs', 'anthropic', 'openai', 'minimax', 'higgsfield', 'ffmpeg'];

export interface TaskSpec {
  resource: Resource;
  kind: string;
  target: string;
  ownerId: string;
  generationId?: string;
  themeId?: string;
  /** Hora de lanzamiento del video (ms); 0 = primero (Estudio). */
  priority: number;
  /** Se puede retomar tras un reinicio (clip de MiniMax con su task_id): al apagar no se le espera. */
  resumable?: boolean;
}

export interface RunningTask {
  id: string;
  /** Guarda el id del proveedor (task_id de MiniMax) en la fila de la cola. */
  setExternalId(id: string): Promise<void>;
}

/** Trabajo en la cola de este proceso (para la vista "Cola" y el despacho). */
export interface LiveTask {
  id: string;
  spec: TaskSpec;
  state: 'queued' | 'running';
  /** No antes de (espera tras un fallo transitorio). */
  notBefore: number;
  attempts: number;
  queuedAt: number;
  startedAt?: number;
  lastError?: string;
}

interface Waiter extends LiveTask {
  grant?: () => void;
  cancel?: (e: Error) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** El video se detuvo (hito 5, ADR-052): sus trabajos en cola se cancelan y no entran nuevos. */
export class PausedError extends Error {
  readonly paused = true;
  constructor() {
    super('Detenido por el usuario.');
  }
}

/**
 * Cola global por recurso (hito 5, ADR-045). Cada trabajo de un proveedor (o de ffmpeg) es una fila de
 * QueueTask. Un despachador por recurso, en cuanto hay hueco según su Capacity, toma el trabajo listo de
 * mayor prioridad (hora de lanzamiento del video, después orden de llegada) con FOR UPDATE SKIP LOCKED,
 * sea del video que sea. Lo que está en marcha no se interrumpe. Los fallos transitorios esperan y se
 * reintentan sin marcar el video; un error definitivo solo afecta a su video.
 */
@Injectable()
export class QueueService implements OnModuleInit {
  private readonly logger = new Logger('Cola');
  private readonly caps = new Map<Resource, Capacity>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly kicking = new Set<Resource>();
  private readonly rekick = new Set<Resource>();
  private readonly timers = new Map<Resource, { at: number; t: NodeJS.Timeout }>();
  private draining = false;
  /** Videos detenidos (ADR-052): no se les da turno. */
  private readonly paused = new Set<string>();
  /** Se emite cuando cambia algo (vista "Cola", indicador de la cabecera). */
  readonly changes$ = new Subject<void>();
  /** Lista tras limpiar lo que quedó de una ejecución anterior. */
  ready!: Promise<void>;

  constructor(@Inject(DB) private readonly db: Db) {
    const minimax = env.QUEUE_MINIMAX_CONCURRENCY ?? env.MINIMAX_CONCURRENCY;
    const def: Record<Resource, [number, number | undefined]> = {
      elevenlabs: [env.QUEUE_ELEVENLABS_CONCURRENCY, env.QUEUE_ELEVENLABS_PER_MIN],
      anthropic: [env.QUEUE_ANTHROPIC_CONCURRENCY, env.QUEUE_ANTHROPIC_PER_MIN],
      openai: [env.QUEUE_OPENAI_CONCURRENCY, env.QUEUE_OPENAI_PER_MIN],
      minimax: [Math.max(1, Math.round(minimax)), env.QUEUE_MINIMAX_PER_MIN],
      higgsfield: [env.QUEUE_HIGGSFIELD_CONCURRENCY, undefined],
      ffmpeg: [env.QUEUE_FFMPEG_CONCURRENCY, undefined],
    };
    for (const r of RESOURCES) this.caps.set(r, new Capacity(r, def[r][0], def[r][1]));
  }

  onModuleInit() {
    this.ready = this.cleanup();
  }

  /**
   * Lo que quedó en la cola de la ejecución anterior ya no tiene quien lo espere: se cancela. Las
   * generaciones se retoman solas (PipelineService) y vuelven a encolar lo que les falte; los clips de
   * MiniMax se siguen consultando por su task_id, sin pedirse otra vez.
   */
  private async cleanup() {
    try {
      const r = await this.db.queueTask.updateMany({
        where: { status: { in: ['queued', 'running'] } },
        data: { status: 'cancelled', error: 'Interrumpido por un reinicio de la API (se retoma solo).', finishedAt: new Date() },
      });
      if (r.count) this.logger.log(`${r.count} trabajo(s) de la ejecución anterior pasan a retomarse.`);
      await this.db.queueTask.deleteMany({
        where: { status: { in: ['done', 'cancelled'] }, createdAt: { lt: new Date(Date.now() - 14 * 86_400_000) } },
      });
    } catch (e) {
      this.logger.warn(`No se pudo limpiar la cola: ${(e as Error).message}`);
    }
  }

  capacity(r: Resource): Capacity {
    return this.caps.get(r)!;
  }

  /** Corre fn dentro de la cola con el ámbito actual (dueño, video y prioridad). Sin ámbito, directo. */
  runScoped<T>(resource: Resource | undefined, kind: string, target: string, fn: (t: RunningTask) => Promise<T>, extra: Partial<TaskSpec> = {}): Promise<T> {
    const s = currentScope();
    if (!resource || !s) return fn({ id: '', setExternalId: async () => undefined });
    return this.run(
      { resource, kind, target, ownerId: s.ownerId, generationId: s.generationId, themeId: s.themeId, priority: s.priority ?? Date.now(), ...extra },
      fn,
    );
  }

  /** Encola un trabajo, espera su turno y lo ejecuta; reintenta los fallos transitorios con espera. */
  async run<T>(spec: TaskSpec, fn: (t: RunningTask) => Promise<T>): Promise<T> {
    await this.ready;
    if (spec.generationId && this.paused.has(spec.generationId)) throw new PausedError();
    const row = await this.db.queueTask.create({
      data: {
        ownerId: spec.ownerId,
        generationId: spec.generationId ?? null,
        themeId: spec.themeId ?? null,
        resource: spec.resource,
        kind: spec.kind,
        target: spec.target.slice(0, 200),
        priority: new Date(spec.priority),
      },
      select: { id: true },
    });
    const w: Waiter = { id: row.id, spec, state: 'queued', notBefore: 0, attempts: 0, queuedAt: Date.now() };
    this.waiters.set(w.id, w);
    const task: RunningTask = {
      id: w.id,
      setExternalId: (externalId) => this.write(w.id, { externalId }),
    };
    try {
      for (;;) {
        if (spec.generationId && this.paused.has(spec.generationId)) throw new PausedError();
        await new Promise<void>((resolve, reject) => {
          w.grant = resolve;
          w.cancel = reject;
          void this.kick(spec.resource);
        });
        try {
          const out = await fn(task);
          this.finish(w, 'ok');
          void this.write(w.id, { status: 'done', finishedAt: new Date(), error: null });
          return out;
        } catch (e) {
          if (e instanceof PausedError) throw e;
          const info = transientInfo(e);
          const msg = (e as Error)?.message ?? String(e);
          if (info && this.draining) {
            // Apagando: no se marca el video con error; el paso queda en marcha y se retoma al volver.
            this.finish(w, 'transient');
            void this.write(w.id, { status: 'cancelled', finishedAt: new Date(), error: `Apagado: ${msg.slice(0, 1900)}` });
            return new Promise<T>(() => undefined);
          }
          if (info && w.attempts < env.QUEUE_MAX_RETRIES) {
            w.attempts += 1;
            const wait = info.retryAfterMs ?? backoffMs(w.attempts);
            w.notBefore = Date.now() + wait;
            w.lastError = msg;
            this.logger.warn(`${spec.resource} · ${spec.target}: ${msg.split('\n')[0].slice(0, 160)} → reintento ${w.attempts} en ${Math.round(wait / 1000)} s`);
            this.finish(w, 'transient', info.retryAfterMs, true);
            await this.write(w.id, { status: 'queued', nextRunAt: new Date(w.notBefore), error: msg.slice(0, 2000) }, 5);
            continue;
          }
          this.finish(w, info ? 'transient' : 'error');
          void this.write(w.id, { status: 'failed', finishedAt: new Date(), error: msg.slice(0, 2000) });
          throw e;
        }
      }
    } finally {
      this.waiters.delete(w.id);
      this.changed();
    }
  }

  private finish(w: Waiter, outcome: Outcome, retryAfterMs?: number, requeue = false) {
    const cap = this.capacity(w.spec.resource);
    if (w.state === 'running') cap.onEnd(outcome, Date.now(), retryAfterMs);
    w.state = 'queued';
    w.startedAt = undefined;
    if (!requeue) w.grant = undefined;
    void this.kick(w.spec.resource);
  }

  private async write(id: string, data: Record<string, unknown>, tries = 1) {
    for (let i = 1; ; i++) {
      try {
        await this.db.queueTask.update({ where: { id }, data });
        return;
      } catch (e) {
        if (i >= tries) {
          this.logger.warn(`No se pudo actualizar la tarea ${id}: ${(e as Error).message}`);
          return;
        }
        await sleep(1000 * i);
      }
    }
  }

  /** Toma de la BD el trabajo listo de mayor prioridad de este recurso entre los que esperan aquí. */
  private async claim(r: Resource, now: number): Promise<string | undefined> {
    const ids = [...this.waiters.values()].filter((w) => w.spec.resource === r && w.state === 'queued' && w.grant && w.notBefore <= now).map((w) => w.id);
    if (!ids.length) return undefined;
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "QueueTask" SET "status" = 'running', "startedAt" = ${new Date()}, "attempts" = "attempts" + 1
      WHERE "id" = (
        SELECT "id" FROM "QueueTask"
        WHERE "resource" = ${r} AND "status" IN ('queued', 'running') AND "id" = ANY(${ids}::uuid[])
        ORDER BY "priority" ASC, "seq" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING "id"::text AS "id"`;
    return rows[0]?.id;
  }

  /** Despacha el recurso mientras haya hueco y trabajos listos. */
  private async kick(r: Resource) {
    if (this.kicking.has(r)) {
      this.rekick.add(r);
      return;
    }
    this.kicking.add(r);
    try {
      do {
        this.rekick.delete(r);
        const cap = this.capacity(r);
        while (!this.draining && cap.canStart(Date.now())) {
          let id: string | undefined;
          try {
            id = await this.claim(r, Date.now());
          } catch (e) {
            // BD caída un momento: se vuelve a intentar en unos segundos (si no, nada despertaría al recurso).
            this.logger.warn(`No se pudo tomar un trabajo de ${r}: ${(e as Error).message}`);
            const t = setTimeout(() => void this.kick(r), 3000);
            t.unref?.();
            break;
          }
          if (!id) break;
          const w = this.waiters.get(id);
          if (!w?.grant) continue;
          w.state = 'running';
          w.startedAt = Date.now();
          cap.onStart(w.startedAt);
          const grant = w.grant;
          w.grant = undefined;
          w.cancel = undefined;
          grant();
        }
      } while (this.rekick.has(r));
    } finally {
      this.kicking.delete(r);
      this.arm(r);
      this.changed();
    }
  }

  /** Programa el próximo despacho si hay trabajos que esperan por tiempo (pausa, por minuto, reintento). */
  private arm(r: Resource) {
    const now = Date.now();
    const waiting = [...this.waiters.values()].filter((w) => w.spec.resource === r && w.state === 'queued' && w.grant);
    if (!waiting.length || this.draining) return;
    const cap = this.capacity(r);
    const times = [cap.nextTimeSlot(now), ...waiting.map((w) => (w.notBefore > now ? w.notBefore : 0))].filter((t) => t > now);
    const ready = waiting.some((w) => w.notBefore <= now);
    let at = times.length ? Math.min(...times) : 0;
    if (ready && cap.nextTimeSlot(now) > now) at = cap.nextTimeSlot(now);
    if (!at) return;
    const cur = this.timers.get(r);
    if (cur && cur.at <= at && cur.at > now) return;
    if (cur) clearTimeout(cur.t);
    const t = setTimeout(() => {
      this.timers.delete(r);
      void this.kick(r);
    }, at - now + 20);
    t.unref?.();
    this.timers.set(r, { at, t });
  }

  private changedTimer?: NodeJS.Timeout;
  private changed() {
    if (this.changedTimer) return;
    this.changedTimer = setTimeout(() => {
      this.changedTimer = undefined;
      this.changes$.next();
    }, 250);
    this.changedTimer.unref?.();
  }

  /**
   * Detiene un video (ADR-052): sus trabajos en cola se cancelan al instante y no entran nuevos. Lo que ya
   * está en marcha en un proveedor termina (no se puede interrumpir ni se pierde lo pagado).
   */
  pauseGeneration(id: string) {
    this.paused.add(id);
    for (const w of this.waiters.values()) {
      if (w.spec.generationId !== id || w.state !== 'queued' || !w.cancel) continue;
      const cancel = w.cancel;
      w.grant = undefined;
      w.cancel = undefined;
      void this.write(w.id, { status: 'cancelled', finishedAt: new Date(), error: 'Detenido por el usuario.' });
      cancel(new PausedError());
    }
    this.changed();
  }

  resumeGeneration(id: string) {
    this.paused.delete(id);
    this.changed();
  }

  isPaused(id: string) {
    return this.paused.has(id);
  }

  /** Trabajos de este proceso (en cola y en marcha). */
  live(): LiveTask[] {
    return [...this.waiters.values()].map(({ grant: _g, ...t }) => t);
  }

  capacities(): CapacitySnapshot[] {
    const now = Date.now();
    return RESOURCES.map((r) => this.capacity(r).snapshot(now));
  }

  /**
   * Apagado ordenado: deja de despachar y espera a los trabajos en marcha que no se pueden retomar
   * (imagen, Opus, locución, ffmpeg) hasta SHUTDOWN_GRACE_SEC. Los clips de MiniMax no se esperan:
   * su task_id ya está guardado y se siguen consultando al volver.
   */
  async drain() {
    this.draining = true;
    for (const { t } of this.timers.values()) clearTimeout(t);
    const deadline = Date.now() + env.SHUTDOWN_GRACE_SEC * 1000;
    const pending = () => [...this.waiters.values()].filter((w) => w.state === 'running' && !w.spec.resumable);
    if (pending().length) this.logger.log(`Apagando: espero ${pending().length} trabajo(s) en marcha (máx. ${env.SHUTDOWN_GRACE_SEC} s)…`);
    while (pending().length && Date.now() < deadline) await sleep(500);
    if (pending().length) this.logger.warn(`Apagando con ${pending().length} trabajo(s) sin terminar: se repetirán al volver.`);
  }

  get isDraining() {
    return this.draining;
  }
}
