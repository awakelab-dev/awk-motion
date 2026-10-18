import type { BaseThemeId, ThemeInfo, ThemeStyle } from '@wilox/shared';

/** El tipo vive en @wilox/shared (serializable, hito 2); se reexporta por compatibilidad. */
export type { SfxName, ThemeStyle } from '@wilox/shared';

const GLOSSY_DARK_VIDEO = `STYLE BIBLE (keep identical across all clips): premium educational motion graphics with kinetic typography, 16:9, 2K, ultra-crisp. Modern Apple-keynote / high-end medical explainer look: clean FLAT 2D white typography (bold geometric sans-serif like Roboto / Poppins) composited over glossy semi-transparent 3D glass elements, shallow depth of field, subtle volumetric light and bloom. Background: deep midnight-navy gradient (#011932 to #003670) with a faint hexagonal micro-grid and slow drifting light particles. Accent color vivid electric cyan (#19F7F1 / #0FCED3), secondary ice blue (#D9FBFF); no other colors. 3D elements: floating frosted, semi-transparent iridescent glass objects (capsule-shaped bacteria, spherical cells with soft inner glow) with cyan rim light, refraction and caustics, slow rotation and parallax.`;

const GLOSSY_DARK_IMAGE = `Single still frame from a premium educational motion graphics video, 16:9, ultra-crisp 2K. Modern Apple-keynote / high-end medical explainer look: clean FLAT 2D white typography (bold geometric sans-serif like Poppins / Roboto) composited over glossy semi-transparent 3D glass elements, shallow depth of field, subtle volumetric light and bloom. Background: deep midnight-navy gradient (#011932 to #003670) with a faint hexagonal micro-grid and small drifting light particles. Accent color vivid electric cyan (#19F7F1 / #0FCED3), secondary ice blue (#D9FBFF); no other colors. 3D elements: frosted semi-transparent iridescent glass objects with cyan rim light, refraction and caustics. Calm, perfectly balanced composition.`;

const GLOSSY_LIGHT_VIDEO = `STYLE BIBLE LIGHT (keep identical across all clips): premium educational motion graphics with kinetic typography, 16:9, 2K, ultra-crisp. Modern Apple-keynote / high-end medical explainer look, the bright twin of the dark version: clean FLAT 2D typography (bold geometric sans-serif like Roboto / Poppins) in deep navy (#01264C / #003670) composited over glossy semi-transparent 3D glass elements, shallow depth of field, soft studio light and gentle bloom. Background: clean luminous gradient from near-white to pale ice blue (#F0F3FC to #E2E6F2, hints of #D9FBFF) with a faint hexagonal micro-grid in pale steel blue and slow drifting soft light particles and bokeh; bright and clean, never grey or dirty. Accent color deep teal-cyan (#0ABCC9 / #0B93AA); secondary steel blue (#4E7EA5); no warm colors. 3D elements: floating frosted, semi-transparent iridescent glass objects (capsule-shaped bacteria, spherical cells with soft inner glow) tinted soft blue with crisp dark-teal rim light, refraction and caustics, subtle soft shadows so they stand out against the light background; slow rotation and parallax. All text and icons must have strong contrast against the light background.`;

const GLOSSY_LIGHT_IMAGE = `Single still frame from a premium educational motion graphics video, 16:9, ultra-crisp 2K. Modern Apple-keynote / high-end medical explainer look, the bright twin of a dark glossy style: clean FLAT 2D typography (bold geometric sans-serif like Poppins / Roboto) in deep navy (#01264C / #003670) composited over glossy semi-transparent 3D glass elements, shallow depth of field, soft studio light and gentle bloom. Background: clean luminous gradient from near-white to pale ice blue (#F0F3FC to #E2E6F2, hints of #D9FBFF) with a faint hexagonal micro-grid in pale steel blue and small drifting soft light particles; bright and clean, never grey. Accent color deep teal-cyan (#0ABCC9 / #0B93AA); secondary steel blue (#4E7EA5); no warm colors. 3D elements: frosted semi-transparent iridescent glass objects tinted soft blue with crisp dark-teal rim light, refraction, caustics and subtle soft shadows so they stand out against the light background. Calm, perfectly balanced composition.`;

const PASTEL_VIDEO = `STYLE BIBLE "PASTEL KINETIC" (keep identical across all clips): vibrant editorial motion design with bold kinetic typography, 16:9, 2K, ultra-crisp, energetic but friendly, NOT futuristic, no glass, no neon, no sci-fi. Background: full-screen softly moving particle field of round bokeh dots and small confetti-like circles in saturated pastel tones (dusty coral #EE8C7A, mint teal #5FBFA8, lavender #9B8FD9, butter yellow #F2C45A, powder blue #72A3C4) drifting slowly over a warm off-white to pale powder-blue gradient (#F0F3FC). Typography: FLAT 2D text only, clean geometric sans-serif (Poppins / Roboto style, bold and medium weights) in deep navy #01264C, with key words highlighted in an elegant contrasting serif italic (Playfair Display italic style); words in the same phrase alternate colors (navy, coral, mint, lavender) and some words are split half one color, half another. Imagery: REAL photorealistic footage and photos living INSIDE the animation, framed in soft rounded shapes (circles, pills, rounded rectangles) with thin pastel outlines, the footage moving subtly inside its mask. Transitions: fluid MORPHS only (shapes morph into other shapes, image masks morph from circle to rounded rectangle, letters stretch and morph into the next word), smooth elastic easing, playful overshoot.`;

const PASTEL_IMAGE = `Single still frame from a vibrant editorial motion design video with kinetic typography, 16:9, ultra-crisp 2K, friendly and NOT futuristic (no glass, no neon, no 3D icons). Background: warm off-white to pale powder-blue gradient (#F0F3FC) with floating round confetti and bokeh dots in saturated pastel tones (dusty coral #EE8C7A, mint teal #5FBFA8, lavender #9B8FD9, butter yellow #F2C45A, powder blue #72A3C4). Typography: FLAT 2D text, clean geometric sans-serif (Poppins style) in deep navy #01264C, key words in an elegant serif italic (Playfair Display italic style), words alternating colors and some words split in two colors. Imagery: REAL photorealistic photos framed inside soft rounded shapes (circles, pills, rounded rectangles) with thin pastel outlines. Calm, balanced composition.`;

const GLOSSY_NOTES = `Glossy style: NO people, NO faces, NO hands, NO realistic footage or photos; mediaFrames must always be an empty array. Typography is geometric sans only (bold / medium / light weights, uppercase and sentence case) — NEVER serif or italic serif; the accent treatment is the style's accent color, a soft glow or an underline bar on one word or phrase, or weight contrast. Every keyframe still needs rich imagery: at least one prominent glossy 3D glass object or a group of glass icon tiles that embodies the idea; a frame with only text on panels is too poor. Visual metaphors are glossy semi-transparent 3D glass objects: capsule bacteria, cells, frosted panels, shields, and 3D glass icons inside frosted glass tiles. Never show bare numbers as the main visual for lists ("1, 2, 3, 4"): use one glossy 3D icon per item inside a glass tile plus its caption.`;

/** Los 3 temas base (hito 1): semilla en código, de solo lectura en el Estudio. */
export const BASE_THEMES: Record<BaseThemeId, ThemeStyle> = {
  dark: {
    info: {
      id: 'dark',
      name: 'Dark',
      description: 'Glossy Dark · vidrio 3D sobre azul medianoche con acentos cian',
      swatches: ['#011932', '#003670', '#19F7F1', '#D9FBFF'],
    },
    videoBible: GLOSSY_DARK_VIDEO,
    imageBible: GLOSSY_DARK_IMAGE,
    clipBible:
      'STYLE: premium keynote-style motion graphics, 16:9, 2K. Flat white typography over glossy semi-transparent 3D glass elements with electric cyan rim light, deep midnight-navy background with a faint hexagonal grid and drifting light particles. Motion: light sweeps, glass shatters and re-forms, liquid glass morphs, shockwave ripples, bloom pulses; smooth premium easing.',
    avoid:
      'people, faces, hands, realistic hospital footage, clutter, distorted, missing or misspelled letters, warm colors, camera shake at the end.',
    soundHint: 'whooshes, light sweeps, glass morph shimmer, soft impacts, glass chimes',
    imagery: 'glossy semi-transparent 3D glass objects that embody the concept, chosen fresh for each idea, and for enumerations one 3D glass icon inside an identical frosted glass tile per item, each with its caption; never bare numbers as the visual',
    usesMediaFrames: false,
    directorNotes: GLOSSY_NOTES + ' Text is white, accents electric cyan.',
    sfx: { opener: 'sweep', accents: ['ping', 'whoosh', 'pulse', 'sparkle'], hit: 'impact' },
  },
  light: {
    info: {
      id: 'light',
      name: 'Light',
      description: 'Glossy Light · el gemelo claro del Dark: vidrio 3D sobre fondo luminoso con micro-rejilla y acentos teal',
      swatches: ['#F0F3FC', '#D9FBFF', '#0B93AA', '#01264C'],
    },
    videoBible: GLOSSY_LIGHT_VIDEO,
    imageBible: GLOSSY_LIGHT_IMAGE,
    clipBible:
      'STYLE: bright premium keynote-style motion graphics (the light twin of the dark glossy style), 16:9, 2K. Flat deep-navy typography over glossy blue-tinted glass elements with dark-teal rim light, luminous near-white to pale ice-blue background with a faint hexagonal micro-grid and drifting soft light particles. Motion: light sweeps, glass shatters and re-forms, liquid glass morphs, soft ripples, gentle bloom; smooth premium easing; always bright and clean.',
    avoid:
      'people, faces, hands, realistic hospital footage, dark backgrounds, sky, clouds, smoke, grey or muddy tones, clutter, distorted or misspelled letters, warm colors, camera shake at the end.',
    soundHint: 'glass flips, whooshes, soft impacts, glass chimes, subtle digital pops',
    imagery: 'glossy semi-transparent 3D glass objects that embody the concept, chosen fresh for each idea, and for enumerations one 3D glass icon inside an identical frosted glass tile per item, each with its caption; never bare numbers as the visual',
    usesMediaFrames: false,
    directorNotes:
      GLOSSY_NOTES + ' Text is deep navy, accents deep teal; keep it airy and less loaded than the dark style. On the light background the accent is the deep-teal color or a thin teal underline, never a glow on text (it looks muddy on light backgrounds). Glass objects keep a crisp dark-teal rim and soft shadow so they never dissolve into the white; supporting lines in steel blue must stay clearly legible.',
    sfx: { opener: 'sweep', accents: ['ping', 'whoosh', 'sparkle', 'pulse'], hit: 'impact' },
  },
  pastel: {
    info: {
      id: 'pastel',
      name: 'Pastel',
      description: 'Pastel Kinetic · editorial, confeti pastel, fotos y video en marcos redondeados',
      swatches: ['#F0F3FC', '#EE8C7A', '#5FBFA8', '#9B8FD9', '#F2C45A'],
    },
    videoBible: PASTEL_VIDEO,
    imageBible: PASTEL_IMAGE,
    clipBible:
      'STYLE "PASTEL KINETIC": vibrant editorial motion design with bold kinetic typography, 16:9, 2K, friendly, NOT futuristic, no glass, no neon. Softly drifting pastel confetti and bokeh dots (coral, mint, lavender, butter yellow, powder blue) over a warm off-white to pale powder-blue gradient. Flat 2D typography in deep navy sans with coral / mint / lavender accents and an elegant serif italic for key words. Real photorealistic footage living inside rounded masks with thin pastel outlines, moving subtly. Transitions are fluid MORPHS with elastic easing and playful overshoot: text melts into liquid blobs that pop into confetti, masks morph from one shape into another, letters stretch into the next word.',
    avoid:
      'glass, chrome, glossy 3D objects, neon glows, dark backgrounds, sci-fi HUD, 3D icons, faces looking at camera, distorted hands, clutter, misspelled letters, camera shake at the end.',
    soundHint: 'liquid morph blips, playful swooshes, soft pops, bubbles, light ticks for letters, a soft thump when the title lands',
    imagery: 'real photorealistic photos or footage inside rounded masks that show the concept itself, chosen fresh for each idea from the whole visual world of the topic (objects, close-ups, microscopy, instruments, places, procedures, hands, data on screens, people at work) rather than defaulting to a person posing; people are seen from behind or in profile. For enumerations of 2-4 items, one identical mask per item, each with its own photo and caption',
    usesMediaFrames: true,
    directorNotes: `Pastel style: use real photorealistic photos/footage inside rounded frames (circles, pills, rounded rectangles) with thin pastel outlines. Media-frame rule (MANDATORY): alternate video and still starting with video — 1 frame: video; 2: video + still; 3: video + still + video; 4: video + still + video + still (never more than 4 frames). For video frames describe a continuous action for the whole clip (e.g. "the nurse keeps walking down the corridor"), and compose them mid-action in the keyframe. Nobody looks at the camera. All media frames in one keyframe share the same shape and size (e.g. three equal pills or three equal circles in a row) or there is a single large one. Color play is restrained but playful: mostly deep navy text; in a row of equal media frames each caption may take its frame's pastel outline color (coordinated color-coding, the signature of this style); otherwise ONE accent word or phrase per frame in coral/mint/lavender or in serif italic; at most ONE hero word split in two colors, split at a natural point (e.g. \"IA|AS\", \"EPIDEM|IOLÓGICOS\"), never inside a small word. Transitions are liquid morphs with elastic overshoot.`,
    sfx: { opener: 'whoosh', accents: ['pop', 'bubble', 'sparkle', 'tick'], hit: 'pop' },
  },
};

export const BASE_THEME_LIST: ThemeInfo[] = Object.values(BASE_THEMES).map((t) => ({ ...t.info, origin: 'base' as const }));

export const IMAGE_TEXT_RULES =
  'TEXT RULES: flat 2D text only, perfectly legible, exact Spanish spelling with accents exactly as written; no other text, no watermark, no logos.';
