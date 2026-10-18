/** Estado «Publicado» (hito 9, T3c, ADR-105): textos para mostrar dónde se usa un video publicado. */
export type PublishedUse = 'manual' | 'rise' | 'scorm';

const LABEL: Record<PublishedUse, string> = { rise: 'Rise 360', scorm: 'SCORM liviano', manual: 'publicado a mano' };
const ORDER: PublishedUse[] = ['rise', 'scorm', 'manual'];

/** «Rise 360 y publicado a mano». */
export function publishedText(uses: readonly PublishedUse[]): string {
  const parts = ORDER.filter((u) => uses.includes(u)).map((u) => LABEL[u]);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}` : (parts[0] ?? 'publicado');
}
