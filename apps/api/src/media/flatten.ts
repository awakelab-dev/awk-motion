import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { readFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import pLimit from 'p-limit';

/**
 * «Colores planos» (hito 10, T7, ADR-137). GPT Image deja un moteado suave (manchas de ±8 niveles) en las superficies
 * grandes de un solo color, sobre todo en letras gruesas y saturadas. No es una decisión de estilo: no se quita con
 * el prompt. Este filtro lo alisa sin tocar bordes ni fotos:
 * 1. Bordes = donde un píxel difiere de su vecino más de `edge` niveles (tras un desenfoque leve); se ensanchan 2 px.
 * 2. Lo que no es borde se separa en regiones conectadas. Solo se alisan las grandes (≥ `minArea` px) y casi de un
 *    color (desviación ≤ `maxStd` por canal): letras gruesas, fondos, bandas. Las fotos quedan fuera porque tienen
 *    bordes por todas partes o, en sus zonas desenfocadas, más variación.
 * 3. Cada región se promedia solo con sus propios píxeles (convolución normalizada, radio ~`radius`): no se mezclan
 *    colores vecinos y los degradados amplios se conservan. El borde de la región se funde con el original.
 */
export interface FlattenOptions {
  edge?: number;
  minArea?: number;
  maxStd?: number;
  radius?: number;
}

export interface FlattenStats {
  regions: number;
  /** Fracción de la imagen alisada. */
  share: number;
}

const DEFAULTS = { edge: 4, minArea: 1500, maxStd: 5, radius: 40 };

/** Desenfoque de caja separable, en el sitio (bordes: se repite el último píxel). */
function boxBlur(src: Float32Array, w: number, h: number, r: number, tmp: Float32Array) {
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[o + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = acc / n;
      acc += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      src[y * w + x] = acc / n;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
}

/** Alisa el moteado de una imagen RGBA (en el sitio). */
export function flattenRgba(px: Uint8ClampedArray | Uint8Array, w: number, h: number, opts: FlattenOptions = {}): FlattenStats {
  const o = { ...DEFAULTS, ...opts };
  const N = w * h;
  const ch = [0, 1, 2].map((c) => {
    const a = new Float32Array(N);
    for (let i = 0; i < N; i++) a[i] = px[i * 4 + c];
    return a;
  });
  const tmp = new Float32Array(N);

  // 1. Bordes, sobre una copia levemente desenfocada (dos pasadas de caja de radio 1 ≈ gaussiana σ 1).
  const edge = new Uint8Array(N);
  for (const c of ch) {
    const b = c.slice();
    boxBlur(b, w, h, 1, tmp);
    boxBlur(b, w, h, 1, tmp);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const dx = x < w - 1 ? Math.abs(b[i + 1] - b[i]) : 0;
        const dy = y < h - 1 ? Math.abs(b[i + w] - b[i]) : 0;
        if (dx > o.edge || dy > o.edge) edge[i] = 1;
      }
  }
  // Ensanchar 2 px (cuadrado 5×5, separable).
  const wide = new Uint8Array(N);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let e = 0;
      for (let k = Math.max(0, x - 2); k <= Math.min(w - 1, x + 2) && !e; k++) e = edge[y * w + k];
      wide[y * w + x] = e;
    }
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      let e = 0;
      for (let k = Math.max(0, y - 2); k <= Math.min(h - 1, y + 2) && !e; k++) e = wide[k * w + x];
      edge[y * w + x] = e;
    }

  // 2. Regiones conectadas (4 vecinos) de lo que no es borde.
  const label = new Int32Array(N);
  const stack = new Int32Array(N);
  type Region = { id: number; area: number; x0: number; y0: number; x1: number; y1: number; sum: number[]; sq: number[] };
  const regions: Region[] = [];
  let next = 0;
  for (let s = 0; s < N; s++) {
    if (edge[s] || label[s]) continue;
    const id = ++next;
    const r: Region = { id, area: 0, x0: w, y0: h, x1: 0, y1: 0, sum: [0, 0, 0], sq: [0, 0, 0] };
    let top = 0;
    stack[top++] = s;
    label[s] = id;
    while (top) {
      const i = stack[--top];
      const x = i % w;
      const y = (i - x) / w;
      r.area++;
      if (x < r.x0) r.x0 = x;
      if (x > r.x1) r.x1 = x;
      if (y < r.y0) r.y0 = y;
      if (y > r.y1) r.y1 = y;
      for (let c = 0; c < 3; c++) {
        const v = ch[c][i];
        r.sum[c] += v;
        r.sq[c] += v * v;
      }
      if (x > 0 && !edge[i - 1] && !label[i - 1]) (label[i - 1] = id), (stack[top++] = i - 1);
      if (x < w - 1 && !edge[i + 1] && !label[i + 1]) (label[i + 1] = id), (stack[top++] = i + 1);
      if (y > 0 && !edge[i - w] && !label[i - w]) (label[i - w] = id), (stack[top++] = i - w);
      if (y < h - 1 && !edge[i + w] && !label[i + w]) (label[i + w] = id), (stack[top++] = i + w);
    }
    if (r.area < o.minArea) continue;
    const std = [0, 1, 2].map((c) => Math.sqrt(Math.max(0, r.sq[c] / r.area - (r.sum[c] / r.area) ** 2)));
    if (Math.max(...std) <= o.maxStd) regions.push(r);
  }

  // 3. Promedio de cada región con sus propios píxeles (3 pasadas de caja ≈ gaussiana).
  const out = ch.map((c) => c.slice());
  const touched = new Uint8Array(N);
  const R = o.radius;
  const br = Math.max(1, Math.round(R / 2));
  let smoothed = 0;
  for (const r of regions) {
    const x0 = Math.max(0, r.x0 - R), y0 = Math.max(0, r.y0 - R);
    const x1 = Math.min(w - 1, r.x1 + R), y1 = Math.min(h - 1, r.y1 + R);
    const cw = x1 - x0 + 1, chh = y1 - y0 + 1, cn = cw * chh;
    const m = new Float32Array(cn);
    for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) m[y * cw + x] = label[(y + y0) * w + x + x0] === r.id ? 1 : 0;
    const t = new Float32Array(cn);
    const wgt = m.slice();
    for (let p = 0; p < 3; p++) boxBlur(wgt, cw, chh, br, t);
    for (let c = 0; c < 3; c++) {
      const v = new Float32Array(cn);
      for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) v[y * cw + x] = m[y * cw + x] * ch[c][(y + y0) * w + x + x0];
      for (let p = 0; p < 3; p++) boxBlur(v, cw, chh, br, t);
      for (let y = 0; y < chh; y++)
        for (let x = 0; x < cw; x++) {
          const k = y * cw + x;
          if (!m[k]) continue;
          const i = (y + y0) * w + x + x0;
          out[c][i] = v[k] / Math.max(1e-6, wgt[k]);
          touched[i] = 1;
        }
    }
    smoothed += r.area;
  }

  // Fundir el contorno de lo alisado con el original (caja 3×3 sobre la máscara).
  const alpha = new Float32Array(N);
  for (let i = 0; i < N; i++) alpha[i] = touched[i];
  boxBlur(alpha, w, h, 1, tmp);
  for (let i = 0; i < N; i++) {
    const a = alpha[i];
    if (!a) continue;
    for (let c = 0; c < 3; c++) px[i * 4 + c] = Math.round(a * out[c][i] + (1 - a) * ch[c][i]);
  }
  return { regions: regions.length, share: smoothed / N };
}

/** Ancho y alto de un PNG (cabecera IHDR). */
function pngSize(buf: Buffer): { w: number; h: number } {
  const sig = '89504e470d0a1a0a';
  if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== sig) throw new Error('El fotograma no es un PNG.');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** ffmpeg con entrada y salida por tuberías (binarias). */
function ffmpegPipe(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-v', 'error', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg (${code}): ${err.trim().split('\n').pop() ?? ''}`))));
    p.stdin.on('error', () => undefined);
    p.stdin.end(input);
  });
}

/**
 * Lee un PNG, lo alisa y lo vuelve a escribir en el mismo sitio. Decodifica y codifica con ffmpeg (el mismo del
 * render): el decodificador de @napi-rs/canvas no lee los PNG en el servidor de producción («Invalid SVG image»).
 */
export async function flattenPngFile(path: string, opts?: FlattenOptions): Promise<FlattenStats> {
  const { w, h } = pngSize(await readFile(path));
  const raw = await ffmpegPipe(['-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
  if (raw.length !== w * h * 4) throw new Error(`ffmpeg devolvió ${raw.length} bytes para ${w}×${h}.`);
  const px = new Uint8Array(raw.buffer, raw.byteOffset, raw.length);
  const stats = flattenRgba(px, w, h, opts);
  const tmp = `${path}.flat.png`;
  await ffmpegPipe(['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', 'pipe:0', '-frames:v', '1', '-pix_fmt', 'rgb24', tmp], Buffer.from(px.buffer, px.byteOffset, px.length));
  await rename(tmp, path);
  return stats;
}

// Fuera del hilo principal (2–3 s por fotograma de 2560×1440): con el worker compilado (dist), en un hilo aparte;
// en los tests (src en TypeScript), en el mismo hilo. Dos a la vez como mucho.
const workerFile = fileURLToPath(new URL('./flatten.worker.js', import.meta.url));
const limit = pLimit(2);

export function flattenPng(path: string, opts?: FlattenOptions): Promise<FlattenStats> {
  return limit(
    () =>
      new Promise<FlattenStats>((resolve, reject) => {
        if (!existsSync(workerFile)) return flattenPngFile(path, opts).then(resolve, reject);
        const w = new Worker(workerFile, { workerData: { path, opts } });
        w.once('message', (m: { stats?: FlattenStats; error?: string }) => (m.stats ? resolve(m.stats) : reject(new Error(m.error ?? 'Error al aplanar.'))));
        w.once('error', reject);
        w.once('exit', (code) => code && reject(new Error(`El filtro terminó con código ${code}.`)));
      }),
  );
}
