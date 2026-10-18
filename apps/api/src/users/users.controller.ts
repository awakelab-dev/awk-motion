import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ensureUnclassified, hashPassword, passwordProblem, type Db, type User } from '@wilox/db';
import type { AuthUser, UserSummary, UserTransferResponse } from '@wilox/shared';
import { AuthService } from '../auth/auth.service.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { DB } from '../db/db.module.js';
import { OwnershipService } from '../access/ownership.service.js';
import { creditUsd } from '../projects/history.service.js';

const Email = z.string().trim().toLowerCase().pipe(z.email('Email no válido.'));
const CreateSchema = z.object({
  email: Email,
  name: z.string().trim().max(80).optional(),
  password: z.string().max(500),
  role: z.enum(['admin', 'user']).default('user'),
});
const PatchSchema = z.object({
  name: z.string().trim().max(80).nullable().optional(),
  role: z.enum(['admin', 'user']).optional(),
  active: z.boolean().optional(),
});
const ResetSchema = z.object({ password: z.string().max(500) });
const TransferSchema = z.object({ toUserId: z.string().uuid() });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join(' '));
  return r.data;
}

function checkPassword(p: string) {
  const problem = passwordProblem(p);
  if (problem) throw new BadRequestException(problem);
}

/**
 * Gestión simple de usuarios (hito 3, ADR-028): solo el admin. Sin registro público ni recuperación por email.
 * El admin no puede quitarse a sí mismo el rol ni desactivarse (para no quedarse fuera).
 * Hito 11 (ADR-142): suspender (`active = false`, sin eliminar) y pasar sus proyectos a otro usuario.
 */
@Controller('users')
@Roles('admin')
export class UsersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auth: AuthService,
    private readonly ownership: OwnershipService,
  ) {}

  private async summaries(where?: { id: string }): Promise<UserSummary[]> {
    const users = await this.db.user.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { generations: true, themes: { where: { deletedAt: null } }, projects: { where: { deletedAt: null, system: null } } } } },
    });
    // USD de sus trabajos (hito 11, ADR-145, sin créditos): los de Higgsfield sin USD anotado, por sus créditos a la tarifa del plan.
    const costs = await this.db.$queryRaw<{ ownerId: string; usd: number | null }[]>`
      SELECT "ownerId"::text AS "ownerId",
             sum(CASE WHEN "costUsd" > 0 THEN "costUsd"::float8 ELSE coalesce(credits, 0) * ${creditUsd()} END) AS usd
      FROM "GenerationJob" GROUP BY 1`;
    const byOwner = new Map(costs.map((c) => [c.ownerId, c.usd ?? 0]));
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      active: u.active,
      createdAt: u.createdAt.toISOString(),
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      generations: u._count.generations,
      projects: u._count.projects,
      themes: u._count.themes,
      costUsd: Math.round((byOwner.get(u.id) ?? 0) * 1e4) / 1e4,
    }));
  }

  private async one(id: string): Promise<UserSummary> {
    const [s] = await this.summaries({ id });
    if (!s) throw new NotFoundException('Usuario no encontrado.');
    return s;
  }

  private async user(id: string): Promise<User> {
    const u = /^[0-9a-f-]{36}$/i.test(id) ? await this.db.user.findUnique({ where: { id } }) : null;
    if (!u) throw new NotFoundException('Usuario no encontrado.');
    return u;
  }

  @Get()
  list(): Promise<UserSummary[]> {
    return this.summaries();
  }

  @Post()
  async create(@Body() body: unknown): Promise<UserSummary> {
    const { email, name, password, role } = parse(CreateSchema, body);
    checkPassword(password);
    if (await this.db.user.findUnique({ where: { email } })) throw new ConflictException(`Ya existe un usuario con el email ${email}.`);
    const u = await this.db.user.create({ data: { email, name: name || null, role, passwordHash: await hashPassword(password) } });
    await ensureUnclassified(this.db, u.id); // hito 4 (ADR-035): todo usuario tiene su "Sin clasificar"
    return this.one(u.id);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() me: AuthUser): Promise<UserSummary> {
    const patch = parse(PatchSchema, body);
    const u = await this.user(id);
    if (u.id === me.id && (patch.active === false || patch.role === 'user')) {
      throw new BadRequestException('No puedes desactivarte ni quitarte el rol de administrador a ti mismo.');
    }
    await this.db.user.update({ where: { id }, data: patch });
    if (patch.active === false) await this.auth.revokeSessions(id);
    else this.auth.forgetUser(id);
    return this.one(id);
  }

  /**
   * «Pasar sus proyectos a…» (hito 11, ADR-142): todos los proyectos del usuario (p. ej. suspendido) pasan a otro usuario
   * activo o al propio admin; los videos de su «Sin clasificar», a un proyecto nuevo «Sin clasificar de <nombre>».
   */
  @Post(':id/transfer')
  @HttpCode(200)
  async transfer(@Param('id') id: string, @Body() body: unknown): Promise<UserTransferResponse> {
    const { toUserId } = parse(TransferSchema, body);
    return this.ownership.transferAll(id, toUserId);
  }

  /** Nueva contraseña fijada por el admin: cierra todas las sesiones de ese usuario. */
  @Post(':id/password')
  @HttpCode(200)
  async resetPassword(@Param('id') id: string, @Body() body: unknown, @CurrentUser() me: AuthUser): Promise<UserSummary> {
    const { password } = parse(ResetSchema, body);
    const u = await this.user(id);
    if (u.id === me.id) throw new BadRequestException('Para tu propia contraseña usa "Mi cuenta".');
    checkPassword(password);
    await this.db.user.update({ where: { id }, data: { passwordHash: await hashPassword(password) } });
    await this.auth.revokeSessions(id);
    return this.one(id);
  }
}
