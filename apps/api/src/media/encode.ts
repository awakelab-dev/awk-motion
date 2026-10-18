import { FPS } from '@wilox/shared';

/**
 * Codificación de los segmentos (hito 6, ADR-055). Clips y congelados salen con exactamente los mismos
 * parámetros de H.264, que son los del final de siempre (CRF 16 preset slow). Así el final se une sin
 * recodificar el video (concat con copia): una sola compresión y segundos en lugar de minutos.
 *
 * Nivel, perfil y escala de tiempo van fijos para que todos los segmentos declaren lo mismo aunque
 * x264 eligiera otra cosa según el contenido (sin `-tune stillimage` en los congelados por la misma razón).
 */
export const SEGMENT_FORMAT = 2;

export const X264_SEGMENT = [
  '-c:v',
  'libx264',
  '-preset',
  'slow',
  '-crf',
  '16',
  '-pix_fmt',
  'yuv420p',
  '-profile:v',
  'high',
  '-level:v',
  '5.1',
  '-r',
  String(FPS),
  '-video_track_timescale',
  String(FPS * 512),
];

/** Audio de los segmentos (solo para los clips del ZIP: el final se mezcla desde los WAV). */
export const AAC_SEGMENT = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];
