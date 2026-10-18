import { join } from 'node:path';
import { FPS, type InsertState } from '@wilox/shared';
import { buildCues, type Cue, type SubtitleWord } from '../delivery/subtitles.js';
import type { PlannedClip } from './timeline.js';

/**
 * Insertos (hito 6, ADR-073): clips fuera de la locución, generados entre dos clips (o en los extremos) o
 * subidos como portada o cierre. El video se alarga lo que duren: en cada punto de inserción el video de la
 * locución se corta en el borde entre clips y la voz en el hueco entre subtítulos más cercano (nunca a mitad
 * de una palabra); ahí entra el hueco, con silencio o con la locución del inserto. La música sigue.
 */

/** La locución propia de un inserto empieza 0,3 s después de su inicio y deja 0,4 s al final. */
export const INSERT_VOICE_LEAD = 0.3;
export const INSERT_VOICE_TAIL = 0.4;

export interface GapInsert {
  id: number;
  frames: number;
  /** Primer frame del inserto en el final. */
  startFrame: number;
}

export interface Gap {
  /** Después del clip `after` (0 = al principio). */
  after: number;
  /** Frame de la línea de tiempo de la voz donde se corta el video (borde entre clips). */
  boundaryFrame: number;
  /** Segundo de la voz donde se corta el audio (hueco entre subtítulos más cercano al borde). */
  cutSec: number;
  frames: number;
  inserts: GapInsert[];
}

export interface Composition {
  /** Frames del final (locución + insertos). */
  totalFrames: number;
  gaps: Gap[];
}

/**
 * Transición de un video subido (ADR-075): 2 s. MiniMax entrega ~5 s; se le pide quedarse quieto 3 s y animar
 * solo 2 (los 2 últimos en la portada, los 2 primeros en el cierre) y se usan solo esos 2 s.
 */
export const TRANSITION_FRAMES = 2 * FPS;

/**
 * Archivo con los 2 s de la transición: el tramo con movimiento de lo que entrega MiniMax, acelerado a 2 s
 * (ADR-076; el de ADR-075, `_2s.mp4`, tomaba 2 s fijos y podía caer en un tramo quieto).
 */
export const transitionCut = (runDir: string, id: number, version: number) => join(runDir, 'inserts', `ins${id}_transicion_v${version}_mov.mp4`);

/**
 * Tramo de la transición que se usa (ADR-076). `d` es la curva de movimiento del clip (d[i] = movimiento
 * entre los frames i-1 e i). Se toma desde un poco antes de que empiece el movimiento hasta un poco después
 * de que termine; si dura menos de 2 s se completa con cuadros quietos del lado del video vecino (la
 * portada termina en el clip01; el cierre empieza en el último clip). Si dura más, se acelera a 2 s.
 */
export function transitionWindow(d: number[], closing: boolean, target = TRANSITION_FRAMES): { from: number; frames: number } {
  const n = d.length;
  if (n <= target) return { from: 0, frames: n };
  const peak = Math.max(...d);
  const still = closing ? { from: 0, frames: target } : { from: n - target, frames: target };
  if (peak < 0.5) return still;
  const thr = Math.max(0.4, peak * 0.08);
  const first = d.findIndex((v) => v > thr);
  let last = first;
  for (let i = n - 1; i > first; i--)
    if (d[i] > thr) {
      last = i;
      break;
    }
  let from = Math.max(0, first - 3);
  let to = Math.min(n, last + 3);
  const need = target - (to - from);
  if (need > 0) {
    if (closing) {
      const back = Math.min(need, from);
      from -= back;
      to = Math.min(n, to + need - back);
    } else {
      const fwd = Math.min(need, n - to);
      to += fwd;
      from = Math.max(0, from - (need - fwd));
    }
  }
  return { from, frames: to - from };
}

/** Frames de la transición lista de un video subido (ADR-074/075). */
export const transitionFrames = (ins: Pick<InsertState, 'transition'>) =>
  ins.transition?.status === 'ready' && ins.transition.enabled !== false ? Math.min(TRANSITION_FRAMES, ins.transition.deliveredFrames ?? 0) : 0;

/** La transición va antes del video en el cierre y después en la portada. */
export const transitionFirst = (ins: Pick<InsertState, 'after'>) => ins.after > 0;

/** Frames propios de un inserto: su video y, si tiene, su transición. */
export const ownFrames = (ins: Pick<InsertState, 'deliveredFrames' | 'transition'>) => (ins.deliveredFrames ?? 0) + transitionFrames(ins);

/** Frames que ocupa un inserto en el final (con su locución, si la tiene). */
export function insertFrames(ins: Pick<InsertState, 'deliveredFrames' | 'voice' | 'voiceSec' | 'transition'>): number {
  const own = ownFrames(ins);
  if (ins.voice !== 'text' || !ins.voiceSec) return own;
  return Math.max(own, Math.ceil((INSERT_VOICE_LEAD + ins.voiceSec + INSERT_VOICE_TAIL) * FPS));
}

export function boundaryFrame(plan: PlannedClip[], after: number, totalFrames: number): number {
  if (after <= 0) return 0;
  if (after >= plan.length) return totalFrames;
  return plan[after - 1].slotEndFrame;
}

/**
 * Corte de la voz para un borde: al principio, 0; al final, el fin de la voz; si no, justo antes del
 * subtítulo que empieza más cerca del borde (así el corte cae entre palabras y entre subtítulos).
 */
export function cutSecFor(cues: Pick<Cue, 'start' | 'end'>[], boundarySec: number, after: number, clips: number, voiceEndSec: number): number {
  if (after <= 0) return 0;
  if (after >= clips) return voiceEndSec;
  let best: number | undefined;
  for (let j = 1; j < cues.length; j++) {
    const cut = Math.max(cues[j - 1].start, cues[j].start - 0.05);
    if (best === undefined || Math.abs(cut - boundarySec) < Math.abs(best - boundarySec)) best = cut;
  }
  return best ?? boundarySec;
}

/** Composición del final con sus insertos (los listos y con frames). */
export function compose(plan: PlannedClip[], voiceFrames: number, inserts: InsertState[], cues: Pick<Cue, 'start' | 'end'>[]): Composition {
  const voiceEnd = voiceFrames / FPS;
  const usable = inserts.filter((x) => x.status === 'ready' && insertFrames(x) > 0).sort((a, b) => a.after - b.after || a.id - b.id);
  const gaps: Gap[] = [];
  let added = 0;
  for (const ins of usable) {
    let g = gaps.find((x) => x.after === ins.after);
    if (!g) {
      const b = boundaryFrame(plan, ins.after, voiceFrames);
      g = { after: ins.after, boundaryFrame: b, cutSec: cutSecFor(cues, b / FPS, ins.after, plan.length, voiceEnd), frames: 0, inserts: [] };
      gaps.push(g);
    }
    const f = insertFrames(ins);
    g.inserts.push({ id: ins.id, frames: f, startFrame: g.boundaryFrame + added });
    g.frames += f;
    added += f;
  }
  return { totalFrames: voiceFrames + added, gaps };
}

/** Frames que se corre el clip `index` (1…n) por los insertos anteriores. */
export const clipShift = (c: Composition, index: number) => c.gaps.filter((g) => g.after < index).reduce((n, g) => n + g.frames, 0);

/** Segundos que se corre un instante de la voz por los insertos anteriores. */
export const voiceShift = (c: Composition, sec: number) => c.gaps.filter((g) => g.cutSec <= sec + 1e-6).reduce((n, g) => n + g.frames, 0) / FPS;

/**
 * Subtítulos del final con insertos: los de la locución corridos (un subtítulo que cruzara un corte se
 * acorta hasta el corte) y los de la locución de cada inserto en su tramo.
 */
export function finalCues(o: {
  paragraphs: { text: string }[];
  words: SubtitleWord[];
  voiceFrames: number;
  plan?: PlannedClip[];
  inserts?: InsertState[];
}): Cue[] {
  const cues = buildCues(o.paragraphs, o.words, o.voiceFrames ? o.voiceFrames / FPS : undefined);
  if (!o.inserts?.length || !o.plan) return cues;
  const comp = compose(o.plan, o.voiceFrames, o.inserts, cues);
  if (!comp.gaps.length) return cues;
  const out: Cue[] = cues.map((c) => {
    const cut = comp.gaps.find((g) => g.after > 0 && g.cutSec > c.start + 1e-6 && g.cutSec < c.end);
    const end = cut ? cut.cutSec : c.end;
    const d = voiceShift(comp, c.start);
    return { ...c, start: c.start + d, end: end + d };
  });
  for (const g of comp.gaps)
    for (const gi of g.inserts) {
      const ins = o.inserts.find((x) => x.id === gi.id);
      if (ins?.voice !== 'text' || !ins.text || !ins.voiceWords?.length) continue;
      const at = gi.startFrame / FPS + INSERT_VOICE_LEAD;
      for (const c of buildCues([{ text: ins.text }], ins.voiceWords.map((w) => ({ ...w, paragraph: 0 })), ins.voiceSec)) out.push({ ...c, start: c.start + at, end: Math.min(c.end + at, (gi.startFrame + gi.frames) / FPS) });
    }
  return out.sort((a, b) => a.start - b.start);
}
