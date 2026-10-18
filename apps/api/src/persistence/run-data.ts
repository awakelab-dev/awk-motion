import type { RunState, Shot, Storyboard, ThemeStyle } from '@wilox/shared';
import type { TimedWord } from '@wilox/prompts';
import type { PlannedClip } from '../pipeline/timeline.js';

/**
 * Lo que se persiste de una generación (hito 3, ADR-031). El RunRecord del RunStore la extiende
 * con lo que solo vive en memoria (SSE, colas, busy).
 */
export interface RunData {
  state: RunState;
  /** Carpeta absoluta de la generación (storage/runs/<id>). */
  dir: string;
  ownerId: string;
  /** Copia del tema con el que se creó: editar o borrar el tema no la afecta (ADR-018). */
  theme: ThemeStyle;
  /** Referencias del tema (ruta relativa a la generación). ref = media_id/ruta ya subida; vacío = hay que subirla. */
  /** Referencias del tema copiadas al video; `typography` = lámina tipográfica (ADR-094). */
  themeRefs: { path: string; ref?: string; typography?: boolean }[];
  approved: boolean;
  words?: TimedWord[];
  storyboard?: Storyboard;
  plan?: PlannedClip[];
  shots?: Shot[];
  /** Referencia (job_id/media_id o ruta) y archivo local de cada fotograma clave. ref vacío = hay que subirlo. */
  keyAssets: Map<number, { ref: string; path: string }>;
  /** Clip IA en bruto de cada clip. */
  clipRaw: Map<number, string>;
}

/** Estados en los que la generación estaba trabajando (tras un reinicio se marcan como interrumpidos). */
export const RUNNING: RunState['status'][] = ['queued', 'voice', 'timings', 'storyboard', 'keyframes', 'clips', 'post', 'render'];

/**
 * Lo que estaba en marcha cuando la API se detuvo se marca para reintentar (ADR-013).
 * Devuelve true si cambió algo.
 */
export function markInterrupted(d: RunData): boolean {
  const s = d.state;
  let changed = false;
  for (const k of s.keyframes) {
    if (k.status === 'generating' || k.activity) {
      k.activity = undefined;
      k.status = d.keyAssets.has(k.index) ? 'ready' : 'error';
      if (k.status === 'error') k.error = 'Interrumpido por un reinicio de la API; regénéralo.';
      changed = true;
    }
  }
  for (const c of s.clips)
    if (c.status === 'generating') {
      c.status = 'error';
      changed = true;
    }
  if (RUNNING.includes(s.status)) {
    s.status = 'error';
    s.error = 'La API se reinició durante este paso. Pulsa Reintentar para continuar desde donde quedó.';
    s.message = 'Interrumpido por un reinicio de la API.';
    changed = true;
  }
  if ((!d.storyboard || !d.shots) && s.status === 'awaiting_approval') {
    s.status = 'error';
    s.error = 'No se encontró el storyboard de esta generación; pulsa Reintentar para rehacerla.';
    changed = true;
  }
  return changed;
}
