/**
 * Voz del proyecto (hito 13a, ADR-177/178): versión del modelo de voz, semilla y velocidad de la narración.
 *
 * - `voiceModel`: 'v3' (ElevenLabs v3, la locución entera en un solo pedido, ADR-133) o 'v4' (`eleven_v4`, un pedido por
 *   párrafo con el texto anterior y el siguiente como contexto y la semilla del proyecto; «Rehacer audio» pide solo ese
 *   párrafo). Los proyectos nuevos nacen en v4; uno en v3 puede pasar a v4 (solo hacia v4, nunca de vuelta).
 * - `voiceSpeed`: velocidad de la narración (0,70–1,15), aplicada después de pedir la voz (ffmpeg rubberband).
 */
export type VoiceModel = 'v3' | 'v4';

/** Pausa de voz a voz entre dos párrafos en v4: 0,2 s de la propia voz + 0,4 s del punto aparte (D3/D5). */
export const V4_PARAGRAPH_GAP_SEC = 0.6;
/** Margen que queda antes de la primera palabra y después de la última al recortar el audio de un párrafo en v4 (s). */
export const V4_LEAD_SEC = 0.06;
export const V4_TAIL_SEC = 0.15;
/** Tope de caracteres de un pedido a `eleven_v4`. */
export const V4_MAX_CHARS = 10000;
/** Caracteres de contexto (texto anterior y siguiente) que acompañan cada párrafo en v4. */
export const V4_CONTEXT_CHARS = 1000;
/**
 * Créditos de ElevenLabs por carácter en v4 frente a v3 (medido el 21-11-2026: 240 créditos por 495 caracteres; v3 cobra
 * uno por carácter). Solo para el aviso de gasto mientras no haya locuciones v4 en el historial de costos.
 */
export const V4_CREDITS_PER_CHAR = 240 / 495;

/** Velocidad de la narración (T2). */
export const VOICE_SPEED_MIN = 0.7;
export const VOICE_SPEED_MAX = 1.15;
export const VOICE_SPEED_STEP = 0.05;
/** Velocidad de los proyectos nuevos (los anteriores quedan en 1,0). */
export const VOICE_SPEED_DEFAULT = 0.85;

/** Voz de un proyecto (para la web). */
export interface ProjectVoice {
  model: VoiceModel;
  /** Velocidad de la narración de los videos nuevos (1 = la de la voz). */
  speed: number;
}

/** Normaliza la velocidad al paso de 0,05 dentro del rango. */
export function clampSpeed(v: number): number {
  const s = Math.round(v / VOICE_SPEED_STEP) * VOICE_SPEED_STEP;
  return Math.round(Math.min(VOICE_SPEED_MAX, Math.max(VOICE_SPEED_MIN, s)) * 100) / 100;
}

/** «Cambiar velocidad» de varios videos del proyecto (T2, ADR-178): sin pedir voz ni clips. */
export interface SpeedCandidate {
  id: string;
  title: string;
  createdAt: string;
  durationSec: number;
  /** Velocidad de su locución actual (1 = la de la voz). */
  speed: number;
  voiceModel: VoiceModel;
  published: boolean;
  /** Se puede cambiar ahora (terminado o en revisión de fotogramas, sin trabajo en curso). */
  available: boolean;
  reason?: string;
}

export interface SpeedBatchRequest {
  ids: string[];
  speed: number;
}

export interface SpeedBatchResponse {
  started: string[];
  skipped: { id: string; title: string; reason: string }[];
}

/** Frase de la muestra de voz (una vez por voz y versión; se estira a la velocidad elegida). */
export const VOICE_SAMPLE_TEXT =
  'Hola, esta es una muestra de la narración. Así sonará la voz en tus videos y micro cápsulas, a la velocidad que elijas para el proyecto.';

/**
 * «Pasar a v4» un proyecto en v3 (hito 13a, T3, ADR-179): solo el dueño, irreversible. Toda la locución de sus videos se
 * rehace en v4 por párrafo, a la velocidad elegida, sin fotogramas ni clips nuevos.
 */
export interface ToV4Status {
  /** Versión de voz del proyecto. */
  model: VoiceModel;
  /** Videos del proyecto que siguen en v3 (en un proyecto v3, todos). */
  v3Videos: number;
  /** Caracteres de voz de esos videos (para el aviso de gasto). */
  chars: number;
  /** Cuántos de ellos están publicados (el cliente verá el cambio). */
  published: number;
  /** Los que no se pueden pasar ahora: esperan su turno (clips en curso, aún sin terminar…) y pasan solos después. */
  waiting: { id: string; title: string; reason: string }[];
  /** Quien pide es el dueño (solo él lo hace). */
  canConvert: boolean;
}

export interface ToV4Response {
  /** Videos que empezaron a pasar a v4. */
  started: string[];
  /** Videos que esperan a terminar lo que están haciendo y pasan después, solos. */
  waiting: { id: string; title: string; reason: string }[];
  voice: ProjectVoice;
}
