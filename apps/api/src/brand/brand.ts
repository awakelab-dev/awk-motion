import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BrandSchema, NEUTRAL_BRAND, type Brand, type BrandConfig } from '@wilox/shared';
import { env, REPO_ROOT } from '../config/env.js';

/**
 * Marca de la instalación (hito 12, ADR-150). Se carga una vez al arrancar desde `brands/<BRAND>/brand.json`
 * (raíz del repo): si la marca pedida no existe o no es válida, la API no arranca. Sin `BRAND`, la identidad
 * neutra (ADR-008), que es exactamente la de antes del hito 12.
 */

export const BRANDS_DIR = resolve(REPO_ROOT, 'brands');

/** Ruta pública de un archivo de la marca (lo sirve `BrandController`). */
export const brandFileUrl = (name: string) => `/api/brand/files/${encodeURIComponent(name)}`;

const isUrl = (v: string) => v.startsWith('https://');

export interface LoadedBrand {
  brand: Brand;
  /** Carpeta de la marca (sin ella, la neutra del código). */
  dir?: string;
  /** Archivos propios que se pueden servir (nombre → ruta absoluta). */
  files: Map<string, string>;
}

/** Lee y valida una marca. Lanza un error claro si falta la carpeta, el JSON no es válido o falta un archivo. */
export function loadBrand(id: string | undefined, root = BRANDS_DIR): LoadedBrand {
  if (!id) return { brand: NEUTRAL_BRAND, files: new Map() };
  const dir = resolve(root, id);
  const file = resolve(dir, 'brand.json');
  if (!existsSync(file)) throw new Error(`BRAND=${id}: no existe ${file}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`BRAND=${id}: brand.json no es JSON válido (${(e as Error).message})`);
  }
  const parsed = BrandSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`BRAND=${id}: brand.json inválido:\n${lines}`);
  }
  const cfg: BrandConfig = parsed.data;
  if (cfg.id !== id) throw new Error(`BRAND=${id}: el id de brand.json es «${cfg.id}» (debe ser el nombre de la carpeta)`);

  const files = new Map<string, string>();
  const asset = (v: string | undefined) => {
    if (!v) return undefined;
    if (isUrl(v)) return v;
    const abs = resolve(dir, v);
    if (!existsSync(abs)) throw new Error(`BRAND=${id}: falta el archivo ${abs}`);
    files.set(v, abs);
    return brandFileUrl(v);
  };
  const brand: Brand = {
    ...cfg,
    logo: { full: asset(cfg.logo.full), fullHeight: cfg.logo.fullHeight, mark: asset(cfg.logo.mark), label: cfg.logo.label },
    favicon: asset(cfg.favicon),
  };
  return { brand, dir, files };
}

/** La marca de esta instalación. */
export const loaded: LoadedBrand = loadBrand(env.BRAND);
export const brand: Brand = loaded.brand;

/**
 * Script que la web carga en el `<head>` antes de pintar (`/api/brand.js`): deja la marca en `window.__BRAND__`
 * y aplica colores, tipografía, título y favicon sin parpadeo. Si falla, la web sigue con la neutra.
 */
export function brandScript(b: Brand = brand): string {
  const json = JSON.stringify(b).replace(/</g, '\\u003c');
  return `(function(){var b=${json};window.__BRAND__=b;var d=document,r=d.documentElement;
for(var k in b.colors)r.style.setProperty('--'+k,b.colors[k]);
if(b.font){r.style.setProperty('--brand-font-sans',b.font.sans);if(b.font.mono)r.style.setProperty('--brand-font-mono',b.font.mono);
if(b.font.href){var l=d.createElement('link');l.rel='stylesheet';l.href=b.font.href;d.head.appendChild(l);}}
d.title=b.name;
if(b.favicon){var f=d.getElementById('favicon');if(f){f.removeAttribute('type');f.href=b.favicon;}}
})();
`;
}
