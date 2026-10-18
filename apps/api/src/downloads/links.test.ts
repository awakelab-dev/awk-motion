import { describe, expect, it } from 'vitest';
import { linkExpiry, linkPageHtml, retentionOf } from './links.js';

const DAY = 86_400_000;

describe('links de descarga (T5, ADR-111)', () => {
  const done = new Date('2026-10-12T12:00:00Z');
  it('sin links: 30 días; con links: hasta el último que vence; sin caducidad: nunca', () => {
    expect(retentionOf(done, [])?.getTime()).toBe(done.getTime() + 30 * DAY);
    expect(retentionOf(done, [{ expiresAt: new Date(done.getTime() + 7 * DAY) }])?.getTime()).toBe(done.getTime() + 30 * DAY);
    expect(retentionOf(done, [{ expiresAt: new Date(done.getTime() + 45 * DAY) }])?.getTime()).toBe(done.getTime() + 45 * DAY);
    expect(retentionOf(done, [{ expiresAt: new Date(done.getTime() + 7 * DAY) }, { expiresAt: null }])).toBeNull();
  });
  it('caducidad del link: 7 o 30 días desde hoy, o ninguna', () => {
    expect(linkExpiry(7, done)?.getTime()).toBe(done.getTime() + 7 * DAY);
    expect(linkExpiry(null, done)).toBeNull();
  });
  it('página pública: lista, preparándose (se recarga sola) o no disponible', () => {
    const ready = linkPageHtml({ state: 'ready', projectName: 'Curso <A>', videoTitle: 'Higiene', format: 'SCORM 1.2', fileName: 'Curso_A_x_scorm12.zip', bytes: 131855, fileUrl: 'tok/archivo', expiresAt: new Date('2026-11-11T12:00:00Z') });
    expect(ready).toContain('Curso &lt;A&gt;');
    expect(ready).toContain('href="tok/archivo"');
    expect(ready).toContain('132 KB');
    expect(ready).toContain('Disponible hasta el 11-11-2026');
    expect(ready).toContain('noindex');
    expect(linkPageHtml({ state: 'preparing', projectName: 'P' })).toContain('http-equiv="refresh"');
    expect(linkPageHtml({ state: 'gone' })).toContain('ya no está disponible');
  });
});
