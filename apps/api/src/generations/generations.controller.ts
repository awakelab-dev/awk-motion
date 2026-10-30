import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { Request, Response } from 'express';
import { map, type Observable } from 'rxjs';
import { z } from 'zod';
import { FPS, MAX_REFERENCES_IN_PROMPT, SOUND_MODES, type SoundMode, type ThemeStyle, type AuthUser, type GenerationSummary, type HistoryResponse, type PromptSummary, type RunState } from '@wilox/shared';
import { CurrentUser } from '../auth/decorators.js';
import { Inject } from '@nestjs/common';
import type { Db } from '@wilox/db';
import { DB } from '../db/db.module.js';
import { DownloadsService } from '../downloads/downloads.service.js';
import { toSrt, toVtt } from '../delivery/subtitles.js';
import { finalCues } from '../pipeline/inserts.js';
import { probeVideo } from '../media/ffmpeg.js';
import { safeName, sendZip } from '../downloads/zip.js';
import { HistoryService } from '../projects/history.service.js';
import { env, repoPath } from '../config/env.js';
import { PipelineService } from '../pipeline/pipeline.service.js';
import { PROVIDERS, type Providers } from '../providers/ports.js';
import { ThemeStore } from '../themes/theme-store.js';
import { MediaService } from '../storage/media.service.js';
import { MusicService } from '../music/music.service.js';
import { RunStore, type RunRecord } from './run-store.js';
import { PublicationsService } from '../publications/publications.service.js';
import { TrashService } from '../trash/trash.service.js';
import { AccessService } from '../access/access.service.js';
import { splitParagraphs } from '../pipeline/text.js';
import { sendToEnd } from '../projects/video-order.js';

const PauseSchema = z.object({ afterWord: z.number().int().min(0), deltaSec: z.number().min(-10).max(10) });

const CreateSchema = z.object({
  text: z.string().trim().min(20, 'El texto es demasiado corto.').max(20_000, 'El texto es demasiado largo para un solo video.'),
  theme: z.string().min(1).max(64),
  voiceId: z.string().optional(),
  // Hito 4 (ADR-035): todo video se lanza dentro de un proyecto (puede ser "Sin clasificar").
  projectId: z.string({ error: 'Elige el proyecto donde queda el video.' }).uuid('Elige el proyecto donde queda el video.'),
  parentId: z.string().regex(/^[\w-]+$/).nullable().optional(),
  // Hito 5 (ADR-044): archivo de assets/music/; null = "Sin música"; sin el campo, el de MUSIC_PATH.
  musicTrack: z.string().max(200).nullable().optional(),
  // Hito 6 (ADR-059): sonido de los clips; sin el campo, el del modelo.
  soundMode: z.enum(SOUND_MODES).optional(),
  // Hito 5 (ADR-049): guion importado, una fila por párrafo del texto.
  script: z
    .object({
      rows: z
        .array(
          z.object({
            voice: z.string().max(5000),
            scene: z.string().max(3000).optional(),
            expression: z.string().max(300).optional(),
            layout: z.string().max(1000).optional(),
            voiceTag: z.string().max(60).optional(),
            verified: z.boolean().optional(),
          }),
        )
        .max(200),
      structure: z.string().max(2000).optional(),
      source: z.string().max(300).optional(),
    })
    .optional(),
});
const VersionSchema = z.object({
  text: z.string().trim().min(20, 'El texto es demasiado corto.').max(20_000, 'El texto es demasiado largo para un solo video.'),
  voiceId: z.string().optional(),
});
const HistorySchema = z.object({
  q: z.string().max(300).optional(),
  // 'none' (dirección antigua de "Sin proyecto") equivale a "Sin clasificar".
  project: z.union([z.literal('none'), z.string().uuid()]).optional(),
  theme: z.string().max(64).optional(),
  status: z.enum(['done', 'awaiting_approval', 'working', 'error', 'paused']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const MoveSchema = z.object({ projectId: z.string().uuid() });
const SoundSchema = z
  .object({
    mode: z.enum(SOUND_MODES).optional(),
    gainDb: z.number().min(-12, 'El ajuste va de −12 a +12 dB.').max(12, 'El ajuste va de −12 a +12 dB.').multipleOf(3, 'El ajuste va en pasos de 3 dB.').optional(),
  })
  .refine((v) => v.mode !== undefined || v.gainDb !== undefined, 'Indica el sonido o el ajuste.');
const ClipSoundSchema = z.object({ mode: z.enum(['mute', 'synth']).nullable() });
const MusicSchema = z.object({ track: z.string().max(200).nullable() });
const RevoiceSchema = z.object({
  text: z.string().trim().min(2).max(5000).optional(),
  instruction: z.string().trim().max(1000).optional(),
  saveRules: z.boolean().optional(),
});
const InsertSchema = z.object({
  kind: z.enum(['generated', 'upload']),
  after: z.number().int().min(0),
  voice: z.enum(['pause', 'text']),
  text: z.string().max(1500).optional(),
  note: z.string().max(1000).optional(),
  fileName: z.string().max(300).optional(),
  data: z.string().optional(),
  trimStart: z.number().min(0).optional(),
  trimEnd: z.number().min(0).optional(),
  fit: z.enum(['contain', 'cover', 'stretch']).optional(),
  keepAudio: z.boolean().optional(),
  transition: z.boolean().optional(),
});
const TransitionSchema = z.object({ note: z.string().max(1000).optional(), remove: z.boolean().optional(), enabled: z.boolean().optional() });
const MAX_INSERT_BYTES = 60 * 1024 * 1024;

const RegenSchema = z.object({ note: z.string().max(1000).optional(), useSuggestion: z.boolean().optional() });

@Controller('generations')
export class GenerationsController {
  constructor(
    private readonly store: RunStore,
    private readonly pipeline: PipelineService,
    private readonly themes: ThemeStore,
    @Inject(PROVIDERS) private readonly providers: Providers,
    @Inject(DB) private readonly db: Db,
    private readonly history: HistoryService,
    private readonly downloads: DownloadsService,
    private readonly music: MusicService,
    private readonly media: MediaService,
    private readonly publications: PublicationsService,
    private readonly trash: TrashService,
    private readonly access: AccessService,
  ) {}

  /**
   * Generación de un proyecto al que el usuario tiene acceso (hito 11, ADR-142: suyo, compartido con él, público o,
   * para el admin, cualquiera); las demás no existen para él.
   */
  private async rec(id: string, user: AuthUser, o: { hidden?: boolean } = {}): Promise<RunRecord> {
    // En la papelera o eliminado (T3d, ADR-106): no existe para la app, salvo su miniatura y su ficha (vista de la papelera).
    if (!o.hidden && this.trash.isHidden(id)) throw new NotFoundException('El video está en la papelera.');
    const r = await this.store.get(id);
    if (!r || !(await this.access.role(r.projectId, user))) throw new NotFoundException('Generación no encontrada.');
    return r;
  }

  /** Retomar solo en el modo con que se creó: las referencias de Higgsfield no sirven en API y al revés. */
  private sameMode(rec: RunRecord) {
    if (rec.state.mode !== this.providers.mode)
      throw new BadRequestException(
        `Esta generación se creó en modo ${rec.state.mode.toUpperCase()} y la API corre en modo ${this.providers.mode.toUpperCase()}: ` +
          `cambia GENERATION_MODE=${rec.state.mode} en .env para retomarla. Mientras tanto se puede ver y descargar.`,
      );
  }

  private act(fn: () => void) {
    try {
      fn();
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  /** Historial (hito 3, ADR-032): búsqueda full-text, filtros, página y totales del conjunto filtrado. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: Record<string, string>): Promise<HistoryResponse> {
    const q = HistorySchema.safeParse(query);
    if (!q.success) throw new BadRequestException('Filtros no válidos.');
    // Hito 11 (ADR-142): ?all=1 = el admin ve los videos de todos los proyectos.
    return this.history.history(user, q.data, query.all === '1');
  }

  @Post()
  async create(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<RunState> {
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' '));
    const { text, theme, projectId, parentId } = parsed.data;
    // Hito 11 (ADR-142): en un proyecto al que tiene acceso (suyo, compartido, público o, el admin, cualquiera).
    const project = await this.db.project.findFirst({ where: { id: projectId, archivedAt: null, trashedAt: null, deletedAt: null }, select: { id: true, ownerId: true } });
    if (!project || !(await this.access.role(project.id, user))) throw new BadRequestException('Ese proyecto no existe o está archivado.');
    // Recrear (ADR-033): el video del que sale debe estar en un proyecto al que tiene acceso.
    const parent = parentId ? await this.db.generation.findFirst({ where: { id: parentId }, select: { projectId: true } }) : null;
    if (parentId && (!parent || !(await this.access.role(parent.projectId, user)))) throw new BadRequestException('El video que se recrea no existe.');
    // Los temas base, los propios y, en un proyecto ajeno, los de su dueño (hito 11, sin editarlos); los demás no existen.
    const style = this.themes.canAccess(theme, user.id) || this.themes.canAccess(theme, project.ownerId) ? this.themes.style(theme) : undefined;
    const detail = style ? this.themes.detail(theme) : undefined;
    if (!style || !detail) throw new BadRequestException(`El tema "${theme}" no existe.`);
    if (detail.status !== 'saved') throw new BadRequestException('Ese tema es un borrador: guárdalo en "Mis temas" antes de usarlo.');
    const voiceId = parsed.data.voiceId || this.providers.defaultVoiceId();
    if (!voiceId) throw new BadRequestException('Elige una voz.');
    const musicTrack = parsed.data.musicTrack === undefined ? this.music.defaultTrack : parsed.data.musicTrack;
    const script = parsed.data.script?.rows.length ? parsed.data.script : undefined;
    if (script) {
      const paras = splitParagraphs(text);
      if (paras.length !== script.rows.length)
        throw new BadRequestException(`El guion tiene ${script.rows.length} filas y el texto ${paras.length} párrafos: deben coincidir (uno por fila).`);
    }
    if (musicTrack && !this.music.pathOf(musicTrack)) throw new BadRequestException(`El track «${musicTrack}» no está en la carpeta de música.`);
    // Copia del tema y de sus referencias: la generación no depende de cambios posteriores en el Estudio.
    const refs = this.themes.referencePaths(theme).slice(0, MAX_REFERENCES_IN_PROMPT);
    // Láminas tipográficas del tema (ADR-094): van en la copia, detrás de las referencias de estilo.
    const sheets = this.themes.typographyPaths(theme);
    const soundMode = parsed.data.soundMode ?? 'model';
    return this.launch(user, { text, themeKey: theme, style, refs: [...refs.map((abs) => ({ abs })), ...sheets.map((abs) => ({ abs, typography: true }))], voiceId, musicTrack, soundMode, script, projectId, parentId: parentId ?? null });
  }

  /**
   * Cambiar el texto (ADR-033): versión nueva del video, en el mismo proyecto y con la misma copia del
   * tema (aunque el tema se haya editado o borrado después). Arranca desde la locución.
   */
  @Post(':id/versions')
  async newVersion(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser): Promise<RunState> {
    const parsed = VersionSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' '));
    const src = await this.rec(id, user);
    const voiceId = parsed.data.voiceId || src.state.voiceId;
    // Los media_id de Higgsfield sirven en otra generación del mismo modo; en otro modo se vuelven a subir.
    const sameMode = src.state.mode === this.providers.mode;
    return this.launch(user, {
      text: parsed.data.text,
      themeKey: src.state.theme,
      themeName: src.state.themeName,
      style: src.theme,
      refs: src.themeRefs.map((r) => ({ abs: isAbsolute(r.path) ? r.path : join(src.dir, r.path), ref: sameMode ? r.ref : undefined, typography: r.typography })),
      voiceId,
      // Hereda la música del original (hito 5, ADR-044).
      musicTrack: src.state.musicTrack ?? null,
      // Hereda el sonido (hito 6, ADR-059); los videos de antes del hito 6 pasan al del modelo (clips nuevos).
      soundMode: src.state.soundMode ?? 'model',
      soundGainDb: src.state.soundGainDb,
      projectId: src.projectId,
      parentId: src.state.id,
    });
  }

  /** Crea la generación (carpeta, copia del tema y de sus referencias) y lanza la fase 1. */
  private async launch(
    user: AuthUser,
    o: {
      text: string;
      themeKey: string;
      themeName?: string;
      style: ThemeStyle;
      refs: { abs: string; ref?: string; typography?: boolean }[];
      voiceId: string;
      musicTrack: string | null;
      soundMode: SoundMode;
      soundGainDb?: number;
      script?: RunState['script'];
      projectId: string;
      parentId: string | null;
    },
  ): Promise<RunState> {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    const id = `${stamp}-${o.themeKey}-${randomUUID().slice(0, 6)}`;
    const dir = join(repoPath(env.STORAGE_DIR), 'runs', id);
    await mkdir(dir, { recursive: true });
    const references: { path: string; ref?: string; typography?: boolean }[] = []; // relativas a la carpeta de la generación
    if (o.refs.length) await mkdir(join(dir, 'referencias'), { recursive: true });
    // Una versión nueva copia las referencias del video original: si su carpeta salió de la caché, se bajan.
    await this.media.ensure(...o.refs.map((r) => r.abs));
    for (const r of o.refs) {
      if (!existsSync(r.abs)) continue;
      // Las láminas se llaman tipografia_<fuente>.png en la copia (los nombres no chocan con ref_NN.jpg).
      const name = r.typography && !basename(r.abs).startsWith('tipografia_') ? `tipografia_${basename(r.abs)}` : basename(r.abs);
      const dst = join(dir, 'referencias', name);
      await copyFile(r.abs, dst);
      references.push({ path: join('referencias', name), ref: r.ref, ...(r.typography ? { typography: true } : {}) });
    }
    const rec = this.store.create(
      {
        id,
        createdAt: new Date().toISOString(),
        mode: this.providers.mode,
        theme: o.themeKey,
        themeName: o.themeName ?? o.style.info.name,
        voiceId: o.voiceId,
        musicTrack: o.musicTrack,
        soundMode: o.soundMode,
        soundGainDb: o.soundGainDb || undefined,
        // Locución en un solo pedido (ADR-133); en MCP (Higgsfield, sin tiempos por carácter), por párrafo.
        voiceMode: this.providers.mode === 'mcp' ? 'paragraph' : env.VOICE_MODE,
        script: o.script,
        text: o.text,
        status: 'queued',
        message: 'En cola…',
        paragraphs: [],
        keyframes: [],
        clips: [],
        log: [],
      },
      dir,
      { style: structuredClone(o.style), references },
      { ownerId: user.id, projectId: o.projectId, parentId: o.parentId },
    );
    if (o.parentId) this.store.log(rec, `Sale de ${o.parentId}.`);
    this.pipeline.startPhase1(rec);
    return rec.state;
  }

  /** Corregir un video terminado (ADR-033): vuelve a la revisión de fotogramas; al aprobar solo se rehacen los clips afectados. */
  @Post(':id/reopen')
  @HttpCode(202)
  async reopen(@Param('id') id: string, @Headers('x-confirm-change') confirm: string | undefined, @CurrentUser() user: AuthUser) {
    await this.publications.guardVideo(id, user.id, confirm === '1'); // T3c: aviso si está publicado
    const rec = await this.rec(id, user);
    this.sameMode(rec);
    this.act(() => this.pipeline.reopen(rec));
    return rec.state;
  }

  /** Regenerar un clip suelto de un video terminado (con una indicación opcional) y volver a renderizar. */
  @Post(':id/clips/:index/regenerate')
  @HttpCode(202)
  async regenerateClip(@Param('id') id: string, @Headers('x-confirm-change') confirm: string | undefined, @Param('index', ParseIntPipe) index: number, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    await this.publications.guardVideo(id, user.id, confirm === '1'); // T3c: aviso si está publicado
    const { note } = z.object({ note: z.string().max(1000).optional() }).parse(body ?? {});
    const rec = await this.rec(id, user);
    this.sameMode(rec);
    this.act(() => this.pipeline.regenerateClip(rec, index, note));
    return rec.state;
  }

  /** «Dividir en dos» (hito 10, T3, ADR-130): si el clip se puede dividir y dónde iría el corte. */
  @Get(':id/clips/:index/split')
  async splitInfo(@Param('id') id: string, @Param('index', ParseIntPipe) index: number, @CurrentUser() user: AuthUser) {
    const rec = await this.rec(id, user);
    try {
      return this.pipeline.splitInfo(rec, index);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  /** «Dividir en dos» un clip de un video terminado: fotograma intermedio, dos clips y el final de nuevo. */
  @Post(':id/clips/:index/split')
  @HttpCode(202)
  async splitClip(@Param('id') id: string, @Headers('x-confirm-change') confirm: string | undefined, @Param('index', ParseIntPipe) index: number, @CurrentUser() user: AuthUser) {
    await this.publications.guardVideo(id, user.id, confirm === '1'); // T3c: aviso si está publicado
    const rec = await this.rec(id, user);
    this.sameMode(rec);
    this.act(() => this.pipeline.splitClip(rec, index));
    return rec.state;
  }

  /** «Aplicar la regla a este video» (ADR-082): qué clips cambiarían. */
  @Get(':id/media-rule')
  async mediaRulePlan(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const rec = await this.rec(id, user);
    return this.pipeline.mediaRulePlan(rec);
  }

  /** Aplica la animación de las imágenes según cuántas haya y rehace los clips que cambian (aviso de gasto en la app). */
  @Post(':id/media-rule')
  @HttpCode(202)
  async applyMediaRule(@Param('id') id: string, @Headers('x-confirm-change') confirm: string | undefined, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    await this.publications.guardVideo(id, user.id, confirm === '1'); // T3c: aviso si está publicado
    const { alsoVideoClips } = z.object({ alsoVideoClips: z.boolean().optional() }).parse(body ?? {});
    const rec = await this.rec(id, user);
    this.sameMode(rec);
    this.act(() => this.pipeline.applyMediaRule(rec, !!alsoVideoClips));
    return rec.state;
  }

  /** Cambiar la música de un video terminado (hito 5, ADR-044): solo se vuelve a renderizar (final_vN.mp4). */
  @Post(':id/music')
  @HttpCode(202)
  async changeMusic(@Param('id') id: string, @Headers('x-confirm-change') confirm: string | undefined, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    await this.publications.guardVideo(id, user.id, confirm === '1'); // T3c: aviso si está publicado
    const r = MusicSchema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException('Track no válido.');
    const rec = await this.rec(id, user);
    this.act(() => this.pipeline.changeMusic(rec, r.data.track));
    return rec.state;
  }

  /** Sonido de un video terminado (hito 6, ADR-059): modo y ajuste en dB; solo ffmpeg (final_vN.mp4). */
  @Post(':id/sound')
  @HttpCode(202)
  async changeSound(@Param('id') id: string, @Headers('x-confirm-change') confirm: string | undefined, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    await this.publications.guardVideo(id, user.id, confirm === '1'); // T3c: aviso si está publicado
    const r = SoundSchema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join(' '));
    const rec = await this.rec(id, user);
    this.act(() => this.pipeline.changeSound(rec, r.data));
    return rec.state;
  }

  /** Sonido de un clip (ADR-059): silenciar, sintetizado o el del video; solo ffmpeg. */
  @Post(':id/clips/:index/sound')
  @HttpCode(202)
  async changeClipSound(@Param('id') id: string, @Headers('x-confirm-change') confirm: string | undefined, @Param('index', ParseIntPipe) index: number, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    await this.publications.guardVideo(id, user.id, confirm === '1'); // T3c: aviso si está publicado
    const r = ClipSoundSchema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException('Sonido no válido.');
    const rec = await this.rec(id, user);
    this.act(() => this.pipeline.changeClipSound(rec, index, r.data.mode));
    return rec.state;
  }

  /** Tramo de locución del fotograma Ki (= clip i), con sus párrafos y palabras (pop-up "Rehacer audio", ADR-048). */
  @Get(':id/clips/:index/voice')
  async voiceSegment(@Param('id') id: string, @Param('index', ParseIntPipe) index: number, @CurrentUser() user: AuthUser) {
    const rec = await this.rec(id, user);
    try {
      return await this.pipeline.voiceSegment(rec, index);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  /** Rehacer la locución de un párrafo con el texto corregido y/o una indicación (ADR-048). */
  @Post(':id/paragraphs/:index/revoice')
  @HttpCode(202)
  async revoice(@Param('id') id: string, @Headers('x-confirm-change') confirm: string | undefined, @Param('index', ParseIntPipe) index: number, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    await this.publications.guardVideo(id, user.id, confirm === '1'); // T3c: aviso si está publicado
    const r = RevoiceSchema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join(' '));
    const rec = await this.rec(id, user);
    this.sameMode(rec);
    this.act(() => this.pipeline.revoice(rec, index, r.data));
    return rec.state;
  }

  /** Pausa entre dos palabras (ADR-164): alargar o acortar el silencio sin volver a pedir la voz; sin costo. */
  @Post(':id/word-pause')
  @HttpCode(202)
  async wordPause(@Param('id') id: string, @Headers('x-confirm-change') confirm: string | undefined, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    await this.publications.guardVideo(id, user.id, confirm === '1'); // T3c: aviso si está publicado
    const r = PauseSchema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException('Pausa no válida.');
    const rec = await this.rec(id, user);
    this.act(() => this.pipeline.addPause(rec, r.data.afterWord, r.data.deltaSec));
    return rec.state;
  }

  /** «Rehacer la locución» (ADR-134): toda la locución en un solo pedido, con la misma voz; sin clips nuevos. */
  @Post(':id/revoice-all')
  @HttpCode(202)
  async revoiceAll(@Param('id') id: string, @Headers('x-confirm-change') confirm: string | undefined, @CurrentUser() user: AuthUser) {
    await this.publications.guardVideo(id, user.id, confirm === '1'); // T3c: aviso si está publicado
    const rec = await this.rec(id, user);
    this.sameMode(rec);
    this.act(() => this.pipeline.revoiceAll(rec));
    return rec.state;
  }

  /** Fila del historial de una generación (tras moverla, por ejemplo). */
  @Get(':id/summary')
  async summary(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<GenerationSummary> {
    await this.rec(id, user, { hidden: true });
    const [s] = await this.history.summaries([id]);
    return s;
  }

  /** Mover a otro proyecto (o a "Sin clasificar", que es un proyecto más: ADR-035). */
  @Patch(':id')
  async move(@Param('id') id: string, @Body() body: unknown, @Headers('x-confirm-change') confirm: string | undefined, @CurrentUser() user: AuthUser): Promise<GenerationSummary> {
    const r = MoveSchema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException('Proyecto no válido.');
    const rec = await this.rec(id, user);
    const { projectId } = r.data;
    const target = await this.db.project.findFirst({ where: { id: projectId, trashedAt: null, deletedAt: null }, select: { id: true, name: true, delivery: true, ownerId: true } });
    if (!target || !(await this.access.role(target.id, user))) throw new BadRequestException('Ese proyecto no existe.');
    // Hito 11 (ADR-142): sacar un video hacia un proyecto de otro dueño es solo del dueño del proyecto de origen.
    const source = await this.access.project(rec.projectId, user, { trashed: true });
    if (source.ownerId !== target.ownerId) this.access.requireOwner(source.role, 'move-out');
    // T3c (ADR-105): el video toma el logo del proyecto nuevo; se confirma siempre.
    const hasLogo = !!(target.delivery as { logo?: unknown } | null)?.logo;
    await this.publications.guardMove(id, user.id, { id: target.id, name: target.name, hasLogo }, confirm === '1');
    const moved = rec.projectId !== projectId;
    rec.projectId = projectId;
    this.store.update(rec, (s) => (s.projectId = projectId));
    await this.store.flush(rec);
    // En el proyecto nuevo queda al final (ADR-162).
    if (moved) await sendToEnd(this.db, id);
    this.access.forget(); // el video cambió de proyecto: su acceso también
    const [s] = await this.history.summaries([id]);
    return s;
  }

  /** Prompts guardados (nombre, tipo, versión). */
  @Get(':id/prompts')
  async prompts(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<PromptSummary[]> {
    await this.rec(id, user);
    const rows = await this.db.prompt.findMany({ where: { generationId: id }, orderBy: { name: 'asc' } });
    return rows.map((p) => ({ name: p.name, kind: p.kind, version: p.version, size: p.content.length, createdAt: p.createdAt.toISOString() }));
  }

  @Get(':id/prompts/:name')
  async prompt(@Param('id') id: string, @Param('name') name: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.rec(id, user);
    const p = await this.db.prompt.findUnique({ where: { generationId_name: { generationId: id, name } } });
    if (!p) throw new NotFoundException('Prompt no encontrado.');
    res.type('text/plain; charset=utf-8').send(p.content);
  }

  /** ZIP con los entregables del video: final, clips con SFX y congelados, voz, fotogramas, prompts y ficha. */
  @Get(':id/download')
  async download(@Param('id') id: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const rec = await this.rec(id, user);
    await this.store.flush(rec);
    const videos = await this.downloads.videos([id], false);
    await sendZip(res, `wilox_${safeName(id)}`, videos);
  }

  @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<RunState> {
    return (await this.rec(id, user)).state;
  }

  @Sse(':id/events')
  async events(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<Observable<MessageEvent>> {
    return (await this.rec(id, user)).subject.pipe(map((s) => ({ data: s }) as MessageEvent));
  }

  @Post(':id/keyframes/:index/regenerate')
  @HttpCode(202)
  async regenerate(@Param('id') id: string, @Param('index', ParseIntPipe) index: number, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { note, useSuggestion } = RegenSchema.parse(body ?? {});
    const rec = await this.rec(id, user);
    this.sameMode(rec);
    this.act(() => this.pipeline.regenerateKeyframe(rec, index, note, useSuggestion));
    return rec.state;
  }

  /** Descarta la propuesta de un fotograma en un video terminado (ADR-071). */
  @Post(':id/keyframes/:index/discard')
  async discardKeyframe(@Param('id') id: string, @Param('index', ParseIntPipe) index: number, @CurrentUser() user: AuthUser) {
    const rec = await this.rec(id, user);
    this.act(() => this.pipeline.discardKeyframe(rec, index));
    return rec.state;
  }

  /** Aplica las propuestas de fotogramas de un video terminado: rehace los clips afectados y el render (ADR-071). */
  @Post(':id/keyframes/apply')
  @HttpCode(202)
  async applyKeyframes(@Param('id') id: string, @Headers('x-confirm-change') confirm: string | undefined, @CurrentUser() user: AuthUser) {
    await this.publications.guardVideo(id, user.id, confirm === '1'); // T3c: aviso si está publicado
    const rec = await this.rec(id, user);
    this.sameMode(rec);
    this.act(() => this.pipeline.applyKeyframes(rec));
    return rec.state;
  }

  /**
   * Inserta un clip generado o sube un video (portada o cierre) en un video terminado (ADR-073). El video
   * subido se guarda en inserts/ y se revisa con ffprobe antes de aceptarlo.
   */
  @Post(':id/inserts')
  @HttpCode(202)
  async addInsert(@Param('id') id: string, @Headers('x-confirm-change') confirm: string | undefined, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    await this.publications.guardVideo(id, user.id, confirm === '1'); // T3c: aviso si está publicado
    const r = InsertSchema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join(' '));
    const rec = await this.rec(id, user);
    if (r.data.kind === 'generated' || r.data.transition) this.sameMode(rec);
    let upload: Parameters<PipelineService['addInsert']>[2];
    if (r.data.kind === 'upload') {
      if (!r.data.data || !r.data.fileName) throw new BadRequestException('Falta el video.');
      const buf = Buffer.from(r.data.data.replace(/^data:[^,]+,/, ''), 'base64');
      if (buf.length > MAX_INSERT_BYTES) throw new BadRequestException('El video pasa de 60 MB: recórtalo o comprímelo antes de subirlo.');
      const ext = (r.data.fileName.match(/\.(mp4|mov|m4v|webm|mkv)$/i)?.[1] ?? 'mp4').toLowerCase();
      const dir = join(rec.dir, 'inserts');
      await mkdir(dir, { recursive: true });
      const path = join(dir, `subido_${Date.now()}.${ext}`);
      await writeFile(path, buf);
      try {
        upload = { path, meta: await probeVideo(path) };
      } catch (e) {
        throw new BadRequestException(`No se pudo leer el video: ${(e as Error).message}`);
      }
    }
    this.act(() => this.pipeline.addInsert(rec, r.data, upload));
    return rec.state;
  }

  @Post(':id/inserts/:insertId/regenerate')
  @HttpCode(202)
  async regenerateInsert(@Param('id') id: string, @Headers('x-confirm-change') confirm: string | undefined, @Param('insertId', ParseIntPipe) insertId: number, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    await this.publications.guardVideo(id, user.id, confirm === '1'); // T3c: aviso si está publicado
    const { note } = RegenSchema.parse(body ?? {});
    const rec = await this.rec(id, user);
    this.sameMode(rec);
    this.act(() => this.pipeline.regenerateInsert(rec, insertId, note));
    return rec.state;
  }

  /** Transición de un video subido (ADR-074): agregarla o regenerarla (con indicación) o quitarla. */
  @Post(':id/inserts/:insertId/transition')
  @HttpCode(202)
  async insertTransition(@Param('id') id: string, @Headers('x-confirm-change') confirm: string | undefined, @Param('insertId', ParseIntPipe) insertId: number, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    await this.publications.guardVideo(id, user.id, confirm === '1'); // T3c: aviso si está publicado
    const o = TransitionSchema.parse(body ?? {});
    const rec = await this.rec(id, user);
    if (!o.remove && o.enabled === undefined) this.sameMode(rec);
    this.act(() => this.pipeline.insertTransition(rec, insertId, o));
    return rec.state;
  }

  @Delete(':id/inserts/:insertId')
  async removeInsert(@Param('id') id: string, @Headers('x-confirm-change') confirm: string | undefined, @Param('insertId', ParseIntPipe) insertId: number, @CurrentUser() user: AuthUser) {
    await this.publications.guardVideo(id, user.id, confirm === '1'); // T3c: aviso si está publicado
    const rec = await this.rec(id, user);
    this.act(() => this.pipeline.removeInsert(rec, insertId));
    return rec.state;
  }

  /** Volver a unir el final de un video terminado, sin costo (ADR-158). */
  @Post(':id/rejoin')
  @HttpCode(202)
  async rejoin(@Param('id') id: string, @Headers('x-confirm-change') confirm: string | undefined, @CurrentUser() user: AuthUser) {
    await this.publications.guardVideo(id, user.id, confirm === '1'); // T3c: aviso si está publicado
    const rec = await this.rec(id, user);
    this.act(() => this.pipeline.rejoin(rec));
    return rec.state;
  }

  @Post(':id/approve')
  @HttpCode(202)
  async approve(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const rec = await this.rec(id, user);
    // Volver al video terminado sin cambios no usa proveedores: se permite aunque el modo sea otro (ADR-051).
    if (!this.pipeline.isNoopApproval(rec)) this.sameMode(rec);
    this.act(() => this.pipeline.approve(rec));
    return rec.state;
  }

  /** Detener un video sin final (hito 5, ADR-052): sale de la cola hasta Reanudar. */
  @Post(':id/pause')
  @HttpCode(202)
  async pause(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const rec = await this.rec(id, user);
    this.act(() => this.pipeline.pause(rec));
    return rec.state;
  }

  /** Reanudar un video detenido: vuelve a la cola con su prioridad y sigue desde donde quedó. */
  @Post(':id/continue')
  @HttpCode(202)
  async continue(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const rec = await this.rec(id, user);
    this.sameMode(rec);
    this.act(() => this.pipeline.continue(rec));
    return rec.state;
  }

  @Post(':id/retry')
  @HttpCode(202)
  async retry(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const rec = await this.rec(id, user);
    this.sameMode(rec);
    this.act(() => this.pipeline.retry(rec));
    return rec.state;
  }

  /**
   * Subtítulos del final vigente (hito 6, ADR-061/062): `vtt` o `srt`, desde los tiempos por palabra con las
   * reglas vigentes (y se guardan junto al final).
   */
  @Get(':id/subtitles/:format')
  async subtitles(@Param('id') id: string, @Param('format') format: string, @Req() req: Request, @Res() res: Response, @CurrentUser() user: AuthUser) {
    if (format !== 'vtt' && format !== 'srt') throw new NotFoundException();
    const rec = await this.rec(id, user);
    const rel = rec.state.finalUrl ? decodeURIComponent(rec.state.finalUrl.split('/files/')[1]?.split('?')[0] ?? '') : '';
    if (!rel) throw new NotFoundException('El video aún no tiene final.');
    const file = resolve(rec.dir, rel).replace(/\.mp4$/, `.${format}`);
    // Se arman siempre con las reglas vigentes (ADR-062) desde los tiempos por palabra; el archivo junto al
    // final queda para los videos sin tiempos.
    let body: string;
    if (rec.words?.length) {
      // Con insertos (ADR-073) los subtítulos se corren y se agregan los de su locución.
      const cues = finalCues({ paragraphs: rec.state.paragraphs, words: rec.words, voiceFrames: rec.state.totalFrames ?? 0, plan: rec.plan, inserts: rec.state.inserts });
      body = format === 'vtt' ? toVtt(cues) : toSrt(cues);
      await writeFile(file, body).catch(() => undefined);
    } else if ((await this.media.ensure(file), existsSync(file))) body = await readFile(file, 'utf8');
    else throw new NotFoundException('Este video no tiene tiempos por palabra.');
    res.setHeader('content-type', format === 'vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8');
    if (req.query.download !== undefined) res.setHeader('content-disposition', `attachment; filename="subtitulos_${safeName(id)}.${format}"`);
    res.send(body);
  }

  /** Sirve los archivos de la generación (imágenes, clips, voz, final) sin salir de su carpeta. */
  @Get(':id/files/*path')
  async file(@Param('id') id: string, @Req() req: Request, @Res() res: Response, @CurrentUser() user: AuthUser) {
    const rec = await this.rec(id, user, { hidden: true });
    const rel = decodeURIComponent(req.path.split('/files/')[1] ?? '');
    const abs = resolve(rec.dir, rel);
    if (!abs.startsWith(resolve(rec.dir) + sep)) throw new NotFoundException();
    // Desde la caché local o, si la carpeta salió de ella, con una URL firmada (hito 8, ADR-093).
    await this.media.serve(res, abs, { download: req.query.download !== undefined });
  }
}
