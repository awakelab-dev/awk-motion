import { isOriginalQuality, type ExportQuality } from '@wilox/shared';

/**
 * Una publicación despublicada no se borra (ADR-139): queda con `status = 'unpublished'` y sin archivos, guardando su
 * token. Si el video se vuelve a publicar con la misma calidad y logo, vuelve la misma dirección (y siguen andando el
 * código de Rise o el SCORM liviano que la usaban).
 */
export const UNPUBLISHED = 'unpublished';

/** Clave para reutilizar una publicación: calidad y logo («720p_balanced|sin-logo»). */
export const variantOf = (q: ExportQuality, logo = false) => `${isOriginalQuality(q) ? 'original' : `${q.height}p_${q.compression}`}|${logo ? 'logo' : 'sin-logo'}`;

/** Tokens públicos de un documento (código para Rise), en orden y sin repetir: cada video aparece con sus archivos. */
export function tokensOf(doc: string): string[] {
  const out: string[] = [];
  for (const m of doc.matchAll(/\/publico\/([A-Za-z0-9_-]{16,64})\//g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
