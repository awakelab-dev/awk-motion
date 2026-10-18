import { ZipArchive } from 'archiver';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Response } from 'express';

/**
 * Entregables de un video (hito 3, ADR-032): final, clips con SFX y congelados (segments/), voz,
 * fotogramas clave vigentes, prompts y una ficha con los datos del video. Los medios van sin
 * comprimir (ya lo están); el ZIP se escribe directo en la respuesta, sin archivos temporales.
 */
export interface ZipVideo {
  /** Carpeta absoluta de la generación. */
  dir: string;
  /** Carpeta dentro del ZIP ('' = raíz). */
  prefix: string;
  /** Archivo del final (relativo a dir), si existe. */
  finalPath?: string | null;
  /** Versión reducida del final (ruta absoluta, ADR-085): va como final.mp4 en lugar del original. */
  finalAbs?: string;
  /** Fotogramas vigentes (relativos a dir). */
  keyframes: string[];
  /** Ficha del video (ficha.json). */
  info: Record<string, unknown>;
  /** Prompts desde la BD (nombre → contenido); si falta alguno se usa prompts/ en disco. */
  prompts: { name: string; content: string }[];
  /**
   * Reproductor HTML (hito 6, ADR-065 y ADR-068): index.html, css/, js/ e img/ junto a final.mp4, con portada,
   * subtítulos y logo (nombre relativo → contenido).
   */
  player?: Record<string, string | Buffer>;
  /** Subtítulos del final (hito 6, ADR-061/062), armados desde los tiempos por palabra. */
  subtitles?: { vtt: string; srt: string };
}

const MEDIA = /\.(mp4|png|jpe?g|wav|mp3|webm)$/i;

/** Nombre de archivo seguro para Content-Disposition. */
export function safeName(s: string) {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\w.-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'wilox'
  );
}

function addVideo(zip: ZipArchive, v: ZipVideo) {
  const at = (p: string) => (v.prefix ? `${v.prefix}/${p}` : p);
  const add = (rel: string, name = rel) => {
    const abs = join(v.dir, rel);
    if (existsSync(abs) && statSync(abs).isFile()) zip.file(abs, { name: at(name), store: MEDIA.test(rel) });
  };
  if (v.finalPath) {
    if (v.finalAbs && existsSync(v.finalAbs)) zip.file(v.finalAbs, { name: at('final.mp4'), store: true });
    else add(v.finalPath, 'final.mp4');
    for (const [name, data] of Object.entries(v.player ?? {})) zip.append(data, { name: at(name), store: /\.(jpe?g|png)$/i.test(name) });
    // Subtítulos con el mismo nombre que el final (VLC y otros reproductores los cargan solos).
    for (const ext of ['vtt', 'srt'] as const) {
      const rel = v.finalPath.replace(/\.mp4$/, `.${ext}`);
      // Con las reglas vigentes (ADR-062) si hay tiempos por palabra; si no, el archivo junto al final.
      if (v.subtitles) zip.append(v.subtitles[ext], { name: at(`final.${ext}`) });
      else if (existsSync(join(v.dir, rel))) add(rel, `final.${ext}`);
    }
  }
  const seg = join(v.dir, 'segments');
  if (existsSync(seg))
    for (const f of readdirSync(seg).sort()) if (/^(clip|ins)\d+(ex)?\.mp4$/.test(f)) add(`segments/${f}`, `clips/${f}`);
  add('voice/voz_completa.wav', 'voz/voz_completa.wav');
  const voice = join(v.dir, 'voice');
  if (existsSync(voice)) for (const f of readdirSync(voice).sort()) if (/^parrafo\d+\.(mp3|wav)$/.test(f)) add(`voice/${f}`, `voz/${f}`);
  for (const k of v.keyframes) add(k, `fotogramas/${k.split('/').pop()}`);
  const inDb = new Set(v.prompts.map((p) => p.name));
  for (const p of v.prompts) zip.append(p.content, { name: at(`prompts/${p.name}`) });
  const pdir = join(v.dir, 'prompts');
  if (existsSync(pdir)) for (const f of readdirSync(pdir).sort()) if (!inDb.has(f)) add(`prompts/${f}`);
  zip.append(JSON.stringify(v.info, null, 2), { name: at('ficha.json') });
}

/** Llena un ZIP con uno o varios videos (y un LEEME.txt): para la respuesta o para un archivo de «Descargas». */
export function fillVideosZip(zip: ZipArchive, videos: ZipVideo[], readme?: string) {
  if (readme) zip.append(readme, { name: 'LEEME.txt' });
  for (const v of videos) addVideo(zip, v);
}

/** Envía un ZIP con uno o varios videos. */
export async function sendZip(res: Response, filename: string, videos: ZipVideo[], readme?: string) {
  const zip = new ZipArchive({ zlib: { level: 6 } });
  res.setHeader('content-type', 'application/zip');
  res.setHeader('content-disposition', `attachment; filename="${safeName(filename)}.zip"`);
  zip.on('warning', (e) => {
    if (e.code !== 'ENOENT') throw e;
  });
  zip.on('error', () => res.destroy());
  zip.pipe(res);
  fillVideosZip(zip, videos, readme);
  await zip.finalize();
}
