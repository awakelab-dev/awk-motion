import { Body, Controller, Get, Inject, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import type { AuthUser, ProjectAccessRequest, ProjectAccessState, ThemeInfo } from '@wilox/shared';
import type { Db } from '@wilox/db';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { DB } from '../db/db.module.js';
import { ThemeStore } from '../themes/theme-store.js';
import { AccessService } from './access.service.js';
import { OwnershipService } from './ownership.service.js';

const AccessSchema = z.object({ userIds: z.array(z.string().uuid()).max(500), public: z.boolean() });
const OwnerSchema = z.object({ ownerId: z.string().uuid() });

/**
 * Acceso a un proyecto (hito 11, ADR-142): con quién se comparte, si es público, cambiar el dueño (admin) y los temas
 * que se pueden usar en él (los míos y los del dueño). El guard global ya comprobó el acceso a `projects/:id…`.
 */
@Controller()
export class AccessController {
  constructor(
    private readonly ownership: OwnershipService,
    private readonly access: AccessService,
    private readonly themes: ThemeStore,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get('projects/:id/access')
  state(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<ProjectAccessState> {
    return this.ownership.state(id, user);
  }

  @Put('projects/:id/access')
  update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser): Promise<ProjectAccessState> {
    return this.ownership.update(id, user, AccessSchema.parse(body ?? {}) as ProjectAccessRequest);
  }

  @Roles('admin')
  @Post('projects/:id/owner')
  setOwner(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser): Promise<ProjectAccessState> {
    return this.ownership.setOwner(id, user, OwnerSchema.parse(body ?? {}).ownerId);
  }

  /** Temas para «Nuevo video» en este proyecto: los base, los míos y, si es de otro dueño, los suyos (sin editarlos). */
  @Get('projects/:id/themes')
  async themesFor(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<ThemeInfo[]> {
    const p = await this.access.project(id, user);
    if (p.ownerId === user.id) return this.themes.composerList(user.id);
    const o = await this.db.user.findUnique({ where: { id: p.ownerId }, select: { name: true, email: true } });
    return this.themes.composerListFor(user.id, p.ownerId, o?.name || o?.email || '');
  }
}
