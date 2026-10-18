import { CLIP_FRAMES, FPS, LEAD_FRAMES, type Shot } from '@wilox/shared';
import type { TimedWord } from '@wilox/prompts';

export interface PlanInput {
  /** Frame en el que la voz dice cada PFC (en orden). */
  anchorFrames: number[];
  /** Frame de inicio de cada PFC que cae al principio de un párrafo (o undefined). */
  paragraphStartFrames?: (number | undefined)[];
  totalFrames: number;
  clipFrames?: number;
  leadFrames?: number;
  /** Mínimo de frames de un clip para que valga la pena generarlo. */
  minFrames?: number;
}

export interface PlannedClip {
  /** Índice del shot del storyboard. */
  shot: number;
  startFrame: number;
  /** Donde empieza el siguiente clip (o el final): el congelado rellena hasta aquí. */
  slotEndFrame: number;
}

export interface Segment {
  name: string;
  kind: 'clip' | 'freeze';
  clip: number;
  startFrame: number;
  endFrame: number;
}

/**
 * Plan de la línea de tiempo (docs/02, paso 4), determinista:
 * - el primer clip empieza en el frame 0;
 * - cada clip empieza LEAD frames antes de su PFC, o en el inicio del párrafo si la PFC lo abre;
 * - si pisa al anterior se desplaza hasta el fin del anterior;
 * - si ya no cabe un clip razonable antes del final, el shot se descarta.
 */
export function planTimeline(input: PlanInput): PlannedClip[] {
  const clipF = input.clipFrames ?? CLIP_FRAMES;
  const lead = input.leadFrames ?? LEAD_FRAMES;
  const minF = input.minFrames ?? Math.round(1.5 * FPS);
  const out: PlannedClip[] = [];
  input.anchorFrames.forEach((anchor, shot) => {
    let start: number;
    if (out.length === 0) start = 0;
    else {
      const para = input.paragraphStartFrames?.[shot];
      start = para !== undefined ? para : anchor - lead;
      const prev = out[out.length - 1];
      start = Math.max(start, prev.startFrame + clipF);
    }
    if (out.length > 0 && start > input.totalFrames - minF) return; // no cabe
    out.push({ shot, startFrame: start, slotEndFrame: input.totalFrames });
  });
  for (let i = 0; i < out.length - 1; i++) out[i].slotEndFrame = out[i + 1].startFrame;
  return out;
}

/**
 * Segmentos de un solo clip (el clip y, si no llena su hueco, su congelado). Solo dependen de ese clip y
 * de su hueco en el plan: el post de cada clip puede hacerse en cuanto llega (hito 6, ADR-056).
 */
export function clipSegments(plan: PlannedClip[], i: number, delivered: number): Segment[] {
  const p = plan[i];
  const nn = String(i + 1).padStart(2, '0');
  const slot = p.slotEndFrame - p.startFrame;
  const len = Math.min(delivered, slot);
  const segs: Segment[] = [{ name: `clip${nn}`, kind: 'clip', clip: i, startFrame: p.startFrame, endFrame: p.startFrame + len }];
  if (len < slot) segs.push({ name: `clip${nn}ex`, kind: 'freeze', clip: i, startFrame: p.startFrame + len, endFrame: p.slotEndFrame });
  return segs;
}

/** Segmentos clip/congelado para un plan, dado cuántos frames aporta cada clip. */
export function segmentsFor(plan: PlannedClip[], clipFrames: (i: number) => number): Segment[] {
  return plan.flatMap((_, i) => clipSegments(plan, i, clipFrames(i)));
}

/** Inicio de cada párrafo: frame redondo (múltiplo de 12 = 0,5 s) tras una pausa ≥ 0,5 s. */
export function paragraphStarts(durations: number[], pauseSec = 0.5, gridFrames = 12): number[] {
  const starts: number[] = [];
  let t = 0;
  durations.forEach((d, i) => {
    if (i === 0) starts.push(0);
    else {
      const minF = Math.ceil((t + pauseSec) * FPS);
      const f = Math.ceil(minF / gridFrames) * gridFrames;
      starts.push(f / FPS);
    }
    t = starts[i] + d;
  });
  return starts;
}

export const totalFramesFor = (voiceEndSec: number) => Math.ceil(voiceEndSec * FPS - 1e-6);

/** Plan de la línea de tiempo de los planos: cada uno anclado a su palabra (el primero de un párrafo, a su inicio). */
export function planShots(words: TimedWord[], shots: Shot[], paragraphs: { startSec: number }[], totalFrames: number) {
  const firstOfParagraph = new Set<number>();
  words.forEach((w, i) => {
    if (i === 0 || words[i - 1].paragraph !== w.paragraph) firstOfParagraph.add(i);
  });
  return planTimeline({
    anchorFrames: shots.map((sh) => Math.round(words[sh.anchorWordIndex].start * FPS)),
    paragraphStartFrames: shots.map((sh) =>
      firstOfParagraph.has(sh.anchorWordIndex) ? Math.round(paragraphs[words[sh.anchorWordIndex].paragraph].startSec * FPS) : undefined,
    ),
    totalFrames,
  });
}
