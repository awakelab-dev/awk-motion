import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthUser } from '@wilox/shared';
import { env } from '../config/env.js';
import { readCookie } from './auth.guard.js';
import { AuthService, SESSION_COOKIE } from './auth.service.js';
import { CurrentUser, Public } from './decorators.js';

const LoginSchema = z.object({ email: z.string().trim().min(3).max(200), password: z.string().min(1).max(500) });
const PasswordSchema = z.object({ current: z.string().min(1).max(500), next: z.string().min(1).max(500) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new BadRequestException('Datos incompletos.');
  return r.data;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private setCookie(res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.COOKIE_SECURE,
      path: '/',
      maxAge: env.SESSION_DAYS * 86_400_000,
    });
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<AuthUser> {
    const { email, password } = parse(LoginSchema, body);
    const { token, user } = await this.auth.login(email, password, { ip: req.ip, userAgent: req.headers['user-agent'] });
    this.setCookie(res, token);
    return user;
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await this.auth.logout(token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  /** Cambiar la contraseña propia: exige la actual y cierra las demás sesiones. */
  @Post('password')
  @HttpCode(200)
  async password(@CurrentUser() user: AuthUser, @Body() body: unknown, @Req() req: Request) {
    const { current, next } = parse(PasswordSchema, body);
    await this.auth.changePassword(user.id, current, next, readCookie(req, SESSION_COOKIE) ?? '');
    return { ok: true };
  }
}
