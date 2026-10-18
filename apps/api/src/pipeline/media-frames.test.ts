import { describe, expect, it } from 'vitest';
import { applyMediaFrameRule, mediaKindsByCount, mediaKindsLabel, type Shot } from '@wilox/shared';
import { BASE_THEMES } from '@wilox/styles';
import { clipVideoPrompt, mediaFrameNames, mediaFrameRuleLine, reviewSystemPrompt, reviseShotSystemPrompt, storyboardSystemPrompt } from '@wilox/prompts';

/** Animación de las imágenes según cuántas haya (hito 7, ADR-080). */
const shot = (kinds: ('video' | 'still')[]): Shot => ({
  anchorWordIndex: 0,
  pfc: 'x',
  idea: 'x',
  title: 'X',
  keyframe: {
    layout: 'x',
    scene: 'x',
    summary: 'x',
    texts: [],
    mediaFrames: kinds.map((kind, i) => ({ kind, subject: `s${i}` })),
    repeatedItems: 0,
  },
  animation: [],
  endState: 'x',
  sound: 'x',
});

describe('animación de las imágenes', () => {
  it('tabla por cantidad: 1 → V, 2 → VF, 3 → VFV, 4 → FFFF', () => {
    expect(mediaKindsByCount(0)).toEqual([]);
    expect(mediaKindsByCount(1)).toEqual(['video']);
    expect(mediaKindsByCount(2)).toEqual(['video', 'still']);
    expect(mediaKindsByCount(3)).toEqual(['video', 'still', 'video']);
    expect(mediaKindsByCount(4)).toEqual(['still', 'still', 'still', 'still']);
  });

  it('«según cuántas haya» corrige lo que Opus decidió distinto y dice qué planos cambió', () => {
    const shots = [shot(['video']), shot(['video', 'still', 'video', 'still']), shot(['still', 'video', 'video']), shot([])];
    expect(applyMediaFrameRule(shots, 'byCount')).toEqual([1, 2]);
    expect(shots.map(mediaKindsLabel)).toEqual(['V', 'FFFF', 'VFV', '']);
    // Aplicarla dos veces no cambia nada más.
    expect(applyMediaFrameRule(shots, 'byCount')).toEqual([]);
  });

  it('«la decide Opus» (o sin regla) no toca nada', () => {
    const shots = [shot(['video', 'still', 'video', 'still'])];
    expect(applyMediaFrameRule(shots, 'opus')).toEqual([]);
    expect(applyMediaFrameRule(shots, undefined)).toEqual([]);
    expect(mediaKindsLabel(shots[0])).toBe('VFVF');
  });

  it('la regla fija va a Opus solo en los temas con fotos y «según cuántas haya»', () => {
    const pastel = BASE_THEMES.pastel;
    expect(mediaFrameRuleLine(pastel)).toBe('');
    expect(mediaFrameRuleLine({ ...BASE_THEMES.dark, mediaFrameRule: 'byCount' })).toBe('');
    const byCount = { ...pastel, mediaFrameRule: 'byCount' as const };
    const line = mediaFrameRuleLine(byCount);
    expect(line).toContain('4: all four stills');
    expect(line).toContain('OVERRIDES any media-frame rule in the STYLE NOTES');
    for (const p of [storyboardSystemPrompt(byCount), reviewSystemPrompt(byCount), reviseShotSystemPrompt(byCount)]) expect(p).toContain(line.trim());
    // Sin la regla, los prompts son los de siempre.
    expect(storyboardSystemPrompt(pastel)).not.toContain('MEDIA-FRAME RULE (fixed by the app');
  });
});

describe('prompt del clip con marcos (ADR-081)', () => {
  const pastel = BASE_THEMES.pastel;
  it('nombra cada marco por su lugar, o por su orden si el storyboard no lo trae', () => {
    expect(mediaFrameNames([{}])).toEqual(['the']);
    expect(mediaFrameNames([{}, {}])).toEqual(['first (left or top)', 'second (right or bottom)']);
    expect(mediaFrameNames([{}, {}, {}])).toEqual(['left (first)', 'middle (second)', 'right (third)']);
    expect(mediaFrameNames([{ position: 'Top' }, { position: 'bottom' }])).toEqual(['top', 'bottom']);
    expect(mediaFrameNames([{}, {}, {}, {}])[3]).toBe('fourth (reading order)');
  });

  it('video en movimiento hasta el final, foto quieta y sin el último segundo calmo', () => {
    const sh = shot(['video', 'still', 'video']);
    sh.keyframe.mediaFrames[1].position = 'centre';
    const p = clipVideoPrompt(pastel, 3, sh, 'start');
    expect(p).toContain('The LEFT (FIRST) media frame is LIVE-ACTION VIDEO');
    expect(p).toContain('The CENTRE media frame is a STILL PHOTO');
    expect(p).toContain('until the very last frame of the clip');
    expect(p).toContain('by about 2.0 s');
    expect(p).not.toContain('The final second is calm');
    expect(p).toMatch(/AVOID: .*video frames frozen like photos, motion inside the still photo frames\.$/);
  });

  it('solo fotos: se mantiene el final calmo; sin marcos el prompt es el de siempre', () => {
    const fotos = clipVideoPrompt(pastel, 2, shot(['still', 'still', 'still', 'still']), 'start');
    expect(fotos).toContain('The final second is calm');
    expect(fotos).not.toContain('video frames frozen like photos');
    expect(fotos).not.toContain('keeps moving');
    const nada = clipVideoPrompt(pastel, 2, shot([]), 'start');
    expect(nada).not.toContain('MEDIA FRAMES');
    expect(nada.endsWith(pastel.avoid)).toBe(true);
  });
});
