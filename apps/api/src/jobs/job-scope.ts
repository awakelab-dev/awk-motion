import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A quién se le anota cada trabajo de un proveedor (hito 3, ADR-031). El pipeline y el Estudio abren
 * el ámbito (withJobs) y los proveedores instrumentados registran cada llamada dentro de él.
 * AsyncLocalStorage se mantiene a través de await y de las colas de p-limit.
 */
export interface JobScope {
  ownerId: string;
  generationId?: string;
  themeId?: string;
  /** Prueba del Estudio (n). */
  testN?: number;
  /**
   * Prioridad en la cola global (hito 5, ADR-045): hora de lanzamiento del video en ms; las
   * correcciones usan la de su video y el Estudio va primero (0).
   */
  priority?: number;
}

export type JobKind = 'tts' | 'timing' | 'llm' | 'image' | 'video' | 'upload';

export interface JobRecord {
  kind: JobKind;
  /** Qué produce: "K03_v2", "clip01_ia_v1", "parrafo01", "Storyboard"… */
  target: string;
  provider: string;
  model: string;
  externalId?: string;
  credits?: number;
  costUsd?: number;
  usage?: Record<string, unknown>;
  url?: string;
  error?: string;
  startedAt: Date;
  finishedAt: Date;
}

const storage = new AsyncLocalStorage<JobScope>();
let sink: ((scope: JobScope, job: JobRecord) => void) | undefined;

export function withJobs<T>(scope: JobScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** Ámbito actual (dueño, generación, prioridad), si lo hay. */
export function currentScope(): JobScope | undefined {
  return storage.getStore();
}

export function setJobSink(fn: (scope: JobScope, job: JobRecord) => void) {
  sink = fn;
}

/** Registra un trabajo en el ámbito actual (si no hay ámbito, p. ej. listar voces, no se anota). */
export function recordJob(job: JobRecord) {
  const scope = storage.getStore();
  if (scope && sink) sink(scope, job);
}
