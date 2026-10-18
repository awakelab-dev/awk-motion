import { GlobalFonts, createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { weightName } from '@wilox/prompts';

/**
 * Láminas tipográficas del tema (hito 8, A2, ADR-094): la fuente real (Google Fonts o un .ttf/.otf subido),
 * dibujada en una lámina neutral como la que funcionó a mano en el hito 7 (ADR-088): alfabeto en mayúsculas y
 * minúsculas con la Ñ en cada peso, números, tildes y signos, y una frase con todas las letras. Sin palabras
 * de ningún video (GPT Image se sesgaba hacia ese fotograma).
 */

export interface FontFile {
  weight: number;
  path: string;
}

export const slugOf = (family: string) =>
  family
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'fuente';

/** Pesos por defecto según el rol: el regular y el del titular (ExtraBold, o Bold para el texto). */
export const defaultWeights = (role: 'headings' | 'body' | 'both') => (role === 'body' ? [400, 700] : [400, 800]);

/** Pesos a probar, del pedido al más cercano (Oswald no tiene 800: queda en 700). */
const candidates = (w: number) => [w, w - 100, w + 100, w - 200, w + 200, w - 300, w + 300].filter((x) => x >= 100 && x <= 900);

/**
 * Baja un peso de Google Fonts (CSS2 sin agente de navegador → TrueType) y lo guarda en la caché compartida
 * `storage/fuentes/google/<familia>/<peso>.ttf`. Devuelve undefined si la familia no tiene ese peso.
 */
async function googleWeight(family: string, weight: number, cacheDir: string): Promise<string | undefined> {
  const file = join(cacheDir, slugOf(family), `${weight}.ttf`);
  if (existsSync(file)) return file;
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${weight}`;
  const res = await fetch(url, { headers: { 'user-agent': 'Wilox-Motion' } });
  if (res.status === 400) return undefined;
  if (!res.ok) throw new Error(`Google Fonts respondió ${res.status}.`);
  const css = await res.text();
  const src = /src:\s*url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/.exec(css)?.[1];
  if (!src) throw new Error('Google Fonts no devolvió el archivo de la fuente.');
  const bin = await fetch(src);
  if (!bin.ok) throw new Error(`No se pudo bajar la fuente (${bin.status}).`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.part`, Buffer.from(await bin.arrayBuffer()));
  await rename(`${file}.part`, file);
  return file;
}

/** ¿Está la familia en Google Fonts? (con su peso regular o el más cercano). */
export async function googleFamilyExists(family: string, cacheDir: string): Promise<boolean> {
  for (const w of candidates(400)) if (await googleWeight(family, w, cacheDir)) return true;
  return false;
}

/** Los pesos pedidos (o los más cercanos que tenga la familia), sin repetir. */
export async function googleFont(family: string, weights: number[], cacheDir: string): Promise<FontFile[]> {
  const out: FontFile[] = [];
  for (const w of weights) {
    for (const c of candidates(w)) {
      if (out.some((f) => f.weight === c)) break;
      const path = await googleWeight(family, c, cacheDir);
      if (path) {
        out.push({ weight: c, path });
        break;
      }
    }
  }
  if (!out.length) throw new Error(`«${family}» no está en Google Fonts: revisa el nombre o sube su archivo .ttf u .otf.`);
  return out.sort((a, b) => b.weight - a.weight);
}

/** Registra un archivo de fuente con un alias propio; lanza un error si no es una fuente válida. */
function register(path: string, alias: string) {
  const key = GlobalFonts.registerFromPath(path, alias);
  if (!key) throw new Error('El archivo no es una fuente TrueType u OpenType válida.');
}

/** Comprueba un .ttf/.otf subido antes de guardarlo en el tema. */
export function validateFont(path: string) {
  register(path, `wilox-check-${Date.now()}`);
}

const W = 1920;
const M = 100;
const INK = '#141414';
const SOFT = '#4a4a4a';
const UPPER = 'ABCDEFGHIJKLMNÑOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnñopqrstuvwxyz';
const DIGITS = '0123456789';
const SIGNS = 'áéíóú ÁÉÍÓÚ üÜ   ¿? ¡!   «» “”   % $ & @ #   ,.:;   ( )  – /';
const KEY_GLYPHS = 'a g y l t f j ñ  Q R G J  1 4 7';
const PANGRAM = 'El veloz murciélago hindú comía feliz cardillo y kiwi.';

/** Tamaño de letra para que el texto quepa en el ancho (con un tope). */
function fit(ctx: SKRSContext2D, font: (px: number) => string, text: string, width: number, max: number) {
  let px = max;
  ctx.font = font(px);
  const w = ctx.measureText(text).width;
  if (w > width) px = Math.floor((max * width) / w);
  return px;
}

/**
 * Dibuja la lámina (PNG 1920 px de ancho; el alto depende de los pesos): cabecera gris con el nombre, por cada
 * peso (del más grueso al más fino) su nombre, las mayúsculas y las minúsculas; los números en todos los pesos;
 * tildes y signos; y una franja con la frase, en el peso más fino.
 */
export async function renderSpecimen(family: string, files: FontFile[], out: string): Promise<void> {
  const faces = [...files].sort((a, b) => b.weight - a.weight);
  const tag = `wilox-${slugOf(family)}-${Date.now().toString(36)}`;
  for (const f of faces) register(f.path, `${tag}-${f.weight}`);
  const font = (w: number) => (px: number) => `${px}px "${tag}-${w}"`;
  const light = faces[faces.length - 1].weight;
  const probe = createCanvas(W, 100).getContext('2d');

  // Medidas: cada bloque con su tamaño ajustado al ancho útil.
  type Row = { h: number; draw: (ctx: SKRSContext2D, y: number) => void };
  const rows: Row[] = [];
  const text = (t: string, w: number, max: number, color = INK, gap = 0.32): Row => {
    const px = fit(probe, font(w), t, W - 2 * M, max);
    return {
      h: Math.round(px * (1 + gap)),
      draw: (ctx, y) => {
        ctx.font = font(w)(px);
        ctx.fillStyle = color;
        ctx.fillText(t, M, y + px);
      },
    };
  };
  for (const f of faces) {
    const label = `${weightName(f.weight)} ${f.weight}`;
    rows.push({
      h: 44,
      draw: (ctx, y) => {
        ctx.font = font(light)(24);
        ctx.fillStyle = '#8a8a8a';
        ctx.fillText(label.toUpperCase(), M, y + 26);
      },
    });
    rows.push(text(UPPER, f.weight, 104));
    rows.push(text(LOWER, f.weight, 104, INK, 0.45));
  }
  // Números en todos los pesos, uno al lado del otro.
  {
    const gapX = 60;
    let px = 96;
    const width = () =>
      faces.reduce((n, f) => {
        probe.font = font(f.weight)(px);
        return n + probe.measureText(DIGITS).width;
      }, 0) +
      gapX * (faces.length - 1);
    const total = width();
    if (total > W - 2 * M) px = Math.floor((px * (W - 2 * M)) / total);
    rows.push({
      h: Math.round(px * 1.4),
      draw: (ctx, y) => {
        let x = M;
        for (const f of faces) {
          ctx.font = font(f.weight)(px);
          ctx.fillStyle = INK;
          ctx.fillText(DIGITS, x, y + px);
          x += ctx.measureText(DIGITS).width + gapX;
        }
      },
    });
  }
  // Letras clave en grande, en el peso más grueso y el más fino: las que más cambian de una fuente a otra
  // (a y g de uno o dos pisos, la cola de la y, el remate de la l y la t, la Q, la R…). GPT Image las copiaba
  // peor cuando solo aparecían en la fila del alfabeto (la g de Work Sans, ADR-094).
  {
    const label = 'LETRAS CLAVE';
    rows.push({
      h: 44,
      draw: (ctx, y) => {
        ctx.font = font(light)(24);
        ctx.fillStyle = '#8a8a8a';
        ctx.fillText(label, M, y + 26);
      },
    });
    const heavy = faces[0].weight;
    const pair = faces.length > 1 ? [heavy, light] : [heavy];
    for (const w of pair) rows.push(text(KEY_GLYPHS, w, 150, INK, 0.3));
  }
  rows.push(text(SIGNS, light, 64, SOFT, 0.6));

  const HEAD = 100;
  const FOOT = 110;
  const body = rows.reduce((n, r) => n + r.h, 0);
  const H = HEAD + 40 + body + 30 + FOOT;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  // Cabecera: nombre de la fuente.
  ctx.fillStyle = '#f1f1f1';
  ctx.fillRect(0, 0, W, HEAD);
  ctx.font = font(faces[0].weight)(fit(probe, font(faces[0].weight), `${family.toUpperCase()} · MUESTRA TIPOGRÁFICA`, W - 2 * M, 36));
  ctx.fillStyle = SOFT;
  ctx.fillText(`${family.toUpperCase()} · MUESTRA TIPOGRÁFICA`, M, 64);
  let y = HEAD + 40;
  for (const r of rows) {
    r.draw(ctx, y);
    y += r.h;
  }
  // Franja con la frase, en el peso más fino.
  ctx.fillStyle = '#d6d6d6';
  ctx.fillRect(0, H - FOOT, W, FOOT);
  const pp = fit(probe, font(light), PANGRAM, W - 2 * M, 52);
  ctx.font = font(light)(pp);
  ctx.fillStyle = INK;
  ctx.fillText(PANGRAM, M, H - FOOT + (FOOT + pp * 0.7) / 2);

  await mkdir(dirname(out), { recursive: true });
  await writeFile(`${out}.part`, await canvas.encode('png'));
  await rename(`${out}.part`, out);
}
