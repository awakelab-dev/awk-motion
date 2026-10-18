import { activeCorrections, SFX_NAMES, STANDARD_TEST, type Shot, type ThemeBrief, type ThemeStyle } from '@wilox/shared';
import { BASE_THEMES } from '@wilox/styles';
import { artDirection, clipVideoPrompt, imageReviewSystemPrompt, keyframeImagePrompt, referenceNote, typographyNote } from './index.js';

/**
 * Estudio de temas (hito 2). Opus convierte una descripción + imágenes de referencia en un
 * ThemeStyle completo, y la prueba estándar (frames A/B + clip A→B) usa exactamente las mismas
 * plantillas que el pipeline (keyframeImagePrompt / clipVideoPrompt), para que lo que se ve en la
 * prueba sea lo que saldrá en los videos.
 */

/** Regla de marcos de medios (docs/04_aprendizajes.md) para temas con fotos/video reales. */
export const MEDIA_FRAME_RULE =
  'Media-frame rule (MANDATORY): alternate video and still starting with video — 1 frame: video; 2: video + still; 3: video + still + video; 4: video + still + video + still (never more than 4 frames). For video frames describe a continuous action for the whole clip, and compose them mid-action in the keyframe. Nobody looks at the camera. All media frames in one keyframe share the same shape and size.';

export function themeProposalSystemPrompt(): string {
  const example = BASE_THEMES.pastel;
  return `You are the design director of "Micro Cápsulas", a studio that produces short educational videos in Chilean Spanish with premium motion graphics and kinetic typography. You create a NEW visual style ("theme") from a description written by the client and, when attached, reference images. Your output is a JSON theme that a fixed production pipeline will use for every video in that style.

HOW THE PIPELINE USES EACH FIELD (all fields in English except "description"):
- imageBible: prepended to every GPT Image 2.5 keyframe prompt. Starts with "Single still frame from …", 16:9, ultra-crisp 2K; defines background, palette with hex codes, typography (always FLAT 2D text, the font family style and weights, text colors), the imagery/rendering technique and materials; ends with "Calm, balanced composition." 90-160 words. Never describe a specific scene.
- videoBible: the same identity for MiniMax H3 video, starting with 'STYLE BIBLE "<NAME IN CAPS>" (keep identical across all clips):' and adding how things MOVE (motion language, easing, transitions). 110-200 words.
- clipBible: a SHORT version (50-90 words) starting with "STYLE:" used in every 5-second clip prompt (the look already comes from the start/end keyframes, so focus on identity + motion vocabulary).
- avoid: comma-separated list of what the style forbids (other styles' signatures that would contaminate it, wrong colors), always ending with "clutter, distorted or misspelled letters, camera shake at the end."
- directorNotes: STYLE NOTES for the art director (Opus) who writes each storyboard. They OVERRIDE the general art-direction principles below when they disagree, so write here everything that makes this style unique: typography rules (which families/weights, whether an italic or serif accent is allowed or forbidden), what the single accent treatment is, what the rich imagery of every frame is, how enumerations of 2-4 items look (identical containers native to the style, each with its own visual and caption; never bare numbers), and any color-coding rule. ${'If the style uses real photos or footage, include this rule verbatim: "' + MEDIA_FRAME_RULE + '"'} If it does NOT, say "NO realistic photos or footage; mediaFrames must always be an empty array." 70-170 words.
- imagery: one sentence, the visual vocabulary that makes each frame rich (principle RICHNESS): what kinds of images/objects depict a concept in this style, and how enumerations get one identical visual per item.
- usesMediaFrames: true only if the style shows REAL photorealistic photos/footage inside frames or masks; false for illustration, 3D objects, icons, paper, clay, etc.
- soundHint: short list of synthesized sound effects that match the style (no music, no voice).
- sfx: the synthesizer profile. Available generators: ${SFX_NAMES.join(', ')}. opener = start of every clip, accents = 3-4 sounds on motion peaks, hit = strongest peak. Soft, playful styles lean on whoosh/pop/bubble/tick/sparkle; premium/tech styles on sweep/whoosh/impact/ping/pulse/shatter.
- description: Spanish, max 120 characters, for the theme picker (e.g. "Acuarela editorial · manchas de color, papel texturado y trazos a mano").
- swatches: 4-6 hex colors of the theme, background first, accent last.

THE PIPELINE ADDS THESE PRINCIPLES TO EVERY STORYBOARD (your directorNotes may override them for this style):
${artDirection({ ...example, imagery: '<imagery of the style>' })}

RULES:
- Text in the frames is always FLAT 2D, perfectly legible, exact Spanish spelling; the pipeline lists the literal words. Never design a style whose typography is 3D, distorted, handwritten-illegible or made of objects.
- Everything must be producible by GPT Image 2.5 (stills) and MiniMax H3 (5-second image-to-video): be concrete (materials, lighting, hex colors, font style) instead of vague adjectives.
- Keep the style coherent across 2 hours of videos on any subject: no subject-specific objects in the bibles (the scenes bring the subject), only the look.
- When reference images are attached, extract their palette, rendering technique, materials, lighting, composition density and typographic mood; describe them in your own words (never mention "the reference"). Follow the client's description where it conflicts with the images.
- Respect the client's explicit options (palette, typography, photos vs objects) exactly, unless a CLIENT CORRECTION changes the palette or the typography.
- CLIENT CORRECTIONS (when listed) are changes the client asked for after seeing earlier versions. They OVERRIDE the description, the palette/typography options and the reference images wherever they conflict, and a later correction overrides an earlier one. Every active correction must be visible in the result. The only exception is photos vs objects, which is a fixed switch: if a correction asks for the opposite, keep the switch and say so in "corrections".

FORMAT EXAMPLE ONLY (the existing "Pastel Kinetic" style — copy its structure and level of detail, never its look):
imageBible: ${example.imageBible}
clipBible: ${example.clipBible}
avoid: ${example.avoid}
directorNotes: ${example.directorNotes}
imagery: ${example.imagery}

In "notes" (Spanish, 2-4 sentences) explain what you took from the description and the references and the key decisions.
In "corrections" add one entry per numbered CLIENT CORRECTION (same number): in Spanish, one sentence saying which fields you changed and how to satisfy it, or why it was not possible. Empty array when there are no corrections.`;
}

/**
 * Mensaje de la propuesta. Sin `current`: el tema se diseña desde cero con la descripción y las
 * correcciones activas. Con `current`: Opus revisa el tema vigente para aplicar la corrección nueva
 * (`newCorrectionId`) sin perder las anteriores (ADR-042).
 */
export function themeProposalUserText(
  brief: ThemeBrief,
  refCount: number,
  opts: { current?: ThemeStyle; newCorrectionId?: string; note?: string } = {},
): string {
  const options = [
    brief.palette ? `Palette requested: ${brief.palette}` : '',
    brief.typography ? `Typography requested: ${brief.typography}` : '',
    brief.imageryMode === 'photos'
      ? 'Imagery: REAL photos/footage inside frames (usesMediaFrames = true).'
      : brief.imageryMode === 'objects'
        ? 'Imagery: NO real photos — only objects, illustration or 3D (usesMediaFrames = false).'
        : 'Imagery: decide whether it uses real photos/footage or only objects/illustration.',
  ].filter(Boolean);
  const corrections = activeCorrections(brief);
  const list = corrections.map((c, i) => `${i + 1}. ${c.id === opts.newCorrectionId ? '[NEW] ' : ''}${c.text.trim()}`).join('\n');
  const block = corrections.length
    ? `

CLIENT CORRECTIONS (oldest first). They OVERRIDE the description, the options and the references wherever they conflict; a later correction overrides an earlier one:
${list}`
    : '';
  const base = `THEME NAME: ${brief.name}

CLIENT DESCRIPTION (Spanish):
${brief.description}

${options.join('\n')}${block}
${refCount ? `\n${refCount} reference image${refCount > 1 ? 's are' : ' is'} attached below.` : '\nNo reference images.'}`;
  if (opts.current) {
    const newOne = corrections.findIndex((c) => c.id === opts.newCorrectionId);
    const change =
      newOne >= 0
        ? `Apply the NEW correction #${newOne + 1} and keep every earlier correction satisfied.`
        : opts.note
          ? `REQUESTED CHANGE (Spanish or English): ${opts.note}`
          : 'Make sure every correction is satisfied.';
    return `${base}

CURRENT THEME (revise it; keep what works):
${JSON.stringify(opts.current, null, 1)}

${change}

Return the full revised theme.`;
  }
  return `${base}

Design the complete theme${corrections.length ? ' from the description and ALL the corrections above' : ''}. Return only the JSON.`;
}

// ------------------------------------------------------------------ prueba estándar

/**
 * Los dos planos de la prueba estándar, idénticos para todo tema (solo cambia si usa fotos
 * reales o no). Se ensamblan con las mismas plantillas que el pipeline.
 */
export function standardTestShots(t: ThemeStyle): { A: Shot; B: Shot } {
  const photos = t.usesMediaFrames;
  const T = STANDARD_TEST;
  const A: Shot = {
    anchorWordIndex: 0,
    pfc: T.titleA,
    idea: 'Portada',
    title: 'COVER',
    keyframe: {
      layout: photos ? 'title block left, one large media frame right' : 'title block left, one hero object right',
      scene: photos
        ? `Cover frame. The title "${T.titleA}" is the dominant hero, huge and bold, in the left half; the subtitle "${T.subtitleA}" sits below it, much smaller and lighter, with the style's single accent treatment on "síntesis". In the right third, one large rounded media frame shows hands writing in a notebook on a bright wooden desk, mid-action. Balanced, generous margins.`
        : `Cover frame. The title "${T.titleA}" is the dominant hero, huge and bold, in the left half; the subtitle "${T.subtitleA}" sits below it, much smaller and lighter, with the style's single accent treatment on "síntesis". In the right third, one prominent hero object rendered in the style: a stylised lightbulb that embodies an idea. Balanced, generous margins.`,
      summary: photos
        ? `title "${T.titleA}" left with subtitle, one large media frame of hands writing on the right`
        : `title "${T.titleA}" left with subtitle, one hero lightbulb object on the right`,
      texts: [T.titleA, T.subtitleA],
      mediaFrames: photos ? [{ kind: 'video', subject: 'hands writing in a notebook on a bright wooden desk' }] : [],
      repeatedItems: 0,
    },
    animation: [],
    endState: 'calm cover',
    sound: t.soundHint,
  };
  const items = T.items;
  const B: Shot = {
    anchorWordIndex: 0,
    pfc: T.titleB,
    idea: 'Enumeración de tres elementos',
    title: 'THREE ITEMS',
    keyframe: {
      layout: 'small title on top, row of three equal items',
      scene: photos
        ? `Enumeration of three equal items in one horizontal row, centred: three identical rounded media frames of the same shape, size and spacing, each with its own photo and a short caption below it: "${items[0]}" (a hand placing a ceramic coffee cup on a table), "${items[1]}" (a green potted plant on a sunny windowsill), "${items[2]}" (a person walking through a sunlit corridor, seen from behind). A small title "${T.titleB}" above the row.`
        : `Enumeration of three equal items in one horizontal row, centred: three identical containers native to the style (same shape, size and spacing), each holding its own simple generic icon rendered in the style and a short caption below it: "${items[0]}" (a leaf), "${items[1]}" (a star), "${items[2]}" (a gear). A small title "${T.titleB}" above the row.`,
      summary: photos
        ? `small title "${T.titleB}" above a row of three equal media frames with captions`
        : `small title "${T.titleB}" above a row of three equal icon containers with captions`,
      texts: [T.titleB, ...items],
      mediaFrames: photos
        ? [
            { kind: 'video', subject: 'a hand placing a ceramic coffee cup on a table' },
            { kind: 'still', subject: 'a green potted plant on a sunny windowsill' },
            { kind: 'video', subject: 'a person walking through a sunlit corridor, seen from behind' },
          ]
        : [],
      repeatedItems: 3,
    },
    animation: [
      { from: 0, to: 1.2, action: `The cover title "${T.titleA}" stretches and morphs, its letters shrinking and sliding up to become the small title "${T.titleB}"; the subtitle dissolves in the style's own way.` },
      { from: 1.2, to: 2.8, action: `The hero visual on the right splits into three identical items that glide into one centred row with an elastic settle, each revealing its own visual.` },
      { from: 2.8, to: 4.0, action: `The captions "${items.join('", "')}" build under each item one after another, in sync.` },
      { from: 4.0, to: 5.0, action: 'Everything settles; only a subtle ambient motion of the background remains.' },
    ],
    endState: `Small title "${T.titleB}" on top and the row of three equal items with their captions, perfectly still and balanced.`,
    sound: t.soundHint,
  };
  return { A, B };
}

export function testFramePrompt(t: ThemeStyle, key: 'A' | 'B', refCount: number, sheets = 0): string {
  const { A, B } = standardTestShots(t);
  // Láminas tipográficas del tema (ADR-094) detrás de las referencias; sin ellas, el prompt de siempre.
  return (
    keyframeImagePrompt(t, key === 'A' ? A : B) +
    referenceNote(refCount, { first: sheets > 0 }) +
    typographyNote(t.typefaces?.filter((f) => f.status === 'ready') ?? [], sheets, refCount > 0)
  );
}

export function testClipPrompt(t: ThemeStyle): string {
  const { A, B } = standardTestShots(t);
  return clipVideoPrompt(t, 1, B, A.keyframe.summary);
}

export function studioReviewSystemPrompt(t: ThemeStyle, brief: ThemeBrief | undefined, refCount: number): string {
  return `${imageReviewSystemPrompt(t)}

STUDIO TEST — you are also the design director validating a NEW theme ("${t.info.name}") with the standard test used for every theme: frame A (cover: title + subtitle + one hero visual) and frame B (enumeration: small title + three equal items with captions). The briefs are FIXED on purpose (so themes can be compared); do not criticise their content. Judge instead:
- whether the frames look like the requested style${brief ? ` (client description: "${brief.description.slice(0, 1200)}")` : ''}${refCount ? ' and like the reference images attached first' : ''};
- whether the look is premium, coherent and usable for 2 hours of educational videos (legibility, contrast, balance, richness);
- exact Spanish spelling of every text, flat 2D legible typography.
When a problem comes from the THEME (bibles, palette, avoid, notes, imagery), fix it in "suggestions": each suggestion names one field and gives its FULL new text (same format and length rules as the current one). Do not suggest changes for random one-off generation glitches; say "regenerate" in "issues" instead. Current theme fields:
imageBible: ${t.imageBible}
videoBible: ${t.videoBible}
clipBible: ${t.clipBible}
avoid: ${t.avoid}
directorNotes: ${t.directorNotes}
imagery: ${t.imagery}
soundHint: ${t.soundHint}`;
}
