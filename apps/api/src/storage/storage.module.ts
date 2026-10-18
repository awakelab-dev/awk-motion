import { Global, Module } from '@nestjs/common';
import { MediaService } from './media.service.js';
import { StorageController } from './storage.controller.js';

/** Medios en almacenamiento remoto con caché local (hito 8, ADR-093). */
@Global()
@Module({ controllers: [StorageController], providers: [MediaService], exports: [MediaService] })
export class StorageModule {}
