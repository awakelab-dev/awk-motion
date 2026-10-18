import { extname } from 'node:path';

/**
 * Claves del almacenamiento remoto (hito 8, ADR-093). Es un espejo de `storage/` con nombres propios de
 * Wilox Motion bajo un prefijo por entorno; las subcarpetas de cada video, tema, proyecto o lote son las
 * mismas que escribe el código, así las rutas relativas de la BD no cambian.
 *
 *   storage/runs/<id>/…      → wilox-motion/<entorno>/videos/<id>/…
 *   storage/themes/<id>/…    → wilox-motion/<entorno>/temas/<id>/…
 *   storage/projects/<id>/…  → wilox-motion/<entorno>/proyectos/<id>/…
 *   storage/downloads/<id>/… → wilox-motion/<entorno>/lotes/<id>/…
 *   storage/fuentes/…        → wilox-motion/<entorno>/fuentes/…
 *
 * Lo demás (`mock/`, `bench/`, `probes/`, `previews/`…) es de trabajo y no se sube.
 */
const MAP: [local: string, remote: string][] = [
  ['runs/', 'videos/'],
  ['themes/', 'temas/'],
  ['projects/', 'proyectos/'],
  ['downloads/', 'lotes/'],
  ['fuentes/', 'fuentes/'],
];

/** Archivos temporales que no se suben (se renombran o se borran al terminar). */
const SKIP = [/(^|\/)\.DS_Store$/, /\.tmp(\.[a-z0-9]+)?$/i, /\.part$/i, /(^|\/)\._/];

export const mediaPrefix = (envName: string, root = 'wilox-motion') => `${root}/${envName}/`;

export function keyOfRel(rel: string, prefix: string): string | undefined {
  const r = rel.split('\\').join('/').replace(/^\/+/, '');
  if (SKIP.some((x) => x.test(r))) return undefined;
  for (const [a, b] of MAP) if (r.startsWith(a) && r.length > a.length) return prefix + b + r.slice(a.length);
  return undefined;
}

export function relOfKey(key: string, prefix: string): string | undefined {
  if (!key.startsWith(prefix)) return undefined;
  const k = key.slice(prefix.length);
  for (const [a, b] of MAP) if (k.startsWith(b)) return a + k.slice(b.length);
  return undefined;
}

/**
 * Carpeta "unidad" de una ruta relativa: lo que se sube junto, se usa junto y sale junto de la caché
 * (`runs/<id>`, `themes/<id>`, `projects/<id>`, `downloads/<id>`; `fuentes`).
 */
export function unitOfRel(rel: string): string | undefined {
  const parts = rel.split('\\').join('/').replace(/^\/+/, '').split('/');
  if (parts[0] === 'fuentes') return 'fuentes';
  if (!MAP.some(([a]) => a === `${parts[0]}/`) || !parts[1]) return undefined;
  return `${parts[0]}/${parts[1]}`;
}

/** Carpetas que salen de la caché local cuando no se usan (videos y lotes); temas, logos y fuentes se quedan. */
export const evictable = (unit: string) => unit.startsWith('runs/') || unit.startsWith('downloads/');

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'application/x-subrip; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
};

export const contentType = (file: string) => TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
