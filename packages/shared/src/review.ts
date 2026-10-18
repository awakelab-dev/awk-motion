/**
 * Revisión del storyboard por el cliente (hito 8, A4, ADR-098): un link sin sesión con los fotogramas como
 * slides y la locución de cada tramo, donde el cliente deja observaciones por fotograma y puede aprobar.
 */

export const REVIEW_AUTHOR_MAX = 60;
export const REVIEW_TEXT_MAX = 2000;
/** Tope de observaciones por video (el link es público). */
export const REVIEW_MAX_COMMENTS = 400;

/** `comment` = sobre un fotograma del storyboard; `video` = sobre un plano del video terminado (T6b, ADR-116). */
export type ReviewCommentKind = 'comment' | 'approval' | 'video';

/** Una observación (o la aprobación) del cliente, tal como la ve la app. */
export interface ReviewComment {
  id: string;
  kind: ReviewCommentKind;
  /** Fotograma (K0 = portada); sin el campo en una aprobación. */
  keyframeIndex?: number;
  /** Versión del fotograma que vio el cliente. */
  keyframeVersion?: number;
  author: string;
  text: string;
  createdAt: string;
  resolvedAt?: string;
  /** «En curso» desde (T8): el equipo ya la está corrigiendo. */
  inProgressAt?: string;
  /** Archivada desde (ADR-140). */
  archivedAt?: string;
  /** Pendiente, en curso, resuelta (T8, ADR-119) o archivada (ADR-140). */
  status: ReviewCommentStatus;
  /** Se hizo sobre una versión anterior del fotograma (en una aprobación, de alguno; en una del video, del final). */
  outdated: boolean;
}

/**
 * Estado de una observación (T8, ADR-119). «Archivada» (ADR-140): no es urgente y quizá no se haga, pero se guarda por
 * si el revisor insiste; no cuenta como abierta y solo se ve al pedirla. El cliente la sigue viendo como no resuelta.
 */
export type ReviewCommentStatus = 'pending' | 'progress' | 'resolved' | 'archived';
export const REVIEW_COMMENT_STATUSES: readonly ReviewCommentStatus[] = ['pending', 'progress', 'resolved', 'archived'];

/** Cambiar el estado de varias observaciones a la vez (ADR-140). */
export interface ReviewStatusBatch {
  ids: string[];
  status: ReviewCommentStatus;
}

/** Una observación en la pantalla «Observaciones» (T8): con su video, su proyecto y la miniatura del fotograma. */
export interface ReviewInboxItem extends ReviewComment {
  kind: 'comment' | 'video';
  generationId: string;
  videoTitle: string;
  projectId: string;
  projectName: string;
  /** Miniatura del fotograma vigente al que se refiere (ruta de la app). */
  thumb?: string;
  /** Versión vigente del fotograma (para «sobre v1, hoy v3»). */
  currentVersion?: number;
}

export interface ReviewInbox {
  items: ReviewInboxItem[];
  /** Cuántas hay en cada estado (con el filtro de proyecto, sin el de estado). */
  counts: Record<ReviewCommentStatus, number>;
  /** Proyectos con observaciones, con las abiertas (pendientes + en curso) de cada uno. */
  projects: { id: string; name: string; open: number }[];
}

/** Link de revisión activo. */
export interface ReviewLink {
  url: string;
  createdAt: string;
}

/** Revisión de un video en la app. */
export interface VideoReview {
  link?: ReviewLink;
  /** Observaciones, de la más antigua a la más nueva. */
  comments: ReviewComment[];
  /** La última aprobación del cliente. */
  approval?: ReviewComment;
  /** Observaciones sin resolver. */
  open: number;
  /** Sin resolver por fotograma (índice → cantidad). */
  openByKeyframe: Record<string, number>;
}

/** Algo nuevo del cliente en un video (avisos de la app). */
export interface ReviewActivity {
  id: string;
  kind: ReviewCommentKind;
  generationId: string;
  projectName: string;
  videoTitle: string;
  keyframeIndex?: number;
  author: string;
  text: string;
  createdAt: string;
}

/** Avisos nuevos desde `since` y la hora del servidor para la próxima consulta. */
export interface ReviewActivityPage {
  items: ReviewActivity[];
  now: string;
}

/** Una observación del cliente que toca un clip (T11): las del video en su plano y las del storyboard en sus dos fotogramas. */
export interface ClipFeedbackComment {
  id: string;
  kind: 'comment' | 'video';
  keyframeIndex: number;
  author: string;
  text: string;
  createdAt: string;
  status: ReviewCommentStatus;
  outdated: boolean;
}

/** Sugerencia de Opus para un clip (T11, ADR-122). */
export interface ClipAdvice {
  summary: string;
  /** `instruction` en español (la que ve el equipo); en un clip, `modelInstruction` es la misma en inglés para el modelo de video. */
  actions: { target: 'clip' | 'start' | 'end'; instruction: string; modelInstruction: string; why: string }[];
  notes: string;
  /** Cuándo se pidió y sobre qué observaciones. */
  at: string;
  commentIds: string[];
  /** Hay observaciones nuevas, o cambió el clip o un fotograma, desde la sugerencia. */
  stale: boolean;
}

export interface ClipFeedback {
  /** Solo las abiertas (pendientes y en curso): las resueltas ya no se muestran en «Editar clip». */
  comments: ClipFeedbackComment[];
  advice?: ClipAdvice;
}

