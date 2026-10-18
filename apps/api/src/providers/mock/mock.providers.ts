import type { Shot, Storyboard, VoiceOption } from '@wilox/shared';
import { CLIP_FRAMES, FPS, OUTPUT_HEIGHT, OUTPUT_WIDTH } from '@wilox/shared';
import type { WordTime } from '../../pipeline/align.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { env, repoPath } from '../../config/env.js';
import { ffmpeg, FIT_2K } from '../../media/ffmpeg.js';
import type {
  ImagePort,
  ImageRequest,
  ImageResult,
  LlmContent,
  LlmPort,
  OnItem,
  TimingPort,
  TtsPort,
  TtsOptions,
  TtsResult,
  VideoPort,
  VideoRequest,
  VideoResult,
} from '../ports.js';

/**
 * Proveedores de desarrollo (GENERATION_MODE=mock): todo local con ffmpeg, sin red ni créditos.
 * Sirven para probar la UI, la aprobación y el render de punta a punta.
 */
/**
 * Esperas simuladas (hito 5): con MOCK_SPEED=1, locución 0,6 s, Opus 0,8 s, imagen 1,5 s y clip 8 s,
 * para probar la cola y los lotes sin gastar. MOCK_SPEED=0 las quita.
 */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms * env.MOCK_SPEED));

/**
 * Fallos forzados (hito 5, solo en mock), con marcas en el texto de la locución:
 * - `[mock:fallar]`: la locución de ese párrafo falla una vez (error definitivo: el video queda con
 *   error y Reintentar lo continúa).
 * - `[mock:429]`: la locución responde dos veces "HTTP 429" (la cola espera y reintenta sola).
 * - `[mock:marcos]` (hito 7): el storyboard pone 1, 2, 3, 4, 1… marcos en los planos, todos como video, para
 *   probar la animación de las imágenes según cuántas haya (en un tema con fotos).
 * - `[mock:largo]` (hito 10): planos cada 13 s, para probar «Dividir en dos» (ADR-130).
 */
const failedOnce = new Set<string>();
const limited = new Map<string, number>();

const PALETTE = ['0x19F7F1', '0xEE8C7A', '0x5FBFA8', '0x9B8FD9', '0xF2C45A', '0x72A3C4', '0x0B93AA'];

export class MockTts implements TtsPort, TimingPort {
  async listVoices(): Promise<VoiceOption[]> {
    return [{ id: 'mock-voice', name: 'Voz de prueba (tono)', description: 'mock' }];
  }

  async synthesize(text: string, _voiceId: string, outBase: string, opts?: TtsOptions): Promise<TtsResult> {
    await wait(600);
    if (text.includes('[mock:fallar]') && !failedOnce.has(text)) {
      failedOnce.add(text);
      throw new Error('Mock: fallo forzado de la locución ([mock:fallar]). Pulsa Reintentar.');
    }
    if (text.includes('[mock:429]') && (limited.get(text) ?? 0) < 2) {
      limited.set(text, (limited.get(text) ?? 0) + 1);
      throw Object.assign(new Error('HTTP 429 en mock: rate limit ([mock:429])'), { retryAfterMs: 2000 });
    }
    const words = text.split(/\s+/).filter(Boolean);
    const per = 0.36;
    const dur = Math.max(1, words.length * per);
    const path = `${outBase}.wav`;
    await ffmpeg([
      '-f', 'lavfi', '-i', `sine=frequency=180:sample_rate=48000:duration=${dur.toFixed(3)}`,
      '-af', 'volume=0.15,aformat=channel_layouts=stereo', '-c:a', 'pcm_s16le', path,
    ]);
    const times: WordTime[] = words.map((w, i) => ({ word: w, start: i * per, end: i * per + per * 0.8 }));
    return { path, words: times, jobId: `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, ...(opts?.model ? { model: opts.model } : {}) };
  }

  async wordTimes(_s: string[], audio: TtsResult): Promise<WordTime[]> {
    return audio.words ?? [];
  }
}

export class MockImages implements ImagePort {
  async generate(requests: ImageRequest[], onItem?: OnItem<ImageResult>): Promise<ImageResult[]> {
    const out: ImageResult[] = [];
    for (const [i, r] of requests.entries()) {
      await wait(1500);
      const color = PALETTE[i % PALETTE.length];
      const path = `${r.outBase}.png`;
      await ffmpeg([
        '-f', 'lavfi', '-i', `color=c=0x011932:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`,
        '-vf', `drawbox=x=${200 + i * 140}:y=420:w=900:h=600:color=${color}@0.9:t=fill,drawbox=x=0:y=1320:w=${OUTPUT_WIDTH}:h=40:color=${color}:t=fill`,
        '-frames:v', '1', '-update', '1', path,
      ]);
      const res = { key: r.key, path, ref: path };
      out.push(res);
      await onItem?.(res);
    }
    return out;
  }
}

/**
 * Clips simulados como tareas asíncronas (hito 5): cada envío crea una tarea con su id en
 * storage/mock/tasks.json (con el total de envíos) y se "termina" a los 8 s × MOCK_SPEED. Tras un
 * reinicio de la API se retoma por su id, como el task_id de MiniMax: así se comprueba que nada se pide
 * (ni se pagaría) dos veces.
 */
export class MockVideo implements VideoPort {
  private file = join(repoPath(env.STORAGE_DIR), 'mock', 'tasks.json');
  private chain: Promise<unknown> = Promise.resolve();

  private async load(): Promise<{ submissions: number; tasks: Record<string, { at: number; outPath: string }> }> {
    if (!existsSync(this.file)) return { submissions: 0, tasks: {} };
    return JSON.parse(await readFile(this.file, 'utf8'));
  }

  private edit<T>(fn: (d: Awaited<ReturnType<MockVideo['load']>>) => T): Promise<T> {
    const p = this.chain.then(async () => {
      const d = await this.load();
      const out = fn(d);
      await mkdir(dirname(this.file), { recursive: true });
      // Escritura atómica: una lectura simultánea nunca ve el archivo a medias.
      await writeFile(`${this.file}.tmp`, JSON.stringify(d, null, 1));
      await rename(`${this.file}.tmp`, this.file);
      return out;
    });
    this.chain = p.catch(() => undefined);
    return p;
  }

  async generate(requests: VideoRequest[], onItem?: OnItem<VideoResult>): Promise<VideoResult[]> {
    const out: VideoResult[] = [];
    const d = (CLIP_FRAMES / FPS).toFixed(6);
    for (const r of requests) {
      let id = r.resumeTaskId;
      let at = Date.now();
      const known = id ? await this.edit((x) => x.tasks[id!]) : undefined;
      if (known) at = known.at;
      else {
        id = `mock-${randomUUID()}`;
        await this.edit((x) => {
          x.submissions += 1;
          x.tasks[id!] = { at, outPath: r.outPath };
        });
        await r.onSubmitted?.(id);
      }
      const left = at + 8000 * env.MOCK_SPEED - Date.now();
      if (left > 0) await new Promise((res) => setTimeout(res, left));
      await ffmpeg([
        '-loop', '1', '-t', d, '-i', r.start.path,
        '-loop', '1', '-t', d, '-i', r.end.path,
        // Audio nativo simulado (hito 6): como MiniMax, AAC 32 kHz estéreo; un "whoosh" de ruido rosa.
        '-f', 'lavfi', '-t', d, '-i', `anoisesrc=color=pink:amplitude=${(0.15 + Math.random() * 0.5).toFixed(2)}:sample_rate=32000`,
        '-filter_complex', `[0:v]${FIT_2K},fps=${FPS},format=yuv420p[a];[1:v]${FIT_2K},fps=${FPS},format=yuv420p[b];[a][b]xfade=transition=smoothleft:duration=3:offset=1,trim=end_frame=${CLIP_FRAMES}[v];[2:a]aformat=channel_layouts=stereo,afade=t=in:d=1,afade=t=out:st=1.5:d=2.5[s]`,
        '-map', '[v]', '-map', '[s]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '32000', r.outPath,
      ]);
      const res = { key: r.key, path: r.outPath, jobId: id };
      out.push(res);
      await onItem?.(res);
    }
    return out;
  }
}

/** Storyboard determinista: una PFC al inicio y luego una cada ~7 s. Imita también las revisiones. */
export class MockLlm implements LlmPort {
  async structured(_system: string, user: LlmContent, schema: Record<string, unknown>): Promise<unknown> {
    await wait(800);
    const props = Object.keys((schema.properties as Record<string, unknown>) ?? {});
    const text = typeof user === 'string' ? user : user.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
    // Sugerencia para un clip a partir de las observaciones (T11, ADR-122).
    if (props.includes('actions') && props.includes('summary')) {
      const first = text.match(/CLIENT OBSERVATIONS:\n- \[[^\]]+\] [^:]+: (.+)/)?.[1] ?? '';
      return {
        summary: `Mock: el cliente pide «${first.slice(0, 80)}».`,
        actions: [
          { target: 'end', instruction: `Mock: aplicar «${first.slice(0, 60)}» en el fotograma final.`, modelInstruction: '', why: 'Mock: lo pide la observación sobre el fotograma.' },
          { target: 'clip', instruction: 'Mock: que el título entre más lento y suave; el fondo quieto.', modelInstruction: 'Mock: smoother, slower slide-in of the title; keep the background still.', why: 'Mock: movimiento más suave.' },
        ],
        notes: 'Mock: sin notas.',
      };
    }
    if (props.includes('suggestions')) {
      return {
        reviews: [0, 1].map((index) => ({ index, verdict: 'ok', issues: '' })),
        summary: 'Mock: el tema se ve coherente.',
        suggestions: [{ field: 'avoid', reason: 'Mock: sugerencia de ejemplo.', value: 'clutter, neon, distorted or misspelled letters, camera shake at the end.' }],
      };
    }
    if (props.includes('style')) {
      const name = text.match(/THEME NAME: (.+)/)?.[1] ?? 'Mock';
      // Una entrada por corrección numerada (ADR-042).
      const block = text.split('CLIENT CORRECTIONS')[1]?.split('\n\n')[0] ?? '';
      const corrections = [...block.matchAll(/^(\d+)\. (?:\[NEW\] )?(.+)$/gm)].map((m) => ({ number: Number(m[1]), how: `Mock: aplicada «${m[2].slice(0, 60)}».` }));
      return {
        corrections,
        notes: 'Mock: tema generado sin Opus.',
        style: {
          description: `${name} · tema de prueba (mock)`,
          swatches: ['#101820', '#1f3a5f', '#f2aa4c', '#ffffff'],
          videoBible: `STYLE BIBLE "${name.toUpperCase()}" (keep identical across all clips): mock style, 16:9, 2K, flat 2D typography.`,
          imageBible: 'Single still frame from a mock motion graphics video, 16:9, flat 2D typography. Calm, balanced composition.',
          clipBible: 'STYLE: mock motion graphics, smooth morphs.',
          avoid: 'clutter, distorted or misspelled letters, camera shake at the end.',
          soundHint: 'whooshes, soft pops',
          usesMediaFrames: false,
          directorNotes: 'Mock notes.',
          imagery: 'simple flat objects that show the concept',
          sfx: { opener: 'whoosh', accents: ['pop', 'sparkle', 'tick'], hit: 'impact' },
        },
      };
    }
    if (props.includes('rows') && props.includes('warnings')) {
      // Importar guion (hito 5): filas desde una tabla "| locución | escena |" o un párrafo por fila.
      const doc = (text.split(/DOCUMENT \(Word[^\n]*\n|EXTRACTED TEXT[^\n]*\n/)[1] ?? '').split('\nReturn the rows')[0];
      const table = doc.split('\n').filter((l) => l.startsWith('|')).map((l) => l.split('|').map((c) => c.trim()).filter(Boolean));
      const rows = table.length > 1
        ? table.slice(1).map((c) => ({ voice: c[0] ?? '', scene: c[1] ?? '', expression: c[2] ?? '', layout: '', voiceTag: c[2] ? 'calm' : '' }))
        : doc.split(/\n\s*\n/).map((p) => ({ voice: p.replace(/\s+/g, ' ').trim(), scene: '', expression: '', layout: '', voiceTag: '' }));
      return { rows: rows.filter((r) => r.voice), warnings: ['Mock: guion leído sin Opus.'] };
    }
    if (props.includes('rules') && props.includes('explanation')) {
      // Pronunciación (hito 5): deletrea las siglas del párrafo.
      const para = text.match(/PARAGRAPH \(as written in the video\):\n(.+)/)?.[1] ?? '';
      const acr = [...new Set(para.match(/\b[A-ZÁÉÍÓÚÑ]{2,}\b/g) ?? [])];
      return { rules: acr.map((a) => ({ match: a, say: a.split('').join(', ') })), explanation: acr.length ? `Mock: se deletrean ${acr.join(', ')}.` : 'Mock: se vuelve a locutar.' };
    }
    if (props.includes('choreography')) {
      return { startElements: 'Mock: inicio.', endElements: 'Mock: fin.', choreography: 'Mock: the elements of the start frame slide out to the left while the shapes of the end frame slide in from the right.' };
    }
    if (props.includes('intermediate')) {
      // «Dividir en dos» (ADR-130): el intermedio es el plano con solo su primer texto.
      const m = text.match(/CURRENT SHOT \(its keyframe stays as the end of clip B\):\n([\s\S]+?)\n\nPREVIOUS KEYFRAME/);
      const shot = JSON.parse(m![1]) as Shot;
      const first = shot.keyframe.texts.slice(0, 1);
      return {
        intermediate: { ...shot, title: `${shot.title} A`, keyframe: { ...shot.keyframe, layout: `${shot.keyframe.layout} (intermediate)`, scene: `${shot.keyframe.scene} (intermediate)`, summary: `intermediate of ${shot.keyframe.summary}`, texts: first } },
        second: { animation: [{ from: 0, to: 3, action: 'the rest builds' }, { from: 3, to: 5, action: 'settles' }], endState: shot.endState, sound: shot.sound },
        explanation: 'Mock: el intermedio muestra solo el primer texto.',
      };
    }
    if (props.includes('reviews')) {
      const idx = [...text.matchAll(/^K(\d{2}) · /gm)].map((m) => Number(m[1]));
      return { reviews: idx.map((index) => ({ index, verdict: 'ok', issues: '', revisedScene: '' })) };
    }
    if (props.includes('anchorWordIndex')) {
      const m = text.match(/CURRENT SHOT:\n([\s\S]+?)\n\nPREVIOUS KEYFRAME/);
      const shot = JSON.parse(m![1]) as Shot;
      return { ...shot, keyframe: { ...shot.keyframe, scene: `${shot.keyframe.scene} (revised)` } };
    }
    const board = this.board(text);
    if (props.includes('notes')) return { notes: ['Mock: sin cambios.'], storyboard: board };
    return board;
  }

  private board(user: string): Storyboard {
    const m = user.match(/WORD TIMINGS \(index:word@seconds\):\n(.+)\n/);
    const words = (m?.[1] ?? '')
      .split(' ')
      .map((t) => {
        const [idx, rest] = t.split(/:(.+)/);
        const at = rest?.lastIndexOf('@') ?? -1;
        return { i: Number(idx), word: rest?.slice(0, at) ?? '', t: Number(rest?.slice(at + 1)) };
      })
      .filter((w) => !Number.isNaN(w.i));
    const anchors: typeof words = [];
    // `[mock:largo]` (hito 10, ADR-130): planos cada 13 s, para probar «Dividir en dos».
    const gap = user.includes('[mock:largo]') ? 13 : 7;
    for (const w of words) if (!anchors.length || w.t - anchors[anchors.length - 1].t >= gap) anchors.push(w);
    const frames = user.includes('[mock:marcos]');
    return {
      intro: { scene: 'only the background, calm' },
      shots: anchors.map((a, k) => {
        const txt = words.slice(a.i, a.i + 3).map((w) => w.word.replace(/[^\p{L}\p{N}]/gu, '')).join(' ').toUpperCase();
        return {
          anchorWordIndex: a.i,
          pfc: txt,
          idea: txt,
          title: `MOCK ${k + 1}`,
          keyframe: { layout: k % 2 ? 'centred title' : 'title left', scene: `title "${txt}" centered`, summary: `title ${txt}`, texts: [txt], mediaFrames: frames ? Array.from({ length: (k % 4) + 1 }, (_, j) => ({ kind: 'video' as const, subject: `mock footage ${j + 1}` })) : [], repeatedItems: 0 },
          animation: [
            { from: 0, to: 2, action: 'previous elements exit' },
            { from: 2, to: 4, action: 'title builds' },
            { from: 4, to: 5, action: 'settles' },
          ],
          endState: 'title centered, calm',
          sound: 'whoosh, pop',
        };
      }),
    };
  }
}
