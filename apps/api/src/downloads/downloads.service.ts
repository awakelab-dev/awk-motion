import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import type { Db } from '@wilox/db';
import { DB } from '../db/db.module.js';
import { RunStore } from '../generations/run-store.js';
import { themeLabel } from '../projects/history.service.js';
import { type InsertState, type LogoCorner, type LogoSettings } from '@wilox/shared';
import { toSrt, toVtt, type SubtitleWord } from '../delivery/subtitles.js';
import { finalCues } from '../pipeline/inserts.js';
import type { PlannedClip } from '../pipeline/timeline.js';
import { DeliveryService } from '../delivery/delivery.service.js';
import { MediaService } from '../storage/media.service.js';
import { safeName, sendZip, type ZipVideo } from './zip.js';
import { brand } from '../brand/brand.js';

/** Logo y ajustes de una descarga puntual (ADR-066): logo null = sin logo; sin el campo, los del proyecto. */
export interface DownloadOverride {
  logoDataUrl?: string | null;
  settings?: LogoSettings;
  /** Una esquina para todos los clips (ADR-067). */
  cornerAll?: LogoCorner;
  /** Versión reducida del final de cada video (ADR-085): va como final.mp4 en lugar del original. */
  videoPath?: (id: string) => string | undefined;
  posterWidth?: number;
}

/** Arma los entregables (ZipVideo) de una o varias generaciones desde la BD (hito 3, ADR-032). */
@Injectable()
export class DownloadsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly runs: RunStore,
    private readonly delivery: DeliveryService,
    private readonly media: MediaService,
  ) {}

  async videos(ids: string[], prefixed: boolean, o: DownloadOverride = {}): Promise<ZipVideo[]> {
    const rows = await this.db.generation.findMany({
      where: { id: { in: ids } },
      include: {
        project: { select: { name: true } },
        keyframes: { orderBy: { index: 'asc' }, include: { versions: true } },
        clips: { orderBy: { index: 'asc' }, select: { index: true, title: true, version: true, deliveredFrames: true, ssimStart: true, ssimEnd: true, soundMode: true, soundLufs: true } },
        prompts: { orderBy: { name: 'asc' }, select: { name: true, content: true } },
        paragraphs: { orderBy: { index: 'asc' }, select: { text: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    // El ZIP lleva toda la carpeta de cada video: si salió de la caché local, se baja (hito 8, ADR-093).
    for (const g of rows) await this.media.hydrate(this.runs.dirOf(g.dir));
    // Reproductor HTML de cada video con final (hito 6, ADR-065): index.html junto a final.mp4.
    // En archivos separados (ADR-068): index.html, css/, js/ e img/ junto a final.mp4 (final.vtt y .srt ya van).
    const players = new Map<string, Record<string, string | Buffer>>();
    for (const g of rows) {
      if (!g.finalPath) continue;
      try {
        players.set(g.id, await this.delivery.playerFiles(g.id, g.ownerId, { videoSrc: 'final.mp4', logoDataUrl: o.logoDataUrl, settings: o.settings, cornerAll: o.cornerAll, posterWidth: o.posterWidth }));
      } catch {
        /* sin final en disco: el ZIP va sin reproductor */
      }
    }
    return rows.map((g, i) => ({
      player: players.get(g.id),
      dir: this.runs.dirOf(g.dir),
      prefix: prefixed ? `${String(i + 1).padStart(2, '0')}_${safeName(g.id)}` : '',
      finalPath: g.finalPath,
      finalAbs: g.finalPath ? o.videoPath?.(g.id) : undefined,
      keyframes: g.keyframes.map((k) => k.versions.find((v) => v.version === k.version)?.path).filter((p): p is string => !!p),
      prompts: g.prompts,
      subtitles: this.subtitles(g.paragraphs, g.words as unknown as SubtitleWord[] | null, g.totalFrames, g.plan as unknown as PlannedClip[] | null, g.inserts as unknown as InsertState[] | null),
      info: {
        id: g.id,
        creado: g.createdAt.toISOString(),
        proyecto: g.project?.name ?? null,
        tema: themeLabel(g.themeKey, g.themeName),
        modo: g.mode,
        voz: g.voiceId,
        // Hito 5 (ADR-044): track de assets/music/ con el que se renderizó el final vigente.
        musica: g.musicTrack ?? 'Sin música',
        // Hito 6 (ADR-059): sonido de los clips (nulo = videos anteriores al hito 6, con SFX sintetizados).
        sonido: ({ model: 'del modelo', synth: 'sintetizado', none: 'sin sonido' } as Record<string, string>)[g.soundMode ?? 'synth'] ?? g.soundMode,
        ajusteSonidoDb: g.soundGainDb || undefined,
        estado: g.status,
        duracionSegundos: g.durationSec,
        frames: g.totalFrames,
        framesDelFinal: g.finalFrames,
        versionDe: g.parentId,
        texto: g.text,
        fotogramas: g.keyframes.map((k) => ({ indice: k.index, rotulo: k.label, textos: k.texts, version: k.version })),
        // Hito 6 (ADR-073): clips insertados o videos subidos (portada/cierre) fuera de la locución.
        insertos: ((g.inserts as unknown as InsertState[] | null) ?? []).map((x) => ({ id: x.id, tipo: x.kind === 'upload' ? 'video subido' : 'clip generado', despuesDelClip: x.after, frames: x.deliveredFrames, locucion: x.voice === 'text' ? x.text : 'pausa' })),
        clips: g.clips.map((c) => ({ indice: c.index, titulo: c.title, version: c.version, frames: c.deliveredFrames, ssimInicio: c.ssimStart, ssimFin: c.ssimEnd, sonido: c.soundMode === 'mute' ? 'silenciado' : c.soundMode === 'synth' ? 'sintetizado' : undefined, sonidoModeloLufs: c.soundLufs ?? undefined })),
      },
    }));
  }

  /** ZIP con todos los videos del proyecto (una carpeta por video, en orden de creación). */
  async sendProject(res: Response, projectId: string, _ownerId: string, o: DownloadOverride = {}) {
    // Hito 11 (ADR-142): el acceso al proyecto lo comprobó el guard; entran los videos de todos sus usuarios.
    const p = await this.db.project.findFirst({ where: { id: projectId, trashedAt: null } });
    if (!p) throw new NotFoundException('Proyecto no encontrado.');
    const gens = await this.db.generation.findMany({ where: { projectId, trashedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    if (!gens.length) throw new BadRequestException('El proyecto aún no tiene videos.');
    const videos = await this.videos(
      gens.map((g) => g.id),
      true,
      o,
    );
    await sendZip(res, `wilox_${p.name}`, videos, this.projectReadme(p, videos));
  }

  /** Ids de los videos del proyecto para su ZIP completo (todos, con o sin final; en orden de creación). */
  async projectIds(projectId: string, _ownerId: string): Promise<string[]> {
    const gens = await this.db.generation.findMany({ where: { projectId, trashedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    return gens.map((g) => g.id);
  }

  /** LEEME.txt del ZIP del proyecto. */
  projectReadme(p: { name: string; description: string | null }, videos: ZipVideo[]): string {
    return [
      `Proyecto: ${p.name}`,
      p.description ? `\n${p.description}` : '',
      `\nDescargado el ${new Date().toLocaleString('es-CL')} desde ${brand.name}.`,
      `\nUna carpeta por video (en orden de creación), cada una con final.mp4, index.html (reproductor con portada,`,
      `subtítulos y logo: ábrelo con doble clic o súbelo a Moodle junto a final.mp4), final.vtt y final.srt (subtítulos),`,
      `clips/ (clips con su sonido y congelados), voz/, fotogramas/ (versión vigente), prompts/ y ficha.json.\n`,
      ...videos.map((v) => `- ${v.prefix}: ${String(v.info.estado)} · ${String(v.info.tema)} · ${Number(v.info.duracionSegundos ?? 0).toFixed(1)} s`),
    ].join('\n');
  }

  /** Subtítulos desde los tiempos por palabra (para el ZIP si no están en disco junto al final). */
  private subtitles(paragraphs: { text: string }[], words: SubtitleWord[] | null, totalFrames: number | null, plan: PlannedClip[] | null, inserts: InsertState[] | null) {
    if (!words?.length) return undefined;
    // Con insertos (ADR-073), corridos y con la locución de cada inserto.
    const cues = finalCues({ paragraphs, words, voiceFrames: totalFrames ?? 0, plan: plan ?? undefined, inserts: inserts ?? undefined });
    return { vtt: toVtt(cues), srt: toSrt(cues) };
  }
}
