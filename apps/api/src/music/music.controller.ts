import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthUser, MusicListResponse } from '@wilox/shared';
import { CurrentUser } from '../auth/decorators.js';
import { MusicService } from './music.service.js';

/** Música de fondo (hito 5, ADR-044): lista de la carpeta y escucha previa. */
@Controller('music')
export class MusicController {
  constructor(private readonly music: MusicService) {}

  @Get()
  list(@CurrentUser() user: AuthUser): Promise<MusicListResponse> {
    return this.music.forUser(user.id);
  }

  /** El archivo del track (con soporte de rangos para el reproductor del navegador). */
  @Get(':name/audio')
  audio(@Param('name') name: string, @Res() res: Response) {
    const path = this.music.pathOf(name);
    if (!path) throw new NotFoundException('Ese track no está en la carpeta de música.');
    res.sendFile(path, { dotfiles: 'deny', maxAge: '1h' }, (err) => err && !res.headersSent && res.status(404).end());
  }
}
