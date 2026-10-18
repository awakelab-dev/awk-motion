/**
 * Prueba de voz (hito 10, T2, ADR-129): el mismo video con otra forma de pedir la locución, para compararlas al oído.
 * - `v3-whole`: un solo pedido a ElevenLabs v3 con todo el texto, cortado por párrafos con la alineación (sin pausas
 *   añadidas: las del propio pedido).
 * - `v4-linked`: un pedido por párrafo a `eleven_v4`, cada uno enlazado con los anteriores (`previous_request_ids`) y
 *   con el comienzo del siguiente (`next_text`), montados con la pausa de siempre.
 * La de hoy (un pedido por párrafo a v3, sin enlace) es el video original.
 */
export type VoiceTrialVariant = 'v3-whole' | 'v4-linked';

export const VOICE_TRIAL_VARIANTS: { id: VoiceTrialVariant; label: string; detail: string }[] = [
  {
    id: 'v3-whole',
    label: 'Un solo pedido (v3)',
    detail: 'Todo el texto en un solo pedido a ElevenLabs v3, cortado por párrafos. Las pausas son las del propio pedido.',
  },
  {
    id: 'v4-linked',
    label: 'Pedidos enlazados (v4)',
    detail: 'Un pedido por párrafo a eleven_v4, enlazado con los anteriores para que siga el mismo tono. Pausas de siempre. v4 imita más la voz original que v3: con Similarity alta se pega más a ella.',
  },
];

export const voiceTrialLabel = (v: VoiceTrialVariant) => VOICE_TRIAL_VARIANTS.find((x) => x.id === v)?.label ?? v;

/**
 * Ajustes de la voz para la variante v4 (ADR-131): Similarity (qué tan pegada a la voz original) y Stability (qué tan
 * constante), de 0 a 1. Sin el campo, los de la voz en ElevenLabs.
 */
export interface VoiceTrialSettings {
  similarity?: number;
  stability?: number;
}

/** Similarity por defecto de la variante v4: alta, para que suene como la voz de siempre. */
export const VOICE_TRIAL_V4_SIMILARITY = 0.95;

/** Marca de una copia hecha para la prueba de voz (`Generation.delivery.voiceTrial`). */
export interface VoiceTrialMark {
  variant: VoiceTrialVariant;
  settings?: VoiceTrialSettings;
  /** Video original. */
  from: string;
  at: string;
}

export interface VoiceTrialResponse {
  /** Copias creadas (una por variante), ya locutándose. */
  copies: { id: string; variant: VoiceTrialVariant }[];
}
