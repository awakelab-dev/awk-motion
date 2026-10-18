import { ForbiddenException, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthUser, UserRole } from '@wilox/shared';
import { env } from '../config/env.js';
import { AuthService, SESSION_COOKIE } from './auth.service.js';
import { AccessService } from '../access/access.service.js';
import { routeScope } from '../access/route-scope.js';
import { IS_PUBLIC, ROLES } from './decorators.js';

/** Lee una cookie de la cabecera (sin cookie-parser). */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

/** Orígenes válidos para peticiones que cambian algo: la web (y sus alias, ADR-151) y la propia API, en localhost o 127.0.0.1. */
export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // mismo origen sin cabecera (curl, navegación)
  if (origin === env.WEB_ORIGIN || env.WEB_ORIGIN_ALIASES.includes(origin)) return true; // alias: ADR-151
  try {
    const o = new URL(origin);
    const web = new URL(env.WEB_ORIGIN);
    if (!LOCAL_HOSTS.includes(o.hostname)) return false;
    return o.port === web.port || o.port === String(env.PORT);
  } catch {
    return false;
  }
}

/**
 * Guard global (hito 3, ADR-028): toda ruta exige sesión salvo @Public(); @Roles('admin') limita por rol.
 * Las peticiones que cambian algo (no GET) deben venir de la web: control de Origin contra CSRF,
 * además de la cookie SameSite=Lax.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly access: AccessService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req.headers.origin)) {
      throw new ForbiddenException('Origen no permitido.');
    }
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const token = readCookie(req, SESSION_COOKIE);
    const user = token ? await this.auth.validate(token) : undefined;
    if (!user) throw new UnauthorizedException('Inicia sesión para continuar.');
    req.user = user;

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES, targets);
    if (roles && !roles.includes(user.role)) throw new ForbiddenException('Solo para administradores.');
    // Hito 11 (ADR-142): projects/:id… y generations/:id… exigen acceso al proyecto (404 si no lo ve). Un video en la
    // papelera sigue llegando a su controlador, que decide (su miniatura y su ficha se ven desde la papelera).
    const scope = routeScope((req as Request & { route?: { path?: string } }).route?.path, req.params as Record<string, string>);
    if (scope?.kind === 'project') await this.access.project(scope.id, user, { trashed: scope.trashed });
    else if (scope?.kind === 'generation') await this.access.generation(scope.id, user, { trashed: true });
    return true;
  }
}
