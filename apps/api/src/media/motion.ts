import { FPS } from '@wilox/shared';
import { run } from './ffmpeg.js';

const W = 160;
const H = 90;

/**
 * Curva de movimiento (mcurve.py): diferencia media absoluta entre frames consecutivos
 * a 160×90 en gris. d[0] = 0; d[i] = movimiento entre el frame i-1 y el i.
 */
export async function motionCurve(video: string): Promise<number[]> {
  const { stdout } = await run(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-v',
    'error',
    '-i',
    video,
    '-vf',
    `fps=${FPS},scale=${W}:${H},format=gray`,
    '-f',
    'rawvideo',
    '-',
  ]);
  return motionFromRaw(stdout, W * H);
}

export function motionFromRaw(raw: Uint8Array, frameSize: number): number[] {
  const n = Math.floor(raw.length / frameSize);
  const d = [0];
  for (let f = 1; f < n; f++) {
    let sum = 0;
    const a = (f - 1) * frameSize;
    const b = f * frameSize;
    for (let i = 0; i < frameSize; i++) sum += Math.abs(raw[b + i] - raw[a + i]);
    d.push(sum / frameSize);
  }
  return d;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((x, y) => x - y);
  const k = (s.length - 1) * (p / 100);
  const lo = Math.floor(k);
  const hi = Math.ceil(k);
  return s[lo] + (s[hi] - s[lo]) * (k - lo);
}

/** Picos como en mcurve.py: máximos locales por encima de max(1.5, p80). Devuelve {t, v}. */
export function motionPeaks(d: number[]): { t: number; v: number }[] {
  const thr = Math.max(1.5, percentile(d, 80));
  const out: { t: number; v: number }[] = [];
  for (let i = 1; i < d.length - 1; i++) {
    if (d[i] > d[i - 1] && d[i] >= d[i + 1] && d[i] > thr) out.push({ t: i / FPS, v: d[i] });
  }
  return out;
}
