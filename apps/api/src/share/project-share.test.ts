import { describe, expect, it } from 'vitest';
import { reviewHtml } from '../review/review-page.js';
import { projectGoneHtml, projectPageHtml } from './project-share-page.js';
import { projectShareOf, projectSharePath, projectVideoPath } from './project-share.js';

describe('links del proyecto (T6 y T6b, ADR-112 y ADR-116)', () => {
  it('aprobación: solo los storyboards, sin pestaña de videos', () => {
    const html = projectPageHtml({
      kind: 'review',
      name: 'Curso <A>',
      logo: null,
      videos: [
        { id: 'v1', title: 'Uno', href: '/api/proyecto/t/v/v1/revision', thumb: '/api/proyecto/t/v/v1/miniatura.jpg', openComments: 2, approved: false },
        { id: 'v2', title: 'Dos', href: '/api/proyecto/t/v/v2/revision', openComments: 0, approved: true },
      ],
    });
    expect(html).toContain('Curso &lt;A&gt;');
    expect(html).toContain('Aprobación del storyboard');
    expect(html).toContain('2 observaciones');
    expect(html).toContain('Aprobado');
    expect(html).toContain('href="/api/proyecto/t/v/v1/revision"');
    expect(html).not.toContain('data-tab');
    expect(html).not.toContain('class="play"');
    expect(html).toContain('noindex');
    expect(projectGoneHtml()).toContain('ya no está disponible');
  });

  it('revisión de los videos: tarjetas con duración, observaciones y su página de revisión', () => {
    const html = projectPageHtml({
      kind: 'videos',
      name: 'Curso',
      videos: [{ id: 'v1', title: 'Uno', href: '/api/revision-videos/t/v/v1', thumb: '/api/revision-videos/t/v/v1/portada.jpg', durationSec: 75, openComments: 1, approved: false }],
    });
    expect(html).toContain('Revisión de los videos');
    expect(html).toContain('1:15');
    expect(html).toContain('1 observación');
    expect(html).toContain('href="/api/revision-videos/t/v/v1"');
    expect(html).toContain('class="play"');
    expect(html).not.toContain('Aprobado');
    // Los chips van debajo del título, en su propia fila (T11c, ADR-124).
    expect(html).toMatch(/<div class="head">.*Uno<\/span><\/div><div class="chips">.*1 observación/);
  });

  it('la revisión del video lleva el video y no la aprobación', () => {
    const html = reviewHtml({
      mode: 'video',
      base: '/api/revision-videos/t/v/v1',
      back: { href: '/api/revision-videos/t', label: 'Curso' },
      title: 'Uno',
      project: 'Curso',
      video: '/api/revision-videos/t/v/v1/video.mp4?v=abc',
      overlay: { logo: 'data:image/png;base64,AAAA', settings: { corner: 'tr', widthPct: 12, marginPct: 3, effect: 'none', opacity: 1 }, clips: [{ index: 1, start: 0, end: 4 }], clipCorners: { '1': 'bl' } },
      slides: [{ index: 0, label: 'K00', version: 1, image: '/x/k/0', start: 0, end: 4, words: [] }],
      comments: [],
    });
    expect(html).toContain('<video id="vid"');
    expect(html).toContain('src="/api/revision-videos/t/v/v1/video.mp4?v=abc"');
    expect(html).toContain('Revisión del video');
    expect(html).toContain('← Curso');
    // El logo del proyecto encima del video, con la esquina de cada clip.
    expect(html).toContain('<div class="vlogo" id="vlogo" hidden><img src="data:image/png;base64,AAAA"');
    expect(html).toContain('"clipCorners":{"1":"bl"}');
  });

  it('rutas y lectura de cada link guardado en el proyecto', () => {
    expect(projectVideoPath('tok', 'v1')).toBe('/api/proyecto/tok/v/v1');
    expect(projectVideoPath('tok', 'v1', 'videos')).toBe('/api/revision-videos/tok/v/v1');
    expect(projectSharePath('tok', 'videos')).toBe('/api/revision-videos/tok');
    const d = { share: { token: 'x', createdAt: 'y', videoIds: null }, videoShare: { token: 'z', createdAt: 'y', videoIds: ['a'] } };
    expect(projectShareOf(d)?.token).toBe('x');
    expect(projectShareOf(d, 'videos')?.token).toBe('z');
    expect(projectShareOf({ share: d.share }, 'videos')).toBeUndefined();
    expect(projectShareOf(null)).toBeUndefined();
  });
});
