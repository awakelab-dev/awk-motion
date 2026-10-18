import { z } from 'zod';

/**
 * Storyboard que devuelve Opus. El código ensambla con esto los superprompts finales
 * (bible + escena + reglas), así la estructura probada no depende del LLM.
 */
export const MediaFrameSchema = z.object({
  kind: z.enum(['video', 'still']),
  subject: z.string().describe('Qué muestra el marco, en inglés, en una frase. Si kind=video, la acción continua.'),
  position: z
    .string()
    .optional()
    .describe('Lugar del marco en el fotograma, en inglés y en pocas palabras (p. ej. "left", "centre", "right", "top left", "bottom"). Siempre que haya más de un marco.'),
});

export const AnimationBeatSchema = z.object({
  from: z.number().describe('Segundo de inicio dentro del clip (0-5).'),
  to: z.number().describe('Segundo de fin dentro del clip (0-5).'),
  action: z.string().describe('Qué ocurre en ese tramo, en inglés, en una o dos frases.'),
});

export const KeyframeSpecSchema = z.object({
  layout: z
    .string()
    .describe('Nombre corto de la composición, en inglés (p. ej. "text left, one circular photo right"). Nunca igual al del plano anterior.'),
  scene: z
    .string()
    .describe('Composición del fotograma en inglés, máximo 90 palabras: jerarquía, posiciones y tamaños. Sin describir el fondo ni el estilo. Cita los textos exactos entre comillas.'),
  summary: z.string().describe('Resumen del fotograma en una línea (máximo 20 palabras), en inglés.'),
  texts: z.array(z.string()).describe('Lista literal de TODOS los textos visibles en español, con tildes.'),
  mediaFrames: z
    .array(MediaFrameSchema)
    .describe('Marcos con foto o video real (máximo 4), en orden de lectura: de izquierda a derecha y de arriba abajo. Vacío en los estilos Glossy.'),
  repeatedItems: z
    .number()
    .int()
    .describe('Cuántos elementos iguales repetidos tiene el fotograma (máscaras, baldosas, íconos, paneles); 0 si no hay grupo.'),
});

export const ShotSchema = z.object({
  anchorWordIndex: z
    .number()
    .int()
    .describe('Índice (de la lista numerada de palabras) donde la voz dice la PFC.'),
  pfc: z.string().describe('La palabra o frase clave, en español.'),
  idea: z.string().describe('La única idea que comunica este plano, en español, en pocas palabras.'),
  title: z.string().describe('Título corto del plano, en inglés y mayúsculas (p. ej. WELCOME).'),
  keyframe: KeyframeSpecSchema,
  animation: z.array(AnimationBeatSchema).describe('De 3 a 4 tramos de 0 a 5 s: transición desde el fotograma anterior hasta este.'),
  endState: z.string().describe('Cómo queda el último segundo (calmo, casi estático), en inglés, en una frase.'),
  sound: z.string().describe('Efectos de sonido sugeridos, en inglés, sin música ni voz.'),
});

/**
 * «Dividir en dos» un clip (hito 10, T3, ADR-130): Opus escribe el plano intermedio (su fotograma Kmedio y la
 * animación desde el fotograma anterior) y la nueva animación del segundo clip (de Kmedio al fotograma final, que no
 * cambia).
 */
export const ClipSplitSchema = z.object({
  intermediate: ShotSchema.describe('El plano nuevo: su fotograma es un estado intermedio del plano original.'),
  second: z.object({
    animation: z.array(AnimationBeatSchema).describe('De 3 a 4 tramos de 0 a 5 s: transición desde el fotograma intermedio hasta el final del plano original.'),
    endState: z.string().describe('Cómo queda el último segundo, en inglés, en una frase.'),
    sound: z.string().describe('Efectos de sonido sugeridos, en inglés, sin música ni voz.'),
  }),
  explanation: z.string().describe('Qué muestra el fotograma intermedio y por qué, en español, en una o dos frases.'),
});
export type ClipSplit = z.infer<typeof ClipSplitSchema>;

export const StoryboardSchema = z.object({
  intro: z.object({
    scene: z.string().describe('Fotograma K0: solo el fondo del estilo, sin texto, en inglés, máximo 40 palabras.'),
  }),
  shots: z.array(ShotSchema),
});

/** Pasada de revisión del director de arte sobre el storyboard. */
export const StoryboardReviewSchema = z.object({
  notes: z.array(z.string()).describe('Problemas encontrados y cómo se corrigieron, en español, una frase cada uno.'),
  storyboard: StoryboardSchema,
});

/** Revisión visual de los fotogramas generados. */
export const ImageReviewSchema = z.object({
  reviews: z.array(
    z.object({
      index: z.number().int().describe('Índice del fotograma (0 = K00).'),
      verdict: z.enum(['ok', 'improve']),
      issues: z.string().describe('Qué falla, en español, en una o dos frases. Vacío si verdict=ok.'),
      revisedScene: z.string().describe('Escena corregida (mismas reglas que scene). Vacío si verdict=ok.'),
    }),
  ),
});

/**
 * Sugerencia de Opus para un clip a partir de las observaciones del cliente (hito 9, T11, ADR-122): qué cambiar
 * (el clip, su fotograma inicial o el final) y con qué indicación, lista para aplicar.
 */
export const ClipAdviceSchema = z.object({
  summary: z.string().describe('Qué pide el cliente sobre este clip, en español, en una o dos frases.'),
  actions: z
    .array(
      z.object({
        target: z.enum(['clip', 'start', 'end']).describe('clip = regenerar el clip (movimiento); start/end = regenerar el fotograma inicial o final (lo dibujado).'),
        instruction: z
          .string()
          .describe('La indicación en español, para que la lea el equipo: el cambio concreto (en un fotograma, con los textos exactos entre comillas). Máximo 60 palabras.'),
        modelInstruction: z
          .string()
          .describe('Solo si target=clip: la misma indicación en inglés para el modelo de video, concreta y visual, máximo 60 palabras. Vacío en start/end.'),
        why: z.string().describe('Por qué, en español, una frase; cita las observaciones que resuelve.'),
      }),
    )
    .describe('De 0 a 3 cambios; vacío si nada es pertinente a este clip.'),
  notes: z.string().describe('En español: lo que no se resuelve con estos cambios (voz, tiempos, otro clip) o no es pertinente. Vacío si no hay.'),
});

/** Coreografía de la transición de un video subido (ADR-076/077): cómo sale y entra cada elemento, solo desplazándose. */
export const TransitionPlanSchema = z.object({
  startElements: z.string().describe('Main elements of the START frame with position and color, in English, one short line.'),
  endElements: z.string().describe('Main elements of the END frame with position and color, in English, one short line.'),
  choreography: z.string().describe('Element-by-element choreography for the video model in which elements only slide in or out (never morph or deform), in English, at most 900 characters.'),
});

export type MediaFrame = z.infer<typeof MediaFrameSchema>;
export type TransitionPlan = z.infer<typeof TransitionPlanSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type ClipAdviceBody = z.infer<typeof ClipAdviceSchema>;
export type Storyboard = z.infer<typeof StoryboardSchema>;
export type StoryboardReview = z.infer<typeof StoryboardReviewSchema>;
export type ImageReview = z.infer<typeof ImageReviewSchema>;

// ------------------------------------------------------------------ animación de las imágenes (ADR-080)

/**
 * Regla "según cuántas haya": qué marcos son video y cuáles foto, en orden de lectura.
 * 1 → video; 2 → video + foto; 3 → video + foto + video; 4 (o más) → todas fotos.
 */
export function mediaKindsByCount(n: number): MediaFrame['kind'][] {
  if (n <= 0) return [];
  if (n === 1) return ['video'];
  if (n === 2) return ['video', 'still'];
  if (n === 3) return ['video', 'still', 'video'];
  return Array.from({ length: n }, () => 'still' as const);
}

/**
 * Fija video/foto en cada marco según la regla del tema. Con 'opus' (o sin regla) no toca nada.
 * Devuelve los índices (0…) de los planos que cambiaron. Modifica los planos recibidos.
 */
export function applyMediaFrameRule(shots: Shot[], rule: 'opus' | 'byCount' | undefined): number[] {
  if (rule !== 'byCount') return [];
  const changed: number[] = [];
  shots.forEach((sh, i) => {
    const kinds = mediaKindsByCount(sh.keyframe.mediaFrames.length);
    let diff = false;
    sh.keyframe.mediaFrames.forEach((m, j) => {
      if (m.kind !== kinds[j]) {
        m.kind = kinds[j];
        diff = true;
      }
    });
    if (diff) changed.push(i);
  });
  return changed;
}

/** "VFV": video/foto de cada marco, para el registro. */
export const mediaKindsLabel = (sh: Shot): string => sh.keyframe.mediaFrames.map((m) => (m.kind === 'video' ? 'V' : 'F')).join('');
