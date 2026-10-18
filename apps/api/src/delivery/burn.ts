import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { ClipLogo, LogoCorner, LogoSettings } from '@wilox/shared';

/**
 * Logo dibujado en el video (hito 9, T2, ADR-102): lo mismo que hace el reproductor de las descargas con
 * JavaScript (`player.ts`, ADR-065 a ADR-067), pero dentro del MP4, para los reproductores que solo muestran el
 * video (el bloque de código de Rise 360, la pantalla completa nativa). Tamaño, margen, realce y opacidad del
 * proyecto, en proporción al ancho del video; la esquina de cada clip (o sin logo); y al cambiar de esquina, el
 * logo se desvanece y aparece en la nueva, con los mismos tiempos que el reproductor.
 */

/** Lo que tarda el reproductor en mover el logo: se apaga (CSS .25 s) y a los 260 ms aparece en la nueva esquina. */
export const FADE_OUT_SEC = 0.26;
export const FADE_IN_SEC = 0.25;

export interface LogoRun {
  corner: LogoCorner;
  start: number;
  end: number;
  /** Aparece con fundido (no es el primer tramo). */
  fadeIn: boolean;
  /** Se apaga con fundido (no llega al final). */
  fadeOut: boolean;
}

/**
 * Tramos de tiempo con el logo en una misma esquina, como `cornerAt` del reproductor: dentro de un clip (o
 * inserto), su esquina o la del proyecto; fuera de todos, la del proyecto. Los tramos sin logo no se devuelven,
 * pero sus bordes cuentan como cambio de esquina (fundido).
 */
export function logoRuns(parts: { index: number; startSec: number; endSec: number }[], corners: Record<string, ClipLogo>, def: LogoCorner, durationSec: number): LogoRun[] {
  const cuts = new Set<number>([0, durationSec]);
  for (const p of parts) {
    if (p.startSec > 0 && p.startSec < durationSec) cuts.add(p.startSec);
    if (p.endSec > 0 && p.endSec < durationSec) cuts.add(p.endSec);
  }
  const edges = [...cuts].sort((a, b) => a - b);
  const at = (t: number): ClipLogo => {
    for (const p of parts) if (t >= p.startSec && t < p.endSec) return corners[String(p.index)] || def;
    return def;
  };
  const raw: { corner: ClipLogo; start: number; end: number }[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const [a, b] = [edges[i], edges[i + 1]];
    if (b - a < 1e-6) continue;
    const c = at((a + b) / 2);
    const last = raw.at(-1);
    if (last && last.corner === c) last.end = b;
    else raw.push({ corner: c, start: a, end: b });
  }
  return raw
    .map((r, i) => ({ ...r, fadeIn: i > 0, fadeOut: i < raw.length - 1 }))
    .filter((r): r is LogoRun => r.corner !== 'none');
}

/** El SVG dibujado al tamaño final (si no, se rasteriza a su tamaño propio y se escala borroso). */
export function svgAtSize(svg: string, w: number, h: number): string {
  return svg.replace(/<svg\b([^>]*)>/i, (_m, attrs: string) => {
    const num = (name: string) => {
      const m = attrs.match(new RegExp(`\\s${name}\\s*=\\s*["']([\\d.]+)(px)?["']`, 'i'));
      return m ? Number(m[1]) : undefined;
    };
    const ow = num('width');
    const oh = num('height');
    let a = attrs.replace(/\s(width|height)\s*=\s*["'][^"']*["']/gi, '');
    if (!/\sviewBox\s*=/i.test(a) && ow && oh) a += ` viewBox="0 0 ${ow} ${oh}"`;
    return `<svg${a} width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet">`;
  });
}

export interface LogoLayer {
  png: Buffer;
  /** Tamaño del PNG (con el realce alrededor). */
  width: number;
  height: number;
  /** Cuánto se sale el PNG del recuadro del logo (sombra o brillo) por cada lado. */
  bleed: number;
  /** Recuadro del logo en el video (lo que se separa del borde con el margen). */
  boxWidth: number;
  boxHeight: number;
}

/**
 * El logo con su realce, al tamaño que tendrá en un video de `videoWidth` px (como `layoutLogo` del reproductor).
 * La opacidad se aplica después, en ffmpeg, a todo (logo y realce, como la opacidad de CSS).
 */
export async function renderLogo(content: Buffer, mime: 'image/png' | 'image/svg+xml', settings: LogoSettings, videoWidth: number): Promise<LogoLayer> {
  const w = Math.max(8, Math.round((videoWidth * settings.widthPct) / 100));
  // loadImage decodifica los píxeles (con `new Image()` + `src` solo se conoce el tamaño y se dibuja vacío).
  const probe = await loadImage(content);
  const ratio = probe.width > 0 && probe.height > 0 ? probe.height / probe.width : 1;
  const h = Math.max(1, Math.round(w * ratio));
  const img = mime === 'image/svg+xml' ? await loadImage(Buffer.from(svgAtSize(content.toString('utf8'), w, h))) : probe;
  const boxed = settings.effect === 'dark' || settings.effect === 'light';
  const pad = boxed ? Math.round(w * 0.08) : 0;
  // Sombra: drop-shadow(0 2% 5% rgba(0,0,0,.6)); brillo: dos drop-shadow blancos (5 % y 2 %).
  const bleed = settings.effect === 'shadow' ? Math.ceil(w * 0.05 * 2 + w * 0.02) : settings.effect === 'glow' ? Math.ceil(w * 0.05 * 2) : 0;
  const boxWidth = w + 2 * pad;
  const boxHeight = h + 2 * pad;
  const canvas = createCanvas(boxWidth + 2 * bleed, boxHeight + 2 * bleed);
  const ctx = canvas.getContext('2d');
  if (boxed) {
    const r = w * 0.06;
    ctx.fillStyle = settings.effect === 'dark' ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.72)';
    ctx.beginPath();
    ctx.roundRect(bleed, bleed, boxWidth, boxHeight, r);
    ctx.fill();
  }
  const draw = () => ctx.drawImage(img, bleed + pad, bleed + pad, w, h);
  if (settings.effect === 'shadow') {
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = w * 0.05;
    ctx.shadowOffsetY = w * 0.02;
    draw();
  } else if (settings.effect === 'glow') {
    ctx.shadowColor = 'rgba(255,255,255,0.95)';
    ctx.shadowBlur = w * 0.05;
    draw();
    ctx.shadowColor = 'rgba(255,255,255,0.9)';
    ctx.shadowBlur = w * 0.02;
    draw();
  } else draw();
  return { png: canvas.toBuffer('image/png'), width: canvas.width, height: canvas.height, bleed, boxWidth, boxHeight };
}

/** Posición (px) del PNG del logo en el video para una esquina. */
export function logoXY(layer: LogoLayer, corner: LogoCorner, settings: LogoSettings, videoWidth: number, videoHeight: number) {
  const m = Math.round((videoWidth * settings.marginPct) / 100);
  const bx = corner[1] === 'l' ? m : videoWidth - m - layer.boxWidth;
  const by = corner[0] === 't' ? m : videoHeight - m - layer.boxHeight;
  return { x: bx - layer.bleed, y: by - layer.bleed };
}

const f3 = (n: number) => n.toFixed(3);

/**
 * filter_complex de ffmpeg: el video `[0:v]` (escalado si hace falta) con un overlay del logo `[1:v]` por tramo,
 * cada uno con sus fundidos de entrada y salida (alpha) y activo solo en su ventana. Sale en `[v]`.
 */
export function burnFilter(o: { runs: LogoRun[]; layer: LogoLayer; settings: LogoSettings; videoWidth: number; videoHeight: number; scale: boolean }): string {
  const parts: string[] = [];
  parts.push(o.scale ? `[0:v]scale=-2:${o.videoHeight}:flags=lanczos[b0]` : `[0:v]null[b0]`);
  const n = o.runs.length;
  if (!n) return `${parts[0].replace('[b0]', '[v]')}`;
  const opacity = Math.max(0, Math.min(1, o.settings.opacity));
  parts.push(`[1:v]format=rgba${opacity < 1 ? `,colorchannelmixer=aa=${opacity.toFixed(3)}` : ''}${n > 1 ? `,split=${n}${o.runs.map((_, i) => `[l${i}]`).join('')}` : '[l0]'}`);
  o.runs.forEach((r, i) => {
    const show = r.fadeIn ? r.start + FADE_OUT_SEC : r.start;
    const hide = r.fadeOut ? r.end + FADE_OUT_SEC : r.end;
    const fades = [r.fadeIn ? `fade=t=in:st=${f3(show)}:d=${f3(FADE_IN_SEC)}:alpha=1` : '', r.fadeOut ? `fade=t=out:st=${f3(r.end)}:d=${f3(FADE_OUT_SEC)}:alpha=1` : ''].filter(Boolean);
    parts.push(`[l${i}]${fades.length ? fades.join(',') : 'null'}[f${i}]`);
    const { x, y } = logoXY(o.layer, r.corner, o.settings, o.videoWidth, o.videoHeight);
    parts.push(`[b${i}][f${i}]overlay=x=${x}:y=${y}:enable='between(t,${f3(show)},${f3(hide)})'${i === n - 1 ? '[v]' : `[b${i + 1}]`}`);
  });
  return parts.join(';');
}
