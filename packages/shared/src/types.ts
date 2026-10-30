import type { ThemeId, ThemeInfo } from './theme.js';
import type { VoiceTrialVariant } from './voice-trial.js';

export type GenerationMode = 'mcp' | 'api' | 'mock';

/** Cómo se pide la locución (hito 10, ADR-133): toda en un solo pedido o uno por párrafo. */
export type VoiceMode = 'whole' | 'paragraph';

export interface VoiceOption {
  id: string;
  name: string;
  /** Solo en Higgsfield: 'preset' | 'element'. */
  type?: string;
  previewUrl?: string;
  description?: string;
}

export type RunStatus =
  | 'queued'
  | 'voice'
  | 'timings'
  | 'storyboard'
  | 'keyframes'
  | 'awaiting_approval'
  | 'clips'
  | 'post'
  | 'render'
  | 'done'
  | 'error'
  /** Detenido por el usuario (hito 5): fuera de la cola hasta "Reanudar". */
  | 'paused';

/** Orden de los pasos, para la barra de progreso. */
export const RUN_STEPS: { status: RunStatus; label: string }[] = [
  { status: 'voice', label: 'Locución' },
  { status: 'timings', label: 'Tiempos por palabra' },
  { status: 'storyboard', label: 'Superprompts (Opus)' },
  { status: 'keyframes', label: 'Fotogramas clave' },
  { status: 'awaiting_approval', label: 'Aprobación' },
  { status: 'clips', label: 'Clips de video' },
  { status: 'post', label: 'SFX y congelados' },
  { status: 'render', label: 'Render final' },
];

export type AssetStatus = 'pending' | 'generating' | 'ready' | 'error';

export interface KeyframeState {
  /** K0 = intro; Ki = estado final del clip i. */
  index: number;
  label: string;
  /** Textos exactos que deben aparecer en la imagen. */
  texts: string[];
  prompt: string;
  status: AssetStatus;
  version: number;
  /** Ruta servida por la API (/api/generations/:id/files/...). */
  url?: string;
  error?: string;
  /** Qué se está haciendo ahora con este fotograma (regeneración en curso). */
  activity?: string;
  /** Revisión visual de Opus antes de la aprobación humana. */
  review?: { verdict: 'ok' | 'improve'; issues: string; revisedScene?: string };
  /** Regeneración en curso (hito 5): se guarda para retomarla sola tras un reinicio de la API. */
  pending?: { change?: string; revisedScene?: string; issues?: string; stage: 'rewrite' | 'image' | 'review' };
  /**
   * Fotograma regenerado en un video terminado (ADR-071): la versión actual es una propuesta y esta es la
   * vigente (con la que se hicieron los clips). «Aplicar» rehace los clips afectados; «Descartar» la restaura.
   */
  previous?: KeyframePrevious;
}

/** Versión vigente de un fotograma mientras hay una propuesta sin aplicar (ADR-071). */
export interface KeyframePrevious {
  version: number;
  url?: string;
  /** Relativa a la carpeta de la generación (keyframes/K01_v1.png). */
  path?: string;
  label: string;
  texts: string[];
  prompt: string;
  review?: KeyframeState['review'];
  /** Plano del storyboard de esa versión (Ki, i ≥ 1) o la escena de la intro (K00). */
  shot?: unknown;
  introScene?: string;
}

export interface ClipState {
  index: number;
  title: string;
  startFrame: number;
  /** Frame donde empieza el siguiente segmento IA (o el final). */
  slotEndFrame: number;
  prompt: string;
  status: AssetStatus;
  version: number;
  url?: string;
  /** Frames que entregó el modelo. */
  deliveredFrames?: number;
  ssimStart?: number;
  ssimEnd?: number;
  error?: string;
  /** Versiones de K(i-1) y Ki con que se hizo la versión vigente: al corregir se rehacen solo los clips afectados. */
  builtWith?: [number, number];
  /** Indicación del editor al regenerar este clip (se añade al prompt). */
  note?: string;
  /** task_id de la versión vigente en el proveedor (hito 5): tras un reinicio se sigue consultando. */
  taskId?: string;
  /** Sonido de este clip (hito 6, ADR-059): sin el campo, el del video; 'mute' = silencio; 'synth' = SFX sintetizados. */
  soundMode?: ClipSoundMode;
  /** Sonoridad (LUFS) del audio nativo del modelo en este clip, antes de normalizar; null = sin sonido. */
  soundLufs?: number | null;
}

/**
 * Sonido de los clips de un video (hito 6, ADR-059): 'model' = el audio nativo de MiniMax, normalizado y
 * bajo la voz; 'synth' = los SFX sintetizados en el Mac (los de los hitos 1 a 5); 'none' = sin sonido.
 */
export type SoundMode = 'model' | 'synth' | 'none';
export const SOUND_MODES: readonly SoundMode[] = ['model', 'synth', 'none'];
/** Excepción de un clip respecto del sonido del video. */
export type ClipSoundMode = 'mute' | 'synth';

export interface ParagraphState {
  index: number;
  text: string;
  startSec: number;
  durationSec: number;
  /** Versión de la locución (hito 5): "Rehacer audio" la sube. */
  version?: number;
  /** Texto enviado a la voz si difiere (reglas de pronunciación). */
  spokenText?: string;
}

export interface RunLogEntry {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface RunState {
  id: string;
  createdAt: string;
  mode: GenerationMode;
  /** Proyecto (hito 3, ADR-030). Obligatorio desde el hito 4 (ADR-035): "Sin clasificar" si no tiene uno propio. */
  projectId?: string;
  /** Versión de la que sale (cambio de texto o recreación). */
  parentId?: string | null;
  theme: ThemeId;
  /** Nombre del tema al crear la generación (los temas del Estudio pueden cambiar o borrarse). */
  themeName?: string;
  voiceId: string;
  /** Música de fondo (hito 5, ADR-044): archivo de assets/music/; null = "Sin música". */
  musicTrack?: string | null;
  /** Guion importado (hito 5, ADR-049). */
  script?: GenerationScript;
  /** Sonido de los clips (hito 6, ADR-059). Sin el campo (videos anteriores al hito 6): 'synth'. */
  soundMode?: SoundMode;
  /** Ajuste del sonido del modelo en dB (pasos de 3 dB), sobre la normalización. */
  soundGainDb?: number;
  /**
   * Cómo se pide la locución (hito 10, ADR-133): 'whole' = toda en un solo pedido (cortada por párrafos, sin cambios
   * de tono entre ellos; «Rehacer audio» vuelve a pedir toda); sin el campo = un pedido por párrafo (videos anteriores).
   */
  voiceMode?: VoiceMode;
  text: string;
  status: RunStatus;
  /** Mensaje corto del paso en curso. */
  message: string;
  paragraphs: ParagraphState[];
  voiceUrl?: string;
  durationSec?: number;
  totalFrames?: number;
  keyframes: KeyframeState[];
  clips: ClipState[];
  /** Clips insertados o subidos (portada/cierre) fuera de la locución (hito 6, ADR-073). */
  inserts?: InsertState[];
  finalUrl?: string;
  /** Frames del final: los de la locución más los de los insertos. */
  finalFrames?: number;
  log: RunLogEntry[];
  error?: string;
}

export interface CreateGenerationRequest {
  text: string;
  theme: ThemeId;
  voiceId?: string;
  /** Proyecto donde queda el video (obligatorio desde el hito 4, ADR-035; puede ser "Sin clasificar"). */
  projectId: string;
  /** Recrear (ADR-033): video del que sale. */
  parentId?: string | null;
  /** Música de fondo (hito 5): archivo de assets/music/; null = "Sin música"; sin el campo, la de MUSIC_PATH. */
  musicTrack?: string | null;
  /** Guion importado (hito 5, ADR-049): una fila por párrafo del texto. */
  script?: GenerationScript;
  /** Sonido de los clips (hito 6, ADR-059); sin el campo, el del modelo. */
  soundMode?: SoundMode;
}

/** Un track de assets/music/ (hito 5, ADR-044). */
export interface MusicTrackInfo {
  /** Nombre del archivo ("Corporate 2.mp3"): es lo que se guarda en cada video. */
  name: string;
  /** Nombre para mostrar (sin extensión). */
  title: string;
  durationSec: number;
  /** Sonoridad integrada (LUFS) y ganancia que se le aplica para sonar como el track de referencia. */
  lufs?: number;
  gainDb: number;
}

export interface MusicListResponse {
  tracks: MusicTrackInfo[];
  /** Track de MUSIC_PATH (referencia de volumen), si existe. */
  defaultTrack: string | null;
  /** Con qué empieza el selector: el track del último video del usuario o el de MUSIC_PATH (null = "Sin música"). */
  initial: string | null;
}

/** Cambiar el texto (ADR-033): versión nueva del video con la misma copia del tema, en el mismo proyecto. */
export interface NewVersionRequest {
  text: string;
  voiceId?: string;
}

/** Fila del historial (hito 3). */
export interface GenerationSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  mode: GenerationMode;
  theme: ThemeId;
  themeName?: string;
  /** Voz de ElevenLabs con que se hizo (el nombre sale de la lista de voces). */
  voiceId?: string;
  projectId: string;
  parentId: string | null;
  /** Primeras palabras de la locución. */
  textPreview: string;
  durationSec?: number;
  /** Miniatura: K01 (o K00) de la versión vigente. */
  thumbnailUrl?: string;
  finalUrl?: string;
  /**
   * Lo gastado en USD (hito 11, ADR-145: sin créditos): la suma de sus trabajos; los antiguos de Higgsfield sin USD
   * anotado se convierten con la tarifa del plan Ultra (`PRICE_HIGGSFIELD_CREDIT_USD`).
   */
  costUsd: number;
  /**
   * Publicado (hito 9, T3c, ADR-105): dónde se usan sus publicaciones ('rise', 'scorm', 'manual'). Sin el campo, no
   * está publicado: sus cambios no le llegan a nadie.
   */
  published?: ('manual' | 'rise' | 'scorm')[];
  /** Duplicado de este video (hito 9, T3e, ADR-107). */
  copyOf?: string;
  /** Copia hecha para la prueba de voz (hito 10, T2, ADR-129): con qué variante se locutó. */
  voiceTrial?: VoiceTrialVariant;
}

/** Totales de un conjunto de videos; el costo, en USD (hito 11, ADR-145). */
export interface HistoryTotals {
  videos: number;
  durationSec: number;
  costUsd: number;
}

/** Estado agrupado para el filtro del historial. */
export type HistoryStatus = 'done' | 'awaiting_approval' | 'working' | 'error' | 'paused';

export interface HistoryQuery {
  /** Búsqueda full-text en el texto de la locución (sin tildes; "frase exacta", -excluir, OR). */
  q?: string;
  /** Id del proyecto; vacío = todos. 'none' se sigue aceptando y equivale a "Sin clasificar". */
  project?: string;
  theme?: string;
  status?: HistoryStatus;
  /** Fechas YYYY-MM-DD (incluidas). */
  from?: string;
  to?: string;
  offset?: number;
  limit?: number;
}

export interface HistoryResponse {
  items: GenerationSummary[];
  /** Videos que cumplen los filtros (todas las páginas). */
  total: number;
  totals: HistoryTotals;
  /** Temas presentes en el resultado (para el filtro). */
  themes: { key: string; name: string; count: number }[];
}

/** Proyecto (hito 3, ADR-030): contenedor de videos. */
export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** "Sin clasificar" (hito 4, ADR-035): fijo, no se renombra, archiva ni elimina. */
  unclassified: boolean;
  totals: HistoryTotals;
  /** Videos publicados del proyecto (T3c, ADR-105). */
  published?: number;
  /** Duplicando sus videos en segundo plano (hito 9, T3e, ADR-107): copiados de un total. */
  copying?: { done: number; total: number; failed: number };
  lastVideoAt?: string;
  thumbnailUrl?: string;
  /** Tema, voz y música del último video del proyecto: valores por defecto de un video nuevo (hito 5, ADR-053). */
  defaults?: { theme: ThemeId; voiceId: string; musicTrack: string | null; soundMode?: SoundMode };
  /** Acceso (hito 11, ADR-142): mi papel en el proyecto, su dueño, si es público y con cuántos usuarios se comparte. */
  access: ProjectAccessSummary;
}

// ------------------------------------------------------------------ multiusuario (hito 11, ADR-142)

/**
 * Papel de un usuario en un proyecto: dueño; compartido con él; público (lo ven todos los usuarios de la app); o
 * admin (ve y gestiona los de todos). Con cualquiera de ellos se gestiona todo el proyecto; lo irreversible (papelera,
 * restaurar, archivar, eliminar) y compartir quedan para el dueño (compartir, también para el admin).
 */
export type ProjectRole = 'owner' | 'shared' | 'public' | 'admin';

/** Usuario tal como se muestra en otras pantallas (dueño de un proyecto, con quién se comparte). */
export interface UserRef {
  id: string;
  name: string | null;
  email: string;
  /** false = suspendido. */
  active: boolean;
}

export interface ProjectAccessSummary {
  role: ProjectRole;
  owner: UserRef;
  public: boolean;
  /** Usuarios con los que se comparte. */
  shared: number;
}

/** GET /projects/:id/access: con quién se comparte y si es público. */
export interface ProjectAccessState {
  projectId: string;
  owner: UserRef;
  role: ProjectRole;
  /** Puede cambiar con quién se comparte (el dueño o el admin). */
  canShare: boolean;
  public: boolean;
  publicAt: string | null;
  shares: { user: UserRef; sharedBy: UserRef; createdAt: string }[];
  /** Usuarios activos con los que se puede compartir (todos menos el dueño). */
  candidates: UserRef[];
  /** "Sin clasificar" no se comparte. */
  unclassified: boolean;
}

/** PUT /projects/:id/access. */
export interface ProjectAccessRequest {
  userIds: string[];
  public: boolean;
}

/** POST /projects/:id/owner (admin): pasar el proyecto a otro dueño. */
export interface ProjectOwnerRequest {
  ownerId: string;
}

/** POST /users/:id/transfer (admin): pasar todos los proyectos de un usuario a otro (o al admin). */
export interface UserTransferRequest {
  toUserId: string;
}

export interface UserTransferResponse {
  projects: number;
  /** Proyecto creado con los videos de su «Sin clasificar» («Sin clasificar de <nombre>»), si tenía videos. */
  unclassifiedProjectId?: string;
  videos: number;
}

export interface ProjectsResponse {
  /** "Sin clasificar" primero y después el resto, del más reciente al más antiguo. */
  projects: ProjectSummary[];
  /** Id de "Sin clasificar" (hito 4, ADR-035). */
  unclassifiedId: string;
  /** Todos mis videos. */
  all: HistoryTotals;
}

/** Proyecto del sistema donde quedan los videos sin proyecto propio (hito 4, ADR-035). */
export const UNCLASSIFIED_SYSTEM = 'unclassified';
export const UNCLASSIFIED_NAME = 'Sin clasificar';

/** DELETE /projects/:id cuando el proyecto aún tiene videos y no se pidió moverlos (409). */
export interface ProjectNotEmpty {
  message: string;
  videos: number;
}

export interface PromptSummary {
  name: string;
  kind: string;
  version: number;
  size: number;
  createdAt: string;
}

export interface RegenerateKeyframeRequest {
  /** Indicación opcional: Opus reescribe la escena para aplicarla. */
  note?: string;
  /** Usar la escena corregida que propuso la revisión visual de Opus. */
  useSuggestion?: boolean;
}

export interface AppInfo {
  mode: GenerationMode;
  themes: ThemeInfo[];
  defaultVoiceId: string;
  higgsfield?: { connected: boolean; authUrl?: string; error?: string };
}

// ------------------------------------------------------------------ usuarios (hito 3)

export type UserRole = 'admin' | 'user';

/** Usuario con sesión iniciada (GET /api/auth/me). */
export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
}

/** Fila de la pantalla de usuarios del admin. */
export interface UserSummary extends AuthUser {
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  generations: number;
  /** Proyectos de los que es dueño (sin «Sin clasificar» ni los eliminados; hito 11). */
  projects: number;
  themes: number;
  /** Costo en USD (modo API y Opus). */
  costUsd: number;
}

export interface CreateUserRequest {
  email: string;
  name?: string;
  password: string;
  role: UserRole;
}

// ------------------------------------------------------------------ cola global (hito 5, ADR-045)

export type QueueResourceId = 'elevenlabs' | 'anthropic' | 'openai' | 'minimax' | 'higgsfield' | 'ffmpeg';

/** Uso de un recurso de la cola: huecos ocupados / capacidad, uso por minuto y pausa. */
export interface QueueResourceInfo {
  resource: QueueResourceId;
  label: string;
  running: number;
  /** Capacidad actual (baja sola ante un 429 y se recupera hasta `max`). */
  capacity: number;
  max: number;
  perMinute?: number;
  usedLastMinute: number;
  /** Trabajos esperando turno (de todos los usuarios). */
  queued: number;
  /** Pausado por fallos seguidos del proveedor hasta esta hora (se reanuda solo). */
  pausedUntil?: string;
}

export type QueueVideoState = 'queued' | 'working' | 'awaiting' | 'error' | 'paused';

/** Un video en curso en la vista "Cola" y en las tarjetas. */
export interface QueueVideo {
  id: string;
  projectId: string;
  projectName: string;
  themeName?: string;
  status: RunStatus;
  state: QueueVideoState;
  message: string;
  createdAt: string;
  /** Posición en la cola global (1 = se atiende primero); solo si tiene trabajos pendientes. */
  position?: number;
  tasks: { queued: number; running: number; retrying: number };
  /** Trabajos por recurso (en cola / en marcha). */
  byResource: Partial<Record<QueueResourceId, { queued: number; running: number }>>;
  keyframes: { ready: number; total: number };
  clips: { ready: number; total: number };
  error?: string;
  textPreview: string;
  /** Miniatura (K01 vigente o K00). */
  thumbnailUrl?: string;
}

export interface QueueOverview {
  counts: Record<QueueVideoState, number>;
  videos: QueueVideo[];
  resources: QueueResourceInfo[];
}

// ------------------------------------------------------------------ rehacer audio (hito 5, ADR-048)

/** Regla de pronunciación del usuario: dónde aparece `match` en el texto, la voz recibe `say`. */
export interface PronunciationRuleInfo {
  id: string;
  match: string;
  say: string;
  note?: string;
  createdAt: string;
}

/**
 * «Aplicar la regla a este video» (hito 7, ADR-082): qué cambiaría al fijar en un video existente la animación
 * de las imágenes según cuántas haya (1 → video; 2 → video + foto; 3 → video + foto + video; 4 → todas fotos).
 */
export interface MediaRulePlan {
  /** El tema del video usa fotos/video en marcos (si no, no hay nada que aplicar). */
  available: boolean;
  /** Regla de la copia del tema del video. */
  rule: 'opus' | 'byCount';
  /** Clips cuya asignación video/foto cambia ("VFVF" → "FFFF"). */
  changes: { clip: number; before: string; after: string }[];
  /** Clips con algún marco de video que ya cumplen la regla (se pueden rehacer con el prompt nuevo, ADR-081). */
  videoClips: number[];
  /** Por qué no se puede aplicar ahora (video sin terminar, propuestas sin aplicar…). */
  blocked?: string;
}

/** Tramo de locución de un fotograma (Ki ↔ clip i) para el pop-up "Rehacer audio". */
export interface VoiceSegment {
  clipIndex: number;
  fromSec: number;
  toSec: number;
  voiceUrl: string;
  paragraphs: {
    index: number;
    text: string;
    version: number;
    spokenText?: string;
    startSec: number;
    durationSec: number;
    /**
     * `index`: índice de la palabra en toda la locución; `gapAfter`: silencio hasta la palabra siguiente (s), también
     * si es la primera del párrafo siguiente; sin el campo, es la última de la locución (pausa entre palabras, ADR-164).
     */
    words: { word: string; start: number; end: number; inSegment: boolean; index: number; gapAfter?: number }[];
  }[];
  /** Reglas del usuario que aparecen en estos párrafos. */
  rules: PronunciationRuleInfo[];
}

/** Pausa entre dos palabras (ADR-164): después de la palabra `afterWord` (índice global), `deltaSec` más (o menos). */
export interface PauseRequest {
  afterWord: number;
  deltaSec: number;
}

export interface RevoiceRequest {
  /** Texto literal nuevo del párrafo (cambia también el texto del video). */
  text?: string;
  /** Indicación en lenguaje natural ("pronunciaste mal IAAS"): Opus la convierte en reglas de pronunciación. */
  instruction?: string;
  /** Guardar las reglas que proponga Opus para mis próximos videos. */
  saveRules?: boolean;
}

// ------------------------------------------------------------------ importar PDF o Word (hito 5, ADR-049)

/** Una fila de un guion: la locución (literal) y, si el guion la trae, la escena y la expresión. */
export interface ScriptRow {
  /** Locución literal de la fila (un párrafo del video). */
  voice: string;
  /** Descripción gráfica de la escena: manda en los planos de este tramo, con el formato del tema. */
  scene?: string;
  /** Expresión o tono de la locución ("entusiasta", "pausado"). */
  expression?: string;
  /** Composición o layout sugerido. */
  layout?: string;
  /** Etiqueta de tono para ElevenLabs v3 (en inglés, p. ej. "excited"), derivada de la expresión. */
  voiceTag?: string;
  /** La locución aparece tal cual en el documento. */
  verified?: boolean;
}

export interface GenerationScript {
  rows: ScriptRow[];
  /** Cómo explicó el usuario la estructura del guion. */
  structure?: string;
  /** Archivo de origen. */
  source?: string;
}

export type ImportMode = 'text' | 'script';

export interface ImportRequest {
  fileName: string;
  /** Archivo en base64 (PDF o .docx). */
  data: string;
  mode: ImportMode;
  /** Guion: cómo está armado ("en la tabla, la columna 1 es la locución y la 2 la escena"). */
  structure?: string;
  /** Estilo de guion usado (ADR-072): el proyecto lo recuerda para la próxima importación. */
  styleId?: string;
  projectId?: string;
}

/** Estilo de guion guardado (ADR-072): cómo está armado un PDF o Word de guion. */
export interface ScriptStyleInfo {
  id: string;
  name: string;
  structure: string;
  updatedAt: string;
  /** Estilo del dueño de un proyecto compartido (hito 11, ADR-142): se usa en ese proyecto, no se edita. */
  ownerName?: string;
}

/** Estilos del usuario y el último usado en el proyecto (se propone por defecto). */
export interface ScriptStylesResponse {
  styles: ScriptStyleInfo[];
  lastUsedId?: string;
}

export interface ImportResult {
  mode: ImportMode;
  /** Locución lista para el formulario: un párrafo por fila (guion) o por párrafo del documento (texto). */
  text: string;
  script?: GenerationScript;
  warnings: string[];
  pages?: number;
}

// ------------------------------------------------------------------ costos (hito 6, ADR-069)

/** Costo de una unidad de trabajo: créditos de Higgsfield (MCP) o USD (API, y Opus en ambos). */
export interface CostUnit {
  usd?: number;
  /** Trabajos medidos de los que sale el promedio (sin el campo: precio fijo de la configuración). */
  samples?: number;
}

/**
 * Costos unitarios para avisar antes de gastar (GET /api/costs/units): por imagen, por clip, por 1.000
 * caracteres de locución y por llamada a Opus. Sin el campo: aún no hay con qué estimar.
 */
export interface CostUnits {
  mode: GenerationMode;
  image?: CostUnit;
  clip?: CostUnit;
  tts1k?: CostUnit;
  llm?: CostUnit;
}

// ------------------------------------------------------------------ insertos (hito 6, ADR-073)

/** Locución durante un inserto: pausa (la voz se detiene y sigue después) o un texto nuevo locutado. */
export type InsertVoice = 'pause' | 'text';
/** Cómo se acomoda un video subido que no es 16:9: con bandas, recortado o estirado. */
export type InsertFit = 'contain' | 'cover' | 'stretch';

/**
 * Clip fuera de la locución (ADR-073): generado (MiniMax, del fotograma Kn al mismo Kn, entre dos clips o en
 * los extremos) o subido (portada o cierre, solo al principio o al final). El video se alarga lo que dure.
 */
export interface InsertState {
  /** 1, 2, … (en el logo por clip y la portada va como índice negativo: -id). */
  id: number;
  kind: 'generated' | 'upload';
  /** Va después del clip `after` (0 = al principio, n = al final). */
  after: number;
  status: AssetStatus;
  version: number;
  /** Clip generado o video subido (recortado y ajustado), para verlo en la app. */
  url?: string;
  error?: string;
  /** Generado: indicación del movimiento. */
  note?: string;
  taskId?: string;
  /** Frames que entregó el modelo (generado) o del recorte (subido). */
  deliveredFrames?: number;
  /** Frames que ocupa en el final. */
  frames?: number;
  voice: InsertVoice;
  /** Locución del inserto (voice = 'text'). */
  text?: string;
  /** Duración de esa locución (s) y sus tiempos por palabra (para los subtítulos). */
  voiceSec?: number;
  voiceWords?: { word: string; start: number; end: number }[];
  upload?: InsertUpload;
  soundLufs?: number | null;
  /**
   * Transición generada de un video subido (ADR-074): en la portada va después (de su último cuadro al
   * primer fotograma del clip01); en el cierre, antes (del último cuadro del último clip a su primer cuadro).
   */
  transition?: InsertTransition;
}

export interface InsertTransition {
  /**
   * Va en el final (hito 7, ADR-086). false = desactivada: se conserva (reactivarla no gasta) pero el final se une
   * sin ella. Sin el campo, activa.
   */
  enabled?: boolean;
  status: AssetStatus;
  version: number;
  url?: string;
  error?: string;
  taskId?: string;
  deliveredFrames?: number;
  note?: string;
}

export interface InsertUpload {
  fileName: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  hasAudio: boolean;
  /** Recorte (s) dentro del video subido. */
  trimStart: number;
  trimEnd: number;
  fit: InsertFit;
  /** Conservar su audio (normalizado) en el final. */
  keepAudio: boolean;
}

export interface InsertRequest {
  kind: 'generated' | 'upload';
  after: number;
  voice: InsertVoice;
  text?: string;
  note?: string;
  /** Subido: el archivo en base64 (MP4, MOV o WebM; hasta 60 MB). */
  fileName?: string;
  data?: string;
  trimStart?: number;
  trimEnd?: number;
  fit?: InsertFit;
  keepAudio?: boolean;
  /** Subido: transición animada de 5 s con el clip vecino (ADR-074). */
  transition?: boolean;
}

// ─── Papelera (hito 9, T3d, ADR-106) ──────────────────────────────────────────────────────────────────

/** Días que un proyecto o video pasa en la papelera antes de eliminarse solo. */
export const TRASH_RETENTION_DAYS = 180;

export interface TrashedProject {
  id: string;
  name: string;
  /** Videos que se fueron con él. */
  videos: number;
  thumbnailUrl?: string;
  trashedAt: string;
  /** Cuándo se elimina solo. */
  expiresAt: string;
}

export interface TrashedVideo {
  summary: GenerationSummary;
  /** Proyecto de donde salió (y si ya no existe o está en la papelera, adónde vuelve: «Sin clasificar»). */
  projectName: string;
  projectGone: boolean;
  trashedAt: string;
  expiresAt: string;
}

export interface TrashResponse {
  projects: TrashedProject[];
  videos: TrashedVideo[];
}

// ─── Duplicar (hito 9, T3e, ADR-107) ──────────────────────────────────────────────────────────────────

/** Duplicar un video: en el mismo proyecto (sin `projectId`) o en otro; toma el logo del proyecto donde queda. */
export interface DuplicateVideoRequest {
  projectId?: string;
}

/** Duplicar un proyecto: el proyecto nuevo sale al instante y sus videos se copian en segundo plano. */
export interface DuplicateProjectResponse {
  project: ProjectSummary;
  /** Videos que se copian. */
  videos: number;
  /** Videos que no se copian porque se están generando. */
  skipped: number;
}

/** «Dividir en dos» un clip (hito 10, T3, ADR-130): si se puede y dónde iría el corte. */
export interface ClipSplitInfo {
  index: number;
  available: boolean;
  /** Por qué no se puede (si no se puede). */
  reason?: string;
  /** Duración del tramo del clip (clip + congelado) y mínimo para dividirlo. */
  slotSec: number;
  minSec: number;
  /** Palabra donde empieza el segundo clip, su segundo en la locución y cuánto dura cada mitad. */
  cutWord?: string;
  cutSec?: number;
  firstSec?: number;
  secondSec?: number;
}

