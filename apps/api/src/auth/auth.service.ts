import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { hashPassword, passwordProblem, verifyPassword, type Db, type User } from '@wilox/db';
import type { AuthUser } from '@wilox/shared';
import { env } from '../config/env.js';
import { DB } from '../db/db.module.js';

export const SESSION_COOKIE = 'wilox_session';

const DAY = 86_400_000;
/** Cuánto se guarda en memoria la validación de una sesión (evita una consulta por cada imagen). */
const CACHE_MS = 30_000;
/** Cada cuánto se actualiza lastSeenAt / se alarga la sesión. */
const TOUCH_MS = 5 * 60_000;
/** Intentos fallidos permitidos por email + IP en la ventana. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function toAuthUser(u: Pick<User, 'id' | 'email' | 'name' | 'role'>): AuthUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

interface Cached {
  user: AuthUser;
  sessionId: string;
  checkedAt: number;
  touchedAt: number;
}

/**
 * Sesiones con cookie httpOnly (hito 3, ADR-028). El token es aleatorio (32 bytes) y en la BD solo
 * se guarda su sha256. Contraseñas con argon2id (@wilox/db).
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');
  private readonly cache = new Map<string, Cached>();
  private readonly failures = new Map<string, { n: number; first: number }>();
  /** Hash de relleno: con un email inexistente se verifica igual, para no revelar qué emails existen por el tiempo. */
  private readonly dummyHash = hashPassword(randomBytes(16).toString('hex'));

  constructor(@Inject(DB) private readonly db: Db) {}

  normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private checkRate(key: string) {
    const f = this.failures.get(key);
    if (!f) return;
    if (Date.now() - f.first > FAILURE_WINDOW_MS) this.failures.delete(key);
    else if (f.n >= MAX_FAILURES) throw new HttpException('Demasiados intentos fallidos. Espera unos minutos.', HttpStatus.TOO_MANY_REQUESTS);
  }

  private fail(key: string) {
    const f = this.failures.get(key);
    if (!f || Date.now() - f.first > FAILURE_WINDOW_MS) this.failures.set(key, { n: 1, first: Date.now() });
    else f.n += 1;
  }

  async login(emailRaw: string, password: string, meta: { ip?: string; userAgent?: string }): Promise<{ token: string; user: AuthUser }> {
    const email = this.normalizeEmail(emailRaw);
    const key = `${email}|${meta.ip ?? ''}`;
    this.checkRate(key);
    const user = await this.db.user.findUnique({ where: { email } });
    const ok = user ? await verifyPassword(user.passwordHash, password) : (await verifyPassword(await this.dummyHash, password), false);
    if (!user || !ok) {
      this.fail(key);
      throw new UnauthorizedException('Email o contraseña incorrectos.');
    }
    if (!user.active) throw new UnauthorizedException('Tu usuario está desactivado. Habla con el administrador.');
    this.failures.delete(key);

    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await this.db.$transaction([
      this.db.session.deleteMany({ where: { userId: user.id, expiresAt: { lt: now } } }),
      this.db.session.create({
        data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(now.getTime() + env.SESSION_DAYS * DAY), userAgent: meta.userAgent?.slice(0, 300) },
      }),
      this.db.user.update({ where: { id: user.id }, data: { lastLoginAt: now } }),
    ]);
    this.logger.log(`Sesión iniciada: ${email}`);
    return { token, user: toAuthUser(user) };
  }

  /** Usuario de un token de sesión, o undefined si no vale (caducada, borrada o usuario desactivado). */
  async validate(token: string): Promise<AuthUser | undefined> {
    const hash = sha256(token);
    const now = Date.now();
    const c = this.cache.get(hash);
    if (c && now - c.checkedAt < CACHE_MS) return c.user;

    const s = await this.db.session.findUnique({ where: { tokenHash: hash }, include: { user: true } });
    if (!s || s.expiresAt.getTime() <= now || !s.user.active) {
      this.cache.delete(hash);
      if (s) await this.db.session.delete({ where: { id: s.id } }).catch(() => undefined);
      return undefined;
    }
    const user = toAuthUser(s.user);
    const touchedAt = c?.touchedAt ?? s.lastSeenAt.getTime();
    if (now - touchedAt > TOUCH_MS) {
      // Sesión deslizante: cada uso la alarga hasta SESSION_DAYS.
      await this.db.session
        .update({ where: { id: s.id }, data: { lastSeenAt: new Date(now), expiresAt: new Date(now + env.SESSION_DAYS * DAY) } })
        .catch(() => undefined);
    }
    this.cache.set(hash, { user, sessionId: s.id, checkedAt: now, touchedAt: now - touchedAt > TOUCH_MS ? now : touchedAt });
    return user;
  }

  async logout(token: string) {
    const hash = sha256(token);
    this.cache.delete(hash);
    await this.db.session.deleteMany({ where: { tokenHash: hash } });
  }

  /** Cierra todas las sesiones de un usuario (menos la indicada, si se da). */
  async revokeSessions(userId: string, exceptToken?: string) {
    const keep = exceptToken ? sha256(exceptToken) : undefined;
    await this.db.session.deleteMany({ where: { userId, ...(keep ? { tokenHash: { not: keep } } : {}) } });
    for (const [h, c] of this.cache) if (c.user.id === userId && h !== keep) this.cache.delete(h);
  }

  /** Olvida la caché de un usuario (cambió su rol o su nombre). */
  forgetUser(userId: string) {
    for (const [h, c] of this.cache) if (c.user.id === userId) this.cache.delete(h);
  }

  async changePassword(userId: string, current: string, next: string, currentToken: string) {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    // 400 y no 401: un 401 hace que la web cierre la sesión.
    if (!(await verifyPassword(user.passwordHash, current))) throw new BadRequestException('La contraseña actual no es correcta.');
    const problem = passwordProblem(next);
    if (problem) throw new BadRequestException(problem);
    if (next === current) throw new BadRequestException('La contraseña nueva es igual a la actual.');
    await this.db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(next) } });
    await this.revokeSessions(userId, currentToken);
  }
}
