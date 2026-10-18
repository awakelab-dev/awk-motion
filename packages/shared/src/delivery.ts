/**
 * Entrega (hito 6, ADR-065 y ADR-066): logo superpuesto y reproductor HTML. El logo y sus ajustes son del
 * proyecto; cada video guarda la esquina del logo por clip y su portada. Al descargar se puede usar otro
 * logo o ajustes solo para esa descarga, y bajar el video o el proyecto en SCORM 1.2 o 2004.
 */

export type LogoCorner = 'tl' | 'tr' | 'bl' | 'br';
/** Realce del logo: ninguno, sombra, brillo, fondo negro o blanco semitransparente. */
export type LogoEffect = 'none' | 'shadow' | 'glow' | 'dark' | 'light';

export interface LogoSettings {
  corner: LogoCorner;
  /** Ancho del logo en % del ancho del video. */
  widthPct: number;
  /** Margen desde los bordes en % del ancho del video. */
  marginPct: number;
  effect: LogoEffect;
  /** 0–1. */
  opacity: number;
}

export const DEFAULT_LOGO_SETTINGS: LogoSettings = { corner: 'tr', widthPct: 12, marginPct: 3, effect: 'none', opacity: 1 };

export const LOGO_CORNERS: readonly LogoCorner[] = ['tl', 'tr', 'bl', 'br'];
/** Logo de un clip: una esquina o 'none' (ese clip va sin logo, ADR-067). */
export type ClipLogo = LogoCorner | 'none';
export const LOGO_EFFECTS: readonly LogoEffect[] = ['none', 'shadow', 'glow', 'dark', 'light'];

/** Logo subido al proyecto. */
export interface LogoInfo {
  /** URL para verlo en la app (con versión para no quedar en caché). */
  url: string;
  mime: 'image/png' | 'image/svg+xml';
  width?: number;
  height?: number;
  fileName: string;
}

/** Entrega de un proyecto: logo (si hay) y sus ajustes por defecto. */
export interface ProjectDelivery {
  logo?: LogoInfo;
  settings: LogoSettings;
}

/**
 * Lo propio de cada video (ADR-066): la esquina del logo en cada clip (según su layout; sin elegir, la del
 * proyecto) y el fotograma de la portada. Tamaño, margen, realce y opacidad son globales del proyecto.
 */
export interface VideoDeliveryOverride {
  /** Esquina del logo por clip (índice del clip, 1…n) o 'none' si ese clip va sin logo. */
  clipCorners?: Record<string, ClipLogo>;
  /** Clip cuyo final es la portada (ADR-067); sin el campo, el clip 1. */
  posterClip?: number;
  /** Portada en un segundo dado (videos de antes de ADR-067). */
  posterSec?: number;
  /** Link para compartir el video sin sesión (hito 7, ADR-083); sin el campo, no hay link activo. */
  share?: { token: string; createdAt: string };
  /** Link de revisión del storyboard para el cliente (hito 8, ADR-098); sin el campo, no hay link activo. */
  review?: { token: string; createdAt: string };
}

/** Link para compartir un video (ADR-083): cualquiera con el link lo ve, sin iniciar sesión. */
export interface VideoShare {
  url: string;
  createdAt: string;
}

/** Tramo de un clip en el final (con su congelado): ahí manda su esquina. */
export interface DeliveryClip {
  index: number;
  title: string;
  startSec: number;
  endSec: number;
  /** Último fotograma del clip (antes de su congelado): ahí ya está todo dibujado. */
  posterSec: number;
}

/** Entrega de un video: el logo y los ajustes del proyecto, y lo propio del video. */
export interface VideoDelivery {
  logo?: LogoInfo;
  /** Ajustes del proyecto (la esquina es la de por defecto). */
  settings: LogoSettings;
  clipCorners: Record<string, ClipLogo>;
  clips: DeliveryClip[];
  /** Clip de la portada (undefined si es un segundo elegido antes de ADR-067). */
  posterClip?: number;
  posterSec: number;
  /** Portada por defecto (fin del clip01). */
  defaultPosterSec: number;
  durationSec: number;
  /** Peso del final (bytes): el HTML en un solo archivo solo se ofrece hasta SINGLE_HTML_MAX_BYTES. */
  finalBytes?: number;
  /** Link para compartir activo (ADR-083). */
  share?: VideoShare;
}

/** Hasta este peso del video se ofrece el HTML en un solo archivo (≈ 1 min con la calidad de hoy). */
export const SINGLE_HTML_MAX_BYTES = 40 * 1024 * 1024;

/** Descarga de un video: HTML (ZIP), SCORM (ADR-066), un solo .html, solo MP4 o el ZIP completo (ADR-067). */
export type DownloadFormat = 'html' | 'single' | 'mp4' | 'scorm12' | 'scorm2004' | 'zip';
/**
 * Descarga de un proyecto en un paquete: el ZIP completo. El SCORM del proyecto es siempre uno por video (lote «Un
 * archivo por video»; decisión de Leonardo, 11-10-2026, ADR-108): ya no hay un SCORM con un SCO por video.
 */
export type ProjectDownloadFormat = 'zip';

/**
 * Logo de una descarga (ADR-066): el del proyecto, ninguno u otro subido solo para esa descarga (no se
 * guarda: sirve para entregar el mismo video a otra empresa).
 */
export type DownloadLogo = 'project' | 'none' | { fileName: string; data: string };

// ─── Resolución y compresión de las descargas (hito 7, ADR-084 y ADR-085) ────────────────────────────

/** Alto del video descargado: 1440 = el original (2560×1440). */
export type ExportHeight = 1440 | 1080 | 720 | 480;
export type ExportCompression = 'high' | 'balanced' | 'light';
export interface ExportQuality {
  height: ExportHeight;
  compression: ExportCompression;
}
export const EXPORT_HEIGHTS: readonly ExportHeight[] = [1440, 1080, 720, 480];
export const EXPORT_COMPRESSIONS: readonly { id: ExportCompression; label: string; crf: number; hint: string }[] = [
  { id: 'high', label: 'Alta calidad', crf: 18, hint: 'Se ve igual que el original' },
  { id: 'balanced', label: 'Equilibrada', crf: 23, hint: 'Pesa bastante menos; diferencias mínimas' },
  { id: 'light', label: 'Liviana', crf: 28, hint: 'La más liviana; algo de pérdida en degradados y fotos' },
];
export const ORIGINAL_QUALITY: ExportQuality = { height: 1440, compression: 'high' };
/** 1440p con alta calidad es el final tal cual (CRF 16, sin recodificar). */
export const isOriginalQuality = (q?: ExportQuality) => !q || (q.height === 1440 && q.compression === 'high');
export const qualityLabel = (q?: ExportQuality) =>
  isOriginalQuality(q) ? '1440p original' : `${q!.height}p · ${EXPORT_COMPRESSIONS.find((c) => c.id === q!.compression)!.label.toLowerCase()}`;

/** Peso estimado de una descarga del final (ADR-084): exacto si ya está hecha (o es el original). */
export interface ExportEstimate {
  bytes: number;
  exact: boolean;
}

/** Estado de una descarga que necesita preparar versiones reducidas (ADR-085). */
export interface PackageStatus {
  ready: boolean;
  /** 0–1 (videos ya preparados + avance del que se está codificando). */
  progress: number;
  /** Peso total de los videos reducidos (cuando están listos). */
  bytes?: number;
  error?: string;
}

export interface DownloadRequest {
  format: DownloadFormat | ProjectDownloadFormat;
  /** Resolución y compresión (sin el campo, el original). */
  quality?: ExportQuality;
  logo?: DownloadLogo;
  /** Ajustes solo para esta descarga (sin el campo, los del proyecto). */
  settings?: LogoSettings;
  /** Esquina para todos los clips en esta descarga (ADR-067); los clips sin logo siguen sin logo. */
  cornerAll?: LogoCorner;
}

// ─── Lotes de descarga (hito 7, ADR-087) ──────────────────────────────────────────────────────────────

/** Formatos de un lote: los de la descarga individual, sin el ZIP completo. */
export type BatchFormat = Exclude<DownloadFormat, 'zip'>;
export const BATCH_FORMATS: readonly BatchFormat[] = ['html', 'scorm12', 'scorm2004', 'single', 'mp4'];
/** Lo que puede ser una fila de «Descargas»: un lote o el documento con el código para Rise 360 (hito 9, T3b, ADR-104). */
/** SCORM liviano (hito 9, T4, ADR-108): el video se carga de su publicación en la nube. */
export type LightScormFormat = 'scorm12-light' | 'scorm2004-light';
export const LIGHT_SCORM_FORMATS: readonly LightScormFormat[] = ['scorm12-light', 'scorm2004-light'];
/** Filas de «Descargas» que arma PublicationsService (publican primero) y no la cola de lotes. */
export const PUBLISHED_BATCH_FORMATS: readonly string[] = ['rise', ...LIGHT_SCORM_FORMATS];
/**
 * Todo pasa por «Descargas» (hito 9, T5a, ADR-109): además de los formatos por video, el ZIP completo de un video
 * (`zip`: final con su reproductor, clips, voz, fotogramas, prompts y ficha) y el del proyecto (`project-zip`).
 */
export type FullZipFormat = 'zip' | 'project-zip';
export type BatchRequestFormat = BatchFormat | FullZipFormat;
export const BATCH_REQUEST_FORMATS: readonly BatchRequestFormat[] = [...BATCH_FORMATS, 'zip', 'project-zip'];
export type DownloadBatchFormat = BatchFormat | FullZipFormat | 'rise' | LightScormFormat;
/** Días que se guarda un lote listo en el servidor; después se borra solo. */
export const BATCH_RETENTION_DAYS = 30;

export type DownloadBatchStatus = 'queued' | 'preparing' | 'packing' | 'ready' | 'error';

/** Video que no entró en el lote y por qué. */
export interface BatchSkipped {
  id: string;
  title: string;
  reason: string;
}

/** Lote de descargas: un ZIP con la descarga individual de cada video, armado en segundo plano. */
export interface DownloadBatchInfo {
  id: string;
  projectId: string;
  projectName: string;
  /** Título del video en las descargas de un solo video (T5a). */
  videoTitle?: string;
  format: DownloadBatchFormat;
  /** Documento para Rise 360 (T3b): .html o .txt y subtítulos encendidos al empezar. */
  rise?: { doc: 'html' | 'txt'; subtitlesOn: boolean };
  /** SCORM liviano (T4): un paquete con todos los videos o un SCORM por video (`each`). */
  light?: { each: boolean };
  /** Resolución y compresión (sin el campo, el original). */
  quality?: ExportQuality;
  /** Logo: 'project' (el del proyecto), 'none' u 'other' (uno subido para el lote). */
  logo: 'project' | 'none' | 'other';
  videos: number;
  /** Videos ya preparados y añadidos al ZIP. */
  done: number;
  status: DownloadBatchStatus;
  /** 0–1. */
  progress: number;
  /** Qué está haciendo ahora (solo mientras se arma). */
  stage?: string;
  /** Lugar en la cola de lotes (1 = el siguiente), si está en cola. */
  position?: number;
  skipped: BatchSkipped[];
  fileName: string;
  bytes?: number;
  downloads: number;
  lastDownloadAt?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Cuándo se borra solo (sin el campo y lista: se guarda mientras tenga un link sin caducidad). */
  expiresAt?: string;
  /** Algún video (o el logo del proyecto) cambió desde que se armó: «Actualizar» la vuelve a armar (T5, ADR-111). */
  stale?: boolean;
  /** Links de descarga para el cliente (T5, ADR-111). */
  links: DownloadLinkInfo[];
}

// ─── Links de descarga (hito 9, T5, ADR-111) ─────────────────────────────────────────────────────────

/** Caducidad de un link: 7 o 30 días, o sin caducidad (null). */
export type LinkDays = 7 | 30 | null;
export const LINK_DAYS: readonly LinkDays[] = [7, 30, null];

export interface DownloadLinkInfo {
  id: string;
  /** Página pública de descarga (sin sesión). */
  url: string;
  label?: string;
  createdAt: string;
  /** Sin el campo: sin caducidad. */
  expiresAt?: string;
  expired: boolean;
  disabled: boolean;
  downloads: number;
  lastDownloadAt?: string;
}

export interface CreateDownloadLinkRequest {
  days: LinkDays;
  label?: string;
}

export interface UpdateDownloadLinkRequest {
  disabled?: boolean;
  /** Cambia la caducidad, contando desde hoy. */
  days?: LinkDays;
  label?: string | null;
}

/** Video de un proyecto que puede ir en un lote (los que tienen final). */
export interface BatchCandidate {
  id: string;
  title: string;
  createdAt: string;
  durationSec: number;
  /** Peso del final (original). */
  bytes: number;
}

/**
 * Pedido de una descarga (lote): las opciones de la descarga individual y los videos elegidos. Con un solo video
 * (formatos por video), el archivo es el paquete mismo (p. ej. el .zip del SCORM, listo para el LMS); con varios,
 * un ZIP con un paquete por video. `project-zip` lleva todos los videos del proyecto (`videoIds` se ignora).
 */
export interface CreateBatchRequest extends Omit<DownloadRequest, 'format'> {
  projectId: string;
  format: BatchRequestFormat;
  videoIds: string[];
}

// ─── Links del proyecto completo (hito 9, T6 y T6b, ADR-112 y ADR-116) ───────────────────────────────────

/** `review` = aprobación del storyboard; `videos` = revisión de los videos terminados. Cada uno es un link aparte. */
export type ProjectShareKind = 'review' | 'videos';
export const PROJECT_SHARE_KINDS: readonly ProjectShareKind[] = ['review', 'videos'];

export interface ProjectShareVideo {
  id: string;
  title: string;
  hasKeyframes: boolean;
  hasFinal: boolean;
  /** Observaciones del cliente sobre el storyboard sin resolver. */
  openComments: number;
  /** Observaciones del cliente sobre el video sin resolver. */
  openVideoComments: number;
  /** Fecha de la última aprobación del storyboard. */
  approvedAt?: string;
}

export interface ProjectShareLink {
  url: string;
  createdAt: string;
  all: boolean;
  videoIds: string[];
}

export interface ProjectShareState {
  /** Sin la clave: ese link no existe. */
  links: Partial<Record<ProjectShareKind, ProjectShareLink>>;
  videos: ProjectShareVideo[];
}

/** Crear o cambiar un link del proyecto: `videoIds` nulo = todos (también los que se agreguen); `renew` = link nuevo. */
export interface ProjectShareRequest {
  kind: ProjectShareKind;
  videoIds: string[] | null;
  renew?: boolean;
}
