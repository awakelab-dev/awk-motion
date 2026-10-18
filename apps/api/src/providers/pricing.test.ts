import { describe, expect, it } from 'vitest';
import { anthropicCost, elevenLabsCost, higgsfieldTtsCredits, miniMaxCost, openAiImageCost } from './pricing.js';

const fn = <T>(v: T) => v as unknown as (u: Record<string, unknown>) => number | undefined;

describe('costos por trabajo (hito 4 · T5)', () => {
  it('Opus: entrada, salida y lectura de caché a su precio', () => {
    const c = fn(anthropicCost({ inPerM: 4, outPerM: 20, cacheReadPerM: 0.2 }));
    expect(c({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000 })).toBeCloseTo(4 + 2 + 0.2);
    expect(anthropicCost({ inPerM: 4 })).toBeUndefined();
  });

  it('GPT Image por tokens de texto, imagen de entrada e imagen de salida', () => {
    const c = fn(openAiImageCost({ textInPerM: 5, imageInPerM: 8, imageOutPerM: 30 }));
    const usage = { input_tokens: 3000, output_tokens: 10_000, input_tokens_details: { text_tokens: 1000, image_tokens: 2000 } };
    expect(c(usage)).toBeCloseTo((1000 * 5 + 2000 * 8 + 10_000 * 30) / 1e6);
    expect(c({ input_tokens: 1000, output_tokens: 0 })).toBeCloseTo(0.005);
    expect(c({})).toBeUndefined();
    expect(openAiImageCost({ fixedUsd: 0.2, imageOutPerM: 30 })).toBe(0.2);
  });

  it('MiniMax por segundo facturado', () => {
    const c = fn(miniMaxCost({ perSecond: 0.13, seconds: 5 }));
    expect(c({ output_seconds: 6 })).toBeCloseTo(0.78);
    expect(c({})).toBeCloseTo(0.65);
    expect(miniMaxCost({ fixedClipUsd: 1, perSecond: 0.13, seconds: 5 })).toBe(1);
  });

  it('locución de Higgsfield: 0,15 créditos por cada 50 caracteres (transacciones reales)', () => {
    expect([40, 99, 254, 267, 429, 455].map(higgsfieldTtsCredits)).toEqual([0.15, 0.3, 0.9, 0.9, 1.35, 1.5]);
  });

  it('ElevenLabs por créditos de la cabecera o por caracteres', () => {
    expect(fn(elevenLabsCost({ creditUsd: 0.0002 }))({ credits: 88, characters: 146 })).toBeCloseTo(0.0176);
    expect(fn(elevenLabsCost({ per1kChars: 0.3 }))({ characters: 1000 })).toBeCloseTo(0.3);
    expect(elevenLabsCost({})).toBeUndefined();
  });
});
