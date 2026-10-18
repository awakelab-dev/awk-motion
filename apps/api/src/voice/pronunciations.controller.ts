import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Db } from '@wilox/db';
import type { AuthUser, PronunciationRuleInfo } from '@wilox/shared';
import { CurrentUser } from '../auth/decorators.js';
import { DB } from '../db/db.module.js';

const RuleSchema = z.object({
  match: z.string().trim().min(1, 'Escribe la palabra o frase.').max(120),
  say: z.string().trim().min(1, 'Escribe cómo debe decirse.').max(300),
});

type Row = { id: string; match: string; say: string; note: string | null; createdAt: Date };
const info = (r: Row): PronunciationRuleInfo => ({ id: r.id, match: r.match, say: r.say, note: r.note ?? undefined, createdAt: r.createdAt.toISOString() });

/** Mis reglas de pronunciación (hito 5, ADR-048): se aplican al texto que recibe la voz en todos mis videos. */
@Controller('pronunciations')
export class PronunciationsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<PronunciationRuleInfo[]> {
    return (await this.db.pronunciationRule.findMany({ where: { ownerId: user.id }, orderBy: { match: 'asc' } })).map(info);
  }

  @Post()
  async create(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<PronunciationRuleInfo> {
    const r = RuleSchema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join(' '));
    const { match, say } = r.data;
    return info(
      await this.db.pronunciationRule.upsert({
        where: { ownerId_match: { ownerId: user.id, match } },
        create: { ownerId: user.id, match, say },
        update: { say },
      }),
    );
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthUser): Promise<PronunciationRuleInfo> {
    const r = RuleSchema.partial().safeParse(body ?? {});
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join(' '));
    if (!(await this.db.pronunciationRule.findFirst({ where: { id, ownerId: user.id } }))) throw new NotFoundException('Regla no encontrada.');
    return info(await this.db.pronunciationRule.update({ where: { id }, data: r.data }));
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const r = await this.db.pronunciationRule.deleteMany({ where: { id, ownerId: user.id } });
    if (!r.count) throw new NotFoundException('Regla no encontrada.');
    return { ok: true };
  }
}
