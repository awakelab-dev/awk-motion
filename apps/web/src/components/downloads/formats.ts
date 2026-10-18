import { LIGHT_SCORM_FORMATS, type BatchFormat, type DownloadBatchInfo } from '@wilox/shared';

/** Formatos de «Un archivo por video» (lotes, ADR-087): los de la descarga individual sin el ZIP completo, con el mismo texto. */
export const BATCH_FORMAT_INFO: Record<BatchFormat, { title: string; hint: string; logo: boolean }> = {
  html: { title: 'HTML', hint: 'Un ZIP por video con index.html, el video y los subtítulos. Funciona sin internet, con doble clic o subido a Moodle.', logo: true },
  scorm12: { title: 'SCORM 1.2', hint: 'Un paquete por video para Moodle u otro LMS: registra el video como visto (95 %) y retoma donde quedó.', logo: true },
  scorm2004: { title: 'SCORM 2004', hint: 'Igual que el 1.2, en la 4.ª edición (además informa el avance).', logo: true },
  single: { title: 'Un solo .html', hint: 'Un .html por video con el video dentro (pesa ~33 % más). Los videos de más de 40 MB no entran.', logo: true },
  mp4: { title: 'Solo el MP4', hint: 'Cada video tal cual, sin logo ni subtítulos.', logo: false },
};

/** Filas que primero publican en la nube (Rise y SCORM liviano): no esperan en la cola de lotes. */
export const isPublishedBatch = (b: Pick<DownloadBatchInfo, 'format'>) => b.format === 'rise' || (LIGHT_SCORM_FORMATS as readonly string[]).includes(b.format);

/** Título del formato de una fila de «Descargas»: un lote, el documento para Rise 360 (T3b, ADR-104) o un SCORM liviano (T4, ADR-108). */
export function batchFormatInfo(b: Pick<DownloadBatchInfo, 'format' | 'rise' | 'light'>): { title: string; logo: boolean } {
  if (b.format === 'rise') return { title: `Código para Rise 360 (.${b.rise?.doc ?? 'html'})`, logo: true };
  if (b.format === 'scorm12-light' || b.format === 'scorm2004-light')
    return { title: `SCORM ${b.format === 'scorm12-light' ? '1.2' : '2004'} liviano (video en la nube)${b.light?.each ? ' · uno por video' : ''}`, logo: true };
  if (b.format === 'zip') return { title: 'ZIP completo', logo: true };
  if (b.format === 'project-zip') return { title: 'ZIP del proyecto', logo: true };
  return BATCH_FORMAT_INFO[b.format];
}
