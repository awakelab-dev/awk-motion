import { describe, expect, it } from 'vitest';
import { EnvSchema } from './env.js';

const base = { DATABASE_URL: 'postgresql://x@localhost/x', GENERATION_MODE: 'mock' };
const s3 = { MEDIA_DRIVER: 's3', AWS_REGION: 'eu-west-3', AWS_S3_BUCKET: 'b' };
const issues = (e: Record<string, string>) => {
  const r = EnvSchema.safeParse({ ...base, ...e });
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('configuración de las dos instalaciones (ADR-151)', () => {
  it('wilox-motion/prod/ solo con BRAND=awakelab (la instalación de Awakelab)', () => {
    expect(issues({ ...s3, MEDIA_ENV: 'prod' }).join()).toMatch(/MEDIA_ROOT: .*Awakelab/);
    expect(issues({ ...s3, MEDIA_ENV: 'prod', BRAND: 'otra' }).join()).toMatch(/MEDIA_ROOT/);
    expect(issues({ ...s3, MEDIA_ENV: 'prod', BRAND: 'awakelab' })).toEqual([]);
    expect(issues({ ...s3, MEDIA_ENV: 'prod', MEDIA_ROOT: 'otra-app' })).toEqual([]);
    // En el Mac (sin remoto) o en otro entorno, nada que proteger.
    expect(issues({ MEDIA_ENV: 'prod' })).toEqual([]);
    expect(issues({ ...s3, MEDIA_ENV: 'dev' })).toEqual([]);
  });

  it('MEDIA_ROOT por defecto, el de hoy; nada de rutas raras', () => {
    const r = EnvSchema.parse(base);
    expect(r.MEDIA_ROOT).toBe('wilox-motion');
    expect(issues({ MEDIA_ROOT: '../otro' }).join()).toMatch(/MEDIA_ROOT/);
    expect(issues({ MEDIA_ROOT: 'wilox-motion/prod' }).join()).toMatch(/MEDIA_ROOT/);
  });

  it('WEB_ORIGIN_ALIASES: lista de orígenes', () => {
    expect(EnvSchema.parse(base).WEB_ORIGIN_ALIASES).toEqual([]);
    expect(EnvSchema.parse({ ...base, WEB_ORIGIN_ALIASES: ' https://motion.wiloxagency.com/ , https://otro.cl ' }).WEB_ORIGIN_ALIASES).toEqual([
      'https://motion.wiloxagency.com',
      'https://otro.cl',
    ]);
    expect(issues({ WEB_ORIGIN_ALIASES: 'https://motion.wiloxagency.com/api' }).join()).toMatch(/WEB_ORIGIN_ALIASES/);
  });

  it('BRAND vacío = neutra', () => {
    expect(EnvSchema.parse({ ...base, BRAND: '' }).BRAND).toBeUndefined();
    expect(issues({ BRAND: '../x' }).join()).toMatch(/BRAND/);
  });
});
