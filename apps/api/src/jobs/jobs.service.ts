import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Db } from '@wilox/db';
import { DB } from '../db/db.module.js';
import { setJobSink, type JobRecord, type JobScope } from './job-scope.js';

/** Escribe cada trabajo de un proveedor en GenerationJob (con su costo en créditos o USD). */
@Injectable()
export class JobsService implements OnModuleInit {
  private readonly logger = new Logger('Jobs');
  private chain: Promise<void> = Promise.resolve();

  constructor(@Inject(DB) private readonly db: Db) {}

  onModuleInit() {
    setJobSink((scope, job) => {
      // En serie: la fila de la generación o de la prueba puede estar escribiéndose todavía.
      this.chain = this.chain.then(() => this.write(scope, job)).catch(() => undefined);
    });
  }

  private async write(scope: JobScope, job: JobRecord) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const themeTestId =
          scope.themeId && scope.testN !== undefined
            ? (await this.db.themeTest.findUnique({ where: { themeId_n: { themeId: scope.themeId, n: scope.testN } }, select: { id: true } }))?.id
            : undefined;
        await this.db.generationJob.create({
          data: {
            ownerId: scope.ownerId,
            generationId: scope.generationId,
            themeId: scope.themeId,
            themeTestId,
            kind: job.kind,
            target: job.target.slice(0, 200),
            provider: job.provider,
            model: job.model,
            externalId: job.externalId,
            status: job.error ? 'failed' : 'succeeded',
            credits: job.error ? 0 : job.credits,
            costUsd: job.error ? 0 : job.costUsd,
            usage: job.usage as object | undefined,
            url: job.url,
            error: job.error?.slice(0, 2000),
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            durationMs: job.finishedAt.getTime() - job.startedAt.getTime(),
          },
        });
        return;
      } catch (e) {
        if (attempt === 4) this.logger.warn(`No se pudo anotar el trabajo ${job.kind} ${job.target}: ${(e as Error).message}`);
        else await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
}
