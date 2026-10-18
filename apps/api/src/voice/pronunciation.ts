import { z } from 'zod';
import { norm } from '../pipeline/text.js';

/** Regla de pronunciación: donde aparece `match` (palabra o frase, sin distinguir mayúsculas), la voz recibe `say`. */
export interface Rule {
  match: string;
  say: string;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Texto que se envía a la voz (hito 5, ADR-048): aplica las reglas por palabra o frase completa. El
 * texto del video no cambia; los tiempos se alinean después con el texto original.
 */
export function applyRules(text: string, rules: Rule[]): string {
  let out = text;
  // Las frases más largas primero ("control de infecciones" antes que "control").
  for (const r of [...rules].sort((a, b) => b.match.length - a.match.length)) {
    const m = r.match.trim();
    if (!m || !r.say.trim()) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc(m)}(?![\\p{L}\\p{N}])`, 'giu');
    out = out.replace(re, r.say.trim());
  }
  return out;
}

/** Reglas que tocan un texto (para mostrarlas en el pop-up). */
export function rulesIn(text: string, rules: Rule[]): Rule[] {
  return rules.filter((r) => applyRules(text, [r]) !== text);
}

/**
 * Correspondencia de índices de palabras entre el texto anterior y el nuevo de un párrafo (LCS sobre
 * palabras normalizadas): cada palabra anterior va a la nueva igual o, si se cambió, a la más cercana.
 */
export function mapWordIndices(oldWords: string[], newWords: string[]): number[] {
  const a = oldWords.map(norm);
  const b = newWords.map(norm);
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const map: (number | undefined)[] = new Array(n).fill(undefined);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      map[i] = j;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  // Sin pareja: la posición proporcional entre sus vecinas con pareja.
  return map.map((v, k) => {
    if (v !== undefined) return v;
    let p = k - 1;
    while (p >= 0 && map[p] === undefined) p--;
    const prev = p >= 0 ? map[p]! : -1;
    return Math.max(0, Math.min(Math.max(0, m - 1), prev + 1));
  });
}

/** Respuesta de Opus a una indicación de pronunciación. */
export const PronunciationFixSchema = z.object({
  rules: z
    .array(
      z.object({
        match: z.string().describe('Exact word or phrase as written in the paragraph (case-insensitive match).'),
        say: z.string().describe('How to write it so the Spanish TTS voice pronounces it as requested.'),
      }),
    )
    .describe('Pronunciation rules. Empty if the instruction is not about pronunciation (then the paragraph is simply re-voiced).'),
  explanation: z.string().describe('One short sentence in Spanish: what was changed and why.'),
});
export type PronunciationFix = z.infer<typeof PronunciationFixSchema>;

export function pronunciationSystemPrompt(): string {
  return [
    'You fix pronunciation problems of a Spanish (Chile) text-to-speech voice (ElevenLabs eleven_v3) used to narrate educational videos.',
    'The user listened to a narrated paragraph and describes in natural language what sounded wrong (a mispronounced word, an acronym read as a word, a number, a foreign term, a missing pause…).',
    'Return pronunciation RULES: each rule maps an exact word or phrase that appears in the paragraph ("match", as written) to the text that should be sent to the voice instead ("say").',
    'Techniques for "say": spell acronyms letter by letter with commas ("I, A, A, S"), write numbers and symbols in words, respell foreign words phonetically for a Spanish reader, add a comma for a short pause, split a hard compound word.',
    'Rules must be reusable in other videos: only the problematic word or short phrase, never a whole sentence. Never change the meaning. Keep "say" in Spanish.',
    'If the instruction is not about pronunciation (e.g. "say it again", "too fast"), return no rules: the paragraph is simply re-voiced.',
  ].join('\n');
}

export function pronunciationUserPrompt(o: { paragraph: string; spoken: string; instruction: string; rules: Rule[] }): string {
  return [
    `PARAGRAPH (as written in the video):\n${o.paragraph}`,
    o.spoken !== o.paragraph ? `TEXT SENT TO THE VOICE LAST TIME:\n${o.spoken}` : '',
    o.rules.length ? `RULES ALREADY APPLIED:\n${o.rules.map((r) => `- "${r.match}" → "${r.say}"`).join('\n')}` : '',
    `WHAT THE USER HEARD / WANTS:\n${o.instruction}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
