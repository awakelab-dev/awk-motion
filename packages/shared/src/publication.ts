import type { DownloadLogo, ExportQuality, LogoCorner, LogoSettings } from './delivery.js';

/**
 * Publicaciones (hito 9, ADR-101): una copia del final de un video (en una calidad y, desde T2, con el logo
 * dibujado) con sus subtítulos y su portada, en una carpeta pública del almacenamiento con un nombre que no se
 * puede adivinar. La URL no caduca: sirve para el código de Rise 360 y el SCORM liviano. Sigue al final vigente:
 * si el video tiene un final nuevo, se vuelve a publicar en la misma URL.
 */
export type PublicationStatus = 'queued' | 'preparing' | 'ready' | 'error';
/** Dónde se usa una publicación (aviso al despublicar). */
export type PublicationUse = 'manual' | 'rise' | 'scorm';

export interface PublicationInfo {
  id: string;
  generationId: string;
  /** Título del video (comienzo de su texto). */
  title: string;
  quality: ExportQuality;
  /** Con el logo del proyecto dibujado en el video, en la esquina de cada clip (T2, ADR-102). */
  logo: boolean;
  status: PublicationStatus;
  error?: string;
  /** 0–1 mientras se prepara (codificar la calidad elegida y subir). */
  progress?: number;
  /** URLs públicas (estables). */
  urls: { video: string; subtitles?: string; poster?: string };
  bytes?: number;
  createdAt: string;
  publishedAt?: string;
  /** El video tiene un final más nuevo que lo publicado: se está volviendo a publicar. */
  stale: boolean;
  uses: PublicationUse[];
}

export interface CreatePublicationRequest {
  quality: ExportQuality;
  /** Con el logo del proyecto dibujado en el video (T2, ADR-102). */
  logo?: boolean;
}

/** Pedido del documento con el código para Rise 360 (T3 y T3b, ADR-103/104): se arma en segundo plano y queda en «Descargas». */
export interface CreateRiseRequest {
  quality: ExportQuality;
  /** Con el logo del proyecto dibujado en el video. */
  logo: boolean;
  /** Subtítulos encendidos al empezar (`default` en el `<track>`). */
  subtitlesOn: boolean;
  doc: 'html' | 'txt';
  /** Proyecto: los videos elegidos (sin el campo, todos los que tienen final; T5b, ADR-113). */
  videoIds?: string[];
}

/**
 * SCORM liviano (hito 9, T4, ADR-108): el paquete SCORM sin el video adentro; el reproductor lo carga de su
 * publicación en la nube (calidad elegida, sin logo dibujado: el logo, la portada y los subtítulos van en el
 * paquete). Se arma en segundo plano y queda en «Descargas».
 */
export interface CreateLightScormRequest {
  version: '1.2' | '2004';
  quality: ExportQuality;
  logo?: DownloadLogo;
  settings?: LogoSettings;
  cornerAll?: LogoCorner;
  /** Proyecto: los videos elegidos (sin el campo, todos los que tienen final). Siempre un SCORM por video (en un ZIP). */
  videoIds?: string[];
}
