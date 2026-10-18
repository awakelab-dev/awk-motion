import { Controller, Get, Inject, Optional, Query, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import type { AppInfo, AuthUser, VoiceOption } from '@wilox/shared';
import { CurrentUser, Public, Roles } from './auth/decorators.js';
import { env } from './config/env.js';
import { HIGGSFIELD } from './providers/providers.module.js';
import type { HiggsfieldClient } from './providers/mcp/higgsfield-client.js';
import { PROVIDERS, type Providers } from './providers/ports.js';
import { ThemeStore } from './themes/theme-store.js';

@Controller()
export class AppController {
  private voices?: { at: number; list: VoiceOption[] };

  constructor(
    @Inject(PROVIDERS) private readonly providers: Providers,
    private readonly themes: ThemeStore,
    @Optional() @Inject(HIGGSFIELD) private readonly hf: HiggsfieldClient | null,
  ) {}

  @Get('info')
  async info(@CurrentUser() user: AuthUser): Promise<AppInfo> {
    let higgsfield: AppInfo['higgsfield'];
    if (this.hf) {
      await this.hf.connect().catch(() => undefined);
      higgsfield = this.hf.status();
    }
    return { mode: this.providers.mode, themes: this.themes.composerList(user.id), defaultVoiceId: this.providers.defaultVoiceId(), higgsfield };
  }

  @Get('voices')
  async listVoices(@Query('refresh') refresh?: string): Promise<VoiceOption[]> {
    if (this.voices && !refresh && Date.now() - this.voices.at < 10 * 60_000) return this.voices.list;
    try {
      const list = await this.providers.tts.listVoices();
      this.voices = { at: Date.now(), list };
      return list;
    } catch (e) {
      throw new ServiceUnavailableException(`No se pudieron listar las voces: ${(e as Error).message}`);
    }
  }

  /** Paso del OAuth de Higgsfield: devuelve la URL de autorización o confirma la conexión. La cuenta es de todos: solo el admin la conecta. */
  @Roles('admin')
  @Get('auth/higgsfield/start')
  async start() {
    if (!this.hf) return { connected: false, error: 'GENERATION_MODE no es mcp.' };
    await this.hf.connect().catch(() => undefined);
    return this.hf.status();
  }

  /** Vuelta del OAuth (redirección desde Higgsfield). El código solo vale con el verificador PKCE que guarda la API. */
  @Public()
  @Get('auth/higgsfield/callback')
  async callback(@Query('code') code: string | undefined, @Query('error') error: string | undefined, @Res() res: Response) {
    const back = new URL(env.WEB_ORIGIN);
    if (!this.hf || !code) {
      back.searchParams.set('higgsfield', `error:${error ?? 'sin código'}`);
      return res.redirect(back.toString());
    }
    try {
      await this.hf.finishAuth(code);
      back.searchParams.set('higgsfield', 'ok');
    } catch (e) {
      back.searchParams.set('higgsfield', `error:${(e as Error).message.slice(0, 200)}`);
    }
    res.redirect(back.toString());
  }
}
