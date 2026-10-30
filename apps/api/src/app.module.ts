import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { DbModule } from './db/db.module.js';
import { StorageModule } from './storage/storage.module.js';
import { GenerationsController } from './generations/generations.controller.js';
import { DownloadsService } from './downloads/downloads.service.js';
import { JobsService } from './jobs/jobs.service.js';
import { MusicController } from './music/music.controller.js';
import { MusicService } from './music/music.service.js';
import { HistoryService } from './projects/history.service.js';
import { ProjectsController } from './projects/projects.controller.js';
import { RunStore } from './generations/run-store.js';
import { PipelineService } from './pipeline/pipeline.service.js';
import { QueueModule } from './queue/queue.module.js';
import { QueueController } from './queue/queue.controller.js';
import { PronunciationsController } from './voice/pronunciations.controller.js';
import { ImportsController } from './imports/imports.controller.js';
import { ProvidersModule } from './providers/providers.module.js';
import { StudioService } from './themes/studio.service.js';
import { ThemeStore } from './themes/theme-store.js';
import { ThemesController } from './themes/themes.controller.js';
import { TypographyService } from './themes/typography.service.js';
import { UsersController } from './users/users.controller.js';
import { DeliveryController } from './delivery/delivery.controller.js';
import { DeliveryService } from './delivery/delivery.service.js';
import { PackagesService } from './delivery/packages.service.js';
import { BatchesController, DownloadLinksController } from './downloads/batches.controller.js';
import { BatchesService } from './downloads/batches.service.js';
import { ExportsService } from './delivery/exports.service.js';
import { CostsController } from './costs/costs.controller.js';
import { ScriptStylesController } from './imports/script-styles.controller.js';
import { ReviewController } from './review/review.controller.js';
import { ReviewService } from './review/review.service.js';
import { ClipAdviceService } from './review/clip-advice.service.js';
import { PublicationsController } from './publications/publications.controller.js';
import { PublicationsService } from './publications/publications.service.js';
import { LogoBurnService } from './delivery/logo-burn.service.js';
import { TrashController } from './trash/trash.controller.js';
import { TrashService } from './trash/trash.service.js';
import { DuplicateController } from './duplicate/duplicate.controller.js';
import { DuplicateService } from './duplicate/duplicate.service.js';
import { VideoOrderController } from './projects/video-order.controller.js';
import { RevoiceBatchController } from './voice/revoice-batch.controller.js';
import { RevoiceBatchService } from './voice/revoice-batch.service.js';
import { VoiceTrialController } from './voice/voice-trial.controller.js';
import { VoiceTrialService } from './voice/voice-trial.service.js';
import { ProjectShareController } from './share/project-share.controller.js';
import { ProjectShareService } from './share/project-share.service.js';
import { AccessService } from './access/access.service.js';
import { AccessController } from './access/access.controller.js';
import { OwnershipService } from './access/ownership.service.js';
import { BrandController } from './brand/brand.controller.js';

@Module({
  imports: [DbModule, StorageModule, QueueModule, ProvidersModule],
  controllers: [AppController, BrandController, AuthController, UsersController, ProjectsController, GenerationsController, ThemesController, MusicController, QueueController, PronunciationsController, ImportsController, DeliveryController, CostsController, ScriptStylesController, BatchesController, ReviewController, PublicationsController, TrashController, DuplicateController, VideoOrderController, DownloadLinksController, ProjectShareController, VoiceTrialController, RevoiceBatchController, AccessController],
  providers: [AccessService, OwnershipService, AuthService, JobsService, HistoryService, DownloadsService, { provide: APP_GUARD, useClass: AuthGuard }, RunStore, MusicService, PipelineService, ThemeStore, StudioService, TypographyService, DeliveryService, ExportsService, PackagesService, BatchesService, ReviewService, ClipAdviceService, PublicationsService, LogoBurnService, TrashService, DuplicateService, ProjectShareService, VoiceTrialService, RevoiceBatchService],
})
export class AppModule {}
