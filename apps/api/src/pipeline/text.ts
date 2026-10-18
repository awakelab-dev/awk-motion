/** Divide el texto pegado en párrafos (unidades de locución). */
export function splitParagraphs(text: string): string[] {
  const clean = text.replace(/\r\n?/g, '\n').trim();
  if (!clean) return [];
  let parts = clean.split(/\n\s*\n+/);
  if (parts.length === 1 && clean.includes('\n')) {
    // Sin líneas en blanco: cada línea no vacía es un párrafo, pero se unen las líneas cortadas del PDF.
    parts = clean.split(/\n(?=[A-ZÁÉÍÓÚÑ¿¡])/);
  }
  return parts.map((p) => p.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Palabras del texto fuente, tal como se escriben (con puntuación). */
export function tokenize(paragraph: string): string[] {
  return paragraph.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
}

/** Normaliza para comparar: minúsculas, sin tildes, solo letras y números. */
export function norm(w: string): string {
  return w
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}
