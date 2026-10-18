import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { env } from '../config/env.js';
import { originAllowed, readCookie } from './auth.guard.js';

describe('auth', () => {
  it('lee la cookie de sesión', () => {
    const req = { headers: { cookie: 'a=1; wilox_session=abc%3D; b=2' } } as unknown as Request;
    expect(readCookie(req, 'wilox_session')).toBe('abc=');
    expect(readCookie(req, 'otra')).toBeUndefined();
    expect(readCookie({ headers: {} } as Request, 'wilox_session')).toBeUndefined();
  });
  it('solo acepta peticiones de la web local', () => {
    expect(originAllowed(undefined)).toBe(true);
    expect(originAllowed('http://localhost:5173')).toBe(true);
    expect(originAllowed('http://127.0.0.1:5173')).toBe(true);
    expect(originAllowed('http://localhost:3001')).toBe(true);
    expect(originAllowed('http://evil.com')).toBe(false);
    expect(originAllowed('http://localhost:8080')).toBe(false);
    expect(originAllowed('null')).toBe(false);
  });
  it('acepta los alias de WEB_ORIGIN (transición de dominios, ADR-151)', () => {
    const before = env.WEB_ORIGIN_ALIASES;
    try {
      env.WEB_ORIGIN_ALIASES = ['https://motion.wiloxagency.com'];
      expect(originAllowed('https://motion.wiloxagency.com')).toBe(true);
      expect(originAllowed('https://otro.example.com')).toBe(false);
      expect(originAllowed('https://motion.wiloxagency.com.evil.com')).toBe(false);
    } finally {
      env.WEB_ORIGIN_ALIASES = before;
    }
  });
});
