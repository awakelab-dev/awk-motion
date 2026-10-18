import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Raíz del monorepo (apps/api/src/config → ../../../..). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const rootEnv = resolve(REPO_ROOT, '.env');
if (existsSync(rootEnv)) loadDotenv({ path: rootEnv, quiet: true });

const opt = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const optNum = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? Number(v) : undefined))
  .pipe(z.number().nonnegative().optional());

export const EnvSchema = z
  .object({
    GENERATION_MODE: z.enum(['mcp', 'api', 'mock']).default('mcp'),
    PORT: z.coerce.number().default(3001),
    WEB_ORIGIN: z.string().default('http://localhost:5173'),
    /**
     * Otros dominios en los que responde esta instalación (hito 12, ADR-151), separados por comas: se aceptan como
     * `Origin` de las peticiones que cambian algo (observaciones desde un link de revisión ya enviado) y en CORS.
     * Los links nuevos salen siempre con WEB_ORIGIN.
     */
    WEB_ORIGIN_ALIASES: z
      .string()
      .optional()
      .transform((v) => (v ?? '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean))
      .pipe(z.array(z.string().regex(/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i, 'cada alias es un origen: https://dominio'))),
    STORAGE_DIR: z.string().default('storage'),
    /**
     * Marca de esta instalación (hito 12, ADR-150): carpeta `brands/<BRAND>/` de la raíz del repo. Sin la línea,
     * la identidad neutra de ADR-008, la de antes del hito 12.
     */
    BRAND: opt.pipe(z.string().regex(/^[a-z0-9-]+$/, 'solo minúsculas, números y guiones').optional()),

    // Base de datos y sesiones (hito 3)
    DATABASE_URL: z.string({ error: 'Falta DATABASE_URL (ver .env.example; la BD se levanta con pnpm db:up)' }).min(1, 'Falta DATABASE_URL'),
    /** Días que dura una sesión sin actividad. */
    SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    /** Cookie solo por HTTPS (false en local). */
    COOKIE_SECURE: z.stringbool().default(false),
    /** Track por defecto y referencia de volumen de la música (hito 5, ADR-044). */
    MUSIC_PATH: z.string().default('assets/music/Inspiring.mp3'),
    /** Carpeta de los tracks del selector (por defecto, la de MUSIC_PATH). */
    MUSIC_DIR: opt,
    /** Igualar la sonoridad de cada track con la del de MUSIC_PATH (LUFS), con un ajuste máximo de ±MUSIC_MAX_GAIN_DB. */
    MUSIC_NORMALIZE: z.stringbool().default(true),
    MUSIC_MAX_GAIN_DB: z.coerce.number().min(0).max(30).default(12),
    /**
     * Sonido nativo de los clips (hito 6, ADR-059): cada clip se normaliza a esta sonoridad (LUFS; −18,4 es la
     * media de los SFX sintetizados de los hitos 1 a 5) con un ajuste máximo de ±MODEL_SOUND_MAX_GAIN_DB, y
     * se mezcla a 0.3 como los SFX.
     */
    MODEL_SOUND_LUFS: z.coerce.number().min(-40).max(-6).default(-18.4),
    MODEL_SOUND_MAX_GAIN_DB: z.coerce.number().min(0).max(30).default(12),
    /**
     * Medios en almacenamiento remoto con caché local (hito 8, ADR-093): none = solo el disco (como hasta el
     * hito 7); dir = una carpeta que hace de remoto (pruebas); s3 = el bucket de AWS_S3_BUCKET.
     */
    MEDIA_DRIVER: z.enum(['none', 'dir', 's3']).default('none'),
    /**
     * Raíz del prefijo propio en el bucket (hito 12, ADR-151): <MEDIA_ROOT>/<MEDIA_ENV>/…. `wilox-motion` es la de
     * Awakelab (con lo publicado en Moodle); otra instalación usa la suya.
     */
    MEDIA_ROOT: z.string().regex(/^[a-z0-9-]+$/, 'solo minúsculas, números y guiones').default('wilox-motion'),
    /** Entorno dentro del prefijo propio: <MEDIA_ROOT>/<MEDIA_ENV>/… (prod en el servidor, dev en el Mac). */
    MEDIA_ENV: z.string().regex(/^[a-z0-9-]+$/).default('dev'),
    /** Carpeta del driver dir. */
    MEDIA_DIR: opt,
    /** Días sin usar tras los cuales la carpeta de un video sale de la caché local (si todo está subido). */
    MEDIA_CACHE_DAYS: z.coerce.number().min(0).default(14),
    /** Horas tras las cuales el ZIP de un lote sale de la caché local (se baja desde el remoto). */
    MEDIA_BATCH_CACHE_HOURS: z.coerce.number().min(0).default(24),
    MEDIA_UPLOAD_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    /** Duración de las URLs firmadas que recibe el navegador para un archivo que no está en la caché (s). */
    MEDIA_URL_TTL_SEC: z.coerce.number().int().min(60).max(43200).default(21600),
    /** Liberar la caché local automáticamente (false hasta confirmar la migración a S3, ADR-096). */
    MEDIA_EVICT: z.stringbool().default(false),
    /** Solo pruebas: endpoint de un S3 local (moto). */
    MEDIA_S3_ENDPOINT: opt,
    AWS_REGION: opt,
    AWS_S3_BUCKET: opt,
    /**
     * Publicaciones (hito 9, ADR-101): dirección pública del bucket (CloudFront), p. ej. https://media.awakelab.world.
     * Con S3 y esta dirección, lo publicado se sirve desde ahí; sin ella (o sin S3), desde la API
     * (`/api/publico/<token>/<archivo>`), que también vale para probar en el Mac.
     */
    MEDIA_PUBLIC_BASE: opt,
    /** Cache-Control (s) de lo publicado: lo que tarda en verse un final nuevo o una despublicación por CloudFront. */
    MEDIA_PUBLIC_MAX_AGE_SEC: z.coerce.number().int().min(0).max(86400).default(300),
    FFMPEG_PATH: z.string().default('ffmpeg'),
    FFPROBE_PATH: z.string().default('ffprobe'),

    ANTHROPIC_API_KEY: opt,
    ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),
    ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
    /** Segunda pasada de Opus como director de arte sobre el storyboard. */
    STORYBOARD_REVIEW: z.stringbool().default(true),
    /** Opus revisa visualmente los fotogramas antes de mostrarlos para aprobación. */
    IMAGE_REVIEW: z.stringbool().default(true),

    // Modo MCP (conector Higgsfield)
    HIGGSFIELD_MCP_URL: z.string().default('https://mcp.higgsfield.ai/mcp'),
    HIGGSFIELD_TOKEN_FILE: z.string().default('~/.wilox/higgsfield-oauth.json'),
    HIGGSFIELD_DEFAULT_VOICE_ID: z.string().default('97775303-f689-4cac-b904-fe7887d4899e'),
    HIGGSFIELD_DECLINED_PRESET_ID: z.string().default('24bae836-2c4a-48e0-89b6-49fcc0b21612'),
    HIGGSFIELD_IMAGE_RESOLUTION: z.enum(['1k', '2k', '4k']).default('2k'),
    HIGGSFIELD_IMAGE_QUALITY: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
    HIGGSFIELD_IMAGE_VARIANT: z.enum(['flare', 'sunburst']).default('sunburst'),
    WHISPER_MODEL: z.string().default('small'),

    // Modo API
    MINIMAX_API_KEY: opt,
    MINIMAX_VIDEO_MODEL: z.string().default('MiniMax-H3'),
    MINIMAX_BASE_URL: z.string().default('https://api.minimax.io'),
    MINIMAX_CONCURRENCY: z.coerce.number().default(6),
    ELEVENLABS_API_KEY: opt,
    ELEVENLABS_MODEL: z.string().default('eleven_v3'),
    /** Cómo se pide la locución de los videos nuevos (hito 10, ADR-133): toda en un solo pedido o uno por párrafo. */
    VOICE_MODE: z.enum(['whole', 'paragraph']).default('whole'),
    /** Modelo de la variante «pedidos enlazados» de la prueba de voz (hito 10, ADR-129). */
    ELEVENLABS_V4_MODEL: z.string().default('eleven_v4'),
    ELEVENLABS_DEFAULT_VOICE_ID: opt,
    /** Historial de ElevenLabs tras cada locución (ADR-040): delete (por defecto) · zero (Enterprise) · keep. */
    ELEVENLABS_HISTORY: z.enum(['delete', 'zero', 'keep']).default('delete'),
    OPENAI_API_KEY: opt,
    IMAGE_MODEL: z.string().default('gpt-image-2.5-sunburst'),
    IMAGE_QUALITY: z.enum(['auto', 'low', 'medium', 'high', 'xhigh', 'max']).default('high'),
    IMAGE_CONCURRENCY: z.coerce.number().default(6),

    CLIP_SECONDS: z.coerce.number().int().min(4).max(15).default(5),

    // Precios para el costo de cada trabajo (GenerationJob). Opcionales: sin precio, el costo queda vacío.
    /** USD por crédito de Higgsfield (para comparar MCP con API). */
    PRICE_HIGGSFIELD_CREDIT_USD: optNum,
    /** Créditos de Higgsfield por locución (text2speech_v2). */
    PRICE_HIGGSFIELD_TTS_CREDITS: optNum,
    // Cola global por recurso (hito 5, ADR-045): trabajos simultáneos y límite por minuto de cada recurso.
    // Son topes: ante un 429 la cola baja la concurrencia, respeta Retry-After y la recupera sola.
    QUEUE_ELEVENLABS_CONCURRENCY: z.coerce.number().int().min(1).default(5),
    QUEUE_ELEVENLABS_PER_MIN: optNum,
    QUEUE_ANTHROPIC_CONCURRENCY: z.coerce.number().int().min(1).default(4),
    QUEUE_ANTHROPIC_PER_MIN: optNum,
    QUEUE_OPENAI_CONCURRENCY: z.coerce.number().int().min(1).default(20),
    QUEUE_OPENAI_PER_MIN: z.coerce.number().min(1).default(250),
    /** Por defecto, MINIMAX_CONCURRENCY. */
    QUEUE_MINIMAX_CONCURRENCY: optNum,
    QUEUE_MINIMAX_PER_MIN: optNum,
    QUEUE_HIGGSFIELD_CONCURRENCY: z.coerce.number().int().min(1).default(12),
    /** Post y render con ffmpeg en el Mac. */
    QUEUE_FFMPEG_CONCURRENCY: z.coerce.number().int().min(1).default(2),
    /** Reintentos de un trabajo ante 429/5xx/red antes de marcar el video con error. */
    QUEUE_MAX_RETRIES: z.coerce.number().int().min(0).default(12),
    /** Al apagar la API, segundos de espera a los trabajos en marcha (los clips de MiniMax no esperan: se retoman). */
    SHUTDOWN_GRACE_SEC: z.coerce.number().min(0).default(90),
    /** Modo mock: multiplica las esperas simuladas de los proveedores (0 = sin esperas). */
    MOCK_SPEED: z.coerce.number().min(0).default(1),

    PRICE_ANTHROPIC_INPUT_PER_MTOK: optNum,
    PRICE_ANTHROPIC_OUTPUT_PER_MTOK: optNum,
    /** Lectura de caché de Opus (USD por millón; sin él, al precio de entrada). */
    PRICE_ANTHROPIC_CACHE_READ_PER_MTOK: optNum,
    /** Precio fijo por imagen de OpenAI; si está, manda sobre el cálculo por tokens. */
    PRICE_OPENAI_IMAGE_USD: optNum,
    /** GPT Image por tokens (hito 4 · T5): texto e imagen de entrada, imagen de salida (USD por millón). */
    PRICE_OPENAI_TEXT_INPUT_PER_MTOK: optNum,
    PRICE_OPENAI_IMAGE_INPUT_PER_MTOK: optNum,
    PRICE_OPENAI_IMAGE_OUTPUT_PER_MTOK: optNum,
    /** Precio fijo por clip de MiniMax; si está, manda sobre el precio por segundo. */
    PRICE_MINIMAX_CLIP_USD: optNum,
    /** MiniMax-H3 en 2K por segundo facturado (hito 4 · T5). */
    PRICE_MINIMAX_PER_SECOND_2K: optNum,
    /** USD por crédito de ElevenLabs (la cabecera character-cost da los créditos de cada locución). */
    PRICE_ELEVENLABS_CREDIT_USD: optNum,
    PRICE_ELEVENLABS_PER_1K_CHARS: optNum,
  })
  .superRefine((e, ctx) => {
    const need = (k: keyof typeof e) => {
      if (!e[k]) ctx.addIssue({ code: 'custom', path: [k], message: `Falta ${k} (GENERATION_MODE=${e.GENERATION_MODE})` });
    };
    if (e.MEDIA_DRIVER === 'dir') need('MEDIA_DIR');
    // Regla de ADR-148: wilox-motion/prod/ es de Awakelab (lo publicado en Moodle). La limpieza horaria de cada
    // instalación borra las carpetas públicas de su prefijo que no están en su base: otra instalación las borraría.
    if (e.MEDIA_DRIVER !== 'none' && e.MEDIA_ROOT === 'wilox-motion' && e.MEDIA_ENV === 'prod' && e.BRAND !== 'awakelab')
      ctx.addIssue({
        code: 'custom',
        path: ['MEDIA_ROOT'],
        message: 'wilox-motion/prod/ es de la instalación de Awakelab: pon BRAND=awakelab o, si es otra instalación, su propio MEDIA_ROOT (ADR-148)',
      });
    if (e.MEDIA_DRIVER === 's3') {
      need('AWS_REGION');
      need('AWS_S3_BUCKET');
    }
    if (e.GENERATION_MODE === 'mcp') need('ANTHROPIC_API_KEY');
    if (e.GENERATION_MODE === 'api') {
      need('ANTHROPIC_API_KEY');
      need('MINIMAX_API_KEY');
      need('ELEVENLABS_API_KEY');
      need('OPENAI_API_KEY');
    }
  });

export type Env = z.infer<typeof EnvSchema>;

function load(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida en .env:\n${lines}`);
  }
  return parsed.data;
}

export const env: Env = load();

/** Resuelve una ruta relativa a la raíz del repo y expande ~. */
export function repoPath(p: string): string {
  const home = process.env.HOME ?? '';
  const expanded = p.startsWith('~/') ? resolve(home, p.slice(2)) : p;
  return isAbsolute(expanded) ? expanded : resolve(REPO_ROOT, expanded);
}
