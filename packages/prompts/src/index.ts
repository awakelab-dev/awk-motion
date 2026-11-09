import { SHOT_MAX_SPACING_SEC, SHOT_MIN_SPACING_SEC, SHOT_SPACING_SEC, type Shot, type Storyboard, type ThemeId, type ThemeStyle, type Typeface } from '@wilox/shared';
import { IMAGE_TEXT_RULES } from '@wilox/styles';

export interface TimedWord {
  /** Palabra tal como aparece en el texto fuente. */
  word: string;
  /** Segundos en la línea de tiempo global. */
  start: number;
  end: number;
  paragraph: number;
}

export interface StoryboardInput {
  theme: ThemeId;
  paragraphs: { text: string; startSec: number; durationSec: number }[];
  words: TimedWord[];
  totalSec: number;
  clipSec: number;
  /**
   * Guion del cliente (hito 5, ADR-049): una fila por párrafo con la escena, la expresión y el layout
   * sugeridos. Sin guion los prompts son exactamente los de siempre (golden).
   */
  script?: { scene?: string; expression?: string; layout?: string }[];
}

/**
 * Principios de dirección de arte (sin ejemplos, para no sesgar las composiciones).
 * ADR-009 y ADR-010: claridad de composición SIN perder riqueza visual.
 */
export function artDirection(t: ThemeStyle): string {
  return `ART DIRECTION PRINCIPLES — principles, not templates: invent, for each idea, the composition that tells it best. The goal is a premium motion design studio frame: clear AND visually rich. Simple never means empty.
1. ONE IDEA PER SHOT. The keyframe shows only that idea. If the narration enumerates items, the enumeration is the idea.
2. RICH, MEANINGFUL IMAGERY IN EVERY KEYFRAME (except K0). Imagery in this style: ${t.imagery}. Each image must depict the concept being said, never generic smiling people or decoration. Photos and objects carry no readable text, numbers or labels (screens, documents and charts appear softly blurred or abstract): the only text in the frame is the listed typography. A frame with only text, or with text plus one small image, is too poor. When the narration enumerates 2-4 items, every item gets its own visual of identical shape and size plus its caption.
3. CLEAR HIERARCHY. One dominant element or one unified group; everything else clearly secondary. Up to three typographic levels with strong contrast of scale, weight and case (e.g. a small light label, a huge bold hero, a supporting line where the key phrase can switch to the elegant serif italic).
4. ECONOMY OF WORDS, NOT OF IMAGES. At most ~8 words on screen, or a list of up to 4 captions of up to 5 words plus a title of 2-3 words.
5. BALANCE AND BREATHING ROOM. Content fills roughly 55-65 % of the frame, balanced left/right or centred; margins on every side; nothing touches or is cropped by the edges. THE MORE ELEMENTS, THE SMALLER EACH ONE: with 3-4 images, shrink them (medium-small) so gutters widen and the outer margins stay generous (about 10 % of the width on the sides, 12 % of the height top and bottom); a frame must never feel tight.
6. CONSISTENCY WITHIN A FRAME. Repeated elements (masks, tiles, icons) share exactly the same shape, size and spacing on one clear axis or grid.
7. MOTION GRAPHICS, NOT A WEB PAGE. No buttons, chips or pill labels around words, no bullet or numbered lists, no numbered badges, no flat UI cards or boxes holding only text, no tables or UI widgets. The style's own objects (e.g. frosted 3D glass panels or tiles in the Glossy styles) may carry text: they are part of the art, not UI.
8. RESTRAINED COLOR. One accent treatment per frame (one accent-colored word or phrase, one serif italic phrase, or one two-color hero word); the rest of the text in the main text color. Do not reuse the same accent device in consecutive frames (e.g. two split words in a row). Color-coding a set of equal items (each caption or item in the color of its own frame outline) is ONE coordinated system, not several accents. Never give each letter of a word a different color.
9. VARIETY ACROSS THE SEQUENCE. Consecutive keyframes never repeat a composition (alternate text-led / image-led, asymmetric / centred, single hero image / row of equals) and never repeat the same image subject (e.g. not a nurse in every frame). Name the composition in "layout".
10. CONTINUITY. The next keyframe must be reachable by a morph from the current one: some element transforms into the next hero instead of everything vanishing.
11. THE SCENE IS A COMPOSITION BRIEF of at most 90 words: hierarchy, positions, relative sizes, what each image shows, which element carries the accent. Never restate the background, palette or style (the style bible is prepended automatically) and never assign a color to every word.
12. PRECEDENCE. When these general principles and the STYLE NOTES disagree, the STYLE NOTES win: they define the identity of the style.`;
}

/**
 * Regla fija de animación de las imágenes (ADR-080): solo en los temas con «según cuántas haya». El código la
 * vuelve a aplicar después del storyboard; aquí se le dice a Opus para que componga cada marco acorde (los de
 * video, a mitad de acción). En los demás temas no añade nada (el golden no cambia).
 */
export function mediaFrameRuleLine(t: ThemeStyle): string {
  if (!t.usesMediaFrames || t.mediaFrameRule !== 'byCount') return '';
  return `\nMEDIA-FRAME RULE (fixed by the app; it OVERRIDES any media-frame rule in the STYLE NOTES): list the media frames in reading order (left to right, top to bottom) and assign by count: 1 frame: video; 2: first video + second still; 3: first video + middle still + third video; 4: all four stills. Never more than 4 frames. Video frames show a continuous action for the whole clip and are composed mid-action; still frames are calm photos.`;
}

/** System prompt para Opus: cómo se construye el video + principios + estilo. */
export function storyboardSystemPrompt(t: ThemeStyle): string {
  return `You are the art director of "Micro Cápsulas": short educational videos in Chilean Spanish with premium motion graphics and kinetic typography, at the level of a top motion design studio. You design the storyboard for one narration. Code turns your JSON into (a) GPT Image 2.5 keyframe prompts (style bible + your scene) and (b) MiniMax H3 image-to-video prompts that animate from keyframe K(i-1) to keyframe Ki in 5 seconds.

HOW THE VIDEO IS BUILT:
- The narration is the master timeline. After each 5.167 s AI clip its last frame is held as a freeze-frame while the voice continues, until the next clip starts.
- Each shot corresponds to one PFC (key word or phrase). The clip starts ~1 s before the voice says it, so the text builds while it is being said.
- K0 is the intro frame: only the style background, no text. Shot 1 animates K0 -> K1, shot 2 animates K1 -> K2, and so on. Each keyframe is the calm END STATE of its shot and must be self-contained.

CHOOSING SHOTS:
- The FIRST shot anchors at word index 0.
- Then one shot per distinct idea, about every ${SHOT_MIN_SPACING_SEC}-${SHOT_MAX_SPACING_SEC} s of narration and never closer than ${SHOT_MIN_SPACING_SEC} s (by the time the voice says them). Paragraph starts are natural anchors.
- On-screen text comes literally from the narration; never paraphrase technical terms. Exact Spanish spelling with accents. Captions longer than ~4 words go in UPPERCASE, split into short lines with " / ".
- "texts" lists every visible string exactly as it must appear; the scene quotes them identically.

${artDirection(t)}

WRITING THE ANIMATION: 3-4 beats covering 0.0-5.0 s. Describe bold, specific transformations from the start frame into this frame (what morphs into what, what bursts, what stretches), then the build of the new hero in sync with the idea; the last ~1 s settles calmly. Everything that appears must exist in the end frame.${t.usesMediaFrames ? ' In shots with media frames, the frames reach their final place and size by about 2 s so the footage has time to play, the last beat says what the footage of each video frame keeps doing, and every media frame has its "position" in the frame (left, centre, right, top left…).' : ''}

STYLE "${t.info.name}":
${t.videoBible}
STYLE NOTES: ${t.directorNotes}
${t.usesMediaFrames ? '' : 'mediaFrames must be [] for every shot in this style.'}${mediaFrameRuleLine(t)}
"sound": a short list of synced sound effects (${t.soundHint}); never music or voice.`;
}

export function storyboardUserPrompt(input: StoryboardInput): string {
  const paras = input.paragraphs
    .map((p, i) => `Paragraph ${i + 1} (starts ${p.startSec.toFixed(2)} s, lasts ${p.durationSec.toFixed(2)} s):\n${p.text}`)
    .join('\n\n');
  const words = input.words.map((w, i) => `${i}:${w.word}@${w.start.toFixed(2)}`).join(' ');
  // Un plano cada ~7,2 s (ADR-114; T3f lo había llevado a ~10,3 s).
  const approx = Math.max(1, Math.round(input.totalSec / SHOT_SPACING_SEC));
  return `NARRATION (total ${input.totalSec.toFixed(2)} s; each AI clip lasts ${input.clipSec.toFixed(3)} s):

${paras}

WORD TIMINGS (index:word@seconds):
${words}

Design the storyboard: intro scene (K0) plus about ${approx} shots, one idea each. Return only the JSON.${input.script?.some((r) => r.scene || r.layout) ? scriptSection(input) : ''}`;
}

/** Sección del guion del cliente en el mensaje del storyboard (solo si hay guion). */
function scriptSection(input: StoryboardInput): string {
  const firstWord: number[] = [];
  input.words.forEach((w, i) => {
    if (firstWord[w.paragraph] === undefined) firstWord[w.paragraph] = i;
  });
  const rows = input.paragraphs
    .map((p, i) => {
      const r = input.script?.[i];
      if (!r || (!r.scene && !r.layout)) return '';
      return [
        `Row ${i + 1} = Paragraph ${i + 1} (first word index ${firstWord[i] ?? '?'}, lasts ${p.durationSec.toFixed(2)} s):`,
        r.scene ? `  Scene: ${r.scene}` : '',
        r.layout ? `  Layout: ${r.layout}` : '',
        r.expression ? `  Narration tone: ${r.expression}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
  return `

CLIENT SCRIPT (scene descriptions for each paragraph):
${rows}`;
}

/**
 * Reglas para respetar el guion del cliente (hito 5, ADR-049). Se añaden al system prompt del storyboard
 * y de la revisión solo cuando hay guion, así los prompts base no cambian.
 */
export function scriptDirectionPrompt(): string {
  return `

CLIENT SCRIPT RULES (this narration comes with a script):
- Each script row is one paragraph of the narration. Its first shot MUST be anchored at the first word of that paragraph; a row never shares a shot with another row.
- The row's scene description dictates WHAT each of its shots shows (subject, objects, situation, on-screen text idea). Translate it into your keyframe fields; do not invent a different concept.
- If a row lasts more than about ${SHOT_MAX_SPACING_SEC} seconds, split it into several shots that stay coherent with its description (a progression of the same scene: detail, reveal, consequence), keeping the usual rhythm of one shot every ${SHOT_MIN_SPACING_SEC}–${SHOT_MAX_SPACING_SEC} s.
- A suggested layout is a strong hint for the composition; adapt it if it breaks the art direction principles.
- The THEME always wins on HOW it looks: style bible, palette, typography, materials, imagery vocabulary, media frames rule and everything in AVOID. If the script asks for a visual style, colors or fonts that contradict the theme, keep the theme and only take the content.
- Narration tone notes are for the voice: ignore them for the images except as mood.`;
}

/** Segunda pasada: Opus relee su storyboard como director de arte y corrige. */
export function reviewSystemPrompt(t: ThemeStyle): string {
  return `You are the senior art director reviewing a storyboard written by a junior designer for a premium educational motion graphics video (style "${t.info.name}"). Your job is to raise it to studio quality before any image is generated.

Check every shot against these principles and fix what fails; keep what already works. Typical failures in both directions: overloaded frames (two ideas, too many words, mixed shapes, every word colored, UI-looking elements such as pill labels, empty text boxes or numbered badges) and POOR frames (text only, a single small image, imagery that does not show the concept, the same subject repeated across shots, flat typography without contrast of scale). Also: content pushed to the edges, the same composition in consecutive shots, scenes that restate the background or exceed 90 words.

${artDirection(t)}

STYLE NOTES: ${t.directorNotes}
${t.usesMediaFrames ? '' : 'mediaFrames must be [] in this style.'}${mediaFrameRuleLine(t)}

Rules for your answer: keep the same shots and anchorWordIndex unless a shot must be split or merged to respect "one idea per shot" and the ${SHOT_MIN_SPACING_SEC} s minimum spacing; keep texts literal to the narration; update layout, scene, summary, texts, mediaFrames, animation, endState and sound so they stay coherent with each other and with the neighbouring shots. In "notes" list briefly (in Spanish) what you changed; if nothing needed changes, say so.`;
}

export function reviewUserPrompt(board: Storyboard, input: StoryboardInput): string {
  return `${storyboardUserPrompt(input)}

STORYBOARD TO REVIEW:
${JSON.stringify(board, null, 1)}

Return the reviewed storyboard.`;
}

/** Revisión visual de los fotogramas ya generados (Opus con visión). */
export function imageReviewSystemPrompt(t: ThemeStyle): string {
  return `You are the senior art director of a premium motion design studio. You receive the keyframes generated for one educational video (style "${t.info.name}"), each with the brief it was generated from. Judge each image as a finished frame: composition and balance, hierarchy, breathing room, consistency of repeated elements, legibility and exact Spanish spelling of every text, adherence to the style, breathing room (a frame with several images that feels tight or crowded must be improved by shrinking the images and widening margins), visual richness (meaningful imagery that shows the concept; a frame that is flat, empty or text-only is a failure just like an overloaded one), and absence of UI-looking elements or artifacts (warped hands or faces, garbled letters, cropped elements, unrelated photos).

${artDirection(t)}

Be demanding but fair: mark "ok" when the frame is professional even if you would have done it differently. Mark "improve" only for clear problems, explain them in Spanish in one or two sentences, and write "revisedScene": a corrected composition brief (same rules: at most 90 words, no background or style restatement, same exact texts). Fix problems by specifying the right imagery, never by removing imagery: if the photos are wrong, describe the correct ones.`;
}

export function imageReviewItemText(index: number, label: string, scene: string, texts: string[]): string {
  return `K${String(index).padStart(2, '0')} · ${label}\nBrief: ${scene}\nRequired texts: ${texts.length ? texts.map((x) => `"${x}"`).join(', ') : '(none)'}`;
}

/** Reescritura de un plano para aplicar una nota del usuario (o la sugerencia de la revisión visual). */
export function reviseShotSystemPrompt(t: ThemeStyle): string {
  return `You are the art director of a premium motion graphics video (style "${t.info.name}"). Rewrite ONE shot of the storyboard so that it applies the requested change completely and coherently: the scene, texts, mediaFrames, layout, summary, animation, endState and sound must all agree with each other and with the neighbouring shots. Keep anchorWordIndex, pfc and title unless the change requires otherwise. Keep on-screen texts literal to the narration.

${artDirection(t)}

STYLE NOTES: ${t.directorNotes}
${t.usesMediaFrames ? '' : 'mediaFrames must be [].'}${mediaFrameRuleLine(t)}`;
}

export function reviseShotUserPrompt(opts: {
  shot: Shot;
  previousSummary: string;
  nextSummary?: string;
  change: string;
  /** Imágenes de referencia del editor que van adjuntas (hito 13, ADR-170). */
  editorRefs?: number;
}): string {
  // Sin imágenes, el texto de siempre.
  const refs = opts.editorRefs
    ? `

EDITOR REFERENCE IMAGES: the director attached ${opts.editorRefs === 1 ? '1 image (below), "editor reference image 1"' : `${opts.editorRefs} images (below), numbered in order: "editor reference image 1" to "editor reference image ${opts.editorRefs}"`}. The requested change says what to do with them (put one inside a specific media frame, replace an element with it, or create new imagery based on it). Look at them and write the shot so the image generator knows exactly where each one goes and what it shows: name it as "editor reference image N" plus a short description of its content in the scene and, when it fills a media frame, in that frame's subject (a frame holding a reference image is a still photo unless the director asks otherwise). Keep everything else of the shot unless the change requires it.`
    : '';
  return `CURRENT SHOT:
${JSON.stringify(opts.shot, null, 1)}

PREVIOUS KEYFRAME (start of this clip): ${opts.previousSummary}
${opts.nextSummary ? `NEXT KEYFRAME (this frame must morph into it): ${opts.nextSummary}` : 'This is the last shot.'}

REQUESTED CHANGE (from the director, in Spanish or English): ${opts.change}${refs}

Return the full rewritten shot.`;
}

/**
 * «Dividir en dos» un clip (hito 10, T3, ADR-130): un plano intermedio entre el fotograma anterior y el final del plano,
 * para que su tramo largo no quede congelado. Prompts nuevos: los de siempre y el golden no cambian.
 */
export function splitShotSystemPrompt(t: ThemeStyle): string {
  return `You are the art director of a premium motion graphics video (style "${t.info.name}"). One shot of the storyboard stays on screen too long (most of it is a frozen last frame), so it is SPLIT IN TWO CLIPS at a point of the narration:
- clip A goes from the PREVIOUS KEYFRAME to a NEW INTERMEDIATE KEYFRAME (you write this new shot);
- clip B goes from that intermediate keyframe to the CURRENT keyframe of the shot, which DOES NOT CHANGE.
Write the intermediate shot as a natural middle step of the same composition: the same layout family, background and visual language as the current keyframe, showing only what the narration has said up to the split point (typically the title or the first elements already in place, the rest not yet there). Its on-screen texts must be a SUBSET of the current keyframe's texts, copied literally (never new words, never paraphrased); mediaFrames, if any, must also be a subset of the current ones (same subjects and kinds). Its animation goes from the previous keyframe to the intermediate one. Then write clip B's animation (from the intermediate keyframe to the current one), its endState and sound. Keep pfc and title in the language of the original fields.

${artDirection(t)}

STYLE NOTES: ${t.directorNotes}
${t.usesMediaFrames ? '' : 'mediaFrames must be [].'}${mediaFrameRuleLine(t)}`;
}

export function splitShotUserPrompt(opts: { shot: Shot; previousSummary: string; nextSummary?: string; firstNarration: string; secondNarration: string; splitWord: string }): string {
  return `CURRENT SHOT (its keyframe stays as the end of clip B):
${JSON.stringify(opts.shot, null, 1)}

PREVIOUS KEYFRAME (start of clip A): ${opts.previousSummary}
${opts.nextSummary ? `NEXT KEYFRAME (after clip B): ${opts.nextSummary}` : 'This is the last shot of the video.'}

NARRATION DURING CLIP A (up to the split): "${opts.firstNarration}"
NARRATION DURING CLIP B (from the word "${opts.splitWord}"): "${opts.secondNarration}"

Return the intermediate shot, clip B's animation/endState/sound and a short explanation in Spanish.`;
}

// ------------------------------------------------------------------ ensamblado

/**
 * Nota para GPT Image cuando el tema trae imágenes de referencia (temas del Estudio).
 * Solo se añade si hay referencias: los prompts de los temas base no cambian.
 */
export function referenceNote(count: number, o: { first?: boolean } = {}): string {
  if (!count) return '';
  // Con láminas tipográficas detrás (ADR-094) se dice cuáles son las de estilo; sin ellas, el texto de siempre.
  const which = o.first ? (count === 1 ? 'first attached image is a' : `first ${count} attached images are`) : count === 1 ? 'attached image is a' : `${count} attached images are`;
  return ` STYLE REFERENCES: the ${which} STYLE reference only — match their palette, rendering technique, materials, lighting and typographic mood, but never copy their content, subjects, layout, text or logos. The SCENE above defines what the frame shows.`;
}

const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
export const weightName = (w: number) => WEIGHT_NAMES[w] ?? String(w);

/**
 * Láminas tipográficas del tema (ADR-094): van detrás de las referencias de estilo, una por fuente. Son
 * muestras de letra, no escenas: se copia la forma de cada carácter, nunca sus palabras. Sin láminas no se
 * añade nada (los prompts de siempre y el golden no cambian).
 */
export function typographyNote(faces: Pick<Typeface, 'family' | 'role' | 'weights'>[], sheets: number, afterStyleRefs: boolean, o: { beforeEditorRefs?: boolean } = {}): string {
  if (!sheets || !faces.length) return '';
  // Con imágenes del editor detrás (hito 13, ADR-170) las láminas ya no son las últimas: se dice dónde van.
  const where = o.beforeEditorRefs
    ? afterStyleRefs
      ? sheets === 1 ? 'The attached image right after the style references is a TYPE SPECIMEN sheet' : `The ${sheets} attached images right after the style references are TYPE SPECIMEN sheets (one per typeface)`
      : sheets === 1 ? 'The first attached image is a TYPE SPECIMEN sheet' : `The first ${sheets} attached images are TYPE SPECIMEN sheets (one per typeface)`
    : afterStyleRefs
      ? sheets === 1 ? 'The last attached image is a TYPE SPECIMEN sheet' : `The last ${sheets} attached images are TYPE SPECIMEN sheets (one per typeface)`
      : sheets === 1 ? 'The attached image is a TYPE SPECIMEN sheet' : `The ${sheets} attached images are TYPE SPECIMEN sheets (one per typeface)`;
  const w = (f: Pick<Typeface, 'weights'>) => [...f.weights].sort((a, b) => b - a);
  const uses = faces.map((f) => {
    const [heavy, ...rest] = w(f);
    const light = rest.length ? rest[rest.length - 1] : heavy;
    if (f.role === 'headings') return `"${f.family}" ${weightName(heavy)} (${heavy}) for titles, headlines and key words`;
    if (f.role === 'body') return `"${f.family}" ${weightName(light)} (${light}) for body text, captions and labels`;
    return heavy === light
      ? `"${f.family}" ${weightName(heavy)} (${heavy}) for all text`
      : `"${f.family}" for all text: ${weightName(heavy)} (${heavy}) for titles and key words, ${weightName(light)} (${light}) for the rest`;
  });
  return ` TYPOGRAPHY: ${where}, not scenes. Set the text of this frame in ${uses.join('; ')}. Reproduce the exact letterforms of each character from the specimen (proportions, stroke contrast, terminals, width, accents and Ñ), above all the large KEY LETTERS row (how a and g are built, single- or double-storey, with any ear or spur; the tail of y; the l and t; Q, R, G, J and the figures): draw each of those exactly as shown there, never a generic version; never copy the specimen's words, labels, layout or background. This typeface choice overrides any typeface named above.`;
}

/**
 * Imágenes de referencia del editor al regenerar un fotograma (hito 13, ADR-170): van al final de las imágenes adjuntas,
 * numeradas en el orden en que se subieron. A diferencia de las de estilo, de estas se usa el CONTENIDO, como diga la
 * indicación del editor. Sin imágenes no se añade nada (los prompts de siempre y el golden no cambian).
 */
export function editorRefsNote(count: number, instruction: string, o: { others: number }): string {
  if (!count) return '';
  const which = o.others
    ? count === 1 ? 'the last attached image is a CONTENT reference' : `the last ${count} attached images are CONTENT references`
    : count === 1 ? 'the attached image is a CONTENT reference' : `the ${count} attached images are CONTENT references`;
  const numbering = count === 1 ? 'It is "editor reference image 1".' : `They are numbered in this order: "editor reference image 1" is the first of them, up to "editor reference image ${count}".`;
  return ` EDITOR REFERENCE IMAGES: ${which} uploaded by the editor. ${numbering} Unlike the style references, use their CONTENT exactly as the editor asks: when an image must go inside a media frame or replace an element, reproduce it faithfully there (same subject, pose, framing, colours and details; a photo stays photographic); when the editor asks for new imagery based on them, create it from their content in this frame's style. Do not copy their background, watermarks, logos or text unless the editor asks for it. EDITOR INSTRUCTION (may be in Spanish): ${instruction.replace(/\s+/g, ' ').trim()}`;
}

export function introImagePrompt(t: ThemeStyle, scene: string): string {
  return `${t.imageBible} SCENE: opening frame of the video, before anything appears: ${scene} RULES: absolutely no text, no letters, no numbers, no watermark, no logos, no people.`;
}

export function keyframeImagePrompt(t: ThemeStyle, shot: Shot): string {
  const frames = shot.keyframe.mediaFrames.length
    ? ` MEDIA FRAMES (identical shape and size if more than one): ${shot.keyframe.mediaFrames
        .map((m, i) => `frame ${i + 1}: ${m.kind === 'video' ? 'real photo captured mid-action' : 'real still photo'} — ${m.subject}`)
        .join('; ')}.`
    : '';
  const n = Math.max(shot.keyframe.mediaFrames.length, shot.keyframe.repeatedItems ?? 0);
  const scale =
    n >= 3
      ? ` SCALE: with ${n} repeated items, keep each one medium-small (in a single row, all ${n} together span at most about ${n === 3 ? 66 : 70} % of the frame width, each about ${n === 3 ? '20-22' : '15-16'} %; in a 2x2 grid, the grid is no wider than about 45 % and no taller than about 65 % of the frame), wide gutters between them, and outer margins of at least 10 % of the width on the sides and 12 % of the height top and bottom. Airy, never tight.`
      : '';
  const texts = shot.keyframe.texts.map((s) => `"${s.replaceAll(' / ', '" / "')}"`).join(', ');
  return `${t.imageBible} SCENE: ${shot.keyframe.scene}${frames}${scale} COMPOSITION: one clear hero, generous margins, nothing touching the edges, no UI elements (no buttons, chips, badges or bullet lists). Only the images described above; no other photos or people. Photos contain no readable text, numbers or labels; any screen, document or chart inside them is softly blurred. ${IMAGE_TEXT_RULES} The only text allowed, every word present and spelled exactly (" / " marks a line break): ${texts}.`;
}

const MINIMAX_MAX = 6900;

/** Nombre de cada marco en el prompt del clip (ADR-081): su lugar, o su orden de lectura si el storyboard no lo trae. */
export function mediaFrameNames(frames: { position?: string }[]): string[] {
  const n = frames.length;
  const byOrder =
    n === 1
      ? ['the']
      : n === 2
        ? ['first (left or top)', 'second (right or bottom)']
        : n === 3
          ? ['left (first)', 'middle (second)', 'right (third)']
          : frames.map((_, i) => `${['first', 'second', 'third', 'fourth', 'fifth', 'sixth'][i] ?? `#${i + 1}`} (reading order)`);
  return frames.map((f, i) => (n > 1 && f.position?.trim() ? f.position.trim().toLowerCase() : byOrder[i]));
}

/**
 * Bloque de los marcos con foto o video (ADR-081): cada marco por su lugar, los de video siguen moviéndose
 * hasta el último cuadro y las fotos quedan quietas. Antes: "frame 1, frame 2…" y un END STATE quieto que
 * congelaba también el metraje (QA del hito 7).
 */
function mediaFramesBlock(shot: Shot): string {
  const frames = shot.keyframe.mediaFrames;
  const names = mediaFrameNames(frames);
  const lines = frames.map((m, i) => {
    const name = names[i] === 'the' ? 'The media frame' : `The ${names[i].toUpperCase()} media frame`;
    return m.kind === 'video'
      ? `- ${name} is LIVE-ACTION VIDEO: ${m.subject.replace(/\.\s*$/, '')}. The footage keeps playing inside the frame from the moment it appears until the very last frame of the clip: real, continuous motion of the subject, never a frozen photo.`
      : `- ${name} is a STILL PHOTO: ${m.subject.replace(/\.\s*$/, '')}. It stays a frozen photograph; nothing inside it moves, only a very subtle parallax drift.`;
  });
  const settle = frames.some((m) => m.kind === 'video')
    ? 'All media frames reach their final position and size by about 2.0 s; from then on the layout and texts stay put while the footage inside the video frames keeps moving.'
    : 'All media frames reach their final position and size by about 2.0 s.';
  return `\nMEDIA FRAMES (photoreal images inside the frames, named by their place in the end frame):\n${lines.join('\n')}\n${settle}`;
}

/** Prompt de clip corto (como el piloto): bible corta + resúmenes de inicio y fin + beats. */
export function clipVideoPrompt(t: ThemeStyle, shotNumber: number, shot: Shot, startSummary: string): string {
  const nn = String(shotNumber).padStart(2, '0');
  const beats = shot.animation.map((b) => `${b.from.toFixed(1)}-${b.to.toFixed(1)}s: ${b.action}`).join('\n');
  const media = shot.keyframe.mediaFrames;
  const frames = media.length ? mediaFramesBlock(shot) : '';
  const hasVideo = media.some((m) => m.kind === 'video');
  const hasStill = media.some((m) => m.kind === 'still');
  // Con marcos de video no se pide el último segundo quieto: congelaba el metraje (ADR-081). El clip sigue
  // terminando en el fotograma final; el congelado sale de su último cuadro real.
  const endState = hasVideo
    ? `END STATE: ${shot.endState} Layout, texts and frame borders end exactly as in the provided end frame (the last frame will be held as a freeze-frame); only the footage inside the video frames is still moving at the end.`
    : `END STATE: ${shot.endState} The final second is calm, nearly static and identical to the provided end frame (it will be held as a freeze-frame).`;
  const avoidMedia = `, ${[hasVideo ? 'video frames frozen like photos' : '', hasStill ? 'motion inside the still photo frames' : ''].filter(Boolean).join(', ')}`;
  const words = shot.keyframe.texts.map((s) => `"${s.replaceAll(' / ', ' ')}"`).join(', ');
  const prompt = `${t.clipBible}

SHOT ${nn} - ${shot.title} (5 seconds): animate from the provided START frame (${startSummary}) to the provided END frame (${shot.keyframe.summary}).
${beats}${frames}
Everything lands EXACTLY on the provided end frame composition.

${endState}

SOUND: sound effects only (${shot.sound}). NO music, NO voice.
TYPOGRAPHY: flat 2D text, exact Spanish spelling as in the end frame: ${words}. No other words, no gibberish, no watermark, no logos.
AVOID: ${media.length ? `${t.avoid.replace(/[.\s]+$/, '')}${avoidMedia}.` : t.avoid}`;
  return prompt.slice(0, MINIMAX_MAX);
}
/**
 * Clip insertado (hito 6, ADR-073): empieza y termina en el mismo fotograma (el final del clip anterior,
 * que es también el inicio del siguiente) con el movimiento que pida el editor.
 */
export function insertClipPrompt(t: ThemeStyle, frameSummary: string, texts: string[], note?: string): string {
  const words = texts.map((s) => `"${s.replaceAll(' / ', ' ')}"`).join(', ');
  const motion = note?.trim()
    ? `In between: ${note.trim()}`
    : 'In between: subtle, elegant motion over the existing composition (light sweeps, gentle parallax, small accents breathing), never adding new elements';
  const prompt = `${t.clipBible}

INSERTED SHOT (5 seconds): it STARTS and ENDS on the provided frame (${frameSummary}); both frames are the same image.
${motion}. Then everything returns EXACTLY to the provided frame composition.

END STATE: the final second is calm, nearly static and identical to the provided frame (the next shot starts from it).

SOUND: sound effects only, subtle. NO music, NO voice.
TYPOGRAPHY: flat 2D text, exact Spanish spelling as in the frame${words ? `: ${words}` : ''}. No other words, no gibberish, no watermark, no logos.
AVOID: ${t.avoid}`;
  return prompt.slice(0, MINIMAX_MAX);
}
/**
 * Transición de un video subido (hito 6, ADR-074): de su último cuadro al primer fotograma del video
 * (portada) o del último fotograma del video a su primer cuadro (cierre).
 */
/**
 * Coreografía de una transición (ADR-076/077): Opus mira el cuadro de inicio y el de fin y describe cómo
 * entra y sale cada elemento. Sin ella, MiniMax funde los dos cuadros (se superponen). Por las guías de marca
 * de los clientes, los elementos solo se desplazan: nada se deforma ni se transforma en otro (ADR-077).
 */
export function transitionPlanSystemPrompt(t: ThemeStyle): string {
  return `You direct motion-graphics transitions for an image-to-video model (MiniMax) that animates from a START frame to an END frame in 5 seconds. Given two very different frames, the model tends to cross-dissolve them: one picture fades over the other and both are superimposed. That looks cheap. Your job is to prevent it with an element-by-element choreography in which the elements MOVE.

BRAND RULE (strict, from the client's brand guidelines): every element is a rigid, untouchable piece. Logos, brand marks, text blocks, boxes and images are NEVER morphed, deformed, stretched, squashed, bent, warped, rotated, recolored, cropped or turned into another element. They keep their exact shape, proportions, colors and content at every moment. The ONLY thing they may do is move: slide (translate) in a straight or gently curved path, and leave or enter the frame by sliding past its edge or by being covered by a moving shape.

1. List the main elements of each frame (logos, text blocks, boxes, lines, shapes, color fields, background) with their position and color.
2. For each START element, say where it slides to as it leaves (direction, order, timing). For each END element, say from where it slides in to its final position. Stagger them (one after another, a few tenths of a second apart) so the motion reads as a designed animation.
3. The change of background is driven by moving shapes: e.g. the diagonal stripes of the END frame slide in from one side and sweep across, covering the white background as the logos slide out. Shapes may slide; they do not grow, melt or morph.
4. Nothing pops in, nothing ghosts over the picture, nothing fades in place: elements arrive and leave by moving.
5. Text never changes letters and is never distorted. Never add new text or new logos.
6. One continuous movement over the whole 5 seconds with ease-in-out, landing exactly on the END frame. At every moment the picture is ONE coherent composition.

The END or START frame belongs to the lesson style "${t.info.name}". Write the choreography in English, present tense, concrete (positions, directions, order), at most 900 characters.`;
}

export function transitionPlanUserText(mode: 'opening' | 'closing', note?: string): string {
  const what =
    mode === 'opening'
      ? 'START = last frame of the opening video (the client\'s own footage). END = first frame of the lesson.'
      : 'START = last frame of the lesson. END = first frame of the closing video (the client\'s own footage).';
  return `${what}${note?.trim() ? `\nThe client asks: ${note.trim()}` : ''}\nThe two frames follow, START first.`;
}

export function transitionClipPrompt(t: ThemeStyle, mode: 'opening' | 'closing', choreography: string, note?: string): string {
  // ADR-076: MiniMax no respeta "quieto 3 s": se le pide una animación continua de 5 s y después se recorta
  // el tramo con movimiento y se acelera a 2 s. ADR-077: los elementos solo se desplazan, sin morph.
  const what =
    mode === 'opening'
      ? 'from the START frame (the last frame of the opening video, footage from outside this lesson) to the END frame (the first scene of the lesson)'
      : 'from the START frame (the last scene of the lesson) to the END frame (the first frame of the closing video, footage from outside this lesson)';
  const prompt = `TRANSITION SHOT (5 seconds): a smooth motion-graphics transition ${what}, made only of sliding elements.
It starts EXACTLY on the start frame, moves continuously for the whole shot with ease-in-out, and lands EXACTLY on the end frame.
CHOREOGRAPHY (element by element): ${choreography.trim()}
${note?.trim() ? `${note.trim()}.\n` : ''}BRAND RULE: logos, brand marks, text and boxes are rigid: they ONLY slide in or out, keeping their exact shape, proportions and colors. Never morph, deform, stretch, warp, rotate or recolor them, and never turn one element into another.
NEVER cross-dissolve, fade or superimpose the two frames: at every moment the picture is one coherent composition. No cuts, no flashes, no blank or white frames, no zoom punch, no shaking.

${t.clipBible}

SOUND: one soft whoosh following the movement, subtle. NO music, NO voice.
TYPOGRAPHY: do not add any new text; keep only the text already present in the frames, with exact spelling. No gibberish, no watermark, no new logos.
AVOID: morphing or distorting logos, stretched or warped elements, cross-dissolve, double exposure, ghosting, ${t.avoid}`;
  return prompt.slice(0, MINIMAX_MAX);
}
export * from './studio.js';

/**
 * Sugerencia para un clip a partir de las observaciones del cliente (hito 9, T11, ADR-122). Opus ve los dos fotogramas
 * del clip (imagen y plano), el prompt del clip, la locución del tramo y las observaciones, y decide qué cambiar.
 */
export function clipAdviceSystemPrompt(t: ThemeStyle): string {
  return `You are the art director of an educational motion-graphics video in the style "${t.info.name}". The video is a chain of AI clips: each clip animates from its START keyframe (a still image) to its END keyframe, while the voice-over narrates.

A client reviewed the work and left observations (in Spanish). Some were written on the storyboard (on a keyframe), others on the finished video (on a shot). Your job: for ONE clip, decide what the editor should change so the observations that concern this clip are addressed, and write instructions that can be applied as they are.

HOW TO CHOOSE THE TARGET
- "start" or "end" (regenerate that keyframe): when the problem is in what is drawn: wrong, missing or misspelled text, layout, colors, sizes, objects, photos, icons, people, logo placement. A new keyframe image is generated and, once applied, the clips that use it are redone (the end keyframe of this clip is also the start of the next one).
- "clip" (regenerate the clip): when the problem is the motion: animation, transition, speed, camera, distortions, morphing or melting artifacts, flicker, elements that appear or vanish, sound effects of the clip.
- Several targets only when the observations really ask for different things. At most 3 actions; none if nothing applies to this clip.
- Voice-over problems (pronunciation, tone, pace, words) and timing cannot be fixed with these actions: put them in "notes" (the editor uses «Rehacer audio»). Also put in "notes" anything that concerns another clip, praise, or requests you cannot follow.
- Observations marked "outdated" were written about an older version: only act on them if the current images or prompt still show the problem.

HOW TO WRITE THE INSTRUCTIONS
- The team that reads your answer speaks Spanish: "summary", "instruction", "why" and "notes" are in Spanish, short and plain.
- "instruction" for a keyframe: the exact change to the frame (quote exact on-screen texts with accents), keeping everything else. Respect the style; never ask for elements the style forbids.
- "instruction" for the clip: what must change in the motion, concrete and visual (what moves, how, what must stay still), at most 60 words. Also give "modelInstruction": the same instruction in English for the video model, at most 60 words, without describing the whole scene again. For keyframes, "modelInstruction" is empty.
- Never invent requirements beyond what the client asked.`;
}

export interface ClipAdviceKeyframe {
  index: number;
  label: string;
  texts: string[];
  scene: string;
}

export function clipAdviceUserText(o: {
  clip: number;
  start?: ClipAdviceKeyframe;
  end?: ClipAdviceKeyframe;
  clipPrompt: string;
  narration: string;
  comments: { id: string; where: string; author: string; text: string; status: string; outdated: boolean }[];
}): string {
  const kf = (role: string, k?: ClipAdviceKeyframe) =>
    k ? `${role} keyframe K${String(k.index).padStart(2, '0')} · ${k.label}\n  texts: ${k.texts.length ? k.texts.map((x) => `"${x}"`).join(', ') : '(none)'}\n  scene: ${k.scene}` : `${role} keyframe: none`;
  return `CLIP ${String(o.clip).padStart(2, '0')}

${kf('START', o.start)}
${kf('END', o.end)}

CLIP PROMPT (video model):
${o.clipPrompt || '(not available)'}

NARRATION DURING THIS CLIP:
${o.narration || '(silence)'}

CLIENT OBSERVATIONS:
${o.comments.map((c) => `- [${c.id}] ${c.where} · ${c.author} · ${c.status}${c.outdated ? ' · outdated' : ''}: ${c.text}`).join('\n')}

The images follow: first the START keyframe, then the END keyframe.`;
}
