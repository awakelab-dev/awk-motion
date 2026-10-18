import Anthropic from '@anthropic-ai/sdk';
import type { LlmCallMeta, LlmContent, LlmPort } from '../ports.js';

/** Opus 5.5 con effort configurable y salida JSON estructurada (output_config.format). */
export class AnthropicLlm implements LlmPort {
  private client: Anthropic;
  constructor(
    apiKey: string,
    private model: string,
    private effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 3, timeout: 15 * 60_000 });
  }

  async structured(system: string, user: LlmContent, schema: Record<string, unknown>, meta?: LlmCallMeta): Promise<unknown> {
    const content =
      typeof user === 'string'
        ? user
        : user.map((b) =>
            b.type === 'text'
              ? { type: 'text' as const, text: b.text }
              : b.type === 'document'
                ? { type: 'document' as const, source: { type: 'base64' as const, media_type: b.mediaType, data: b.base64 } }
                : { type: 'image' as const, source: { type: 'base64' as const, media_type: b.mediaType, data: b.base64 } },
          );
    // Streaming: con effort alto la respuesta puede tardar varios minutos.
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 64_000,
      system,
      messages: [{ role: 'user', content }],
      output_config: { effort: this.effort, format: { type: 'json_schema', schema } },
    });
    const msg = await stream.finalMessage();
    meta?.onUsage?.({
      id: msg.id,
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? undefined,
      cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? undefined,
    });
    if (msg.stop_reason === 'refusal') throw new Error('Opus rechazó generar el storyboard.');
    if (msg.stop_reason === 'max_tokens') throw new Error('Opus agotó max_tokens antes de terminar el storyboard.');
    const text = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Opus no devolvió JSON válido: ${text.slice(0, 300)}`);
    }
  }
}
