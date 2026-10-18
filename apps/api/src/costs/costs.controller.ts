import { Controller, Get, Inject } from '@nestjs/common';
import type { Db } from '@wilox/db';
import type { CostUnit, CostUnits } from '@wilox/shared';
import { DB } from '../db/db.module.js';
import { PROVIDERS, type Providers } from '../providers/ports.js';

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Costos unitarios para los avisos antes de gastar (hito 6, ADR-069): el promedio en USD de los trabajos reales en modo
 * API de los últimos 90 días (todos los usuarios: los precios son los mismos). Hito 11 (ADR-145): sin créditos, también
 * en modo MCP (que queda sin estimación propia y muestra lo de API). En MOCK no se gasta nada.
 */
@Controller('costs')
export class CostsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PROVIDERS) private readonly providers: Providers,
  ) {}

  @Get('units')
  async units(): Promise<CostUnits> {
    const mode = this.providers.mode;
    if (mode === 'mock') return { mode };
    const rows = await this.db.$queryRaw<{ kind: string; n: bigint; usd: number | null; chars: number | null }[]>`
      SELECT kind::text AS kind, count(*) AS n, sum("costUsd")::float8 AS usd,
             sum(CASE WHEN usage ? 'characters' THEN (usage->>'characters')::float8 END) AS chars
      FROM "GenerationJob"
      WHERE status = 'succeeded' AND "costUsd" IS NOT NULL AND "costUsd" > 0 AND provider NOT IN ('mock', 'higgsfield')
        AND "startedAt" > now() - interval '90 days'
      GROUP BY kind`;
    const avg = (kind: string): CostUnit | undefined => {
      const r = rows.find((x) => x.kind === kind);
      return r && r.usd ? { usd: round(r.usd / Number(r.n)), samples: Number(r.n) } : undefined;
    };
    const tts = rows.find((x) => x.kind === 'tts');
    return {
      mode,
      llm: avg('llm'),
      image: avg('image'),
      clip: avg('video'),
      tts1k: tts?.usd && tts.chars ? { usd: round((tts.usd / tts.chars) * 1000), samples: Number(tts.n) } : undefined,
    };
  }
}
