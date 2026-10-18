#!/usr/bin/env node
/**
 * Vista previa del storyboard sin gastar en video: reutiliza la voz y los tiempos de una
 * generación existente y ejecuta solo Opus (borrador → revisión → prompts de imagen/clip).
 *
 *   node apps/api/scripts/storyboard-preview.mjs draft  <carpeta_run> <carpeta_salida>
 *   node apps/api/scripts/storyboard-preview.mjs review <carpeta_salida>
 *   node apps/api/scripts/storyboard-preview.mjs vision <carpeta_salida>   (lee K00.png… de la carpeta)
 *
 * Requiere haber compilado (pnpm build) y ANTHROPIC_API_KEY en el .env de la raíz.
 */
import { config } from 'dotenv';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { StoryboardSchema, StoryboardReviewSchema, ImageReviewSchema, CLIP_FRAMES, FPS } from '@wilox/shared';
import * as P from '@wilox/prompts';
import { BASE_THEMES } from '@wilox/styles';
// Hito 2: los prompts reciben el ThemeStyle; este script solo trabaja con los temas base.
const TH = (id) => BASE_THEMES[id];
import { AnthropicLlm } from '../dist/providers/api/anthropic.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
config({ path: join(ROOT, '.env'), quiet: true });
const llm = new AnthropicLlm(process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_MODEL || 'claude-opus-5-5', process.env.ANTHROPIC_EFFORT || 'high');

const toApi = (schema) => {
  const strip = (n) => {
    if (Array.isArray(n)) return n.map(strip);
    if (n && typeof n === 'object') {
      const o = {};
      for (const [k, v] of Object.entries(n)) {
        if (['$schema', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format'].includes(k)) continue;
        o[k] = strip(v);
      }
      if (o.type === 'object') o.additionalProperties = false;
      return o;
    }
    return n;
  };
  return strip(z.toJSONSchema(schema, { target: 'draft-2020-12' }));
};
const ask = async (schema, system, user) => schema.parse(await llm.structured(system, user, toApi(schema)));
const nn = (i) => String(i).padStart(2, '0');
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

function writePrompts(out, input, board) {
  const theme = TH(input.theme);
  const shots = board.shots;
  writeFileSync(join(out, 'K00_imagen.md'), P.introImagePrompt(theme, board.intro.scene));
  shots.forEach((sh, i) => {
    writeFileSync(join(out, `K${nn(i + 1)}_imagen.md`), P.keyframeImagePrompt(theme, sh));
    const start = i === 0 ? 'only the style background, no text yet' : shots[i - 1].keyframe.summary;
    writeFileSync(join(out, `clip${nn(i + 1)}_video.md`), P.clipVideoPrompt(theme, i + 1, sh, start));
  });
  const words = input.words;
  const lines = shots.map((sh, i) => `K${nn(i + 1)} @${words[sh.anchorWordIndex]?.start.toFixed(2)}s · ${sh.idea} · [${sh.keyframe.layout}] · ${sh.keyframe.scene.split(/\s+/).length} palabras`);
  writeFileSync(join(out, 'resumen.txt'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'draft') {
  const run = resolve(a);
  const out = resolve(b);
  mkdirSync(out, { recursive: true });
  const st = readJson(join(run, 'state.json'));
  const input = {
    theme: st.theme,
    paragraphs: st.paragraphs,
    words: readJson(join(run, 'prompts', 'tiempos_por_palabra.json')),
    totalSec: st.durationSec,
    clipSec: CLIP_FRAMES / FPS,
  };
  writeFileSync(join(out, 'input.json'), JSON.stringify(input));
  const t0 = Date.now();
  const board = await ask(StoryboardSchema, P.storyboardSystemPrompt(TH(input.theme)), P.storyboardUserPrompt(input));
  writeFileSync(join(out, 'storyboard_borrador.json'), JSON.stringify(board, null, 2));
  console.log(`borrador en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  writePrompts(out, input, board);
} else if (cmd === 'review') {
  const out = resolve(a);
  const input = readJson(join(out, 'input.json'));
  const draft = readJson(join(out, 'storyboard_borrador.json'));
  const t0 = Date.now();
  const r = await ask(StoryboardReviewSchema, P.reviewSystemPrompt(TH(input.theme)), P.reviewUserPrompt(draft, input));
  writeFileSync(join(out, 'storyboard.json'), JSON.stringify(r.storyboard, null, 2));
  writeFileSync(join(out, 'revision_director.md'), r.notes.map((n) => `- ${n}`).join('\n') + '\n');
  console.log(`revisión en ${((Date.now() - t0) / 1000).toFixed(0)} s\n` + r.notes.map((n) => `- ${n}`).join('\n'));
  if (!TH(input.theme).usesMediaFrames) r.storyboard.shots.forEach((s) => (s.keyframe.mediaFrames = []));
  writePrompts(out, input, r.storyboard);
} else if (cmd === 'vision') {
  const out = resolve(a);
  const input = readJson(join(out, 'input.json'));
  const board = readJson(join(out, existsSync(join(out, 'storyboard.json')) ? 'storyboard.json' : 'storyboard_borrador.json'));
  const content = [{ type: 'text', text: 'Review each keyframe below (brief, then image). Return one review per keyframe, using its index.' }];
  const all = [{ index: 0, label: 'Intro', scene: board.intro.scene, texts: [] }, ...board.shots.map((s, i) => ({ index: i + 1, label: s.pfc, scene: s.keyframe.scene, texts: s.keyframe.texts }))];
  for (const k of all) {
    const png = join(out, `K${nn(k.index)}.png`);
    if (!existsSync(png)) continue;
    const jpg = join(out, `_K${nn(k.index)}.jpg`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', png, '-vf', 'scale=1344:-2', '-q:v', '3', jpg]);
    content.push({ type: 'text', text: P.imageReviewItemText(k.index, k.label, k.scene, k.texts) });
    content.push({ type: 'image', mediaType: 'image/jpeg', base64: readFileSync(jpg).toString('base64') });
  }
  const r = await ask(ImageReviewSchema, P.imageReviewSystemPrompt(TH(input.theme)), content);
  writeFileSync(join(out, 'revision_visual.json'), JSON.stringify(r, null, 2));
  for (const rv of r.reviews) console.log(`K${nn(rv.index)} ${rv.verdict}${rv.issues ? ' · ' + rv.issues : ''}`);
} else {
  console.log('uso: storyboard-preview.mjs draft <run> <salida> | review <salida> | vision <salida>');
}
