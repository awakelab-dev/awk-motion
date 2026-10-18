import { ffmpeg, ffprobe, run } from './ffmpeg.js';

/**
 * Sonido nativo de los clips de MiniMax (hito 6, ADR-059). MiniMax H3 siempre entrega audio con el clip
 * (AAC 32 kHz estéreo) y los prompts le piden solo efectos, sin música ni voz. Medido el 03-10-2026 en 47
 * clips: de −11 a −26 LUFS (media ≈ −15,5) con picos de −0,5 a 0 dBFS. Cada clip se normaliza a una
 * sonoridad común y se mezcla bajo la voz como los SFX sintetizados (0.3).
 */

/** Fundidos de cada clip: corto al entrar (no suaviza el primer golpe) y más largo al salir (sin corte seco al congelado). */
export const FADE_IN_SEC = 0.02;
export const FADE_OUT_SEC = 0.25;
/** Por debajo de esta sonoridad el clip se considera sin sonido (no se amplifica el ruido de fondo). */
const SILENCE_LUFS = -60;

/** ¿El archivo trae una pista de audio? */
export async function hasAudio(file: string): Promise<boolean> {
  const { stdout } = await ffprobe(['-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]);
  return stdout.toString().trim().length > 0;
}

/**
 * Sonoridad integrada (LUFS) del audio de un clip en sus primeros `durSec` segundos (la parte que se usa).
 * null = sin pista de audio o prácticamente en silencio.
 */
export async function clipLoudness(file: string, durSec: number): Promise<number | null> {
  if (!(await hasAudio(file))) return null;
  const { stderr } = await run(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-t',
    durSec.toFixed(6),
    '-i',
    file,
    '-vn',
    '-af',
    'ebur128=framelog=verbose',
    '-f',
    'null',
    '-',
  ]);
  const all = [...stderr.matchAll(/^\s*I:\s+(-?[\d.]+|-inf)\s+LUFS/gm)];
  const v = all.length ? Number(all[all.length - 1][1]) : NaN;
  return Number.isFinite(v) && v > SILENCE_LUFS ? Math.round(v * 10) / 10 : null;
}

/** Ganancia (dB) para llevar `lufs` a `target`, con tope ±maxDb, más el ajuste del video. */
export function modelSoundGainDb(lufs: number, target: number, maxDb: number, extraDb = 0): number {
  const g = Math.max(-maxDb, Math.min(maxDb, target - lufs));
  return Math.round((g + extraDb) * 10) / 10;
}

/**
 * WAV 48 kHz estéreo del sonido nativo de un clip: los primeros `durSec` segundos, con la ganancia dada,
 * un limitador a −1 dBFS (sin nivelado automático) y los fundidos de entrada y salida.
 */
export async function renderModelSound(input: string, durSec: number, gainDb: number, output: string) {
  const d = durSec.toFixed(6);
  const fin = Math.min(FADE_IN_SEC, durSec / 4);
  const fout = Math.min(FADE_OUT_SEC, durSec / 3);
  await ffmpeg([
    '-i',
    input,
    '-vn',
    '-af',
    [
      `atrim=0:${d}`,
      'asetpts=N/SR/TB',
      'aresample=48000',
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
      `volume=${gainDb.toFixed(1)}dB`,
      'alimiter=limit=0.891:level=0',
      `afade=t=in:d=${fin.toFixed(3)}`,
      `afade=t=out:st=${(durSec - fout).toFixed(3)}:d=${fout.toFixed(3)}`,
      'apad',
      `atrim=0:${d}`,
    ].join(','),
    '-c:a',
    'pcm_s16le',
    '-ar',
    '48000',
    output,
  ]);
}

/** WAV de silencio de `durSec` segundos (clip silenciado o sin sonido). */
export async function renderSilence(durSec: number, output: string) {
  await ffmpeg(['-f', 'lavfi', '-t', durSec.toFixed(6), '-i', 'anullsrc=r=48000:cl=stereo', '-c:a', 'pcm_s16le', output]);
}

/**
 * Cambia la pista de audio de un segmento ya codificado sin tocar el video (copia): cambiar el sonido de
 * un clip tarda una fracción de segundo.
 */
export async function remuxSegmentSound(segment: string, soundWav: string, frames: number, fps: number, output: string) {
  const d = (frames / fps).toFixed(6);
  await ffmpeg([
    '-i',
    segment,
    '-i',
    soundWav,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'copy',
    '-af',
    `aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${d}`,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    output,
  ]);
}
