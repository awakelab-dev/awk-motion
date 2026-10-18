import { describe, expect, it } from 'vitest';
import { spokenWords } from '../delivery/subtitles.js';
import { reviewHtml } from './review-page.js';

describe('presentación del storyboard (ADR-098)', () => {
  it('escapa los datos del video y de las observaciones dentro de la página', () => {
    const html = reviewHtml({
      base: '/api/revision/tok',
      title: '</script><script>alert(1)</script>',
      project: 'P & <b>',
      slides: [{ index: 0, label: 'K00', version: 1, start: 0, end: 0, words: [] }],
      comments: [{ id: '1', keyframeIndex: 0, author: '<img src=x onerror=alert(1)>', text: '</script>', createdAt: '2026-10-09T12:00:00Z', resolved: false, outdated: false }],
    });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('P &amp; &lt;b&gt;');
    expect(html.match(/<\/script>/g)?.length).toBe(2); // solo los dos <script> propios
  });

  it('las palabras de la locución conservan los signos del texto', () => {
    const items = spokenWords([{ text: '¿Qué es? Algo — simple.' }], [
      { word: 'Qué', start: 0, end: 0.3, paragraph: 0 },
      { word: 'es', start: 0.3, end: 0.5, paragraph: 0 },
      { word: 'Algo', start: 0.6, end: 0.9, paragraph: 0 },
      { word: 'simple', start: 1, end: 1.4, paragraph: 0 },
    ]);
    expect(items.map((i) => i.text)).toEqual(['¿Qué', 'es?', 'Algo —', 'simple.']);
  });
});

describe('revisión del video: tramo de cada plano en el final (T6b, ADR-116)', () => {
  it('sin insertos, cada plano va de su clip al siguiente y el último hasta el final', async () => {
    const { planoTimes } = await import('./review.service.js');
    const slots = new Map([[1, { start: 0 }], [2, { start: 7 }], [3, { start: 14 }]]);
    const t = planoTimes([0, 1, 2, 3], slots, { totalFrames: 20 * 24, gaps: [] });
    expect(t).toEqual([{ start: 0, end: 0 }, { start: 0, end: 7 }, { start: 7, end: 14 }, { start: 14, end: 20 }]);
  });
  it('con una portada subida (al principio) y un inserto tras el clip 2, los planos se corren', async () => {
    const { planoTimes } = await import('./review.service.js');
    const slots = new Map([[1, { start: 1 }], [2, { start: 7 }], [3, { start: 14 }]]);
    const comp = {
      totalFrames: (20 + 3 + 5) * 24,
      gaps: [
        { after: 0, boundaryFrame: 0, cutSec: 0, frames: 3 * 24, inserts: [] },
        { after: 2, boundaryFrame: 14 * 24, cutSec: 13.9, frames: 5 * 24, inserts: [] },
      ],
    };
    const t = planoTimes([0, 1, 2, 3], slots, comp);
    // K00 cubre la portada (3 s) y lo que suena antes del clip 1; el inserto queda en el plano 2.
    expect(t).toEqual([{ start: 0, end: 4 }, { start: 4, end: 10 }, { start: 10, end: 22 }, { start: 22, end: 28 }]);
  });
});
