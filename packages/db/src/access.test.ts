import { describe, expect, it } from 'vitest';
import { projectRole, visibleProjects } from './access.js';

const A = { id: 'a', role: 'user' as const };
const ADMIN = { id: 'z', role: 'admin' as const };
const p = (o: Partial<{ ownerId: string; publicAt: Date | null; system: string | null }> = {}) => ({ ownerId: 'a', publicAt: null, system: null, ...o });

describe('papel en un proyecto (hito 11, ADR-142)', () => {
  it('el dueño manda sobre todo', () => {
    expect(projectRole(p(), A, true)).toBe('owner');
    expect(projectRole(p({ ownerId: 'z' }), ADMIN, false)).toBe('owner');
  });
  it('compartido, público o nada', () => {
    const B = { id: 'b', role: 'user' as const };
    expect(projectRole(p(), B, true)).toBe('shared');
    expect(projectRole(p({ publicAt: new Date() }), B, false)).toBe('public');
    expect(projectRole(p(), B, false)).toBeNull();
  });
  it('«Sin clasificar» nunca es público', () => {
    expect(projectRole(p({ publicAt: new Date(), system: 'unclassified' }), { id: 'b', role: 'user' }, false)).toBeNull();
  });
  it('el admin ve los de todos', () => {
    expect(projectRole(p(), ADMIN, false)).toBe('admin');
  });
  it('filtros de las listas', () => {
    expect(visibleProjects(A)).toHaveProperty('OR');
    expect(visibleProjects(A, true)).toHaveProperty('OR'); // ?all=1 no sirve a un usuario normal
    expect(visibleProjects(ADMIN, true)).toEqual({});
  });
});
