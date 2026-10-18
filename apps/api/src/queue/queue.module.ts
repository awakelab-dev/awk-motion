import { Global, Module } from '@nestjs/common';
import { QueueService } from './queue.service.js';

/** Cola global por recurso (hito 5, ADR-045): la usan los proveedores (gate) y el pipeline (ffmpeg). */
@Global()
@Module({ providers: [QueueService], exports: [QueueService] })
export class QueueModule {}
