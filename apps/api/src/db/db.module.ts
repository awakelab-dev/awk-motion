import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Db } from '@wilox/db';
import { env } from '../config/env.js';

/** Token de inyección del cliente de Prisma: `@Inject(DB) private readonly db: Db`. */
export const DB = Symbol('DB');

@Injectable()
class DbLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}
  async onApplicationShutdown() {
    await this.db.$disconnect();
  }
}

@Global()
@Module({
  providers: [{ provide: DB, useFactory: () => createDb(env.DATABASE_URL) }, DbLifecycle],
  exports: [DB],
})
export class DbModule {}
