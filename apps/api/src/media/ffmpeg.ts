import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { FPS, OUTPUT_HEIGHT, OUTPUT_WIDTH, SAMPLES_PER_FRAME } from '@wilox/shared';
import { AAC_SEGMENT, X264_SEGMENT } from './encode.js';

const FFMPEG = () => process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = () => process.env.FFPROBE_PATH || 'ffprobe';

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

/** Ejecuta un binario y devuelve stdout (Buffer) y stderr. Lanza si el código no es 0. */
export function run(bin: string, args: string[], opts: { input?: Buffer } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => {
      err += d.toString();
      if (err.length > 200_000) err = err.slice(-100_000);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(`${bin} ${args.slice(0, 6).join(' ')}… salió con código ${code}\n${err.slice(-2000)}`));
    });
    if (opts.input) p.stdin.end(opts.input);
    else p.stdin.end();
  });
}

export const ffmpeg = (args: string[]) => run(FFMPEG(), ['-hide_banner', '-v', 'error', '-y', ...args]);
export const ffprobe = (args: string[]) => run(FFPROBE(), ['-v', 'error', ...args]);

/** Filtro que lleva cualquier imagen/video a 2560×1440 (escala y recorta, sin bandas). */
export const FIT_2K = `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}`;

export async function durationSec(file: string): Promise<number> {
  const { stdout } = await ffprobe(['-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(stdout.toString().trim());
}

/** Cuenta frames de video decodificando (exacto, aunque el contenedor no lo declare). */
export async function countFrames(file: string): Promise<number> {
  const { stdout } = await ffprobe([
    '-count_frames',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=nb_read_frames',
    '-of',
    'csv=p=0',
    file,
  ]);
  return parseInt(stdout.toString().trim(), 10);
}

/**
 * Cuenta los frames de video sin decodificar (paquetes del stream): exacto en H.264 y en segundos aunque
 * el video dure minutos. Para el final unido con copia (hito 6, ADR-057), donde decodificar todo para
 * contar tardaba más que la unión.
 */
export async function countPackets(file: string): Promise<number> {
  const { stdout } = await ffprobe(['-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]);
  return parseInt(stdout.toString().trim(), 10);
}

/** Inicio del stream de video (s): el final debe empezar en 0 (ADR-058). */
export async function videoStartTime(file: string): Promise<number> {
  const { stdout } = await ffprobe(['-select_streams', 'v:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', file]);
  return parseFloat(stdout.toString().trim()) || 0;
}

export async function hasFilter(name: string): Promise<boolean> {
  try {
    const { stdout } = await run(FFMPEG(), ['-hide_banner', '-filters']);
    return new RegExp(`\\s${name}\\s`).test(stdout.toString());
  } catch {
    return false;
  }
}

/** Decodifica audio a WAV PCM 48 kHz estéreo. */
export async function toWav48k(input: string, output: string) {
  await ffmpeg(['-i', input, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', output]);
}

/** Imagen → PNG 2560×1440 (para congelados y comparación). */
export async function imageTo2k(input: string, output: string) {
  await ffmpeg(['-i', input, '-vf', FIT_2K, '-frames:v', '1', '-update', '1', output]);
}

/** Imagen → JPEG 2560×1440 de alta calidad (para enviarla como first/last frame). */
export async function imageToJpeg2k(input: string, output: string) {
  await ffmpeg(['-i', input, '-vf', FIT_2K, '-frames:v', '1', '-update', '1', '-q:v', '2', output]);
}

/** Copia reducida en JPEG (para la revisión visual de Opus). */
export async function imagePreviewJpeg(input: string, output: string, width = 1344) {
  await ffmpeg(['-i', input, '-vf', `scale=${width}:-2`, '-frames:v', '1', '-update', '1', '-q:v', '3', output]);
}

/** Último frame de un video como PNG. */
export async function lastFrame(video: string, output: string) {
  const n = await countFrames(video);
  await ffmpeg(['-i', video, '-vf', `select=eq(n\\,${Math.max(0, n - 1)})`, '-frames:v', '1', '-update', '1', output]);
}

/** SSIM entre el frame `frameIndex` de un video (o 'last') y una imagen de referencia. */
export async function ssimAgainst(video: string, frameIndex: number | 'last', image: string): Promise<number | undefined> {
  try {
    const idx = frameIndex === 'last' ? Math.max(0, (await countFrames(video)) - 1) : frameIndex;
    const { stderr } = await run(FFMPEG(), [
      '-hide_banner',
      '-i',
      video,
      '-i',
      image,
      '-lavfi',
      `[0:v]select=eq(n\\,${idx}),${FIT_2K},format=yuv420p[a];[1:v]${FIT_2K},format=yuv420p[b];[a][b]ssim`,
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ]);
    const m = stderr.match(/All:([0-9.]+)/);
    return m ? parseFloat(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normaliza un clip IA: 2560×1440, 24 fps, exactamente `frames` frames, con la pista de SFX
 * (el audio nativo del modelo se descarta).
 */
export async function normalizeClip(input: string, sfxWav: string, frames: number, output: string) {
  const d = (frames / FPS).toFixed(6);
  await ffmpeg([
    '-i',
    input,
    '-i',
    sfxWav,
    '-filter_complex',
    `[0:v]${FIT_2K},fps=${FPS},settb=1/${FPS},setpts=N,trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p[v];[1:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${d}[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-r',
    String(FPS),
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '14',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    output,
  ]);
}

/** Congelado de N frames a partir de una imagen, con pista silenciosa (freeze.sh). */
export async function freeze(image: string, frames: number, output: string) {
  const d = (frames / FPS).toFixed(6);
  await ffmpeg([
    '-loop',
    '1',
    '-framerate',
    String(FPS),
    '-t',
    d,
    '-i',
    image,
    '-f',
    'lavfi',
    '-t',
    d,
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-vf',
    `${FIT_2K},format=yuv420p,trim=end_frame=${frames}`,
    '-r',
    String(FPS),
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '14',
    '-tune',
    'stillimage',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    output,
  ]);
}

/**
 * Monta la pista de voz global: cada párrafo en su segundo de inicio, a 48 kHz estéreo,
 * con la duración exacta `totalSec`.
 */
export async function assembleVoice(parts: { wav: string; startSec: number }[], totalSec: number, output: string) {
  const inputs = parts.flatMap((p) => ['-i', p.wav]);
  const chains = parts
    .map((p, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=delays=${Math.round(p.startSec * 48000)}S:all=1[p${i}]`)
    .join(';');
  const mix = parts.length === 1 ? `[p0]anull` : `${parts.map((_, i) => `[p${i}]`).join('')}amix=inputs=${parts.length}:duration=longest:normalize=0`;
  await ffmpeg([
    ...inputs,
    '-filter_complex',
    `${chains};${mix},apad,atrim=0:${totalSec.toFixed(6)}[a]`,
    '-map',
    '[a]',
    '-c:a',
    'pcm_s16le',
    '-ar',
    '48000',
    output,
  ]);
}

/**
 * Render final de los hitos 1 a 5 (render.sh generalizado). Desde el hito 6 el pipeline usa
 * `assembleFinal`; este queda para `pnpm render:bench` (medir el antes) y como referencia.
 *
 * Render final (render.sh generalizado): concat de segmentos, voz 1.0, SFX 0.3, música 0.1
 * con fades, limitador, H.264 CRF 16 a 2560×1440 y 24 fps, cortado a `totalFrames`.
 */
export async function renderFinal(opts: {
  segments: string[];
  voiceWav: string;
  music?: string;
  /** Volumen de la música (0.1 por defecto; hito 5: compensado por la sonoridad del track). */
  musicVolume?: number;
  totalFrames: number;
  output: string;
}) {
  const { segments, voiceWav, music, totalFrames, output } = opts;
  const musicVol = opts.musicVolume ?? 0.1;
  const D = totalFrames / FPS;
  const n = segments.length;
  const inputs = segments.flatMap((s) => ['-i', s]);
  inputs.push('-i', voiceWav);
  if (music) inputs.push('-stream_loop', '-1', '-i', music);
  const concatIn = segments.map((_, i) => `[${i}:v][${i}:a]`).join('');
  const fadeOut = Math.max(0, D - 2.5).toFixed(3);
  const parts = [
    `${concatIn}concat=n=${n}:v=1:a=1[v][sfx]`,
    `[sfx]volume=0.3[s]`,
    `[${n}:a]aresample=48000,aformat=channel_layouts=stereo,apad[t]`,
  ];
  if (music) {
    parts.push(
      `[${n + 1}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${D.toFixed(6)},asetpts=N/SR/TB,afade=t=in:d=0.5,afade=t=out:st=${fadeOut}:d=2.5,volume=${musicVol}[m]`,
      `[t][s][m]amix=inputs=3:duration=first:normalize=0,atrim=0:${D.toFixed(6)},alimiter=limit=0.95[a]`,
    );
  } else {
    parts.push(`[t][s]amix=inputs=2:duration=first:normalize=0,atrim=0:${D.toFixed(6)},alimiter=limit=0.95[a]`);
  }
  parts.push(`[v]settb=1/${FPS},setpts=N,fps=${FPS},trim=end_frame=${totalFrames},setpts=PTS-STARTPTS[vo]`);
  await ffmpeg([
    ...inputs,
    '-filter_complex',
    parts.join(';'),
    '-map',
    '[vo]',
    '-map',
    '[a]',
    '-r',
    String(FPS),
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '16',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-c:a',
    'aac',
    '-b:a',
    '256k',
    '-ar',
    '48000',
    output,
  ]);
}

// ─── Hito 6 (ADR-055): segmentos con la calidad del final y unión sin recodificar ───────────────────

/** Cadena de video que lleva un clip IA a 2560×1440 y 24 fps con sus frames contados desde 0. */
const CLIP_VIDEO = `${FIT_2K},fps=${FPS},settb=1/${FPS},setpts=N`;

/**
 * Segmento de clip: 2560×1440, 24 fps, exactamente `frames` frames, codificado ya con la calidad del
 * final. Lleva el sonido del clip en AAC solo para los entregables (el ZIP); el final no lo usa: mezcla
 * los WAV. Sin `soundWav`, la pista es silenciosa.
 */
export async function encodeClipSegment(input: string, frames: number, output: string, soundWav?: string) {
  const d = (frames / FPS).toFixed(6);
  const audioIn = soundWav ? ['-i', soundWav] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
  await ffmpeg([
    '-i',
    input,
    ...audioIn,
    '-filter_complex',
    `[0:v]${CLIP_VIDEO},trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p[v];[1:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${d}[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    ...X264_SEGMENT,
    ...AAC_SEGMENT,
    output,
  ]);
}

/** Frame `index` de un clip IA (contado como en el segmento: 24 fps, desde 0) como PNG 2560×1440. */
export async function clipFrame(input: string, index: number, output: string) {
  await ffmpeg(['-i', input, '-vf', `${CLIP_VIDEO},select=eq(n\\,${index})`, '-frames:v', '1', '-update', '1', output]);
}

/**
 * Congelado de N frames desde una imagen (el último frame en bruto del clip, sin pasar por la
 * compresión del segmento), con los mismos parámetros de H.264 que los clips y una pista silenciosa.
 */
export async function encodeFreeze(image: string, frames: number, output: string) {
  const d = (frames / FPS).toFixed(6);
  await ffmpeg([
    '-loop',
    '1',
    '-framerate',
    String(FPS),
    '-i',
    image,
    '-f',
    'lavfi',
    '-t',
    d,
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-filter_complex',
    `[0:v]${FIT_2K},format=yuv420p,trim=end_frame=${frames},setpts=N/${FPS}/TB[v];[1:a]anull[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    ...X264_SEGMENT,
    ...AAC_SEGMENT,
    output,
  ]);
}

export interface FinalSound {
  /** WAV del sonido del clip (48 kHz estéreo), con la duración de su segmento. */
  wav: string;
  /** Frame del video en que empieza. */
  startFrame: number;
}

/** Pista que va a su propio volumen (hito 6, ADR-073): la locución de un inserto o el audio de un video subido. */
export interface FinalOverlay extends FinalSound {
  volume: number;
}

/**
 * Final del hito 6 (ADR-055): une los segmentos sin recodificar el video (concat con copia) y mezcla el
 * audio de todo el video: voz 1.0, sonido de los clips 0.3 (cada uno en su frame; silencio en los
 * congelados), música 0.1 compensada con fades (0,5 s y 2,5 s) y limitador. Corta en `totalFrames`.
 */
export async function assembleFinal(opts: {
  segments: string[];
  /** Archivo de lista para el demuxer concat (se escribe aquí). */
  listFile: string;
  voiceWav: string;
  sounds: FinalSound[];
  soundVolume?: number;
  music?: string;
  musicVolume?: number;
  /** Locuciones de insertos y audio de videos subidos (ADR-073). */
  overlays?: FinalOverlay[];
  totalFrames: number;
  output: string;
}) {
  const { segments, listFile, voiceWav, sounds, music, totalFrames, output } = opts;
  const overlays = opts.overlays ?? [];
  const musicVol = opts.musicVolume ?? 0.1;
  const soundVol = opts.soundVolume ?? 0.3;
  const D = (totalFrames / FPS).toFixed(6);
  const fadeOut = Math.max(0, totalFrames / FPS - 2.5).toFixed(3);
  await writeFile(listFile, segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const inputs = ['-f', 'concat', '-safe', '0', '-i', listFile, '-i', voiceWav];
  const parts = [`[1:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${D}[t]`];
  const mixIn = ['[t]'];
  if (sounds.length) {
    sounds.forEach((s, i) => {
      inputs.push('-i', s.wav);
      parts.push(`[${2 + i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=delays=${s.startFrame * SAMPLES_PER_FRAME}S:all=1[c${i}]`);
    });
    const all = sounds.map((_, i) => `[c${i}]`).join('');
    parts.push(`${sounds.length === 1 ? `${all}anull` : `${all}amix=inputs=${sounds.length}:duration=longest:normalize=0`},volume=${soundVol}[s]`);
    mixIn.push('[s]');
  }
  overlays.forEach((o, i) => {
    const ii = 2 + sounds.length + i;
    inputs.push('-i', o.wav);
    parts.push(`[${ii}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=delays=${o.startFrame * SAMPLES_PER_FRAME}S:all=1,volume=${o.volume}[o${i}]`);
    mixIn.push(`[o${i}]`);
  });
  if (music) {
    const mi = 2 + sounds.length + overlays.length;
    inputs.push('-stream_loop', '-1', '-i', music);
    parts.push(
      `[${mi}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${D},asetpts=N/SR/TB,afade=t=in:d=0.5,afade=t=out:st=${fadeOut}:d=2.5,volume=${musicVol}[m]`,
    );
    mixIn.push('[m]');
  }
  parts.push(`${mixIn.join('')}amix=inputs=${mixIn.length}:duration=first:normalize=0,atrim=0:${D},alimiter=limit=0.95[a]`);
  await ffmpeg([
    ...inputs,
    '-filter_complex',
    parts.join(';'),
    '-map',
    '0:v',
    '-map',
    '[a]',
    '-c:v',
    'copy',
    // El demuxer concat adelanta cada archivo según su primer paquete de cualquier stream: el AAC de los
    // segmentos empieza en −1024 muestras (priming) y el video quedaba desplazado +21 ms, con un primer
    // instante en negro (ADR-058). Se lleva el video a empezar en 0 moviendo pts y dts lo mismo.
    '-bsf:v',
    'setts=pts=PTS-STARTPTS:dts=DTS-STARTPTS',
    '-frames:v',
    String(totalFrames),
    '-c:a',
    'aac',
    '-b:a',
    '256k',
    '-ar',
    '48000',
    '-movflags',
    '+faststart',
    output,
  ]);
}

/** Sonoridad integrada (LUFS, EBU R128) de un audio: se mide una vez por track de música (hito 5). */
export async function integratedLoudness(file: string): Promise<number | undefined> {
  const { stderr } = await run(FFMPEG(), ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=framelog=verbose', '-f', 'null', '-']);
  const all = [...stderr.matchAll(/^\s*I:\s+(-?[\d.]+|-inf)\s+LUFS/gm)];
  const v = all.length ? Number(all[all.length - 1][1]) : NaN;
  return Number.isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------- insertos (hito 6, ADR-073)

/** Datos de un video subido: tamaño, cuadros por segundo, duración y si trae audio. */
export async function probeVideo(file: string): Promise<{ width: number; height: number; fps: number; durationSec: number; hasAudio: boolean }> {
  const { stdout } = await ffprobe(['-show_entries', 'stream=codec_type,width,height,r_frame_rate:format=duration', '-of', 'json', file]);
  const j = JSON.parse(stdout.toString()) as { streams?: { codec_type: string; width?: number; height?: number; r_frame_rate?: string }[]; format?: { duration?: string } };
  const v = j.streams?.find((x) => x.codec_type === 'video');
  if (!v?.width || !v.height) throw new Error('El archivo no tiene video.');
  const [a, b] = (v.r_frame_rate ?? '0/1').split('/').map(Number);
  return { width: v.width, height: v.height, fps: b ? Math.round((a / b) * 100) / 100 : 0, durationSec: Number(j.format?.duration ?? 0), hasAudio: !!j.streams?.some((x) => x.codec_type === 'audio') };
}

/** Cómo entra un video subido en 2560×1440: con bandas negras, recortado o estirado. */
export function fitFilter(fit: 'contain' | 'cover' | 'stretch') {
  if (fit === 'cover') return FIT_2K;
  if (fit === 'stretch') return `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},setsar=1`;
  return `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
}

/**
 * Segmento de un video subido (portada o cierre): el tramo recortado, ajustado a 2560×1440 y 24 fps, con
 * exactamente `frames` frames y los mismos parámetros de H.264 que los clips.
 */
export async function encodeUploadSegment(input: string, o: { trimStart: number; frames: number; fit: 'contain' | 'cover' | 'stretch' }, output: string, soundWav?: string) {
  const d = (o.frames / FPS).toFixed(6);
  const audioIn = soundWav ? ['-i', soundWav] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
  await ffmpeg([
    '-ss',
    o.trimStart.toFixed(3),
    '-i',
    input,
    ...audioIn,
    '-filter_complex',
    `[0:v]${fitFilter(o.fit)},fps=${FPS},settb=1/${FPS},setpts=N,trim=end_frame=${o.frames},setpts=PTS-STARTPTS,format=yuv420p[v];[1:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${d}[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    ...X264_SEGMENT,
    ...AAC_SEGMENT,
    output,
  ]);
}

/** Audio de un tramo de un video (48 kHz estéreo), para medirlo y normalizarlo. */
export async function extractAudio(input: string, startSec: number, durSec: number, output: string) {
  await ffmpeg(['-ss', startSec.toFixed(3), '-t', durSec.toFixed(3), '-i', input, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', output]);
}

/**
 * Voz con huecos (ADR-073): la locución cortada en cada punto de inserción, con silencio del largo del
 * inserto (su propia locución va aparte, como pista superpuesta).
 */
export async function voiceWithGaps(voiceWav: string, gaps: { cutSec: number; gapSec: number }[], output: string) {
  const sorted = [...gaps].sort((a, b) => a.cutSec - b.cutSec);
  const parts: string[] = [];
  const labels: string[] = [];
  let from = 0;
  sorted.forEach((g, i) => {
    if (g.cutSec > from + 1e-4) {
      parts.push(`[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=${from.toFixed(6)}:${g.cutSec.toFixed(6)},asetpts=N/SR/TB[p${i}]`);
      labels.push(`[p${i}]`);
    }
    parts.push(`aevalsrc=0|0:d=${g.gapSec.toFixed(6)}:s=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[g${i}]`);
    labels.push(`[g${i}]`);
    from = g.cutSec;
  });
  parts.push(`[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start=${from.toFixed(6)},asetpts=N/SR/TB[tail]`);
  labels.push('[tail]');
  parts.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[out]`);
  await ffmpeg(['-i', voiceWav, '-filter_complex', parts.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', '48000', output]);
}

/**
 * Pausa entre dos palabras (ADR-164): en el segundo `atSec` agrega `deltaSec` de silencio (positivo) o quita ese tramo,
 * centrado en `atSec` (negativo; debe ser silencio). Lo demás queda idéntico (sin recodificar con pérdida: PCM a PCM).
 * Con `totalSec`, el resultado dura exactamente eso (se completa con silencio o se recorta el final).
 */
export async function editSilence(input: string, atSec: number, deltaSec: number, output: string, totalSec?: number) {
  const fmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const half = Math.abs(deltaSec) / 2;
  const headEnd = deltaSec > 0 ? atSec : atSec - half;
  const tailStart = deltaSec > 0 ? atSec : atSec + half;
  const parts = [
    `[0:a]${fmt},atrim=0:${headEnd.toFixed(6)},asetpts=N/SR/TB[h]`,
    `[0:a]${fmt},atrim=start=${tailStart.toFixed(6)},asetpts=N/SR/TB[t]`,
  ];
  if (deltaSec > 0) parts.push(`aevalsrc=0|0:d=${deltaSec.toFixed(6)}:s=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[g]`);
  const end = totalSec !== undefined ? `,apad,atrim=0:${totalSec.toFixed(6)}` : '';
  parts.push(`${deltaSec > 0 ? '[h][g][t]' : '[h][t]'}concat=n=${deltaSec > 0 ? 3 : 2}:v=0:a=1${end}[out]`);
  await ffmpeg(['-i', input, '-filter_complex', parts.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', '48000', output]);
}

/** Un cuadro de un video en el segundo `sec`, ajustado a 2560×1440 como en el final (PNG). */
export async function videoFrameAt(input: string, sec: number, fit: 'contain' | 'cover' | 'stretch', output: string) {
  await ffmpeg(['-ss', Math.max(0, sec).toFixed(3), '-i', input, '-vf', fitFilter(fit), '-frames:v', '1', '-update', '1', output]);
}

/**
 * Tramo de un clip IA (ADR-075/076): `frames` frames desde el frame `from` (contados a 24 fps), con su
 * sonido, acelerado para que dure `outFrames` (sin acelerar si son iguales), en su resolución y casi sin
 * pérdida (se vuelve a codificar después, en el segmento).
 */
export async function cutClip(input: string, from: number, frames: number, output: string, outFrames = frames) {
  const speed = frames / outFrames;
  const a = (from / FPS).toFixed(6);
  const d = (outFrames / FPS).toFixed(6);
  const probe = await ffprobe(['-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', input]);
  const hasAudio = probe.stdout.toString().trim().length > 0;
  // Acelerado: se eligen `outFrames` cuadros repartidos del primero al último del tramo (exacto, sin perder el final).
  const pick = Array.from({ length: outFrames }, (_, k) => from + Math.round((k * (frames - 1)) / Math.max(1, outFrames - 1)));
  const video =
    speed === 1
      ? `trim=start_frame=${from}:end_frame=${from + frames}`
      : `select='${[...new Set(pick)].map((i) => `eq(n\\,${i})`).join('+')}'`;
  await ffmpeg([
    '-i',
    input,
    '-filter_complex',
    `[0:v]fps=${FPS},settb=1/${FPS},setpts=N,${video},setpts=N,format=yuv420p[v]` +
      (hasAudio
        ? `;[0:a]aresample=48000,atrim=${a}:${((from + frames) / FPS).toFixed(6)},asetpts=PTS-STARTPTS${speed === 1 ? '' : `,atempo=${speed.toFixed(6)}`},apad,atrim=0:${d}[a]`
        : ''),
    '-map',
    '[v]',
    ...(hasAudio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '320k'] : []),
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '10',
    '-r',
    String(FPS),
    output,
  ]);
}
