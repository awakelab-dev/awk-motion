import { Global, Logger, Module } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { env, repoPath } from '../config/env.js';
import { AnthropicLlm } from './api/anthropic.js';
import { ElevenLabsTts } from './api/elevenlabs.js';
import { MiniMaxVideo } from './api/minimax.js';
import { OpenAiImages } from './api/openai-image.js';
import { HiggsfieldClient } from './mcp/higgsfield-client.js';
import { HiggsfieldImages, HiggsfieldTts, HiggsfieldVideo, type HiggsfieldConfig } from './mcp/higgsfield.providers.js';
import { MockImages, MockLlm, MockTts, MockVideo } from './mock/mock.providers.js';
import { instrument } from './instrument.js';
import { anthropicCost, elevenLabsCost, higgsfieldTtsCredits, miniMaxCost, openAiImageCost } from './pricing.js';
import { PROVIDERS, type Providers } from './ports.js';
import { gate } from '../queue/gate.js';
import { QueueService } from '../queue/queue.service.js';

export const HIGGSFIELD = Symbol('HIGGSFIELD');

/** Costos de docs/03 (créditos Higgsfield). */
const IMAGE_CREDITS: Record<string, number> = { '1k:medium': 0.5, '2k:medium': 1, '2k:high': 2.75 };

/** Proveedores del modo actual, instrumentados para anotar cada trabajo y su costo (GenerationJob). */
function build(hf: HiggsfieldClient | undefined): Providers {
  const p = buildRaw(hf);
  const llm = {
    provider: 'anthropic',
    model: env.ANTHROPIC_MODEL,
    costUsd: anthropicCost({ inPerM: env.PRICE_ANTHROPIC_INPUT_PER_MTOK, outPerM: env.PRICE_ANTHROPIC_OUTPUT_PER_MTOK, cacheReadPerM: env.PRICE_ANTHROPIC_CACHE_READ_PER_MTOK }),
  };
  if (p.mode === 'mock')
    return instrument(p, {
      tts: { provider: 'mock', model: 'tono' },
      image: { provider: 'mock', model: 'mock' },
      video: { provider: 'mock', model: 'mock' },
      llm: { provider: 'mock', model: 'mock' },
    });
  if (p.mode === 'api')
    return instrument(p, {
      // Costos reales (ADR-037): créditos de la cabecera de ElevenLabs, tokens de GPT Image y segundos de MiniMax.
      tts: { provider: 'elevenlabs', model: env.ELEVENLABS_MODEL, costUsd: elevenLabsCost({ creditUsd: env.PRICE_ELEVENLABS_CREDIT_USD, per1kChars: env.PRICE_ELEVENLABS_PER_1K_CHARS }) },
      image: {
        provider: 'openai',
        model: `${env.IMAGE_MODEL} ${env.IMAGE_QUALITY}`,
        costUsd: openAiImageCost({
          fixedUsd: env.PRICE_OPENAI_IMAGE_USD,
          textInPerM: env.PRICE_OPENAI_TEXT_INPUT_PER_MTOK,
          imageInPerM: env.PRICE_OPENAI_IMAGE_INPUT_PER_MTOK,
          imageOutPerM: env.PRICE_OPENAI_IMAGE_OUTPUT_PER_MTOK,
        }),
      },
      video: {
        provider: 'minimax',
        model: `${env.MINIMAX_VIDEO_MODEL} 2K ${env.CLIP_SECONDS}s`,
        costUsd: miniMaxCost({ perSecond: env.PRICE_MINIMAX_PER_SECOND_2K, fixedClipUsd: env.PRICE_MINIMAX_CLIP_USD, seconds: env.CLIP_SECONDS }),
      },
      llm,
    });
  const imgCredits = IMAGE_CREDITS[`${env.HIGGSFIELD_IMAGE_RESOLUTION}:${env.HIGGSFIELD_IMAGE_QUALITY}`] ?? 2.75;
  return instrument(p, {
    // Locución: créditos por caracteres (ADR-038) salvo que PRICE_HIGGSFIELD_TTS_CREDITS fije un valor por llamada.
    tts: {
      provider: 'higgsfield',
      model: 'text2speech_v2 · elevenlabs',
      credits: env.PRICE_HIGGSFIELD_TTS_CREDITS ?? ((u) => higgsfieldTtsCredits(Number(u.characters ?? 0))),
    },
    timing: { provider: 'higgsfield', model: `sandbox · faster-whisper ${env.WHISPER_MODEL}` },
    image: { provider: 'higgsfield', model: `gpt_image_2_5 ${env.HIGGSFIELD_IMAGE_RESOLUTION} ${env.HIGGSFIELD_IMAGE_QUALITY}`, credits: imgCredits },
    video: { provider: 'higgsfield', model: 'minimax_h3 2K', credits: 10 },
    llm,
    creditUsd: env.PRICE_HIGGSFIELD_CREDIT_USD,
  });
}

function buildRaw(hf: HiggsfieldClient | undefined): Providers {
  const log = new Logger('Providers');
  if (env.GENERATION_MODE === 'mock') {
    log.warn('GENERATION_MODE=mock: proveedores locales de prueba, sin red ni créditos.');
    const tts = new MockTts();
    return {
      mode: 'mock',
      tts,
      timing: tts,
      images: new MockImages(),
      video: new MockVideo(),
      llm: new MockLlm(),
      defaultVoiceId: () => 'mock-voice',
    };
  }
  const llm = new AnthropicLlm(env.ANTHROPIC_API_KEY!, env.ANTHROPIC_MODEL, env.ANTHROPIC_EFFORT);
  if (env.GENERATION_MODE === 'api') {
    const tts = new ElevenLabsTts(env.ELEVENLABS_API_KEY!, env.ELEVENLABS_MODEL, env.ELEVENLABS_HISTORY);
    return {
      mode: 'api',
      tts,
      timing: tts,
      images: new OpenAiImages(env.OPENAI_API_KEY!, env.IMAGE_MODEL, env.IMAGE_QUALITY, env.IMAGE_CONCURRENCY),
      video: new MiniMaxVideo(env.MINIMAX_API_KEY!, env.MINIMAX_VIDEO_MODEL, env.MINIMAX_BASE_URL, env.CLIP_SECONDS, env.MINIMAX_CONCURRENCY),
      llm,
      defaultVoiceId: () => env.ELEVENLABS_DEFAULT_VOICE_ID ?? '',
    };
  }
  const cfg: HiggsfieldConfig = {
    declinedPresetId: env.HIGGSFIELD_DECLINED_PRESET_ID,
    imageResolution: env.HIGGSFIELD_IMAGE_RESOLUTION,
    imageQuality: env.HIGGSFIELD_IMAGE_QUALITY,
    imageVariant: env.HIGGSFIELD_IMAGE_VARIANT,
    whisperModel: env.WHISPER_MODEL,
    clipSeconds: env.CLIP_SECONDS,
  };
  const tts = new HiggsfieldTts(hf!, cfg);
  return {
    mode: 'mcp',
    tts,
    timing: tts,
    images: new HiggsfieldImages(hf!, cfg),
    video: new HiggsfieldVideo(hf!, cfg),
    llm,
    defaultVoiceId: () => env.HIGGSFIELD_DEFAULT_VOICE_ID,
    uploadRef: async (path: string) => {
      const contentType = /\.jpe?g$/i.test(path) ? 'image/jpeg' : 'image/png';
      const r = await hf!.call<{ uploads?: { upload_url: string; media_id: string; content_type?: string }[] }>('media_upload', {
        filename: basename(path),
        content_type: contentType,
      });
      const u = r.uploads?.[0];
      if (!u) throw new Error('Higgsfield no devolvió URL de subida.');
      const res = await fetch(u.upload_url, {
        method: 'PUT',
        headers: { 'content-type': u.content_type ?? contentType },
        body: await readFile(path),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) throw new Error(`Subida a Higgsfield falló: HTTP ${res.status}`);
      await hf!.call('media_confirm', { type: 'image', media_id: u.media_id });
      return u.media_id;
    },
  };
}

@Global()
@Module({
  providers: [
    {
      provide: HIGGSFIELD,
      useFactory: () =>
        env.GENERATION_MODE === 'mcp'
          ? new HiggsfieldClient(
              env.HIGGSFIELD_MCP_URL,
              repoPath(env.HIGGSFIELD_TOKEN_FILE),
              `http://localhost:${env.PORT}/api/auth/higgsfield/callback`,
            )
          : null,
    },
    {
      provide: PROVIDERS,
      inject: [HIGGSFIELD, QueueService],
      // Cada trabajo se anota (instrument) y pasa por la cola global (gate, hito 5).
      useFactory: (hf: HiggsfieldClient | null, queue: QueueService) => gate(build(hf ?? undefined), queue),
    },
  ],
  exports: [PROVIDERS, HIGGSFIELD],
})
export class ProvidersModule {}
