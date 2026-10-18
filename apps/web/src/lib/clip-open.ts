/**
 * Abrir «Editar clip» de un video desde otra pantalla (T11, ADR-122): la pantalla «Observaciones» deja el pedido y
 * abre el video; cuando su lista de clips está a la vista, abre el editor de ese clip (y, si se pidió, Opus analiza
 * sus observaciones).
 */
export interface ClipOpenRequest {
  generationId: string;
  index: number;
  analyze: boolean;
  /** Vista a la que volver al cerrar el editor (T11b): «Observaciones», si se abrió desde ahí. */
  returnTo?: 'observaciones';
}

let pending: ClipOpenRequest | undefined;
export const CLIP_OPEN_EVENT = 'wilox:open-clip';

export function requestClipEditor(r: ClipOpenRequest) {
  pending = r;
  window.dispatchEvent(new Event(CLIP_OPEN_EVENT));
}

/** Toma el pedido para este video (una sola vez). */
export function takeClipRequest(generationId: string): ClipOpenRequest | undefined {
  if (pending?.generationId !== generationId) return undefined;
  const r = pending;
  pending = undefined;
  return r;
}

/** Evento para refrescar el contador de «Observaciones» de la cabecera al cambiar un estado. */
export const REVIEWS_CHANGED_EVENT = 'wilox:reviews-changed';
