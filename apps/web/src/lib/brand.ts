import { NEUTRAL_BRAND, brandFeature, type Brand } from '@wilox/shared';

/**
 * Marca de la instalación (hito 12, ADR-150). La deja `/api/brand.js` en `window.__BRAND__` antes de pintar
 * (con colores, tipografía, título y favicon ya aplicados); si no llegó, la identidad neutra (ADR-008).
 */
export const brand: Brand = (window as unknown as { __BRAND__?: Brand }).__BRAND__ ?? NEUTRAL_BRAND;

/** ¿La marca deja ver esta opción? (lo que no menciona, sí). */
export const hasFeature = (key: string) => brandFeature(brand, key);

/** Título de un aviso del navegador con el nombre del producto delante. */
export const notifyTitle = (what: string) => `${brand.name} · ${what}`;
