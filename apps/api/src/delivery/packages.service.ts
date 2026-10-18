import { BadRequestException, Injectable } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import type { ZipArchive } from 'archiver';
import { SINGLE_HTML_MAX_BYTES, isOriginalQuality, type DownloadRequest, type LogoSettings } from '@wilox/shared';
import { safeName } from '../downloads/zip.js';
import { appendFiles, DeliveryService, mergeSettings } from './delivery.service.js';
import type { ScormVersion } from './scorm.js';

export const scormVersion = (format: string): ScormVersion | undefined => (format === 'scorm12' ? '1.2' : format === 'scorm2004' ? '2004' : undefined);

/**
 * La descarga individual de un video, lista para enviarla o meterla en un lote (ADR-087): un archivo que ya
 * existe (MP4), un texto (un solo .html) o un ZIP por llenar (HTML y SCORM).
 */
export type VideoPackage =
  | { kind: 'file'; name: string; path: string }
  | { kind: 'data'; name: string; data: string; contentType: string }
  | { kind: 'zip'; name: string; fill: (z: ZipArchive) => Promise<void> };

/** Nombre de la descarga individual de un video (el mismo en «Descargas»): «<proyecto>_<id>[_720p]» + formato. */
export function videoPackageName(projectName: string, id: string, format: string, q?: DownloadRequest['quality']): string {
  const base = `${safeName(projectName)}_${safeName(id)}${isOriginalQuality(q) ? '' : `_${q!.height}p`}`;
  const scorm = scormVersion(format);
  if (scorm) return `${base}_scorm${scorm === '1.2' ? '12' : '2004'}.zip`;
  return `${base}${format === 'single' ? '.html' : format === 'mp4' ? '.mp4' : '.zip'}`;
}

/** Ancho de la portada para una versión reducida (ADR-085): sin ella, la de siempre. */
export const posterWidthOf = (q: DownloadRequest['quality']) => (isOriginalQuality(q) ? undefined : Math.min(1600, Math.round((q!.height * 16) / 9)));

@Injectable()
export class PackagesService {
  constructor(private readonly delivery: DeliveryService) {}

  /**
   * Descarga de un video (hito 6 y 7) en `html` (ZIP con index.html, css/, js/, img/, video.mp4 y subtítulos),
   * `single` (un solo .html, hasta 40 MB), `mp4` (solo el video) o `scorm12` / `scorm2004` (un SCO). `videoPath`:
   * la versión reducida ya preparada (ADR-085); sin ella, el final. El ZIP completo lo arma DownloadsService.
   */
  async videoPackage(id: string, ownerId: string, req: DownloadRequest, o: { videoPath?: string; posterWidth?: number } = {}): Promise<VideoPackage> {
    const f = await this.delivery.finalFile(id, ownerId);
    const video = o.videoPath ?? f.path;
    const posterWidth = o.posterWidth;
    const suffix = isOriginalQuality(req.quality) ? '' : `_${req.quality!.height}p`;
    const base = `${safeName(f.projectName)}_${safeName(id)}${suffix}`;
    if (req.format === 'mp4') return { kind: 'file', name: `${base}.mp4`, path: video };
    const settings = req.settings as Partial<LogoSettings> | undefined;
    const cornerAll = req.cornerAll;
    const scorm = scormVersion(req.format);
    if (scorm)
      return {
        kind: 'zip',
        name: `${base}_scorm${scorm === '1.2' ? '12' : '2004'}.zip`,
        fill: async (z) => {
          await this.delivery.addScorm(z, scorm, {
            id,
            title: `${f.projectName} · ${f.title}`,
            videoIds: [id],
            ownerId,
            logo: req.logo,
            settings: settings && mergeSettings(settings),
            cornerAll,
            videoPath: o.videoPath ? () => o.videoPath : undefined,
            posterWidth,
          });
        },
      };
    const logoDataUrl = req.logo ? await this.delivery.logoDataUrl(f.projectId, ownerId, req.logo) : undefined;
    if (req.format === 'single') {
      // El tope de 40 MB se mide con el video que va dentro (ADR-085): una versión reducida puede caber.
      if ((await stat(video)).size > SINGLE_HTML_MAX_BYTES)
        throw new BadRequestException('El video pesa más de 40 MB: elige una resolución o compresión menor, o descárgalo como HTML con el video al lado (ZIP).');
      const html = await this.delivery.playerHtml(id, ownerId, { embed: true, logoDataUrl, settings, cornerAll, videoPath: video, posterWidth });
      return { kind: 'data', name: `${base}.html`, data: html, contentType: 'text/html; charset=utf-8' };
    }
    if (req.format !== 'html') throw new BadRequestException(`Formato no válido: ${req.format}`);
    // HTML, CSS, JavaScript, datos, subtítulos, portada y logo en archivos separados (ADR-068).
    const files = await this.delivery.playerFiles(id, ownerId, { videoSrc: 'video.mp4', logoDataUrl, settings, cornerAll, withSubtitles: true, posterWidth });
    return {
      kind: 'zip',
      name: `${base}.zip`,
      fill: async (z) => {
        appendFiles(z, base, files);
        z.file(video, { name: `${base}/video.mp4`, store: true });
      },
    };
  }
}
