import { BadRequestException, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { AuthUser } from '@wilox/shared';
import { CurrentUser } from '../auth/decorators.js';
import { TrashService } from './trash.service.js';

const kindOf = (k: string): 'project' | 'video' => {
  if (k !== 'project' && k !== 'video') throw new BadRequestException('Tipo no válido.');
  return k;
};

/** Papelera (hito 9, T3d, ADR-106): eliminar un video (el proyecto, en ProjectsController), ver, restaurar y eliminar definitivamente. */
@Controller()
export class TrashController {
  constructor(private readonly trash: TrashService) {}

  /** Eliminar un video: va a la papelera (409 si está publicado o 400 si se está generando). */
  @Delete('generations/:id')
  async trashVideo(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.trash.trashVideo(id, user);
    return { ok: true };
  }

  @Get('trash')
  list(@CurrentUser() user: AuthUser) {
    return this.trash.list(user.id);
  }

  @Get('trash/count')
  count(@CurrentUser() user: AuthUser) {
    return this.trash.count(user.id);
  }

  @Post('trash/:kind/:id/restore')
  @HttpCode(200)
  restore(@Param('kind') kind: string, @Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.trash.restore(kindOf(kind), id, user);
  }

  @Post('trash/:kind/:id/delete')
  @HttpCode(200)
  async remove(@Param('kind') kind: string, @Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.trash.deleteForever(kindOf(kind), id, user);
    return { ok: true };
  }

  @Post('trash/empty')
  @HttpCode(200)
  empty(@CurrentUser() user: AuthUser) {
    return this.trash.empty(user.id);
  }
}
