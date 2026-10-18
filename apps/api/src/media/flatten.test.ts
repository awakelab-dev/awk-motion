import { describe, expect, it } from 'vitest';
import { flattenRgba } from './flatten.js';

/** Imagen de prueba: fondo blanco, una letra «gruesa» verde moteada y un recuadro de «foto» con detalle fino. */
function sample(w = 400, h = 240) {
  const px = new Uint8ClampedArray(w * h * 4);
  // Moteado suave (baja frecuencia, ±8 niveles) como el de GPT Image.
  const mottle = (x: number, y: number) => 8 * Math.sin(x / 9) * Math.cos(y / 11);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let c = [250, 250, 250];
      if (x >= 30 && x < 170 && y >= 40 && y < 200) c = [68 + mottle(x, y), 168 + mottle(x, y), 8];
      // «Foto»: rayas finas de alto contraste (no debe cambiar).
      if (x >= 230 && x < 370 && y >= 40 && y < 200) c = (x + y) % 6 < 3 ? [40, 60, 90] : [200, 180, 150];
      px.set([...c.map((v) => Math.round(v)), 255], i);
    }
  return { px, w, h };
}

const region = (px: Uint8ClampedArray, w: number, x0: number, x1: number, y0: number, y1: number, c: number) => {
  const v: number[] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) v.push(px[(y * w + x) * 4 + c]);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { mean, std: Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length), min: Math.min(...v), max: Math.max(...v) };
};

describe('colores planos (ADR-137)', () => {
  it('alisa el moteado de la letra y no toca la foto ni el contorno', () => {
    const { px, w, h } = sample();
    const before = px.slice();
    const stats = flattenRgba(px, w, h);
    const g0 = region(before, w, 45, 155, 55, 185, 1);
    const g1 = region(px, w, 45, 155, 55, 185, 1);
    expect(g0.max - g0.min).toBeGreaterThanOrEqual(14);
    expect(g1.std).toBeLessThan(g0.std / 2);
    expect(Math.abs(g1.mean - g0.mean)).toBeLessThan(2);
    // Foto: idéntica.
    let changed = 0;
    for (let y = 45; y < 195; y++) for (let x = 235; x < 365; x++) for (let c = 0; c < 3; c++) if (px[(y * w + x) * 4 + c] !== before[(y * w + x) * 4 + c]) changed++;
    expect(changed).toBe(0);
    // El borde de la letra sigue nítido: blanco afuera, verde adentro.
    expect(px[(120 * w + 25) * 4 + 1]).toBe(250);
    expect(px[(120 * w + 35) * 4 + 0]).toBeLessThan(100);
    expect(stats.regions).toBeGreaterThanOrEqual(2);
  });

  it('respeta un degradado amplio del fondo', () => {
    const w = 300, h = 200;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([200 + Math.round(x / 30), 210, 230, 255], (y * w + x) * 4);
    flattenRgba(px, w, h);
    expect(Math.abs(px[(100 * w + 10) * 4] - 200)).toBeLessThanOrEqual(1);
    expect(Math.abs(px[(100 * w + 150) * 4] - 205)).toBeLessThanOrEqual(1);
    expect(Math.abs(px[(100 * w + 290) * 4] - 209)).toBeLessThanOrEqual(1);
  });
});
