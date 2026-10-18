import { ChangeCancelled, confirmChange } from '@/lib/confirm';
import type {
  BatchCandidate,
  CreateBatchRequest,
  DownloadBatchInfo,
  InsertRequest,
  MediaRulePlan,
  ScriptStyleInfo,
  ScriptStylesResponse,
  CostUnits,
  LogoSettings,
  ProjectDelivery,
  VideoDelivery,
  DownloadRequest,
  ExportEstimate,
  ExportQuality,
  PackageStatus,
  ClipLogo,
  ClipSoundMode,
  SoundMode,
  AppInfo,
  AuthUser,
  CreateGenerationRequest,
  CreateUserRequest,
  GenerationSummary,
  HistoryQuery,
  HistoryResponse,
  MusicListResponse,
  QueueOverview,
  ImportRequest,
  ImportResult,
  PronunciationRuleInfo,
  RevoiceRequest,
  VoiceSegment,
  TypefaceRole,
  ProjectsResponse,
  ProjectSummary,
  PromptSummary,
  RunState,
  ThemeBrief,
  ThemeDetail,
  ThemeStyle,
  UserSummary,
  VoiceOption,
  ReviewActivityPage,
  ReviewCommentStatus,
  ClipFeedback,
  ReviewInbox,
  VideoReview,
  PublicationInfo,
  CreateRiseRequest,
  TrashResponse,
  DuplicateProjectResponse,
  CreateLightScormRequest,
  CreateDownloadLinkRequest,
  ProjectShareKind,
  ProjectShareRequest,
  ProjectShareState,
  UpdateDownloadLinkRequest,
  RevoiceBatchResponse,
  RevoiceCandidate,
  ClipSplitInfo,
  ProjectAccessState,
  ProjectAccessRequest,
  ThemeInfo,
  UserTransferResponse,
} from '@wilox/shared';

/** Se emite cuando la API responde 401 (sesión caducada o cerrada): App vuelve a la pantalla de login. */
export const UNAUTHORIZED_EVENT = 'wilox:unauthorized';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit & { quiet401?: boolean }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let data: { message?: unknown } | undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    // Aviso del servidor antes de un cambio delicado (T3c, ADR-105): si se confirma, se repite el pedido.
    const c = data as { code?: string; title?: string; message?: string; action?: string } | undefined;
    if (res.status === 409 && c?.code === 'confirm' && !(init?.headers as Record<string, string> | undefined)?.['x-confirm-change']) {
      if (!(await confirmChange({ title: c.title ?? 'Confirmar', message: String(c.message ?? ''), action: c.action ?? 'Continuar' }))) throw new ChangeCancelled();
      return req<T>(path, { ...init, headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}), 'x-confirm-change': '1' } });
    }
    // Aviso que impide la acción (p. ej. eliminar algo publicado, T3d): se muestra y no pasa nada.
    if (res.status === 409 && c?.code === 'blocked') {
      await confirmChange({ title: c.title ?? 'No se puede', message: String(c.message ?? '') });
      throw new ChangeCancelled(String(c.message ?? ''));
    }
    if (res.status === 401 && !init?.quiet401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    const msg = data?.message ?? res.statusText;
    throw new ApiError(Array.isArray(msg) ? msg.join(' ') : String(msg), res.status);
  }
  return data as T;
}

/** Sesión (hito 3). */
export const authApi = {
  /** 401 aquí es "sin sesión", no un error: no dispara el evento. */
  me: () => req<AuthUser>('/auth/me', { quiet401: true }),
  login: (email: string, password: string) =>
    req<AuthUser>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }), quiet401: true }),
  logout: () => req<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  changePassword: (current: string, next: string) => req<{ ok: boolean }>('/auth/password', { method: 'POST', body: JSON.stringify({ current, next }) }),
};

/** Proyectos (hito 3). */
export const projectsApi = {
  /** Con `all` (hito 11), el admin ve los proyectos de todos («Ver los de todos»). */
  list: (archived = false, all = false) => req<ProjectsResponse>(`/projects?${archived ? 'archived=1&' : ''}${all ? 'all=1' : ''}`),
  /** Con quién se comparte y si es público (hito 11, ADR-142). */
  access: (id: string) => req<ProjectAccessState>(`/projects/${id}/access`),
  saveAccess: (id: string, body: ProjectAccessRequest) => req<ProjectAccessState>(`/projects/${id}/access`, { method: 'PUT', body: JSON.stringify(body) }),
  /** Cambiar el dueño (admin). */
  setOwner: (id: string, ownerId: string) => req<ProjectAccessState>(`/projects/${id}/owner`, { method: 'POST', body: JSON.stringify({ ownerId }) }),
  /** Temas para un video nuevo en el proyecto: los míos y, si es de otro, los de su dueño. */
  themes: (id: string) => req<ThemeInfo[]>(`/projects/${id}/themes`),
  create: (name: string, description?: string) => req<ProjectSummary>('/projects', { method: 'POST', body: JSON.stringify({ name, description }) }),
  update: (id: string, body: { name?: string; description?: string | null; archived?: boolean }) =>
    req<ProjectSummary>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  /** Eliminar (T3d, ADR-106): va a la papelera con sus videos. */
  remove: (id: string) => req<{ videos: number }>(`/projects/${id}`, { method: 'DELETE' }),
  downloadUrl: (id: string) => `/api/projects/${id}/download`,
  /** «Rehacer la locución» de varios videos (hito 10, T5, ADR-135). */
  revoiceCandidates: (id: string) => req<RevoiceCandidate[]>(`/projects/${id}/revoice`),
  revoice: (id: string, ids: string[]) => req<RevoiceBatchResponse>(`/projects/${id}/revoice`, { method: 'POST', body: JSON.stringify({ ids }) }),
  /** Detener / reanudar todos los videos sin final del proyecto (hito 5, ADR-052). */
  pause: (id: string) => req<{ paused: number }>(`/projects/${id}/pause`, { method: 'POST' }),
  resume: (id: string) => req<{ resumed: number }>(`/projects/${id}/continue`, { method: 'POST' }),
  /** Duplicar (T3e, ADR-107): el proyecto nuevo sale al instante; sus videos se copian en segundo plano. */
  duplicate: (id: string) => req<DuplicateProjectResponse>(`/projects/${id}/duplicate`, { method: 'POST' }),
  /** Links del proyecto completo: aprobación del storyboard (T6, ADR-112) y revisión de los videos (T6b, ADR-116). */
  share: (id: string) => req<ProjectShareState>(`/projects/${id}/share`),
  saveShare: (id: string, body: ProjectShareRequest) => req<ProjectShareState>(`/projects/${id}/share`, { method: 'POST', body: JSON.stringify(body) }),
  removeShare: (id: string, kind: ProjectShareKind) => req<ProjectShareState>(`/projects/${id}/share?kind=${kind}`, { method: 'DELETE' }),
};

/** Gestión de usuarios (solo admin). */
export const usersApi = {
  list: () => req<UserSummary[]>('/users'),
  create: (body: CreateUserRequest) => req<UserSummary>('/users', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: { name?: string | null; role?: 'admin' | 'user'; active?: boolean }) =>
    req<UserSummary>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  resetPassword: (id: string, password: string) => req<UserSummary>(`/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) }),
  /** «Pasar sus proyectos a…» (hito 11, ADR-142). */
  transfer: (id: string, toUserId: string) => req<UserTransferResponse>(`/users/${id}/transfer`, { method: 'POST', body: JSON.stringify({ toUserId }) }),
};

export const api = {
  info: () => req<AppInfo>('/info'),
  /** Costos unitarios para los avisos antes de gastar (hito 6, ADR-069). */
  costUnits: () => req<CostUnits>('/costs/units'),
  voices: (refresh = false) => req<VoiceOption[]>(`/voices${refresh ? '?refresh=1' : ''}`),
  higgsfieldStart: () => req<{ connected: boolean; authUrl?: string; error?: string }>('/auth/higgsfield/start'),
  create: (body: CreateGenerationRequest) => req<RunState>('/generations', { method: 'POST', body: JSON.stringify(body) }),
  get: (id: string) => req<RunState>(`/generations/${id}`),
  regenerate: (id: string, index: number, opts: { note?: string; useSuggestion?: boolean } = {}) =>
    req<RunState>(`/generations/${id}/keyframes/${index}/regenerate`, { method: 'POST', body: JSON.stringify(opts) }),
  approve: (id: string) => req<RunState>(`/generations/${id}/approve`, { method: 'POST' }),
  reopen: (id: string) => req<RunState>(`/generations/${id}/reopen`, { method: 'POST' }),
  /** Insertos (ADR-073): clip generado entre clips o video subido como portada o cierre. */
  addInsert: (id: string, body: InsertRequest) => req<RunState>(`/generations/${id}/inserts`, { method: 'POST', body: JSON.stringify(body) }),
  regenerateInsert: (id: string, insertId: number, note?: string) =>
    req<RunState>(`/generations/${id}/inserts/${insertId}/regenerate`, { method: 'POST', body: JSON.stringify({ note }) }),
  insertTransition: (id: string, insertId: number, body: { note?: string; remove?: boolean; enabled?: boolean }) =>
    req<RunState>(`/generations/${id}/inserts/${insertId}/transition`, { method: 'POST', body: JSON.stringify(body) }),
  removeInsert: (id: string, insertId: number) => req<RunState>(`/generations/${id}/inserts/${insertId}`, { method: 'DELETE' }),
  /** Propuestas de fotogramas en un video terminado (ADR-071): descartar una o aplicarlas (rehace clips). */
  discardKeyframe: (id: string, index: number) => req<RunState>(`/generations/${id}/keyframes/${index}/discard`, { method: 'POST' }),
  applyKeyframes: (id: string) => req<RunState>(`/generations/${id}/keyframes/apply`, { method: 'POST' }),
  /** «Aplicar la regla a este video» (ADR-082): qué cambia y aplicarla (rehace clips). */
  mediaRulePlan: (id: string) => req<MediaRulePlan>(`/generations/${id}/media-rule`),
  applyMediaRule: (id: string, alsoVideoClips: boolean) =>
    req<RunState>(`/generations/${id}/media-rule`, { method: 'POST', body: JSON.stringify({ alsoVideoClips }) }),
  regenerateClip: (id: string, index: number, note?: string) =>
    req<RunState>(`/generations/${id}/clips/${index}/regenerate`, { method: 'POST', body: JSON.stringify({ note }) }),
  newVersion: (id: string, text: string) => req<RunState>(`/generations/${id}/versions`, { method: 'POST', body: JSON.stringify({ text }) }),
  history: (q: HistoryQuery) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
    return req<HistoryResponse>(`/generations?${p}`);
  },
  summary: (id: string) => req<GenerationSummary>(`/generations/${id}/summary`),
  /** Eliminar un video (T3d, ADR-106): va a la papelera. */
  trashVideo: (id: string) => req<{ ok: true }>(`/generations/${id}`, { method: 'DELETE' }),
  /** Duplicar un video (T3e, ADR-107), en su proyecto o en otro: sin costo; toma el logo del proyecto donde queda. */
  duplicate: (id: string, projectId?: string) => req<GenerationSummary>(`/generations/${id}/duplicate`, { method: 'POST', body: JSON.stringify({ projectId }) }),
  /** «Rehacer la locución» en un solo pedido (hito 10, ADR-134). */
  revoiceAll: (id: string) => req<RunState>(`/generations/${id}/revoice-all`, { method: 'POST' }),
  /** «Dividir en dos» (hito 10, T3, ADR-130). */
  splitInfo: (id: string, index: number) => req<ClipSplitInfo>(`/generations/${id}/clips/${index}/split`),
  splitClip: (id: string, index: number) => req<RunState>(`/generations/${id}/clips/${index}/split`, { method: 'POST' }),
  move: (id: string, projectId: string) => req<GenerationSummary>(`/generations/${id}`, { method: 'PATCH', body: JSON.stringify({ projectId }) }),
  prompts: (id: string) => req<PromptSummary[]>(`/generations/${id}/prompts`),
  prompt: async (id: string, name: string) => {
    const res = await fetch(`/api/generations/${id}/prompts/${encodeURIComponent(name)}`, { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.statusText, res.status);
    return res.text();
  },
  downloadUrl: (id: string) => `/api/generations/${id}/download`,
  retry: (id: string) => req<RunState>(`/generations/${id}/retry`, { method: 'POST' }),
  /** Detener / reanudar un video sin final (hito 5, ADR-052). */
  pause: (id: string) => req<RunState>(`/generations/${id}/pause`, { method: 'POST' }),
  resume: (id: string) => req<RunState>(`/generations/${id}/continue`, { method: 'POST' }),
  /** Música de fondo (hito 5): tracks de assets/music/ y con cuál empieza el selector. */
  music: () => req<MusicListResponse>('/music'),
  musicAudioUrl: (name: string) => `/api/music/${encodeURIComponent(name)}/audio`,
  /** Importar la locución desde un PDF o un Word, como texto o como guion (hito 5, ADR-049). */
  /** Estilos de guion (ADR-072): biblioteca del usuario y el último usado en el proyecto. */
  scriptStyles: (projectId?: string) => req<ScriptStylesResponse>(`/script-styles${projectId ? `?projectId=${projectId}` : ''}`),
  createScriptStyle: (body: { name: string; structure: string }) => req<ScriptStyleInfo>('/script-styles', { method: 'POST', body: JSON.stringify(body) }),
  updateScriptStyle: (id: string, body: { name: string; structure: string }) => req<ScriptStyleInfo>(`/script-styles/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteScriptStyle: (id: string) => req<{ ok: boolean }>(`/script-styles/${id}`, { method: 'DELETE' }),
  importDocument: (body: ImportRequest) => req<ImportResult>('/imports', { method: 'POST', body: JSON.stringify(body) }),
  /** Rehacer audio (hito 5): tramo de locución de Ki y nueva locución de un párrafo. */
  voiceSegment: (id: string, clipIndex: number) => req<VoiceSegment>(`/generations/${id}/clips/${clipIndex}/voice`),
  revoice: (id: string, paragraph: number, body: RevoiceRequest) =>
    req<RunState>(`/generations/${id}/paragraphs/${paragraph}/revoice`, { method: 'POST', body: JSON.stringify(body) }),
  /** Cambiar la música de un video terminado: solo se vuelve a renderizar. */
  changeMusic: (id: string, track: string | null) => req<RunState>(`/generations/${id}/music`, { method: 'POST', body: JSON.stringify({ track }) }),
  /** Entrega (hito 6, ADR-065): logo y ajustes del proyecto, ajuste fino y portada del video, descarga. */
  projectDelivery: (projectId: string) => req<ProjectDelivery>(`/projects/${projectId}/delivery`),
  setProjectDelivery: (projectId: string, settings: Partial<LogoSettings>) =>
    req<ProjectDelivery>(`/projects/${projectId}/delivery`, { method: 'PUT', body: JSON.stringify(settings) }),
  uploadLogo: (projectId: string, fileName: string, data: string) =>
    req<ProjectDelivery>(`/projects/${projectId}/logo`, { method: 'POST', body: JSON.stringify({ fileName, data }) }),
  removeLogo: (projectId: string) => req<ProjectDelivery>(`/projects/${projectId}/logo`, { method: 'DELETE' }),
  videoDelivery: (id: string) => req<VideoDelivery>(`/generations/${id}/delivery`),
  /** Link para compartir el video sin sesión (hito 7, ADR-083). */
  createShare: (id: string) => req<VideoDelivery>(`/generations/${id}/share`, { method: 'POST' }),
  removeShare: (id: string) => req<VideoDelivery>(`/generations/${id}/share`, { method: 'DELETE' }),
  // Publicaciones (hito 9, ADR-101)
  publications: (id: string) => req<PublicationInfo[]>(`/generations/${id}/publications`),
  projectPublications: (id: string) => req<PublicationInfo[]>(`/projects/${id}/publications`),
  publish: (id: string, quality: ExportQuality, logo = false) =>
    req<PublicationInfo>(`/generations/${id}/publications`, { method: 'POST', body: JSON.stringify({ quality, logo }) }),
  republish: (pubId: string) => req<PublicationInfo>(`/publications/${pubId}/refresh`, { method: 'POST' }),
  unpublish: (pubId: string) => req<{ ok: true }>(`/publications/${pubId}`, { method: 'DELETE' }),
  /** Lo propio del video (ADR-066): esquina del logo por clip (null = la del proyecto) y portada. */
  setVideoDelivery: (id: string, body: { clipCorners?: Record<string, ClipLogo | null>; posterClip?: number | null }) =>
    req<VideoDelivery>(`/generations/${id}/delivery`, { method: 'PUT', body: JSON.stringify(body) }),
  playerUrl: (id: string, settings?: LogoSettings, posterSec?: number) =>
    `/api/generations/${id}/player?${settings ? `s=${encodeURIComponent(JSON.stringify(settings))}&` : ''}${posterSec !== undefined ? `t=${posterSec}` : ''}`,
  posterUrl: (id: string, sec: number, width?: number) => `/api/generations/${id}/poster?t=${sec.toFixed(3)}${width ? `&w=${width}` : ''}`,
  /**
   * URL de descarga de un video (ADR-066). Con logo o ajustes propios se pide antes por POST (un token de
   * 10 min); sin ellos, va directo con los del proyecto.
   */
  packageUrl: async (id: string, r: DownloadRequest) => {
    if (!r.logo && !r.settings && !r.cornerAll && !r.quality) return `/api/generations/${id}/package?format=${r.format}`;
    const { token } = await req<{ token: string }>(`/generations/${id}/package`, { method: 'POST', body: JSON.stringify(r) });
    return `/api/generations/${id}/package?token=${token}`;
  },
  /**
   * Descarga con resolución y compresión (hito 7, ADR-085): la pide, espera a que se preparen las versiones
   * reducidas (avance por `onProgress`) y devuelve la URL para bajarla.
   */
  preparePackage: async (kind: 'generations' | 'projects', id: string, r: DownloadRequest, onProgress: (p: number) => void, signal?: { cancelled: boolean }) => {
    const { token, preparing } = await req<{ token: string; preparing: boolean }>(`/${kind}/${id}/package`, { method: 'POST', body: JSON.stringify(r) });
    if (preparing)
      for (;;) {
        if (signal?.cancelled) throw new Error('Cancelado.');
        const st = await req<PackageStatus>(`/${kind}/${id}/package/status?token=${token}`);
        if (st.error) throw new Error(`No se pudo preparar la descarga: ${st.error}`);
        onProgress(st.progress);
        if (st.ready) break;
        await new Promise((ok) => setTimeout(ok, 1500));
      }
    return `/api/${kind}/${id}/package?token=${token}`;
  },
  /**
   * Código para Rise 360 (hito 9, T3 y T3b, ADR-103/104): pide el documento; se publica en segundo plano y queda en
   * «Descargas» (devuelve su fila).
   */
  createRise: (kind: 'generations' | 'projects', id: string, body: CreateRiseRequest) =>
    req<DownloadBatchInfo>(`/${kind}/${id}/rise`, { method: 'POST', body: JSON.stringify(body) }),
  /** SCORM liviano (T4, ADR-108): se publica en segundo plano y queda en «Descargas». */
  createLightScorm: (kind: 'generations' | 'projects', id: string, body: CreateLightScormRequest) =>
    req<DownloadBatchInfo>(`/${kind}/${id}/scorm-light`, { method: 'POST', body: JSON.stringify(body) }),
  /** Peso estimado del final (o de los finales del proyecto) con una resolución y compresión (ADR-084). */
  exportEstimate: (kind: 'generations' | 'projects', id: string, q: ExportQuality) =>
    req<ExportEstimate>(`/${kind}/${id}/export-estimate?height=${q.height}&compression=${q.compression}`),
  /** Descarga de un proyecto: ZIP completo o SCORM 1.2 / 2004 (un SCO por video). */
  projectPackageUrl: async (projectId: string, r: DownloadRequest) => {
    if (!r.logo && !r.settings && !r.cornerAll && !r.quality) return `/api/projects/${projectId}/package?format=${r.format}`;
    const { token } = await req<{ token: string }>(`/projects/${projectId}/package`, { method: 'POST', body: JSON.stringify(r) });
    return `/api/projects/${projectId}/package?token=${token}`;
  },
  /** Subtítulos del final vigente (hito 6): .vtt o .srt; `download` los baja como archivo. */
  subtitlesUrl: (id: string, format: 'vtt' | 'srt', version?: string, download = false) =>
    `/api/generations/${id}/subtitles/${format}?v=${encodeURIComponent(version ?? '')}${download ? '&download=1' : ''}`,
  /** Sonido de un video terminado (hito 6): modo y ajuste en dB; solo ffmpeg. */
  changeSound: (id: string, body: { mode?: SoundMode; gainDb?: number }) =>
    req<RunState>(`/generations/${id}/sound`, { method: 'POST', body: JSON.stringify(body) }),
  /** Sonido de un clip: silenciar, sintetizado o null (el del video). */
  changeClipSound: (id: string, index: number, mode: ClipSoundMode | null) =>
    req<RunState>(`/generations/${id}/clips/${index}/sound`, { method: 'POST', body: JSON.stringify({ mode }) }),
};

const post = <T>(path: string, body?: unknown) => req<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

/** Estudio de temas (hito 2). */
export const themesApi = {
  list: () => req<ThemeDetail[]>('/themes'),
  get: (id: string) => req<ThemeDetail>(`/themes/${id}`),
  create: (brief: ThemeBrief) => post<ThemeDetail>('/themes', brief),
  duplicate: (id: string) => post<ThemeDetail>(`/themes/${id}/duplicate`),
  update: (id: string, body: { brief?: ThemeBrief; style?: ThemeStyle }) => req<ThemeDetail>(`/themes/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id: string) => req<{ ok: boolean }>(`/themes/${id}`, { method: 'DELETE' }),
  addReferences: (id: string, files: { name: string; data: string }[]) => post<ThemeDetail>(`/themes/${id}/references`, { files }),
  removeReference: (id: string, file: string) => req<ThemeDetail>(`/themes/${id}/references/${encodeURIComponent(file)}`, { method: 'DELETE' }),
  propose: (id: string) => post<ThemeDetail>(`/themes/${id}/propose`, {}),
  addCorrection: (id: string, text: string) => post<ThemeDetail>(`/themes/${id}/corrections`, { text }),
  setCorrectionActive: (id: string, cid: string, active: boolean) =>
    req<ThemeDetail>(`/themes/${id}/corrections/${encodeURIComponent(cid)}`, { method: 'PATCH', body: JSON.stringify({ active }) }),
  removeCorrection: (id: string, cid: string) => req<ThemeDetail>(`/themes/${id}/corrections/${encodeURIComponent(cid)}`, { method: 'DELETE' }),
  startTest: (id: string, withClip: boolean) => post<ThemeDetail>(`/themes/${id}/tests`, { withClip }),
  regenerateFrame: (id: string, n: number, key: 'A' | 'B') => post<ThemeDetail>(`/themes/${id}/tests/${n}/frames/${key}/regenerate`),
  clip: (id: string, n: number) => post<ThemeDetail>(`/themes/${id}/tests/${n}/clip`),
  applySuggestions: (id: string, n: number, indices?: number[]) => post<ThemeDetail>(`/themes/${id}/tests/${n}/apply-suggestions`, { indices }),
  save: (id: string, body: { name?: string; description?: string; thumbnailTest?: number }) => post<ThemeDetail>(`/themes/${id}/save`, body),
  /** Tipografías del tema (hito 8, ADR-094). */
  addTypefaces: (id: string, families: string) => post<ThemeDetail>(`/themes/${id}/typefaces`, { families }),
  uploadTypeface: (id: string, body: { family: string; weight: number; fileName: string; data: string }) => post<ThemeDetail>(`/themes/${id}/typefaces/upload`, body),
  updateTypeface: (id: string, family: string, body: { role?: TypefaceRole; weights?: number[]; retry?: boolean }) =>
    req<ThemeDetail>(`/themes/${id}/typefaces/${encodeURIComponent(family)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  removeTypeface: (id: string, family: string) => req<ThemeDetail>(`/themes/${id}/typefaces/${encodeURIComponent(family)}`, { method: 'DELETE' }),
};

/** Suscripción por SSE a un tema del Estudio; reconecta sola. */
export function subscribeTheme(id: string, onTheme: (t: ThemeDetail) => void, onGone: () => void): () => void {
  let es: EventSource | undefined;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    es = new EventSource(`/api/themes/${id}/events`);
    es.onmessage = (ev) => onTheme(JSON.parse(ev.data) as ThemeDetail);
    es.onerror = () => {
      es?.close();
      if (closed) return;
      themesApi.get(id).then(
        (t) => {
          onTheme(t);
          retryTimer = setTimeout(open, 2000);
        },
        () => onGone(),
      );
    };
  };
  open();
  return () => {
    closed = true;
    es?.close();
    if (retryTimer) clearTimeout(retryTimer);
  };
}

/** Reduce una imagen en el navegador (lado mayor ≤ 2048 px, JPEG) y la devuelve como data URL. */
export async function imageToDataUrl(file: File, max = 2048): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * k);
  canvas.height = Math.round(bmp.height * k);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.9);
}

/**
 * Suscripción por SSE al estado de una generación; reconecta sola. Con la pestaña en segundo plano se
 * cierra (libera una de las 6 conexiones por servidor del navegador) y al volver se reabre.
 */
export function subscribe(id: string, onState: (s: RunState) => void, onGone: () => void): () => void {
  let es: EventSource | undefined;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Ya llegó un estado por el canal en vivo: la petición inicial (más vieja) no lo pisa. */
  let live = false;
  const onVisibility = () => {
    if (closed) return;
    if (document.hidden) {
      es?.close();
      es = undefined;
    } else if (!es) {
      api.get(id).then(onState, () => undefined);
      open();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  const open = () => {
    if (document.hidden) return;
    es = new EventSource(`/api/generations/${id}/events`);
    es.onmessage = (ev) => {
      live = true;
      onState(JSON.parse(ev.data) as RunState);
    };
    es.onerror = () => {
      es?.close();
      es = undefined;
      if (closed) return;
      api.get(id).then(
        (s) => {
          onState(s);
          retryTimer = setTimeout(open, 2000);
        },
        () => onGone(),
      );
    };
  };
  // Estado inicial por petición normal: el video se ve aunque el canal en vivo tarde en abrirse (ADR-053).
  api.get(id).then(
    (s) => !closed && !live && onState(s),
    (e: unknown) => !closed && e instanceof ApiError && e.status === 404 && onGone(),
  );
  open();
  return () => {
    closed = true;
    document.removeEventListener('visibilitychange', onVisibility);
    es?.close();
    if (retryTimer) clearTimeout(retryTimer);
  };
}

/** Cola global (hito 5, ADR-045): resumen de los videos en curso y del uso de cada proveedor. */
export const queueApi = {
  get: (all = false) => req<QueueOverview>(`/queue${all ? '?all=1' : ''}`),
};

/**
 * Resumen de la cola por consulta periódica (hito 5): 3 s con la pestaña visible y 20 s en segundo plano.
 * No usa SSE a propósito: el navegador permite solo 6 conexiones abiertas por servidor (HTTP/1.1) entre
 * todas las pestañas, y con varias pestañas abiertas las demás peticiones se quedaban esperando
 * (proyectos que aparecían vacíos hasta reiniciar el navegador).
 */
export function subscribeQueue(onData: (o: QueueOverview) => void, all = false): () => void {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  const tick = async () => {
    if (closed || inFlight) return;
    inFlight = true;
    try {
      onData(await queueApi.get(all));
    } catch {
      /* API reiniciándose: se reintenta en la próxima vuelta */
    } finally {
      inFlight = false;
      if (!closed) timer = setTimeout(tick, document.hidden ? 20_000 : 3000);
    }
  };
  const onVisible = () => {
    if (document.hidden) return;
    if (timer) clearTimeout(timer);
    void tick();
  };
  document.addEventListener('visibilitychange', onVisible);
  void tick();
  return () => {
    closed = true;
    document.removeEventListener('visibilitychange', onVisible);
    if (timer) clearTimeout(timer);
  };
}

/** Mis reglas de pronunciación (hito 5, ADR-048). */
export const pronunciationsApi = {
  list: () => req<PronunciationRuleInfo[]>('/pronunciations'),
  create: (match: string, say: string) => req<PronunciationRuleInfo>('/pronunciations', { method: 'POST', body: JSON.stringify({ match, say }) }),
  update: (id: string, body: { match?: string; say?: string }) => req<PronunciationRuleInfo>(`/pronunciations/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id: string) => req<{ ok: boolean }>(`/pronunciations/${id}`, { method: 'DELETE' }),
};

/** Lotes de descarga (hito 7, ADR-087). */
export const batchesApi = {
  list: (all = false) => req<DownloadBatchInfo[]>(`/download-batches${all ? '?all=1' : ''}`),
  candidates: (projectId: string) => req<BatchCandidate[]>(`/download-batches/candidates?project=${encodeURIComponent(projectId)}`),
  estimate: (videoIds: string[], quality: ExportQuality) => req<ExportEstimate>('/download-batches/estimate', { method: 'POST', body: JSON.stringify({ videoIds, quality }) }),
  create: (body: CreateBatchRequest) => req<DownloadBatchInfo>('/download-batches', { method: 'POST', body: JSON.stringify(body) }),
  retry: (id: string) => req<DownloadBatchInfo>(`/download-batches/${id}/retry`, { method: 'POST' }),
  remove: (id: string) => req<{ ok: boolean }>(`/download-batches/${id}`, { method: 'DELETE' }),
  fileUrl: (id: string) => `/api/download-batches/${id}/file`,
  /** «Actualizar» y links de descarga para el cliente (T5, ADR-111). */
  refresh: (id: string) => req<DownloadBatchInfo>(`/download-batches/${id}/refresh`, { method: 'POST' }),
  createLink: (id: string, body: CreateDownloadLinkRequest) => req<DownloadBatchInfo>(`/download-batches/${id}/links`, { method: 'POST', body: JSON.stringify(body) }),
  updateLink: (linkId: string, body: UpdateDownloadLinkRequest) => req<DownloadBatchInfo>(`/download-links/${linkId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  removeLink: (linkId: string) => req<DownloadBatchInfo>(`/download-links/${linkId}`, { method: 'DELETE' }),
};

/** Revisión del storyboard por el cliente (hito 8, ADR-098). */
export const reviewApi = {
  state: (id: string) => req<VideoReview>(`/generations/${id}/review`),
  createLink: (id: string) => req<VideoReview>(`/generations/${id}/review`, { method: 'POST' }),
  removeLink: (id: string) => req<VideoReview>(`/generations/${id}/review`, { method: 'DELETE' }),
  resolve: (commentId: string, resolved: boolean) => req<VideoReview>(`/review-comments/${commentId}`, { method: 'PATCH', body: JSON.stringify({ resolved }) }),
  activity: (since?: string) => req<ReviewActivityPage>(`/reviews/activity${since ? `?since=${encodeURIComponent(since)}` : ''}`),
  /** Pantalla «Observaciones» (T8, ADR-119). */
  inbox: (projectId?: string, all = false) => req<ReviewInbox>(`/review-comments?${projectId ? `projectId=${encodeURIComponent(projectId)}&` : ''}${all ? 'all=1' : ''}`),
  setStatus: (commentId: string, status: ReviewCommentStatus) => req<{ ok: true }>(`/review-comments/${commentId}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  /** Varias a la vez (ADR-140). */
  setStatusMany: (ids: string[], status: ReviewCommentStatus) => req<{ changed: number }>('/review-comments/status', { method: 'POST', body: JSON.stringify({ ids, status }) }),
  count: () => req<{ pending: number; progress: number }>('/review-comments/count'),
  /** Observaciones de un clip y sugerencia de Opus (T11, ADR-122). */
  clipFeedback: (id: string, index: number) => req<ClipFeedback>(`/generations/${id}/clips/${index}/feedback`),
  clipAdvice: (id: string, index: number) => req<ClipFeedback>(`/generations/${id}/clips/${index}/feedback`, { method: 'POST' }),
};

/** Papelera (hito 9, T3d, ADR-106). */
export const trashApi = {
  list: () => req<TrashResponse>('/trash'),
  count: () => req<{ count: number }>('/trash/count'),
  restore: (kind: 'project' | 'video', id: string) => req<{ projectId: string; unclassified: boolean }>(`/trash/${kind}/${id}/restore`, { method: 'POST' }),
  remove: (kind: 'project' | 'video', id: string) => req<{ ok: true }>(`/trash/${kind}/${id}/delete`, { method: 'POST' }),
  empty: () => req<{ projects: number; videos: number }>('/trash/empty', { method: 'POST' }),
};
