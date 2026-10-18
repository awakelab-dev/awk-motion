import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import type { Db } from '@wilox/db';
import { Roles } from '../auth/decorators.js';
import { env } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { MediaService } from './media.service.js';

/** Estado y mantenimiento del almacenamiento de medios (hito 8, ADR-093). Solo el administrador. */
@Controller('storage')
@Roles('admin')
export class StorageController {
  constructor(
    private readonly media: MediaService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get()
  async status() {
    const idx = this.media.indexed();
    let bytes = 0;
    for (const v of idx.values()) bytes += v.size;
    const dirs = await this.db.mediaDir.groupBy({ by: ['evictedAt'], _count: true }).catch(() => []);
    const evicted = dirs.filter((d) => d.evictedAt).reduce((n, d) => n + d._count, 0);
    const local = dirs.filter((d) => !d.evictedAt).reduce((n, d) => n + d._count, 0);
    return {
      driver: this.media.driver,
      prefix: this.media.prefix,
      objects: idx.size,
      bytes,
      dirs: { local, evicted },
      cacheDays: env.MEDIA_CACHE_DAYS,
      batchCacheHours: env.MEDIA_BATCH_CACHE_HOURS,
    };
  }

  /** Sube ya todo lo que falte. */
  @Post('sweep')
  @HttpCode(200)
  sweep() {
    return this.media.sweep();
  }

  /** Libera la caché ahora (force: también lo usado hace poco, salvo lo que esté trabajando). */
  @Post('evict')
  @HttpCode(200)
  evict(@Body() body: { force?: boolean } | undefined) {
    return this.media.evict({ force: body?.force === true });
  }
}
