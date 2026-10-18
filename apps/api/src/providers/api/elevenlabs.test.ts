import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsTts } from './elevenlabs.js';

const body = JSON.stringify({
  audio_base64: Buffer.from('mp3').toString('base64'),
  alignment: { characters: [...'Hola mundo'], character_start_times_seconds: [...'Hola mundo'].map((_, i) => i / 10), character_end_times_seconds: [...'Hola mundo'].map((_, i) => (i + 1) / 10) },
});
const ok = (headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { 'character-cost': '12', 'request-id': 'req-1', ...headers } });
const dir = mkdtempSync(join(tmpdir(), 'el-'));

afterEach(() => vi.unstubAllGlobals());

describe('ElevenLabs: historial (ADR-040)', () => {
  it('delete: busca el request_id en /v1/history y lo borra', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}${new URL(url).search.includes('enable_logging') ? ' zero' : ''}`);
      if (url.includes('/with-timestamps')) return ok();
      if (url.includes('/v1/history?')) return new Response(JSON.stringify({ history: [{ history_item_id: 'h-9', request_id: 'otro' }, { history_item_id: 'h-1', request_id: 'req-1' }] }));
      return new Response('{}', { status: 200 });
    }));
    const r = await new ElevenLabsTts('k', 'eleven_v3', 'delete').synthesize('Hola mundo', 'v1', join(dir, 'a'));
    expect(r.words?.map((w) => w.word)).toEqual(['Hola', 'mundo']);
    expect(r.usage).toEqual({ credits: 12, history: 'deleted' });
    expect(calls).toEqual(['POST /v1/text-to-speech/v1/with-timestamps', 'GET /v1/history', 'DELETE /v1/history/h-1']);
  });

  it('delete: con la cabecera history-item-id no hace falta buscar', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      return url.includes('/with-timestamps') ? ok({ 'history-item-id': 'h-2' }) : new Response('{}');
    }));
    const r = await new ElevenLabsTts('k', 'eleven_v3').synthesize('Hola mundo', 'v1', join(dir, 'b'));
    expect(r.usage?.history).toBe('deleted');
    expect(calls).toEqual(['POST /v1/text-to-speech/v1/with-timestamps', 'DELETE /v1/history/h-2']);
  });

  it('zero: si la cuenta no es Enterprise (4xx), repite sin enable_logging y borra después', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const zero = url.includes('enable_logging=false');
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}${zero ? ' zero' : ''}`);
      if (url.includes('/with-timestamps')) return zero ? new Response('{"detail":"zero retention mode is enterprise only"}', { status: 403 }) : ok({ 'history-item-id': 'h-3' });
      return new Response('{}');
    }));
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
    const tts = new ElevenLabsTts('k', 'eleven_v3', 'zero');
    const r = await tts.synthesize('Hola mundo', 'v1', join(dir, 'c'));
    expect(r.usage?.history).toBe('deleted');
    // La segunda locución ya no intenta retención cero.
    calls.length = 0;
    await tts.synthesize('Hola mundo', 'v1', join(dir, 'd'));
    vi.useRealTimers();
    expect(calls).toEqual(['POST /v1/text-to-speech/v1/with-timestamps', 'DELETE /v1/history/h-3']);
  }, 30_000);

  it('keep: no toca el historial', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`), ok())));
    const r = await new ElevenLabsTts('k', 'eleven_v3', 'keep').synthesize('Hola mundo', 'v1', join(dir, 'e'));
    expect(r.usage?.history).toBe('kept');
    expect(calls).toHaveLength(1);
  });
});

describe('ElevenLabs: opciones de la prueba de voz (ADR-129, ADR-131)', () => {
  it('modelo, enlace con los pedidos anteriores y ajustes de la voz en el cuerpo', async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/with-timestamps')) {
        sent = JSON.parse(String(init?.body));
        return ok({ 'history-item-id': 'h-5' });
      }
      return new Response('{}');
    }));
    const r = await new ElevenLabsTts('k', 'eleven_v3').synthesize('Hola mundo', 'v1', join(dir, 'e'), {
      model: 'eleven_v4',
      previousRequestIds: ['a', 'b', 'c', 'd'],
      nextText: 'Siguiente',
      voiceSettings: { similarityBoost: 0.95 },
    });
    expect(sent).toEqual({ text: 'Hola mundo', model_id: 'eleven_v4', previous_request_ids: ['b', 'c', 'd'], next_text: 'Siguiente', voice_settings: { similarity_boost: 0.95 } });
    expect(r.model).toBe('eleven_v4');
  });
  it('sin opciones, el cuerpo de siempre', async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/with-timestamps')) {
        sent = JSON.parse(String(init?.body));
        return ok({ 'history-item-id': 'h-6' });
      }
      return new Response('{}');
    }));
    await new ElevenLabsTts('k', 'eleven_v3').synthesize('Hola mundo', 'v1', join(dir, 'f'));
    expect(sent).toEqual({ text: 'Hola mundo', model_id: 'eleven_v3' });
  });
});
