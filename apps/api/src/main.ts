import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { env } from './config/env.js';
import { AppModule } from './app.module.js';
import { ffmpeg } from './media/ffmpeg.js';

async function bootstrap() {
  const log = new Logger('Wilox');
  try {
    await ffmpeg(['-version']);
  } catch {
    throw new Error(`No se encontró ffmpeg (${env.FFMPEG_PATH}). Instálalo con: brew install ffmpeg`);
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: true });
  // Estudio: las imágenes de referencia llegan en base64 (hasta 12 por envío).
  app.useBodyParser('json', { limit: '100mb' });
  app.setGlobalPrefix('api');
  // Detrás del proxy de Vite: req.ip toma la IP real (límite de intentos de login).
  app.set('trust proxy', 'loopback');
  app.enableShutdownHooks();
  app.enableCors({ origin: [env.WEB_ORIGIN, ...env.WEB_ORIGIN_ALIASES], credentials: true });
  await app.listen(env.PORT);
  log.log(`API en http://localhost:${env.PORT}/api · modo ${env.GENERATION_MODE.toUpperCase()} · marca ${env.BRAND ?? 'neutra'}`);
}
await bootstrap();
