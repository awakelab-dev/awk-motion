import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { editorRefsNote, reviseShotUserPrompt, typographyNote } from '@wilox/prompts';
import { decodeRefs, normalizeRef, refForLlm, refKind, refPath, REF_MAX_SIDE } from './refs.js';

const png = (w: number, h: number) => {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#3366cc';
  ctx.fillRect(0, 0, w, h);
  return c.toBuffer('image/png');
};
const dataUrl = (b: Buffer, mime = 'image/png') => `data:${mime};base64,${b.toString('base64')}`;

describe('imágenes de referencia del editor (hito 13, ADR-170)', () => {
  it('reconoce PNG, JPG y WebP por su firma, no por el nombre', () => {
    const c = createCanvas(4, 4);
    expect(refKind(c.toBuffer('image/png'))).toBe('png');
    expect(refKind(c.toBuffer('image/jpeg'))).toBe('jpg');
    expect(refKind(c.toBuffer('image/webp'))).toBe('webp');
    expect(refKind(Buffer.from('GIF89a........'))).toBeUndefined();
  });

  it('rechaza más de 4, vacías, pesadas o de otro tipo, con el número de la imagen', () => {
    const one = { fileName: 'a.png', data: dataUrl(png(8, 8)) };
    expect(() => decodeRefs([one, one, one, one, one])).toThrow(/hasta 4/);
    expect(() => decodeRefs([one, { fileName: 'b.gif', data: dataUrl(Buffer.from('GIF89a0123456789'), 'image/gif') }])).toThrow(/imagen 2 \(b\.gif\).*PNG, JPG ni WebP/);
    expect(() => decodeRefs([{ fileName: 'big.png', data: dataUrl(Buffer.alloc(11 * 1024 * 1024, 1)) }])).toThrow(/más de 10 MB/);
    expect(decodeRefs([one]).map((f) => f.name)).toEqual(['a.png']);
    expect(decodeRefs(undefined)).toEqual([]);
  });

  it('guarda PNG de 2048 px como máximo y da a Opus un JPG de 1024 px', async () => {
    const big = await normalizeRef(png(4000, 1000));
    expect(big.width).toBe(REF_MAX_SIDE);
    expect(big.height).toBe(512);
    expect(refKind(big.png)).toBe('png');
    const small = await normalizeRef(png(300, 200));
    expect([small.width, small.height]).toEqual([300, 200]);
    expect(refKind(await refForLlm(big.png))).toBe('jpg');
    expect(refPath(3, 123, 2)).toBe('refs/K03_123_ref2.png');
  });

  it('la nota del prompt de imagen numera las imágenes del editor y lleva su indicación', () => {
    const n = editorRefsNote(2, '  la imagen 1 en el marco\nde la derecha ', { others: 3 });
    expect(n).toContain('the last 2 attached images are CONTENT references');
    expect(n).toContain('"editor reference image 1" is the first of them, up to "editor reference image 2"');
    expect(n).toContain('EDITOR INSTRUCTION (may be in Spanish): la imagen 1 en el marco de la derecha');
    expect(editorRefsNote(1, 'x', { others: 0 })).toContain('the attached image is a CONTENT reference');
    expect(editorRefsNote(0, 'x', { others: 2 })).toBe('');
  });

  it('con imágenes del editor, las láminas tipográficas dejan de ser «las últimas»; sin ellas, el texto de siempre', () => {
    const faces = [{ family: 'Poppins', role: 'both' as const, weights: [700, 400] }];
    expect(typographyNote(faces, 1, true)).toContain('The last attached image is a TYPE SPECIMEN sheet');
    expect(typographyNote(faces, 1, true, { beforeEditorRefs: true })).toContain('The attached image right after the style references is a TYPE SPECIMEN sheet');
    expect(typographyNote(faces, 2, false, { beforeEditorRefs: true })).toContain('The first 2 attached images are TYPE SPECIMEN sheets');
  });

  it('la reescritura del plano pide nombrar cada imagen del editor solo si las hay', () => {
    const shot = { anchorWordIndex: 3, pfc: 'manos' } as unknown as Parameters<typeof reviseShotUserPrompt>[0]['shot'];
    const base = { shot, previousSummary: 'a', nextSummary: 'b', change: 'pon la imagen 1 en el marco' };
    expect(reviseShotUserPrompt(base)).not.toContain('EDITOR REFERENCE IMAGES');
    const withRefs = reviseShotUserPrompt({ ...base, editorRefs: 2 });
    expect(withRefs).toContain('EDITOR REFERENCE IMAGES: the director attached 2 images');
    expect(withRefs).toContain('"editor reference image 1" to "editor reference image 2"');
    expect(withRefs.endsWith('Return the full rewritten shot.')).toBe(true);
  });
});
