import { describe, expect, it } from 'vitest';
import { routeScope } from './route-scope.js';

describe('routeScope (hito 11)', () => {
  it('protege projects/:id y generations/:id con sus subrutas', () => {
    expect(routeScope('/api/projects/:id', { id: 'p' })).toEqual({ kind: 'project', id: 'p' });
    expect(routeScope('/api/projects/:id/revoice', { id: 'p' })).toEqual({ kind: 'project', id: 'p' });
    expect(routeScope('/api/generations/:id/clips/:index/split', { id: 'g', index: '2' })).toEqual({ kind: 'generation', id: 'g' });
    expect(routeScope('/api/generations/:id/files/*path', { id: 'g' })).toEqual({ kind: 'generation', id: 'g' });
    expect(routeScope('/api/projects/:id/owner', { id: 'p' })).toEqual({ kind: 'project', id: 'p', trashed: true });
  });
  it('no toca las demás rutas', () => {
    expect(routeScope('/api/projects', {})).toBeUndefined();
    expect(routeScope('/api/publications/:id', { id: 'x' })).toBeUndefined();
    expect(routeScope('/api/download-batches/:id', { id: 'x' })).toBeUndefined();
    expect(routeScope('/api/trash/:kind/:id/restore', { kind: 'video', id: 'x' })).toBeUndefined();
    expect(routeScope('/api/proyecto/:token/v/:id/revision', { token: 't', id: 'x' })).toBeUndefined();
    expect(routeScope('/api/projectsx/:id', { id: 'x' })).toBeUndefined();
  });
});
