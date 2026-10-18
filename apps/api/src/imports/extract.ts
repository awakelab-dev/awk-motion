import mammoth from 'mammoth';
import { getDocumentProxy } from 'unpdf';
import { norm } from '../pipeline/text.js';

/**
 * Extracción de texto de un PDF o un Word (hito 5, ADR-049), sin reescribir nada: el texto literal del
 * documento, en párrafos.
 */

interface PdfItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

/** Texto de un PDF en párrafos: une las líneas cortadas y separa por los saltos verticales grandes. */
export async function pdfText(buf: Buffer): Promise<{ text: string; pages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const lines: { text: string; y: number; h: number; page: number; x0: number; x1: number }[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const tc = await page.getTextContent();
    let cur = '';
    let y = 0;
    let h = 0;
    let x0 = 0;
    let x1 = 0;
    const push = () => {
      if (cur.trim()) lines.push({ text: cur.replace(/\s+/g, ' ').trim(), y, h, page: n, x0, x1 });
      cur = '';
    };
    for (const raw of tc.items as unknown as PdfItem[]) {
      if (typeof raw.str !== 'string') continue;
      if (!cur.trim()) {
        y = raw.transform[5];
        h = raw.height || Math.abs(raw.transform[3]) || 10;
        x0 = raw.transform[4];
        x1 = x0;
      }
      cur += raw.str;
      if (raw.str.trim()) x1 = Math.max(x1, raw.transform[4] + (raw.width || 0));
      if (raw.hasEOL) push();
    }
    push();
  }
  // Salto de párrafo: cambio de página o un espacio vertical mayor que 1,5 × el interlineado habitual.
  const gaps = lines.slice(1).map((l, i) => (l.page === lines[i].page ? lines[i].y - l.y : NaN)).filter((g) => g > 0);
  const sorted = [...gaps].sort((a, b) => a - b);
  const typical = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 14;
  const hs = lines.map((l) => l.h).sort((a, b) => a - b);
  const lineStep = (hs.length ? hs[Math.floor(hs.length / 2)] : 12) * 1.2;
  // Ancho de línea completo (por página): una línea que termina en punto y es bastante más corta cierra el párrafo.
  const right = new Map<number, number>();
  for (const l of lines) right.set(l.page, Math.max(right.get(l.page) ?? 0, l.x1));
  const paras: string[] = [];
  let buf2 = '';
  lines.forEach((l, i) => {
    const prev = lines[i - 1];
    const gap = prev && prev.page === l.page ? prev.y - l.y : Infinity;
    const short = !!prev && /[.!?:»"”)]$/.test(prev.text) && prev.x1 < (right.get(prev.page) ?? 0) * 0.85;
    // Un hueco mayor que el interlineado normal (≈ 1,2 × el cuerpo de letra) tras un final de frase también separa.
    const loose = !!prev && /[.!?:»"”)]$/.test(prev.text) && gap > lineStep * 1.4;
    const brk = !prev || gap > typical * 1.5 || gap < 0 || short || loose;
    if (brk && buf2) {
      paras.push(buf2);
      buf2 = '';
    }
    // "infec-" + "ción" → "infección"
    buf2 = buf2 ? (/[\p{L}]-$/u.test(buf2) ? buf2.slice(0, -1) + l.text : `${buf2} ${l.text}`) : l.text;
  });
  if (buf2) paras.push(buf2);
  return { text: paras.join('\n\n'), pages: pdf.numPages };
}

/** Texto de un .docx en párrafos (mammoth). */
export async function docxText(buf: Buffer): Promise<string> {
  const r = await mammoth.extractRawText({ buffer: buf });
  return r.value
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** Un .docx como texto con sus tablas ("| celda | celda |"), para que Opus vea la estructura del guion. */
export async function docxWithTables(buf: Buffer): Promise<string> {
  const { value: raw } = await mammoth.convertToHtml({ buffer: buf });
  // Dentro de una celda, sus párrafos van en la misma línea (si no, la fila se partiría).
  const html = raw.replace(/<(td|th)([^>]*)>([\s\S]*?)<\/\1>/gi, (_m, tag: string, attrs: string, inner: string) =>
    `<${tag}${attrs}>${inner.replace(/<\/p>\s*<p[^>]*>/gi, ' ').replace(/<\/?p[^>]*>/gi, '').replace(/<br\s*\/?>/gi, ' ')}</${tag}>`,
  );
  return html
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<tr[^>]*>/gi, '| ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/(p|h\d|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/table>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * ¿La locución aparece tal cual en el documento? Sus palabras deben estar, en orden, entre las del
 * documento (con huecos: en una tabla las celdas de otra columna se intercalan). Tolera un 3 %.
 */
export function appearsInDocument(voice: string, doc: string): boolean {
  const v = voice.split(/\s+/).map(norm).filter(Boolean);
  const d = doc.split(/\s+/).map(norm).filter(Boolean);
  if (!v.length) return false;
  let j = 0;
  let hit = 0;
  for (const w of v) {
    const k = d.indexOf(w, j);
    if (k >= 0 && k - j < 400) {
      hit += 1;
      j = k + 1;
    }
  }
  return hit / v.length >= 0.97;
}
