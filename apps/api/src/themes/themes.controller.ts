import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  Res,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { resolve, sep } from 'node:path';
import type { Request, Response } from 'express';
import { map, type Observable } from 'rxjs';
import { z } from 'zod';
import { isBaseThemeId, ThemeBriefSchema, ThemeStyleSchema, type AuthUser, type ThemeDetail, type ThemeStyle } from '@wilox/shared';
import { CurrentUser } from '../auth/decorators.js';
import { MediaService } from '../storage/media.service.js';
import { TypographyService } from './typography.service.js';
import { StudioService } from './studio.service.js';
import { ThemeStore } from './theme-store.js';
import { AccessService } from '../access/access.service.js';

const UpdateSchema = z.object({
  brief: ThemeBriefSchema.optional(),
  style: ThemeStyleSchema.optional(),
});
const RefsSchema = z.object({
  files: z
    .array(z.object({ name: z.string().max(200), data: z.string().min(10) }))
    .min(1)
    .max(12),
});
const SaveSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  description: z.string().trim().min(3).max(160).optional(),
  thumbnailTest: z.number().int().optional(),
});
const MAX_REFS = 12;

@Controller('themes')
export class ThemesController {
  constructor(
    private readonly store: ThemeStore,
    private readonly studio: StudioService,
    private readonly media: MediaService,
    private readonly typography: TypographyService,
    private readonly access: AccessService,
  ) {}

  private act<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  /** Tema del Estudio del usuario (los de otros usuarios no existen para él). */
  private custom(id: string, user: AuthUser) {
    if (isBaseThemeId(id)) throw new BadRequestException('Los temas base son de solo lectura: duplícalo para editarlo.');
    const t = this.store.stored(id);
    if (!t || t.ownerId !== user.id) throw new NotFoundException('Tema no encontrado.');
    this.studio.recover(id);
    this.typography.recover(id);
    return t;
  }

  private detail(id: string, user: AuthUser): ThemeDetail {
    const d = this.store.canAccess(id, user.id) ? this.store.detail(id) : undefined;
    if (!d) throw new NotFoundException('Tema no encontrado.');
    return d;
  }

  @Get()
  list(@CurrentUser() user: AuthUser): ThemeDetail[] {
    const all = this.store.list(user.id);
    all.filter((d) => d.origin === 'custom').forEach((d) => (this.studio.recover(d.id), this.typography.recover(d.id)));
    return this.store.list(user.id);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser): ThemeDetail {
    this.detail(id, user); // 404 si no es suyo
    if (!isBaseThemeId(id)) (this.studio.recover(id), this.typography.recover(id));
    return this.detail(id, user);
  }

  @Sse(':id/events')
  events(@Param('id') id: string, @CurrentUser() user: AuthUser): Observable<MessageEvent> {
    this.custom(id, user);
    return this.store.subject(id)!.pipe(map((d) => ({ data: d }) as MessageEvent));
  }

  /** Nuevo borrador desde el formulario del Estudio. */
  @Post()
  create(@Body() body: unknown, @CurrentUser() user: AuthUser): ThemeDetail {
    const parsed = ThemeBriefSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' '));
    // El historial de correcciones lo gestiona la API (ADR-042).
    const { corrections: _c, applied: _a, ...brief } = parsed.data;
    return this.detail(this.store.create(brief, user.id).id, user);
  }

  @Post(':id/duplicate')
  duplicate(@Param('id') id: string, @CurrentUser() user: AuthUser): ThemeDetail {
    return this.detail(this.act(() => this.store.duplicate(id, user.id)).id, user);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser): ThemeDetail {
    const t = this.custom(id, user);
    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' '));
    if (t.activity) throw new BadRequestException('Espera a que Opus termine con el tema.');
    const { brief, style } = parsed.data;
    // Las tipografías (ADR-094) las gestiona la API: un PATCH del estilo no las cambia.
    const bare = (x: ThemeStyle) => JSON.stringify({ ...x, typefaces: undefined });
    const styleChanged = !!style && bare({ ...style, info: { ...style.info, id } }) !== bare(t.style);
    this.store.update(
      id,
      (x) => {
        // Las correcciones y la firma de la versión vigente no se cambian con un PATCH (ADR-042).
        if (brief) x.brief = { ...brief, corrections: x.brief.corrections, applied: x.brief.applied };
        if (style) x.style = { ...style, info: { ...style.info, id }, typefaces: x.style.typefaces };
      },
      { styleChanged },
    );
    return this.detail(id, user);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    this.custom(id, user);
    await this.store.remove(id).catch((e) => {
      throw new BadRequestException((e as Error).message);
    });
    return { ok: true };
  }

  /** Imágenes de referencia en base64 (data URL o base64 puro). */
  @Post(':id/references')
  async addReferences(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser): Promise<ThemeDetail> {
    const t = this.custom(id, user);
    const parsed = RefsSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Envía de 1 a 12 imágenes.');
    if (t.references.length + parsed.data.files.length > MAX_REFS) throw new BadRequestException(`Máximo ${MAX_REFS} imágenes de referencia por tema.`);
    const files = parsed.data.files.map((f) => ({ name: f.name, data: Buffer.from(f.data.replace(/^data:[^,]+,/, ''), 'base64') }));
    try {
      await this.store.addReferences(id, files);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    return this.detail(id, user);
  }

  @Delete(':id/references/:file')
  async removeReference(@Param('id') id: string, @Param('file') file: string, @CurrentUser() user: AuthUser): Promise<ThemeDetail> {
    this.custom(id, user);
    try {
      await this.store.removeReference(id, file);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    return this.detail(id, user);
  }

  /**
   * Opus propone el tema desde la descripción y todas las correcciones activas. Una nota (API
   * anterior) se guarda como corrección nueva y se aplica (ADR-042).
   */
  @Post(':id/propose')
  @HttpCode(202)
  propose(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser): ThemeDetail {
    this.custom(id, user);
    const note = z.object({ note: z.string().max(2000).optional() }).parse(body ?? {}).note?.trim();
    this.act(() => (note && note.length >= 3 ? this.studio.addCorrection(id, note) : this.studio.propose(id)));
    return this.detail(id, user);
  }

  /** Nueva corrección: queda en el historial y Opus la aplica (versión nueva del tema). */
  @Post(':id/corrections')
  @HttpCode(202)
  addCorrection(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser): ThemeDetail {
    this.custom(id, user);
    const parsed = z.object({ text: z.string().trim().min(3).max(2000) }).safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('Escribe la corrección (de 3 a 2000 caracteres).');
    this.act(() => this.studio.addCorrection(id, parsed.data.text));
    return this.detail(id, user);
  }

  /** Activar o desactivar una corrección (el tema queda pendiente de regenerar). */
  @Patch(':id/corrections/:cid')
  changeCorrection(@Param('id') id: string, @Param('cid') cid: string, @Body() body: unknown, @CurrentUser() user: AuthUser): ThemeDetail {
    this.custom(id, user);
    const parsed = z.object({ active: z.boolean() }).safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('Falta "active".');
    this.act(() => this.studio.changeCorrection(id, cid, { active: parsed.data.active }));
    return this.detail(id, user);
  }

  /** Eliminar una corrección del historial (el tema queda pendiente de regenerar). */
  @Delete(':id/corrections/:cid')
  removeCorrection(@Param('id') id: string, @Param('cid') cid: string, @CurrentUser() user: AuthUser): ThemeDetail {
    this.custom(id, user);
    this.act(() => this.studio.changeCorrection(id, cid, { remove: true }));
    return this.detail(id, user);
  }

  @Post(':id/tests')
  @HttpCode(202)
  startTest(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser): ThemeDetail {
    this.custom(id, user);
    const { withClip } = z.object({ withClip: z.boolean().default(true) }).parse(body ?? {});
    this.act(() => this.studio.startTest(id, withClip));
    return this.detail(id, user);
  }

  @Post(':id/tests/:n/frames/:key/regenerate')
  @HttpCode(202)
  regenerateFrame(@Param('id') id: string, @Param('n', ParseIntPipe) n: number, @Param('key') key: string, @CurrentUser() user: AuthUser): ThemeDetail {
    this.custom(id, user);
    if (key !== 'A' && key !== 'B') throw new BadRequestException('Frame inválido.');
    this.act(() => this.studio.regenerateFrame(id, n, key));
    return this.detail(id, user);
  }

  @Post(':id/tests/:n/clip')
  @HttpCode(202)
  clip(@Param('id') id: string, @Param('n', ParseIntPipe) n: number, @CurrentUser() user: AuthUser): ThemeDetail {
    this.custom(id, user);
    this.act(() => this.studio.regenerateClip(id, n));
    return this.detail(id, user);
  }

  @Post(':id/tests/:n/apply-suggestions')
  applySuggestions(@Param('id') id: string, @Param('n', ParseIntPipe) n: number, @Body() body: unknown, @CurrentUser() user: AuthUser): ThemeDetail {
    this.custom(id, user);
    const { indices } = z.object({ indices: z.array(z.number().int()).optional() }).parse(body ?? {});
    this.act(() => this.studio.applySuggestions(id, n, indices));
    return this.detail(id, user);
  }

  /** Guardar en "Mis temas": nombre, descripción corta y miniatura (frame A de una prueba). */
  @Post(':id/save')
  async save(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser): Promise<ThemeDetail> {
    const t = this.custom(id, user);
    const parsed = SaveSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(' '));
    const { name, description, thumbnailTest } = parsed.data;
    if (!t.style.imageBible) throw new BadRequestException('El tema aún no tiene estilo.');
    const withA = [...t.tests].reverse().filter((x) => x.frames.find((f) => f.key === 'A')?.status === 'ready');
    const test = thumbnailTest !== undefined ? withA.find((x) => x.n === thumbnailTest) : withA[0];
    if (!test) throw new BadRequestException('Haz al menos una prueba con el frame A listo antes de guardar el tema.');
    const a = test.frames.find((f) => f.key === 'A')!;
    await this.store.setThumbnail(id, resolve(this.store.dir(id), 'pruebas', String(test.n).padStart(3, '0'), `A_v${a.version}.png`), test.n);
    this.store.update(id, (x) => {
      x.status = 'saved';
      if (name) (x.style.info.name = name), (x.brief.name = name);
      if (description) x.style.info.description = description;
    });
    return this.detail(id, user);
  }

  // ─── Tipografías (hito 8, A2, ADR-094) ──────────────────────────────────────────────────────────────

  /** Agrega fuentes de Google Fonts por nombre ("Roboto, Oswald") y dibuja sus láminas. */
  @Post(':id/typefaces')
  addTypefaces(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser): ThemeDetail {
    this.custom(id, user);
    const b = z.object({ families: z.string().trim().min(2).max(200) }).safeParse(body);
    if (!b.success) throw new BadRequestException('Escribe las fuentes separadas por comas (p. ej. «Roboto, Oswald»).');
    this.typography.add(id, b.data.families);
    return this.detail(id, user);
  }

  /** Sube un .ttf u .otf propio (un archivo por peso). */
  @Post(':id/typefaces/upload')
  async uploadTypeface(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser): Promise<ThemeDetail> {
    this.custom(id, user);
    const b = z.object({ family: z.string(), weight: z.number().int(), fileName: z.string().max(200), data: z.string().min(10) }).safeParse(body);
    if (!b.success) throw new BadRequestException('Falta la fuente, el peso o el archivo.');
    await this.typography.upload(id, b.data);
    return this.detail(id, user);
  }

  /** Rol, pesos o reintentar una fuente. */
  @Patch(':id/typefaces/:family')
  updateTypeface(@Param('id') id: string, @Param('family') family: string, @Body() body: unknown, @CurrentUser() user: AuthUser): ThemeDetail {
    this.custom(id, user);
    const b = z
      .object({ role: z.enum(['headings', 'body', 'both']).optional(), weights: z.array(z.number().int()).optional(), retry: z.boolean().optional() })
      .safeParse(body ?? {});
    if (!b.success) throw new BadRequestException('Datos no válidos.');
    if (b.data.retry) this.typography.retry(id, family);
    else this.typography.update(id, family, b.data);
    return this.detail(id, user);
  }

  @Delete(':id/typefaces/:family')
  async removeTypeface(@Param('id') id: string, @Param('family') family: string, @CurrentUser() user: AuthUser): Promise<ThemeDetail> {
    this.custom(id, user);
    await this.typography.remove(id, family);
    return this.detail(id, user);
  }

  @Get(':id/files/*path')
  async file(@Param('id') id: string, @Req() req: Request, @Res() res: Response, @CurrentUser() user: AuthUser) {
    // Hito 11 (ADR-142): de un tema del dueño de un proyecto compartido con el usuario, solo su miniatura (Generar).
    const owner = isBaseThemeId(id) ? undefined : this.store.stored(id)?.ownerId;
    const rel = decodeURIComponent(req.path.split('/files/')[1] ?? '');
    if (!owner || (owner !== user.id && (rel !== 'miniatura.png' || !(await this.access.seesOwnerAssets(owner, user))))) throw new NotFoundException();
    const dir = resolve(this.store.dir(id));
    const abs = resolve(dir, rel);
    if (!abs.startsWith(dir + sep)) throw new NotFoundException();
    await this.media.serve(res, abs);
  }
}
