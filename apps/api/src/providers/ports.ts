import type { GenerationMode, VoiceOption } from '@wilox/shared';
import type { WordTime } from '../pipeline/align.js';

export interface TtsResult {
  /** Audio descargado en disco (mp3 o wav). */
  path: string;
  /** URL remota (Higgsfield), útil para procesarla en su sandbox. */
  remoteUrl?: string;
  /** Tiempos por palabra si el proveedor los entrega (ElevenLabs /with-timestamps). */
  words?: WordTime[];
  /** Id del trabajo en el proveedor (para GenerationJob). */
  jobId?: string;
  /** Lo que factura el proveedor (p. ej. créditos de ElevenLabs de la cabecera character-cost). */
  usage?: Record<string, unknown>;
  /** Modelo que hizo la locución, si no es el de siempre (prueba de voz, hito 10). */
  model?: string;
}

/**
 * Opciones de una locución (prueba de voz del hito 10, ADR-129): otro modelo y el enlace con las locuciones
 * anteriores para que la voz siga el mismo tono (`previous_request_ids` de ElevenLabs, hasta 3) y el texto que viene.
 */
export interface TtsOptions {
  model?: string;
  previousRequestIds?: string[];
  nextText?: string;
  /**
   * Ajustes de la voz solo para este pedido (ADR-131): `similarityBoost` (qué tan pegada a la voz original) y
   * `stability` (qué tan constante), de 0 a 1. Sin ellos, los de la voz en ElevenLabs.
   */
  voiceSettings?: { similarityBoost?: number; stability?: number };
}

export interface ImageRequest {
  key: string;
  prompt: string;
  /** Imágenes de referencia de estilo (Higgsfield: media_id o job_id; API: ruta local). */
  references?: string[];
  /** Ruta de salida sin extensión; el proveedor añade .png. */
  outBase: string;
}

export interface ImageResult {
  key: string;
  path?: string;
  /** Referencia para usar la imagen como start/end de un video (job_id en Higgsfield, ruta en API). */
  ref?: string;
  error?: string;
  /** Lo que factura el proveedor, si lo devuelve (tokens de OpenAI). */
  usage?: Record<string, unknown>;
}

export interface VideoRequest {
  key: string;
  prompt: string;
  start: { ref: string; path: string };
  end: { ref: string; path: string };
  outPath: string;
  /**
   * Hito 5 (ADR-046): tarea ya enviada al proveedor (task_id de MiniMax). Se sigue consultando en vez de
   * pedir y pagar el clip otra vez (reinicio de la API o reintento).
   */
  resumeTaskId?: string;
  /** Se llama en cuanto el proveedor acepta la tarea, antes de esperar el resultado (para guardarla). */
  onSubmitted?: (taskId: string) => void | Promise<void>;
}

export interface VideoResult {
  key: string;
  path?: string;
  error?: string;
  /** Id del trabajo en el proveedor (job_id de Higgsfield, task_id de MiniMax). */
  jobId?: string;
  /** Uso facturado (task.usage de MiniMax: output_seconds…). */
  usage?: Record<string, unknown>;
}

export type OnItem<T> = (result: T) => void | Promise<void>;

export interface TtsPort {
  listVoices(): Promise<VoiceOption[]>;
  synthesize(text: string, voiceId: string, outBase: string, opts?: TtsOptions): Promise<TtsResult>;
}

export interface TimingPort {
  /** Tiempos por palabra de un párrafo (relativos al inicio de su audio). */
  wordTimes(sourceWords: string[], audio: TtsResult, durationSec: number): Promise<WordTime[]>;
}

export interface ImagePort {
  generate(requests: ImageRequest[], onItem?: OnItem<ImageResult>): Promise<ImageResult[]>;
}

export interface VideoPort {
  generate(requests: VideoRequest[], onItem?: OnItem<VideoResult>): Promise<VideoResult[]>;
}

export type LlmContent =
  | string
  | (
      | { type: 'text'; text: string }
      | { type: 'image'; mediaType: 'image/jpeg' | 'image/png'; base64: string }
      /** PDF completo (hito 5: importar un guion; Opus lee también sus tablas). */
      | { type: 'document'; mediaType: 'application/pdf'; base64: string }
    )[];

export interface LlmUsage {
  id?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface LlmCallMeta {
  /** Para qué es la llamada ("Storyboard", "Revisión visual"…): va como target del trabajo. */
  label?: string;
  onUsage?: (u: LlmUsage) => void;
}

export interface LlmPort {
  /** Devuelve el JSON (sin validar) que cumple `schema`. `user` puede incluir imágenes. */
  structured(system: string, user: LlmContent, schema: Record<string, unknown>, meta?: LlmCallMeta): Promise<unknown>;
}

export interface Providers {
  mode: GenerationMode;
  tts: TtsPort;
  timing: TimingPort;
  images: ImagePort;
  video: VideoPort;
  llm: LlmPort;
  defaultVoiceId(): string;
  /** Sube una imagen local y devuelve una referencia usable como start/end de un clip (Higgsfield: media_id). */
  uploadRef?(path: string): Promise<string>;
}

export const PROVIDERS = Symbol('PROVIDERS');
