/** Constantes de la línea de tiempo (docs/02_pipeline.md). */
export const FPS = 24;
export const SAMPLE_RATE = 48000;
/** Muestras de audio por frame a 48 kHz y 24 fps. */
export const SAMPLES_PER_FRAME = SAMPLE_RATE / FPS; // 2000
/** Duración nominal de un clip IA: MiniMax entrega 5,167 s (124 frames). */
export const CLIP_FRAMES = 124;
/**
 * Separación entre planos que se pide al storyboard (s): un plano cada ~7,2 s, entre 6,5 y 8 s. Con clips de 5,167 s
 * deja ~63–70 % del video animado (medido el 12-10-2026). T3f la bajó al 50 % (un plano cada ~10,3 s) y se revirtió
 * (ADR-114): quedaba demasiado tiempo sin animación. En el hito 10 pasa a ser un ajuste por video.
 */
export const SHOT_SPACING_SEC = 7.2;
export const SHOT_MIN_SPACING_SEC = 6.5;
export const SHOT_MAX_SPACING_SEC = 8;
/** Cada clip empieza ~1 s antes de que la voz diga su PFC (la regla de antes del hito 13a). */
export const LEAD_FRAMES = 24;
/**
 * Regla de sincronía `v2` (hito 13a, T5, ADR-181): el ancla es la primera palabra de la frase clave y el clip empieza
 * 0,5 s antes. Los videos nuevos nacen con ella; los anteriores la toman con «Reajustar sincronía» (T6).
 */
export const LEAD_FRAMES_V2 = 12;
/**
 * Reglas de sincronía: 'v2' (21-11-2026, ADR-181) anclaba en la primera palabra de la frase clave de Opus; 'v3' (la de
 * hoy, ADR-183) ancla en el primero de los textos en pantalla que dice la voz. Las dos con el clip 0,5 s antes.
 */
export type SyncRule = 'v2' | 'v3';
/** Regla de sincronía con la que nacen los videos nuevos y a la que lleva «Reajustar sincronía». */
export const SYNC_RULE: SyncRule = 'v3';
/** Frames de adelanto del clip según la regla de sincronía del video (sin regla = la de antes, 1 s). */
export const leadFramesFor = (rule?: string | null) => (rule ? LEAD_FRAMES_V2 : LEAD_FRAMES);
export const OUTPUT_WIDTH = 2560;
export const OUTPUT_HEIGHT = 1440;

export const framesToSeconds = (f: number) => f / FPS;
export const secondsToFrame = (s: number) => Math.round(s * FPS);

/** Pausa entre dos palabras (ADR-164): lo más que se agrega de una vez, lo mínimo que se cambia y el silencio que queda a cada lado al acortar (s). */
export const PAUSE_MAX_SEC = 3;
export const PAUSE_MIN_SEC = 0.05;
export const PAUSE_MARGIN_SEC = 0.04;
