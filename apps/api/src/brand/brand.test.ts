import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NEUTRAL_BRAND } from '@wilox/shared';
import { brandScript, loadBrand } from './brand.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'brands-'));
const put = (root: string, id: string, json: unknown, files: string[] = []) => {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, 'brand.json'), typeof json === 'string' ? json : JSON.stringify(json));
  for (const f of files) writeFileSync(join(root, id, f), 'x');
};

describe('marca de la instalación (ADR-150)', () => {
  it('sin BRAND, la neutra de antes del hito 12', () => {
    const l = loadBrand(undefined);
    expect(l.brand).toBe(NEUTRAL_BRAND);
    expect(l.brand.name).toBe('Wilox Motion');
    expect(l.brand.nav).toEqual(['proyectos', 'generar', 'temas']);
  });

  it('la de Awakelab del repo es válida', () => {
    const l = loadBrand('awakelab');
    expect(l.brand.name).toBe('Awakelab Motion');
    expect(l.brand.logo.full).toBeUndefined();
    expect(l.brand.logo.mark).toMatch(/^https:\/\/media\.awakelab\.world\/.*isotipo/);
    expect(l.brand.logo.label).toBe('Motion');
    expect(l.brand.tagline).toBe('');
    expect(l.brand.font?.sans).toContain('Poppins');
  });

  it('archivos propios: se sirven por /api/brand/files y deben existir', () => {
    const root = tmp();
    put(root, 'x', { id: 'x', name: 'X', logo: { mark: 'iso.png' }, favicon: 'fav.png' }, ['iso.png', 'fav.png']);
    const l = loadBrand('x', root);
    expect(l.brand.logo.mark).toBe('/api/brand/files/iso.png');
    expect(l.brand.favicon).toBe('/api/brand/files/fav.png');
    expect([...l.files.keys()].sort()).toEqual(['fav.png', 'iso.png']);

    put(root, 'y', { id: 'y', name: 'Y', favicon: 'falta.png' });
    expect(() => loadBrand('y', root)).toThrow(/falta el archivo/);
  });

  it('errores claros: carpeta, JSON, id, «proyectos» y rutas raras', () => {
    const root = tmp();
    expect(() => loadBrand('nada', root)).toThrow(/no existe/);
    put(root, 'a', '{');
    expect(() => loadBrand('a', root)).toThrow(/no es JSON válido/);
    put(root, 'b', { id: 'otra', name: 'B' });
    expect(() => loadBrand('b', root)).toThrow(/debe ser el nombre de la carpeta/);
    put(root, 'c', { id: 'c', name: 'C', nav: ['generar'] });
    expect(() => loadBrand('c', root)).toThrow(/proyectos/);
    put(root, 'd', { id: 'd', name: 'D', favicon: '../../.env' });
    expect(() => loadBrand('d', root)).toThrow(/brand.json inválido/);
    put(root, 'e', { id: 'e', name: 'E', logo: { full: 'http://inseguro/x.png' } });
    expect(() => loadBrand('e', root)).toThrow(/brand.json inválido/);
  });

  it('el script no se puede cortar con </script> y aplica lo de la marca', () => {
    const s = brandScript({ ...NEUTRAL_BRAND, name: '</script><b>', colors: { primary: '#00ffee' } });
    expect(s).not.toContain('</script>');
    expect(s).toContain('window.__BRAND__');
    expect(s).toContain('setProperty');
    expect(() => new Function(s)).not.toThrow();
  });
});
