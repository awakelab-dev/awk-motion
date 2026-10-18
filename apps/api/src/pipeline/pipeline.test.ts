import { describe, expect, it } from 'vitest';
import { alignWords, wordsFromCharAlignment } from './align.js';
import { splitParagraphs, tokenize } from './text.js';
import { paragraphStarts, planTimeline, segmentsFor, totalFramesFor } from './timeline.js';

describe('timeline', () => {
  it('reproduce el plan real de escena01 (referencia/scripts/plan.py)', () => {
    // Inicios reales: 0, 259, 432, 720 (párrafo 2), 883, 1188, 1440. Total 1684.
    const starts = [0, 259, 432, 720, 883, 1188, 1440];
    const plan = planTimeline({
      anchorFrames: starts.map((s) => s + 24),
      paragraphStartFrames: [undefined, undefined, undefined, 720, undefined, undefined, undefined],
      totalFrames: 1684,
    });
    expect(plan.map((p) => p.startFrame)).toEqual(starts);
    const segs = segmentsFor(plan, () => 124).map((s) => [s.name, s.startFrame, s.endFrame]);
    expect(segs).toEqual([
      ['clip01', 0, 124], ['clip01ex', 124, 259], ['clip02', 259, 383], ['clip02ex', 383, 432],
      ['clip03', 432, 556], ['clip03ex', 556, 720], ['clip04', 720, 844], ['clip04ex', 844, 883],
      ['clip05', 883, 1007], ['clip05ex', 1007, 1188], ['clip06', 1188, 1312], ['clip06ex', 1312, 1440],
      ['clip07', 1440, 1564], ['clip07ex', 1564, 1684],
    ]);
  });

  it('desplaza clips que se pisan y descarta los que no caben', () => {
    const plan = planTimeline({ anchorFrames: [0, 100, 130, 715], totalFrames: 720 });
    expect(plan.map((p) => p.startFrame)).toEqual([0, 124, 248]);
    expect(plan[2].slotEndFrame).toBe(720);
  });

  it('recorta el clip si el siguiente empieza antes de que termine', () => {
    const segs = segmentsFor(
      [
        { shot: 0, startFrame: 0, slotEndFrame: 124 },
        { shot: 1, startFrame: 124, slotEndFrame: 200 },
      ],
      () => 130,
    );
    expect(segs.map((s) => [s.name, s.endFrame - s.startFrame])).toEqual([
      ['clip01', 124],
      ['clip02', 76],
    ]);
  });

  it('párrafos en frame redondo y total = duración de la voz', () => {
    expect(paragraphStarts([29.23, 40.12])).toEqual([0, 30]);
    expect(totalFramesFor(30 + 40.12)).toBe(1683);
    expect(totalFramesFor(70.1667)).toBe(1685);
    expect(totalFramesFor(30)).toBe(720);
  });
});

describe('texto y alineación', () => {
  it('divide párrafos y une líneas cortadas', () => {
    const t = 'Bienvenido al Módulo 1 del curso\nInfecciones Asociadas.\n\nPartamos por el lenguaje común.';
    expect(splitParagraphs(t)).toEqual(['Bienvenido al Módulo 1 del curso Infecciones Asociadas.', 'Partamos por el lenguaje común.']);
  });

  it('el texto fuente manda sobre whisper ("IAS" → "IAAS")', () => {
    const src = tokenize('relacionados con las IAAS: su patogenia');
    const heard = [
      { word: 'relacionados', start: 1, end: 1.5 },
      { word: 'con', start: 1.5, end: 1.6 },
      { word: 'las', start: 1.6, end: 1.7 },
      { word: 'IAS,', start: 1.7, end: 2.1 },
      { word: 'su', start: 2.2, end: 2.3 },
      { word: 'patogenia', start: 2.3, end: 2.9 },
    ];
    const out = alignWords(src, heard, 3);
    expect(out.map((w) => w.word)).toEqual(['relacionados', 'con', 'las', 'IAAS:', 'su', 'patogenia']);
    expect(out[3].start).toBeGreaterThan(1.6);
    expect(out[3].start).toBeLessThan(2.2);
    expect(out[5].start).toBe(2.3);
  });

  it('agrupa caracteres de ElevenLabs en palabras', () => {
    const chars = [...'Hola, mundo'];
    const st = chars.map((_, i) => i * 0.1);
    const en = chars.map((_, i) => i * 0.1 + 0.08);
    const w = wordsFromCharAlignment(chars, st, en);
    expect(w.map((x) => x.word)).toEqual(['Hola,', 'mundo']);
    expect(w[0].end).toBeCloseTo(0.48);
    expect(w[1].start).toBeCloseTo(0.6);
  });
});
