import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, NotFoundException, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ensureUnclassified, type Db } from '@wilox/db';
import type { AuthUser, ProjectNotEmpty, ProjectsResponse, ProjectSummary } from '@wilox/shared';
import { CurrentUser } from '../auth/decorators.js';
import { DB } from '../db/db.module.js';
import { DownloadsService } from '../downloads/downloads.service.js';
import { RunStore } from '../generations/run-store.js';
import { PipelineService } from '../pipeline/pipeline.service.js';
import { env } from '../config/env.js';
import { HistoryService } from './history.service.js';
import { TrashService } from '../trash/trash.service.js';
import { DuplicateService } from '../duplicate/duplicate.service.js';
import { AccessService } from '../access/access.service.js';
import { reservedNameProblem, systemProjectProblem } from './rules.js';

const CreateSchema = z.object({
  name: z.string().trim().min(2, 'El nombre debe tener al menos 2 caracteres.').max(80),
  description: z.string().trim().max(500).optional(),
});
const PatchSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  archived: z.boolean().optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join(' '));
  return r.data;
}

/**
 * Proyectos (hito 3, ADR-030 y ADR-032): contenedores de videos, cada usuario los suyos.
 * Hito 4 (ADR-035): todo video vive en un proyecto; "Sin clasificar" es el del sistema (fijo).
 * Hito 11 (ADR-142): también los compartidos con el usuario y los públicos (el guard global comprueba el acceso a
 * `projects/:id…`); archivar y eliminar, solo el dueño.
 */
@Controller('projects')
export class ProjectsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly history: HistoryService,
    private readonly downloads: DownloadsService,
    private readonly runs: RunStore,
    private readonly pipeline: PipelineService,
    private readonly trash: TrashService,
    private readonly duplicate: DuplicateService,
    private readonly access: AccessService,
  ) {}

  /**
   * Detener o reanudar todos los videos del proyecto que aún no tienen final (hito 5, ADR-052). Los videos
   * de otro modo (MCP) no se reanudan desde aquí.
   */
  @Post(':id/pause')
  async pauseAll(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.own(id, user);
    const rows = await this.db.generation.findMany({
      where: { projectId: id, finalPath: null, status: { notIn: ['done', 'paused'] } },
      select: { id: true },
    });
    let n = 0;
    for (const r of rows) {
      const rec = await this.runs.get(r.id);
      if (rec && this.pipeline.canPause(rec)) {
        this.pipeline.pause(rec);
        n += 1;
      }
    }
    return { paused: n };
  }

  @Post(':id/continue')
  async continueAll(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.own(id, user);
    const rows = await this.db.generation.findMany({ where: { projectId: id, status: 'paused', trashedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    let n = 0;
    for (const r of rows) {
      const rec = await this.runs.get(r.id);
      if (!rec || rec.busy || rec.state.mode !== env.GENERATION_MODE) continue;
      this.pipeline.continue(rec);
      n += 1;
    }
    return { resumed: n };
  }

  /** Proyecto al que el usuario tiene acceso (hito 11: suyo, compartido, público o, el admin, cualquiera). */
  private own(id: string, user: AuthUser) {
    return this.access.project(id, user);
  }

  private async summary(id: string, user: AuthUser): Promise<ProjectSummary> {
    const r = await this.history.projects(user, true, true);
    const s = r.projects.find((p) => p.id === id);
    if (!s) throw new NotFoundException('Proyecto no encontrado.');
    return this.duplicate.withProgress(s);
  }

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('archived') archived?: string, @Query('all') all?: string): Promise<ProjectsResponse> {
    // Hito 11 (ADR-142): ?all=1 = el admin ve los proyectos de todos («Ver los de todos»).
    const r = await this.history.projects(user, archived === '1' || archived === 'true', all === '1');
    // Proyectos duplicándose (T3e, ADR-107): con su avance.
    return { ...r, projects: r.projects.map((p) => this.duplicate.withProgress(p)) };
  }

  @Post()
  async create(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<ProjectSummary> {
    const { name, description } = parse(CreateSchema, body);
    const reserved = reservedNameProblem(name);
    if (reserved) throw new BadRequestException(reserved);
    const p = await this.db.project.create({ data: { ownerId: user.id, name, description: description || null } });
    return this.summary(p.id, user);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser): Promise<ProjectSummary> {
    const p = await this.own(id, user);
    const { name, description, archived } = parse(PatchSchema, body);
    const problem = systemProjectProblem(p.system, 'update', { name, description, archived }) ?? (name !== undefined ? reservedNameProblem(name) : undefined);
    if (problem) throw new BadRequestException(problem);
    // Archivar o desarchivar es del dueño (hito 11, ADR-142); renombrar y la descripción, de todos los que tienen acceso.
    if (archived !== undefined && archived !== !!p.archivedAt) this.access.requireOwner(p.role, 'archive');
    await this.db.project.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description: description || null } : {}),
        ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}),
      },
    });
    return this.summary(id, user);
  }

  /**
   * Eliminar un proyecto (hito 9, T3d, ADR-106): va a la papelera con sus videos (antes, ADR-035, sus videos pasaban a
   * «Sin clasificar» y el proyecto se borraba). «Sin clasificar» no se elimina; con videos publicados o generándose,
   * no se elimina (409 / 400 con el motivo).
   */
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<{ videos: number }> {
    return this.trash.trashProject(id, user);
  }

  /** ZIP con todos los videos del proyecto (una carpeta por video), con el logo y los ajustes del proyecto. */
  @Get(':id/download')
  async download(@Param('id') id: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.own(id, user);
    await this.downloads.sendProject(res, id, user.id);
  }
}
