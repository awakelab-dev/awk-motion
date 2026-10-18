import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser, UserRole } from '@wilox/shared';

export const IS_PUBLIC = 'wilox:public';
export const ROLES = 'wilox:roles';

/** La ruta no exige sesión. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** La ruta exige uno de estos roles (además de la sesión). */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES, roles);

/** Usuario de la sesión (lo deja el AuthGuard en req.user). */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
  if (!req.user) throw new Error('CurrentUser en una ruta sin sesión (@Public).');
  return req.user;
});
