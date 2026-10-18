import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Db } from '@wilox/db';
import type { AuthUser, ScriptStyleInfo, ScriptStylesResponse } from '@wilox/shared';
import { CurrentUser } from '../auth/decorators.js';
import { AccessService } from '../access/access.service.js';
import { DB } from '../db/db.module.js';

const StyleSchema = z.object({ name: z.string().trim().min(2).max(80), structure: z.string().trim().min(10).max(2000) });
const UUID = /^[0-9a-f-]{36}$/i;

const info = (s: { id: string; name: string; structure: string; updatedAt: Date }): ScriptStyleInfo => ({ id: s.id, name: s.name, structure: s.structure, updatedAt: s.updatedAt.toISOString() });

/**
 * Estilos de guion (hito 6, ADR-072): cómo está armado un PDF o Word de guion, guardado para no reescribirlo
 * en cada importación. Biblioteca de cada usuario; cada proyecto recuerda el último usado (se propone por
 * defecto al importar en ese proyecto).
 */
@Controller('script-styles')
export class ScriptStylesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  /**
   * Mis estilos y, en un proyecto de otro dueño al que tengo acceso (hito 11, ADR-142), también los del dueño: se usan,
   * no se editan (llevan `ownerName`).
   */
  @Get()
  async list(@Query('projectId') projectId: string | undefined, @CurrentUser() user: AuthUser): Promise<ScriptStylesResponse> {
    const project = projectId && UUID.test(projectId) ? await this.access.project(projectId, user).catch(() => undefined) : undefined;
    const row = project ? await this.db.project.findUnique({ where: { id: project.id }, select: { scriptStyleId: true, owner: { select: { name: true, email: true } } } }) : null;
    const [styles, ownerStyles] = await Promise.all([
      this.db.scriptStyle.findMany({ where: { ownerId: user.id }, orderBy: { name: 'asc' } }),
      project && project.ownerId !== user.id ? this.db.scriptStyle.findMany({ where: { ownerId: project.ownerId }, orderBy: { name: 'asc' } }) : [],
    ]);
    const ownerName = row?.owner.name || row?.owner.email || '';
    return { styles: [...styles.map(info), ...ownerStyles.map((s) => ({ ...info(s), ownerName }))], lastUsedId: row?.scriptStyleId ?? undefined };
  }

  @Post()
  async create(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<ScriptStyleInfo> {
    const d = this.parse(body);
    if (await this.db.scriptStyle.findFirst({ where: { ownerId: user.id, name: d.name } })) throw new ConflictException(`Ya tienes un estilo llamado «${d.name}».`);
    return info(await this.db.scriptStyle.create({ data: { ownerId: user.id, ...d } }));
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser): Promise<ScriptStyleInfo> {
    await this.own(id, user);
    const d = this.parse(body);
    if (await this.db.scriptStyle.findFirst({ where: { ownerId: user.id, name: d.name, id: { not: id } } })) throw new ConflictException(`Ya tienes un estilo llamado «${d.name}».`);
    return info(await this.db.scriptStyle.update({ where: { id }, data: d }));
  }

  /** Eliminar: los proyectos que lo tenían como último usado quedan sin estilo propuesto. */
  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.own(id, user);
    await this.db.scriptStyle.delete({ where: { id } });
    return { ok: true };
  }

  private parse(body: unknown) {
    const r = StyleSchema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException('El estilo necesita un nombre (2 a 80 caracteres) y su descripción (10 a 2.000).');
    return r.data;
  }

  private async own(id: string, user: AuthUser) {
    if (!UUID.test(id) || !(await this.db.scriptStyle.findFirst({ where: { id, ownerId: user.id }, select: { id: true } }))) throw new NotFoundException('Estilo no encontrado.');
  }
}
