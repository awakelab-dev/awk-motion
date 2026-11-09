import { createCanvas, loadImage } from '@napi-rs/canvas';
import { KEYFRAME_REF_MAX_BYTES, KEYFRAME_REFS_MAX, type KeyframeRefUpload } from '@wilox/shared';

/**
 * Imágenes de referencia del editor al regenerar un fotograma (hito 13, ADR-170). Se aceptan PNG, JPG o WebP (por su
 * firma, no por el nombre) y se guardan como PNG de 2048 px como máximo en el lado mayor: así pesan poco para GPT Image,
 * pierden los metadatos y conservan la transparencia de un logo. Para Opus se usa una copia JPG de 1024 px.
 */
export const REF_MAX_SIDE = 2048;
export const REF_LLM_SIDE = 1024;

export type RefKind = 'png' | 'jpg' | 'webp';

/** Tipo por la firma del archivo (o undefined si no es una imagen aceptada). */
export function refKind(buf: Buffer): RefKind | undefined {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return undefined;
}

/** Decodifica las imágenes subidas (data URL) y comprueba cuántas son, su tamaño y su tipo. */
export function decodeRefs(refs: KeyframeRefUpload[] | undefined): { name: string; buf: Buffer }[] {
  if (!refs?.length) return [];
  if (refs.length > KEYFRAME_REFS_MAX) throw new Error(`Se pueden adjuntar hasta ${KEYFRAME_REFS_MAX} imágenes de referencia.`);
  return refs.map((r, i) => {
    const buf = Buffer.from(r.data.replace(/^data:[^,]*,/, ''), 'base64');
    const name = r.fileName || `imagen ${i + 1}`;
    if (!buf.length) throw new Error(`La imagen ${i + 1} (${name}) está vacía.`);
    if (buf.length > KEYFRAME_REF_MAX_BYTES) throw new Error(`La imagen ${i + 1} (${name}) pesa más de ${KEYFRAME_REF_MAX_BYTES / 1024 / 1024} MB.`);
    if (!refKind(buf)) throw new Error(`La imagen ${i + 1} (${name}) no es PNG, JPG ni WebP.`);
    return { name, buf };
  });
}

async function draw(buf: Buffer, maxSide: number) {
  let img: Awaited<ReturnType<typeof loadImage>>;
  try {
    img = await loadImage(buf);
  } catch {
    throw new Error('No se pudo leer la imagen de referencia.');
  }
  if (!img.width || !img.height) throw new Error('La imagen de referencia no tiene tamaño.');
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const canvas = createCanvas(w, h);
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  return { canvas, width: w, height: h };
}

/** PNG para guardar y mandar a GPT Image (≤ 2048 px). */
export async function normalizeRef(buf: Buffer): Promise<{ png: Buffer; width: number; height: number }> {
  const { canvas, width, height } = await draw(buf, REF_MAX_SIDE);
  return { png: canvas.toBuffer('image/png'), width, height };
}

/** JPG de 1024 px para que Opus vea la imagen al reescribir el plano (sobre fondo blanco, por la transparencia). */
export async function refForLlm(buf: Buffer): Promise<Buffer> {
  const img = await loadImage(buf);
  const k = Math.min(1, REF_LLM_SIDE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toBuffer('image/jpeg', 85);
}

/** Nombre del archivo de una referencia en la carpeta del video. */
export const refPath = (index: number, stamp: number, n: number) => `refs/K${String(index).padStart(2, '0')}_${stamp}_ref${n}.png`;
