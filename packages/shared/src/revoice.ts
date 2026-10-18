import type { VoiceMode } from './types.js';

/**
 * «Rehacer la locución» de varios videos de un proyecto (hito 10, T5, ADR-135): cada video vuelve a locutarse en un
 * solo pedido a v3, con la misma voz y el mismo texto (como el botón del video, ADR-134).
 */
export interface RevoiceCandidate {
  id: string;
  title: string;
  createdAt: string;
  durationSec: number;
  /** Caracteres que se envían a la voz (el texto con las reglas de pronunciación). */
  chars: number;
  /** Cómo está pedida su locución hoy: 'whole' = un solo pedido; 'paragraph' = por párrafo (los anteriores al hito 10). */
  voiceMode: VoiceMode;
  published: boolean;
  /** Se puede rehacer ahora (terminado, modo API y sin trabajo en curso). */
  available: boolean;
  /** Por qué no se puede. */
  reason?: string;
}

export interface RevoiceBatchRequest {
  ids: string[];
}

export interface RevoiceBatchResponse {
  /** Videos que empezaron a locutarse. */
  started: string[];
  /** Videos marcados que no se pudieron empezar, con el motivo. */
  skipped: { id: string; title: string; reason: string }[];
}
