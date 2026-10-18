import { describe, expect, it } from 'vitest';
import { DEFAULT_LOGO_SETTINGS } from '@wilox/shared';
import { burnFilter, logoRuns, logoXY, svgAtSize, type LogoLayer } from './burn.js';

const parts = [
  { index: 1, startSec: 0, endSec: 5 },
  { index: 2, startSec: 5, endSec: 10 },
  { index: 3, startSec: 10, endSec: 15 },
  { index: 4, startSec: 15, endSec: 20 },
];

describe('logo dibujado en el video (ADR-102)', () => {
  it('une los clips seguidos con la misma esquina y quita los tramos sin logo (con fundido en sus bordes)', () => {
    const runs = logoRuns(parts, { '2': 'tr', '3': 'none', '4': 'bl' }, 'tr', 20);
    expect(runs).toEqual([
      { corner: 'tr', start: 0, end: 10, fadeIn: false, fadeOut: true },
      { corner: 'bl', start: 15, end: 20, fadeIn: true, fadeOut: false },
    ]);
  });

  it('fuera de los clips manda la esquina del proyecto', () => {
    expect(logoRuns([{ index: 1, startSec: 2, endSec: 4 }], { '1': 'bl' }, 'tr', 6).map((r) => [r.corner, r.start, r.end])).toEqual([
      ['tr', 0, 2],
      ['bl', 2, 4],
      ['tr', 4, 6],
    ]);
  });

  it('un SVG se dibuja al tamaño final conservando su viewBox', () => {
    expect(svgAtSize('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><rect/></svg>', 500, 200)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40" width="500" height="200" preserveAspectRatio="xMidYMid meet"><rect/></svg>',
    );
    expect(svgAtSize('<svg viewBox="0 0 10 10" width="10px">', 30, 30)).toBe('<svg viewBox="0 0 10 10" width="30" height="30" preserveAspectRatio="xMidYMid meet">');
  });

  it('posición por esquina con el margen y el realce que sobresale', () => {
    const layer: LogoLayer = { png: Buffer.alloc(0), width: 250, height: 110, bleed: 10, boxWidth: 230, boxHeight: 90 };
    const s = { ...DEFAULT_LOGO_SETTINGS, marginPct: 3 };
    expect(logoXY(layer, 'tl', s, 1920, 1080)).toEqual({ x: 48, y: 48 });
    expect(logoXY(layer, 'br', s, 1920, 1080)).toEqual({ x: 1920 - 58 - 230 - 10, y: 1080 - 58 - 90 - 10 });
  });

  it('un overlay por tramo, con sus fundidos y activo solo en su ventana', () => {
    const layer: LogoLayer = { png: Buffer.alloc(0), width: 100, height: 50, bleed: 0, boxWidth: 100, boxHeight: 50 };
    const runs = logoRuns(parts, { '3': 'none', '4': 'bl' }, 'tr', 20);
    const f = burnFilter({ runs, layer, settings: { ...DEFAULT_LOGO_SETTINGS, opacity: 0.8 }, videoWidth: 1920, videoHeight: 1080, scale: true });
    expect(f).toContain('[0:v]scale=-2:1080:flags=lanczos[b0]');
    expect(f).toContain('colorchannelmixer=aa=0.800,split=2[l0][l1]');
    expect(f).toContain("[l0]fade=t=out:st=10.000:d=0.260:alpha=1[f0]");
    expect(f).toContain("overlay=x=1762:y=58:enable='between(t,0.000,10.260)'[b1]");
    expect(f).toContain("[l1]fade=t=in:st=15.260:d=0.250:alpha=1[f1]");
    expect(f).toContain("[b1][f1]overlay=x=58:y=972:enable='between(t,15.260,20.000)'[v]");
  });

  it('sin tramos con logo, solo el video', () => {
    const layer: LogoLayer = { png: Buffer.alloc(0), width: 1, height: 1, bleed: 0, boxWidth: 1, boxHeight: 1 };
    expect(burnFilter({ runs: [], layer, settings: DEFAULT_LOGO_SETTINGS, videoWidth: 2560, videoHeight: 1440, scale: false })).toBe('[0:v]null[v]');
  });
});
