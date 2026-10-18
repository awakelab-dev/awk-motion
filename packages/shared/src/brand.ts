import { z } from 'zod';

/**
 * Marca del producto como configuración (hito 12, ADR-150). Cada instalación elige su marca con `BRAND` en el
 * `.env`; la marca vive en `brands/<id>/brand.json` (raíz del repo) y la API la entrega a la web
 * (`GET /api/brand`, `GET /api/brand.js`). Sin `BRAND`, la identidad neutra de ADR-008 (`NEUTRAL_BRAND`),
 * exactamente la de antes del hito 12.
 */

/** Variables de color de la web (las de `:root` en `apps/web/src/index.css`) que una marca puede cambiar. */
export const BRAND_COLOR_KEYS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'success',
  'warning',
  'border',
  'input',
  'ring',
  /** Los dos resplandores del fondo de la página. */
  'glow-1',
  'glow-2',
  /** Degradado del isotipo dibujado (cuando la marca no trae imagen). */
  'mark-from',
  'mark-to',
] as const;
export type BrandColorKey = (typeof BRAND_COLOR_KEYS)[number];

/** Pestañas principales de la cabecera; «Proyectos» siempre está (es la portada). */
export const BRAND_NAV = ['proyectos', 'generar', 'temas'] as const;
export type BrandNav = (typeof BRAND_NAV)[number];

/** Un recurso de la marca: archivo de `brands/<id>/` (nombre simple) o una URL https absoluta. */
const asset = z
  .string()
  .trim()
  .refine((v) => /^https:\/\/\S+$/.test(v) || /^[A-Za-z0-9._-]+\.(png|svg|jpg|jpeg|webp|ico)$/.test(v), {
    message: 'debe ser un archivo de la carpeta de la marca (logo.png) o una URL https',
  });

export const BrandSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** Nombre del producto: título del navegador, avisos, paquetes (SCORM, Rise, LEEME) y textos de la app. */
  name: z.string().trim().min(1).max(60),
  /** Línea bajo el nombre en la cabecera y en el inicio de sesión. */
  tagline: z.string().trim().max(120).default(''),
  loginTagline: z.string().trim().max(120).optional(),
  /** Cambios sobre los colores de la identidad neutra (valores CSS). */
  colors: z.partialRecord(z.enum(BRAND_COLOR_KEYS), z.string().trim().min(1).max(80)).default({}),
  font: z
    .object({
      /** Familia principal (ej. `'Poppins', ui-sans-serif, system-ui, sans-serif`). */
      sans: z.string().trim().min(1).max(200),
      mono: z.string().trim().min(1).max(200).optional(),
      /** Hoja de Google Fonts que carga la familia. */
      href: z.string().regex(/^https:\/\/fonts\.googleapis\.com\/\S+$/).optional(),
    })
    .optional(),
  logo: z
    .object({
      /** Logo completo (con el nombre dibujado) para la cabecera y el inicio de sesión, sobre fondo oscuro. */
      full: asset.optional(),
      /** Alto del logo completo en la cabecera, en px. */
      fullHeight: z.number().int().min(16).max(64).default(26),
      /** Isotipo para espacios reducidos (si no hay logo completo, va junto al nombre). */
      mark: asset.optional(),
      /** Texto junto al logo (ej. «Motion»); sin logo completo, va junto al isotipo en lugar del nombre. */
      label: z.string().trim().max(40).optional(),
    })
    .default({ fullHeight: 26 }),
  favicon: asset.optional(),
  /** Pestañas visibles de la cabecera, en orden. */
  nav: z
    .array(z.enum(BRAND_NAV))
    .min(1)
    .default([...BRAND_NAV])
    .refine((n) => n.includes('proyectos'), { message: '«proyectos» no se puede ocultar' }),
  /** Opciones que la marca enciende o apaga (`brandFeature`); lo que no aparece, encendido. */
  features: z.record(z.string().regex(/^[a-z0-9-]+$/), z.boolean()).default({}),
});

export type BrandConfig = z.infer<typeof BrandSchema>;

/** Marca resuelta tal como la recibe la web: los recursos ya son URLs. */
export interface Brand extends Omit<BrandConfig, 'logo' | 'favicon'> {
  logo: { full?: string; fullHeight: number; mark?: string; label?: string };
  favicon?: string;
}

/** Identidad neutra de ADR-008 (grafito + violeta, Geist). Sus colores son los de `index.css`. */
export const NEUTRAL_BRAND: Brand = {
  id: 'neutral',
  name: 'Wilox Motion',
  tagline: 'Micro cápsulas con motion graphics y tipografía cinética',
  loginTagline: 'Micro cápsulas con motion graphics',
  colors: {},
  logo: { fullHeight: 26 },
  nav: [...BRAND_NAV],
  features: {},
};

/** ¿La marca deja ver esta opción? Lo que la marca no menciona, sí. */
export function brandFeature(brand: Pick<Brand, 'features'>, key: string): boolean {
  return brand.features[key] !== false;
}
