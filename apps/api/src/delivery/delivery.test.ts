import { describe, expect, it } from 'vitest';
import { DEFAULT_LOGO_SETTINGS } from '@wilox/shared';
import { allCorners, logoSize, mergeSettings, sanitizeSvg } from './delivery.service.js';
import { playerFiles, playerHtml } from './player.js';

describe('entrega: logo y reproductor HTML (ADR-065)', () => {
  it('los ajustes del video mandan sobre los del proyecto y estos sobre los por defecto', () => {
    expect(mergeSettings()).toEqual(DEFAULT_LOGO_SETTINGS);
    expect(mergeSettings({ corner: 'bl', widthPct: 20 }, { widthPct: 10, effect: 'glow' })).toEqual({ ...DEFAULT_LOGO_SETTINGS, corner: 'bl', widthPct: 10, effect: 'glow' });
  });

  it('limpia un SVG: sin scripts, sin manejadores de eventos ni referencias externas', () => {
    const svg = sanitizeSvg('<svg onload="alert(1)" viewBox="0 0 10 5"><script>alert(2)</script><a href="https://x.y"><rect width="10" height="5"/></a></svg>');
    expect(svg).not.toMatch(/script|onload|https:/);
    expect(svg).toContain('<rect');
    expect(logoSize(Buffer.from(svg), 'image/svg+xml')).toEqual({ width: 10, height: 5 });
  });

  it('el reproductor no depende de nada externo y lleva subtítulos y logo dentro', () => {
    const html = playerHtml({
      title: 'Prueba <x>',
      videoSrc: 'video.mp4',
      cues: [{ start: 0, end: 1, text: 'Hola </script> mundo' }],
      logoDataUrl: 'data:image/png;base64,AAAA',
      settings: DEFAULT_LOGO_SETTINGS,
      durationSec: 10,
    });
    expect(html).not.toMatch(/(src|href)=["']https?:/);
    expect(html).not.toMatch(/@import|<link /);
    expect(html).toContain('src="video.mp4"');
    expect(html).toContain('Prueba &lt;x&gt;');
    // el texto de los subtítulos no puede cerrar el <script> de la configuración
    expect(html.match(/<\/script>/g)!.length).toBe(2);
    expect(html).toContain('data:image/png;base64,AAAA');
  });

  it('una esquina para todos los clips no le pone logo a los clips sin logo (ADR-067)', () => {
    const clips = [{ index: 1 }, { index: 2 }, { index: 3 }];
    expect(allCorners(clips, { '2': 'none', '3': 'tl' }, 'br')).toEqual({ '1': 'br', '2': 'none', '3': 'br' });
  });

  it('el reproductor oculta el logo en los clips sin logo', () => {
    const html = playerHtml({ title: 'x', videoSrc: 'v.mp4', cues: [], settings: DEFAULT_LOGO_SETTINGS, durationSec: 2, clips: [{ index: 1, start: 0, end: 2 }], clipCorners: { '1': 'none' } });
    expect(html).toContain('"clipCorners":{"1":"none"}');
    expect(html).toContain("corner === 'none'");
  });

  it('el link para compartir abre con subtítulos y fuera de los buscadores; las descargas no cambian (ADR-083)', () => {
    const base = { title: 'x', videoSrc: 'v.mp4', cues: [], settings: DEFAULT_LOGO_SETTINGS, durationSec: 2 };
    const share = playerHtml({ ...base, share: true });
    expect(share).toContain('"cc":true');
    expect(share).toContain('<meta name="robots" content="noindex, nofollow">');
    const normal = playerHtml(base);
    expect(normal).not.toContain('"cc":true');
    expect(normal).not.toContain('noindex');
  });

  it('el paquete separa HTML, CSS, JavaScript, datos, subtítulos, portada y logo (ADR-068)', () => {
    const f = playerFiles(
      {
        title: 'x',
        videoSrc: 'video.mp4',
        cues: [{ start: 0, end: 1, text: 'Hola' }],
        logoDataUrl: `data:image/png;base64,${Buffer.from('png').toString('base64')}`,
        posterJpeg: Buffer.from('jpg'),
        settings: DEFAULT_LOGO_SETTINGS,
        durationSec: 2,
        scorm: '2004',
      },
      { vtt: 'WEBVTT', srt: '1' },
    );
    expect(Object.keys(f).sort()).toEqual(
      ['css/reproductor.css', 'img/logo.png', 'img/portada.jpg', 'index.html', 'js/config.js', 'js/reproductor.js', 'js/scorm.js', 'js/subtitulos.js', 'subtitulos.srt', 'subtitulos.vtt'].sort(),
    );
    const html = String(f['index.html']);
    expect(html).not.toMatch(/<style>|\(function\(\)|WEBVTT|base64/);
    expect(html).toContain('<link rel="stylesheet" href="css/reproductor.css">');
    expect(html).toContain("url('img/portada.jpg')");
    expect(html.indexOf('js/config.js')).toBeLessThan(html.indexOf('js/reproductor.js'));
    expect(html.indexOf('js/reproductor.js')).toBeLessThan(html.indexOf('js/scorm.js'));
    expect(String(f['js/config.js'])).toContain('"logo":"img/logo.png"');
    expect(String(f['js/config.js'])).not.toContain('Hola');
    expect(String(f['js/subtitulos.js'])).toBe('window.WILOX_CUES = [{"start":0,"end":1,"text":"Hola"}];\n');
    expect(String(f['js/reproductor.js'])).toContain('window.WILOX_CONFIG');
  });
});
