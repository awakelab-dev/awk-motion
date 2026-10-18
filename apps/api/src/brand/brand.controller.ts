import { Controller, Get, Header, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Brand } from '@wilox/shared';
import { Public } from '../auth/decorators.js';
import { brand, brandScript, loaded } from './brand.js';

/** Marca de la instalación (hito 12, ADR-150). Pública: la web la necesita antes del inicio de sesión. */
@Controller()
export class BrandController {
  @Public()
  @Get('brand')
  @Header('cache-control', 'no-cache')
  get(): Brand {
    return brand;
  }

  /** La web lo carga en el `<head>` (`<script src="/api/brand.js">`). */
  @Public()
  @Get('brand.js')
  @Header('content-type', 'text/javascript; charset=utf-8')
  @Header('cache-control', 'no-cache')
  script(): string {
    return brandScript();
  }

  /** Logo, isotipo o favicon de la carpeta de la marca (solo los que nombra su brand.json). */
  @Public()
  @Get('brand/files/:name')
  @Header('cache-control', 'public, max-age=3600')
  file(@Param('name') name: string, @Res() res: Response) {
    const abs = loaded.files.get(name);
    if (!abs) throw new NotFoundException();
    res.sendFile(abs);
  }
}
