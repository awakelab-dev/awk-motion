/**
 * Capacidad de un recurso de la cola (hito 5, ADR-045): trabajos simultáneos y límite por minuto, con
 * ajuste automático. Ante un fallo transitorio (429, 5xx, red) baja la concurrencia a la mitad y
 * respeta Retry-After; con éxitos la recupera de a uno hasta el tope. Si un recurso encadena fallos
 * transitorios (proveedor caído), se pausa con una espera creciente y se reanuda solo.
 */
export type Outcome = 'ok' | 'error' | 'transient';

export const DOWN_AFTER = 5;
const PAUSE_BASE_MS = 30_000;
const PAUSE_MAX_MS = 5 * 60_000;

export interface CapacitySnapshot {
  resource: string;
  running: number;
  max: number;
  effective: number;
  perMinute?: number;
  usedLastMinute: number;
  pausedUntil?: string;
  failStreak: number;
}

export class Capacity {
  running = 0;
  effective: number;
  pausedUntil = 0;
  failStreak = 0;
  private okStreak = 0;
  private pauses = 0;
  private starts: number[] = [];

  constructor(
    readonly resource: string,
    readonly max: number,
    readonly perMinute?: number,
  ) {
    this.effective = Math.max(1, max);
  }

  private prune(now: number) {
    while (this.starts.length && this.starts[0] <= now - 60_000) this.starts.shift();
  }

  canStart(now: number): boolean {
    if (now < this.pausedUntil) return false;
    if (this.running >= this.effective) return false;
    if (this.perMinute) {
      this.prune(now);
      if (this.starts.length >= this.perMinute) return false;
    }
    return true;
  }

  /** Cuándo podría volver a haber hueco por tiempo (pausa o ventana por minuto); 0 si no depende del tiempo. */
  nextTimeSlot(now: number): number {
    let t = now < this.pausedUntil ? this.pausedUntil : 0;
    if (this.perMinute) {
      this.prune(now);
      if (this.starts.length >= this.perMinute) t = Math.max(t, this.starts[0] + 60_000);
    }
    return t;
  }

  onStart(now: number) {
    this.running += 1;
    this.starts.push(now);
  }

  onEnd(outcome: Outcome, now: number, retryAfterMs?: number) {
    this.running = Math.max(0, this.running - 1);
    if (outcome === 'ok') {
      this.failStreak = 0;
      this.pauses = 0;
      this.okStreak += 1;
      if (this.effective < this.max && this.okStreak >= this.effective) {
        this.effective += 1;
        this.okStreak = 0;
      }
      return;
    }
    if (outcome === 'error') return; // un error definitivo no dice nada de la capacidad
    this.okStreak = 0;
    this.failStreak += 1;
    this.effective = Math.max(1, Math.floor(this.effective / 2));
    if (retryAfterMs && retryAfterMs > 0) this.pausedUntil = Math.max(this.pausedUntil, now + Math.min(retryAfterMs, PAUSE_MAX_MS));
    if (this.failStreak >= DOWN_AFTER) {
      const ms = Math.min(PAUSE_MAX_MS, PAUSE_BASE_MS * 2 ** this.pauses);
      this.pauses += 1;
      this.failStreak = 0;
      this.pausedUntil = Math.max(this.pausedUntil, now + ms);
    }
  }

  snapshot(now: number): CapacitySnapshot {
    this.prune(now);
    return {
      resource: this.resource,
      running: this.running,
      max: this.max,
      effective: this.effective,
      perMinute: this.perMinute,
      usedLastMinute: this.starts.length,
      pausedUntil: now < this.pausedUntil ? new Date(this.pausedUntil).toISOString() : undefined,
      failStreak: this.failStreak,
    };
  }
}
