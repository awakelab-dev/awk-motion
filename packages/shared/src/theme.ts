import { z } from 'zod';

/**
 * Tema visual serializable (hito 2): lo que antes vivía como código en packages/styles
 * ahora es un dato que se guarda en storage/themes/<id>/theme.json. Los 3 temas base
 * siguen en código (BASE_THEMES) como semilla de solo lectura.
 */

/** Nombres de los generadores de apps/api/src/media/sfx.ts. */
export const SFX_NAMES = ['sweep', 'whoosh', 'impact', 'ping', 'riser', 'shatter', 'sparkle', 'pulse', 'pop', 'bubble', 'tick'] as const;
export const SfxNameSchema = z.enum(SFX_NAMES);
export type SfxName = z.infer<typeof SfxNameSchema>;

/** Id de tema: los base ('dark' | 'light' | 'pastel') o uno creado en el Estudio (slug ASCII). */
export type ThemeId = string;
export const BASE_THEME_IDS = ['dark', 'light', 'pastel'] as const;
export type BaseThemeId = (typeof BASE_THEME_IDS)[number];
export const isBaseThemeId = (v: unknown): v is BaseThemeId => (BASE_THEME_IDS as readonly unknown[]).includes(v);
/** Máximo de imágenes de referencia que se pasan a GPT Image por fotograma. */
export const MAX_REFERENCES_IN_PROMPT = 4;

export const THEME_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export const ThemeInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** Colores para la vista previa en la UI. */
  swatches: z.array(z.string()),
});
export type ThemeInfo = z.infer<typeof ThemeInfoSchema> & {
  /** 'base' = en código (solo lectura); 'custom' = creado en el Estudio. */
  origin?: 'base' | 'custom';
  /** Miniatura (frame A de la prueba elegida), servida por la API. */
  thumbnailUrl?: string;
  /** Tema del dueño de un proyecto compartido (hito 11, ADR-142): se usa en ese proyecto, sin editarlo. */
  ownerName?: string;
};

export const ThemeSfxSchema = z.object({
  opener: SfxNameSchema.describe('Sonido de arranque de cada clip (transición).'),
  accents: z.array(SfxNameSchema).describe('De 3 a 4 sonidos que se reparten sobre los picos de movimiento.'),
  hit: SfxNameSchema.describe('Sonido para el pico de movimiento más fuerte.'),
});

/**
 * Tipografía del tema (hito 8, A2, ADR-094): una fuente real (Google Fonts o un .ttf/.otf subido) con su rol
 * y sus pesos, y su lámina (PNG neutral con el alfabeto, la Ñ, números, tildes y signos en cada peso), que va
 * a GPT Image como referencia tipográfica en los fotogramas con texto. La gestiona la API, no Opus.
 */
export const TypefaceRoleSchema = z.enum(['headings', 'body', 'both']);
export type TypefaceRole = z.infer<typeof TypefaceRoleSchema>;
export const TypefaceSchema = z.object({
  family: z.string().trim().min(2).max(60),
  source: z.enum(['google', 'upload']),
  role: TypefaceRoleSchema,
  /** Pesos pedidos (400, 700, 800…); los que la fuente no tiene se cambian por el más cercano. */
  weights: z.array(z.number().int().min(100).max(900)).min(1).max(4),
  /** Pesos con archivo y su nombre dentro de tipografias/fuentes/. */
  files: z.array(z.object({ weight: z.number().int(), file: z.string() })).default([]),
  /** Lámina dentro de tipografias/ (PNG). */
  sheet: z.string().optional(),
  /** Formato de la lámina con que se dibujó: si cambia el formato, se vuelve a dibujar sola (sin costo). */
  format: z.number().int().optional(),
  status: z.enum(['generating', 'ready', 'error']),
  error: z.string().optional(),
  updatedAt: z.string(),
});
export type Typeface = z.infer<typeof TypefaceSchema>;
/** Formato vigente de la lámina (2: con la fila de letras clave en grande). */
export const SPECIMEN_FORMAT = 2;
/** Hasta 3 fuentes por tema. */
export const MAX_TYPEFACES = 3;

export const ThemeStyleSchema = z.object({
  info: ThemeInfoSchema,
  videoBible: z.string().describe('Bible de video (MiniMax), idéntica en todos los clips. Empieza por "STYLE BIBLE".'),
  imageBible: z.string().describe('Bible de fotograma (GPT Image 2.5). Empieza por "Single still frame from…".'),
  clipBible: z.string().describe('Bible corta para los prompts de clip: el look ya viene en los fotogramas.'),
  avoid: z.string().describe('Lista AVOID del estilo para MiniMax, separada por comas.'),
  soundHint: z.string().describe('Pista de SFX para el bloque SOUND del prompt.'),
  usesMediaFrames: z.boolean().describe('Si el estilo usa fotos/video reales en marcos (criterio imagen/video).'),
  /**
   * Animación de las imágenes (ADR-080): 'opus' (o sin el campo) = la decide Opus con las notas del tema;
   * 'byCount' = según cuántas tenga el fotograma (1 → video; 2 → video + foto; 3 → video + foto + video;
   * 4 → todas fotos), fijada por el código después del storyboard. Lo elige el usuario, no Opus.
   */
  mediaFrameRule: z.enum(['opus', 'byCount']).optional().describe('Animación de las imágenes: la decide Opus o según cuántas haya.'),
  /**
   * «Colores planos» (ADR-137): alisa el moteado que deja GPT Image en las superficies grandes de un solo color (letras
   * gruesas, fondos, bandas) en cada fotograma, después de generarlo. Lo elige el usuario, no Opus.
   */
  flatColors: z.boolean().optional().describe('Alisar el moteado de los colores planos de los fotogramas.'),
  /** Tipografías del tema con sus láminas (ADR-094). Las elige el usuario, no Opus. */
  typefaces: z.array(TypefaceSchema).max(MAX_TYPEFACES).optional(),
  directorNotes: z.string().describe('STYLE NOTES: notas de dirección que prevalecen sobre los principios generales.'),
  imagery: z.string().describe('Qué imágenes dan riqueza a cada fotograma en este estilo (principio RICHNESS).'),
  sfx: ThemeSfxSchema,
});
export type ThemeStyle = z.infer<typeof ThemeStyleSchema>;
export type MediaFrameRule = NonNullable<ThemeStyle['mediaFrameRule']>;

// ------------------------------------------------------------------ Estudio de temas

/**
 * Corrección del tema pedida a Opus (ADR-042). Se guardan todas en el brief: mandan sobre la
 * descripción donde la contradicen, y la más reciente manda sobre las anteriores. Se pueden
 * desactivar o eliminar; entonces el tema queda pendiente de regenerar.
 */
export const ThemeCorrectionSchema = z.object({
  id: z.string(),
  text: z.string().trim().min(3).max(2000),
  active: z.boolean(),
  createdAt: z.string(),
  /** Versión del tema en la que Opus la aplicó por última vez. */
  appliedInVersion: z.number().int().optional(),
  /** Cómo la aplicó Opus (en español, una frase). */
  how: z.string().optional(),
});
export type ThemeCorrection = z.infer<typeof ThemeCorrectionSchema>;

/** Lo que el usuario escribe en el formulario del Estudio. */
export const ThemeBriefSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().min(20).max(6000),
  palette: z.string().trim().max(500).optional(),
  typography: z.string().trim().max(500).optional(),
  /** photos = fotos/video reales en marcos; objects = solo objetos/ilustración; auto = lo decide Opus. */
  imageryMode: z.enum(['auto', 'photos', 'objects']).default('auto'),
  /** Historial de correcciones (ADR-042). Lo gestiona la API; un PATCH del brief no lo cambia. */
  corrections: z.array(ThemeCorrectionSchema).optional(),
  /** Firma de la descripción, correcciones activas y referencias con que Opus hizo la versión vigente. */
  applied: z.object({ signature: z.string(), version: z.number().int(), at: z.string() }).optional(),
});
export type ThemeBrief = z.infer<typeof ThemeBriefSchema>;

/** Correcciones activas, en orden (la última manda). */
export const activeCorrections = (brief: ThemeBrief | undefined): ThemeCorrection[] => (brief?.corrections ?? []).filter((c) => c.active);

/**
 * Firma de lo que Opus usa para proponer el tema: descripción, opciones, correcciones activas y
 * referencias (no el nombre). Si no coincide con `applied.signature`, el tema está pendiente de regenerar.
 */
export function briefSignature(brief: ThemeBrief, referenceFiles: string[]): string {
  return JSON.stringify({
    d: brief.description.trim(),
    p: brief.palette?.trim() ?? '',
    t: brief.typography?.trim() ?? '',
    i: brief.imageryMode,
    c: activeCorrections(brief).map((c) => [c.id, c.text.trim()]),
    r: [...referenceFiles].sort(),
  });
}

/** El tema vigente no refleja la descripción, las correcciones o las referencias actuales. */
export function themeOutOfSync(brief: ThemeBrief | undefined, referenceFiles: string[]): boolean {
  if (!brief?.applied) return false; // temas anteriores a ADR-042: no se sabe; no se avisa
  return brief.applied.signature !== briefSignature(brief, referenceFiles);
}

export interface ThemeReference {
  /** Nombre del archivo normalizado dentro de referencias/ (ref_01.jpg…). */
  file: string;
  originalName: string;
  /** Referencia de Higgsfield (media_id) en caché; se vuelve a subir si falta. */
  mediaId?: string;
  url?: string;
}

export type ThemeTestStatus = 'queued' | 'frames' | 'review' | 'clip' | 'post' | 'done' | 'error';

export interface ThemeTestFrame {
  key: 'A' | 'B';
  label: string;
  texts: string[];
  prompt: string;
  status: 'pending' | 'generating' | 'ready' | 'error';
  version: number;
  url?: string;
  error?: string;
  activity?: string;
  review?: { verdict: 'ok' | 'improve'; issues: string; revisedScene?: string };
}

/** Campos del ThemeStyle que la revisión del Estudio puede proponer cambiar. */
export const STYLE_TEXT_FIELDS = ['videoBible', 'imageBible', 'clipBible', 'avoid', 'soundHint', 'directorNotes', 'imagery'] as const;
export type StyleTextField = (typeof STYLE_TEXT_FIELDS)[number];

export interface StyleSuggestion {
  field: StyleTextField;
  reason: string;
  /** Texto completo que sustituye al campo. */
  value: string;
  applied?: boolean;
}

/** Revisión visual de una prueba del Estudio: por frame + cambios aplicables al tema. */
export const StudioReviewSchema = z.object({
  reviews: z.array(
    z.object({
      index: z.number().int().describe('0 = frame A (portada), 1 = frame B (enumeración).'),
      verdict: z.enum(['ok', 'improve']),
      issues: z.string().describe('Qué falla, en español, en una o dos frases. Vacío si verdict=ok.'),
    }),
  ),
  summary: z.string().describe('Valoración general del tema en español (2-3 frases): qué funciona y qué no, y fidelidad a la descripción y a las referencias.'),
  suggestions: z
    .array(
      z.object({
        field: z.enum(STYLE_TEXT_FIELDS),
        reason: z.string().describe('Por qué, en español, en una frase.'),
        value: z.string().describe('Texto COMPLETO nuevo del campo (en inglés, mismas reglas que el original), no solo el cambio.'),
      }),
    )
    .describe('Cambios concretos en los campos del tema que corrigen los problemas; vacío si el tema está bien.'),
});
export type StudioReview = z.infer<typeof StudioReviewSchema>;

export interface ThemeTestClip {
  prompt: string;
  status: 'pending' | 'generating' | 'ready' | 'error';
  version: number;
  url?: string;
  deliveredFrames?: number;
  /** Versiones de los frames con que se hizo ("A v1 → B v2"). */
  fromFrames?: string;
  ssimStart?: number;
  ssimEnd?: number;
  error?: string;
}

/** Una prueba estándar: pruebas/<n>/ con los frames A y B, el clip A→B y los prompts usados. */
export interface ThemeTest {
  n: number;
  createdAt: string;
  status: ThemeTestStatus;
  message: string;
  /** Versión del tema (theme.version) con la que se hizo. */
  themeVersion: number;
  frames: ThemeTestFrame[];
  /** Si la prueba incluye el clip A→B (se puede lanzar después). */
  withClip: boolean;
  clip: ThemeTestClip;
  reviewSummary?: string;
  suggestions?: StyleSuggestion[];
  error?: string;
}

/** theme.json de un tema del Estudio. */
export interface StoredTheme {
  id: string;
  /** Dueño (hito 3): cada usuario ve solo sus temas. */
  ownerId?: string;
  status: 'draft' | 'saved';
  /** Sube cada vez que cambia el ThemeStyle; cada prueba guarda la versión que usó. */
  version: number;
  createdAt: string;
  updatedAt: string;
  brief: ThemeBrief;
  style: ThemeStyle;
  references: ThemeReference[];
  /** Tema del que se duplicó (id). */
  basedOn?: string;
  /** Prueba cuyo frame A es la miniatura. */
  thumbnailTest?: number;
  /** Notas de Opus al proponer el tema. */
  proposalNotes?: string;
  /** Qué está haciendo Opus ahora (proponer el tema). */
  activity?: string;
  tests: ThemeTest[];
}

/** Vista de un tema para la UI (base o del Estudio). */
export interface ThemeDetail {
  id: string;
  origin: 'base' | 'custom';
  readOnly: boolean;
  status: 'draft' | 'saved';
  version: number;
  style: ThemeStyle;
  brief?: ThemeBrief;
  references: ThemeReference[];
  tests: ThemeTest[];
  basedOn?: string;
  thumbnailUrl?: string;
  thumbnailTest?: number;
  proposalNotes?: string;
  activity?: string;
  updatedAt?: string;
}

/** Respuesta de Opus al proponer un tema. */
export const ThemeProposalSchema = z.object({
  style: ThemeStyleSchema.omit({ info: true, mediaFrameRule: true, flatColors: true, typefaces: true }).extend({
    description: z.string().describe('Descripción corta del tema en español para el selector (máx. 120 caracteres).'),
    swatches: z.array(z.string()).describe('De 4 a 6 colores hex (#RRGGBB) del tema, del fondo al acento.'),
  }),
  notes: z.string().describe('En español, 2-4 frases: qué se tomó de las referencias y qué decisiones se tomaron.'),
  corrections: z
    .array(
      z.object({
        number: z.number().int().describe('Número de la corrección en la lista CLIENT CORRECTIONS.'),
        how: z.string().describe('En español, una frase: qué campos cambiaste y cómo para cumplirla (o por qué no fue posible).'),
      }),
    )
    .describe('Una entrada por cada corrección de la lista CLIENT CORRECTIONS; vacío si no hay correcciones.'),
});
export type ThemeProposal = z.infer<typeof ThemeProposalSchema>;

/**
 * Contenido estándar de la prueba: idéntico para todo tema, para poder compararlos.
 * Incluye una palabra con tilde ("síntesis") para vigilar las erratas del español.
 */
export const STANDARD_TEST = {
  titleA: 'LOREM IPSUM',
  subtitleA: 'Dolor sit amet · síntesis',
  titleB: 'Lorem ipsum',
  items: ['Dolor', 'Consectetur', 'Adipiscing'],
} as const;
