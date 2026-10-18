/**
 * Costo en USD de cada trabajo a partir de lo que factura cada proveedor (hito 4 · T5, ADR-037).
 * Los precios salen de PRICE_* en .env (sin precio, el costo queda vacío y el trabajo se anota igual).
 */
type Usage = Record<string, unknown>;
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);

/**
 * Locución de Higgsfield (text2speech_v2): 0,15 créditos por cada 50 caracteres empezados, según las
 * transacciones reales (40 → 0,15 · 99 → 0,30 · 254 → 0,90 · 429 → 1,35 · 455 → 1,50).
 */
export const higgsfieldTtsCredits = (chars: number) => Math.round(0.15 * Math.ceil(Math.max(0, chars) / 50) * 100) / 100;

/** Opus: entrada, salida y caché (lectura a su precio; escritura al de entrada si no hay otro). */
export function anthropicCost(p: { inPerM?: number; outPerM?: number; cacheReadPerM?: number; cacheWritePerM?: number }) {
  if (p.inPerM === undefined || p.outPerM === undefined) return undefined;
  const { inPerM, outPerM } = p;
  return (u: Usage) =>
    (n(u.inputTokens) * inPerM +
      n(u.outputTokens) * outPerM +
      n(u.cacheReadTokens) * (p.cacheReadPerM ?? inPerM) +
      n(u.cacheWriteTokens) * (p.cacheWritePerM ?? inPerM)) /
    1e6;
}

/**
 * GPT Image por tokens (uso que devuelve /images/generations o /images/edits): texto e imágenes de
 * entrada y la imagen de salida. Si hay un precio fijo por imagen (PRICE_OPENAI_IMAGE_USD), manda ese.
 */
export function openAiImageCost(p: { fixedUsd?: number; textInPerM?: number; imageInPerM?: number; imageOutPerM?: number }) {
  if (p.fixedUsd !== undefined) return p.fixedUsd;
  if (p.imageOutPerM === undefined) return undefined;
  const { imageOutPerM } = p;
  return (u: Usage) => {
    if (u.output_tokens === undefined && u.input_tokens === undefined) return undefined;
    const d = (u.input_tokens_details ?? {}) as Usage;
    const hasDetails = d.text_tokens !== undefined || d.image_tokens !== undefined;
    const text = hasDetails ? n(d.text_tokens) : n(u.input_tokens);
    const image = hasDetails ? n(d.image_tokens) : 0;
    return (text * (p.textInPerM ?? 0) + image * (p.imageInPerM ?? 0) + n(u.output_tokens) * imageOutPerM) / 1e6;
  };
}

/** MiniMax por segundo facturado (task.usage.output_seconds; si no llega, la duración pedida). */
export function miniMaxCost(p: { perSecond?: number; fixedClipUsd?: number; seconds: number }) {
  if (p.fixedClipUsd !== undefined) return p.fixedClipUsd;
  if (p.perSecond === undefined) return undefined;
  const { perSecond } = p;
  return (u: Usage) => (u.output_seconds !== undefined ? n(u.output_seconds) : p.seconds) * perSecond;
}

/**
 * ElevenLabs: créditos que devuelve la cabecera `character-cost` × USD por crédito del plan; sin ese
 * precio, USD por cada 1.000 caracteres enviados (PRICE_ELEVENLABS_PER_1K_CHARS).
 */
export function elevenLabsCost(p: { creditUsd?: number; per1kChars?: number }) {
  if (p.creditUsd === undefined && p.per1kChars === undefined) return undefined;
  return (u: Usage) => {
    if (p.creditUsd !== undefined && u.credits !== undefined) return n(u.credits) * p.creditUsd;
    if (p.per1kChars !== undefined) return (n(u.characters) / 1000) * p.per1kChars;
    return undefined;
  };
}
