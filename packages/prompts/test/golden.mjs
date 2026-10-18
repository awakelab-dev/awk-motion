// Vuelca todos los prompts de los 3 temas base con storyboards reales.
// Uso: node packages/prompts/test/golden.mjs > salida.json  (tras compilar packages/*)
// Sirve para comprobar que un refactor no cambia ni un carácter de los prompts base.
import { readFileSync } from 'node:fs';
import * as P from '../dist/index.js';
import * as S from '../../styles/dist/index.js';

const boards = JSON.parse(readFileSync(new URL('./fixture-storyboards.json', import.meta.url), 'utf8'));
// Hito 1: las funciones reciben el id; hito 2: reciben el ThemeStyle.
const T = (id) => (S.BASE_THEMES ? S.BASE_THEMES[id] : id);
export function dump() {
const out = {};
for (const id of ['dark', 'light', 'pastel']) {
  const b = boards[id];
  const input = {
    theme: id,
    paragraphs: [{ text: 'Hola mundo.', startSec: 0, durationSec: 10 }],
    words: [{ word: 'Hola', start: 0, end: 0.4, paragraph: 0 }, { word: 'mundo.', start: 0.5, end: 1, paragraph: 0 }],
    totalSec: 10,
    clipSec: 124 / 24,
  };
  const o = {
    artDirection: P.artDirection(T(id)),
    storyboardSystem: P.storyboardSystemPrompt(T(id)),
    storyboardUser: P.storyboardUserPrompt(input),
    reviewSystem: P.reviewSystemPrompt(T(id)),
    reviewUser: P.reviewUserPrompt(b, input),
    imageReviewSystem: P.imageReviewSystemPrompt(T(id)),
    reviseShotSystem: P.reviseShotSystemPrompt(T(id)),
    intro: P.introImagePrompt(T(id), b.intro.scene),
    keyframes: b.shots.map((s) => P.keyframeImagePrompt(T(id), s)),
    clips: b.shots.map((s, i) => P.clipVideoPrompt(T(id), i + 1, s, i ? b.shots[i - 1].keyframe.summary : 'intro')),
    themeInfo: (S.BASE_THEMES ?? S.THEMES)[id].info,
    sfx: (S.BASE_THEMES ?? S.THEMES)[id].sfx,
  };
  out[id] = o;
}
return out;
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(JSON.stringify(dump(), null, 1));
