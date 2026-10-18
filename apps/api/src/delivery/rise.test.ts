import { describe, expect, it } from 'vitest';
import { riseCode, riseHtml, riseTxt } from './rise.js';

const it1 = { title: '1. Higiene de manos', video: 'https://media.example/p/abc/video.mp4', subtitles: 'https://media.example/p/abc/subtitulos.vtt', poster: 'https://media.example/p/abc/portada.jpg' };
const o = { subtitlesOn: true, quality: '1080p · equilibrada', logo: true, createdAt: new Date('2026-10-10T12:00:00Z') };

describe('código para Rise 360 (ADR-103)', () => {
  it('es el código probado en Rise, sin atributos de más (ADR-115)', () => {
    expect(riseCode(it1, o)).toBe(
      [
        '<video controls crossorigin="anonymous">',
        '  <source src="https://media.example/p/abc/video.mp4" type="video/mp4">',
        '  <track kind="subtitles" src="https://media.example/p/abc/subtitulos.vtt" srclang="es" label="Español" default>',
        '</video>',
      ].join('\n'),
    );
  });

  it('sin subtítulos encendidos no lleva default; sin .vtt no lleva track', () => {
    expect(riseCode(it1, { subtitlesOn: false })).not.toContain(' default');
    expect(riseCode({ title: 'x', video: 'https://v/video.mp4' }, o)).not.toContain('<track');
  });

  it('el .txt lleva el título y el código de cada video', () => {
    const t = riseTxt('Proyecto «IAAS»', [it1, { ...it1, title: '2. Otro' }], o);
    expect(t).toContain('Código para Rise 360 · Proyecto «IAAS»');
    expect(t).toContain('2 videos · 1080p · equilibrada · con el logo del proyecto');
    expect(t.match(/<video /g)).toHaveLength(2);
  });

  it('el .html escapa el código en el textarea y lo muestra como vista previa', () => {
    const h = riseHtml('A <b>&</b>', [it1], o);
    expect(h).toContain('<title>Código para Rise 360 · A &lt;b&gt;&amp;&lt;/b&gt;</title>');
    expect(h).toContain('<div class="preview"><video controls');
    expect(h).toContain('&lt;video controls crossorigin');
    expect(h).not.toContain('<script src=');
  });
});
