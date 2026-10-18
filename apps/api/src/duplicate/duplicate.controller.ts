import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import type { AuthUser, DuplicateProjectResponse, GenerationSummary } from '@wilox/shared';
import { CurrentUser } from '../auth/decorators.js';
import { DuplicateService } from './duplicate.service.js';

const VideoSchema = z.object({ projectId: z.string().uuid().optional() });

/** Duplicar un video o un proyecto (hito 9, T3e, ADR-107). */
@Controller()
export class DuplicateController {
  constructor(private readonly duplicate: DuplicateService) {}

  /** Duplica el video en su proyecto o en `projectId` (toma el logo de ese proyecto). */
  @Post('generations/:id/duplicate')
  @HttpCode(201)
  video(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser): Promise<GenerationSummary> {
    const { projectId } = VideoSchema.parse(body ?? {});
    return this.duplicate.duplicateVideo(id, user, projectId);
  }

  /** Duplica el proyecto: sale al instante y sus videos se copian en segundo plano (`ProjectSummary.copying`). */
  @Post('projects/:id/duplicate')
  @HttpCode(201)
  project(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<DuplicateProjectResponse> {
    return this.duplicate.duplicateProject(id, user);
  }
}
