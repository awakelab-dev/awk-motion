import { z } from 'zod';
import type { LlmContent, LlmPort } from '../providers/ports.js';

/** Llama a Opus con salida estructurada y valida con zod (un reintento con el error). */
export async function askJson<T>(llm: LlmPort, schema: z.ZodType<T>, system: string, user: LlmContent, label: string): Promise<T> {
  const json = toApiSchema(schema);
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let u: LlmContent = user;
    if (attempt) {
      const retry = `Your previous answer was invalid: ${lastErr}`;
      u = typeof user === 'string' ? `${user}\n\n${retry}` : [...user, { type: 'text', text: retry }];
    }
    const raw = await llm.structured(system, u, json, { label: attempt ? `${label} (reintento)` : label });
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    lastErr = parsed.error.message.slice(0, 1000);
  }
  throw new Error(`${label}: la respuesta de Opus no es válida: ${lastErr}`);
}

/** JSON Schema para output_config.format (sin claves que la API no admite). */
export function toApiSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        if (['$schema', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format'].includes(k)) continue;
        o[k] = strip(v);
      }
      if (o.type === 'object') o.additionalProperties = false;
      return o;
    }
    return node;
  };
  return strip(raw) as Record<string, unknown>;
}
