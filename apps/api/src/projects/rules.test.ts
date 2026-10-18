import { describe, expect, it } from 'vitest';
import { reservedNameProblem, sortProjects, systemProjectProblem } from './rules.js';

describe('"Sin clasificar" (hito 4, ADR-035)', () => {
  it('no se puede eliminar, renombrar ni archivar', () => {
    expect(systemProjectProblem('unclassified', 'delete')).toMatch(/no se puede eliminar/);
    expect(systemProjectProblem('unclassified', 'update', { name: 'Otro' })).toMatch(/renombrar/);
    expect(systemProjectProblem('unclassified', 'update', { archived: true })).toMatch(/archivar/);
    expect(systemProjectProblem('unclassified', 'update', { archived: false })).toMatch(/archivar/);
  });

  it('la descripción sí se puede cambiar', () => {
    expect(systemProjectProblem('unclassified', 'update', { description: 'Pendientes' })).toBeUndefined();
  });

  it('un proyecto normal no tiene restricciones', () => {
    expect(systemProjectProblem(null, 'delete')).toBeUndefined();
    expect(systemProjectProblem(null, 'update', { name: 'Curso IAAS', archived: true })).toBeUndefined();
  });

  it('el nombre queda reservado (sin importar tildes, mayúsculas ni espacios)', () => {
    expect(reservedNameProblem('Sin clasificar')).toBeDefined();
    expect(reservedNameProblem('  SIN   Clasificár ')).toBeDefined();
    expect(reservedNameProblem('Sin clasificar 2')).toBeUndefined();
    expect(reservedNameProblem('Curso IAAS')).toBeUndefined();
  });

  it('va primero y el resto se ordena por el último video o la creación', () => {
    const list = [
      { id: 'a', unclassified: false, createdAt: '2026-09-20T10:00:00Z', lastVideoAt: '2026-09-21T10:00:00Z' },
      { id: 'b', unclassified: false, createdAt: '2026-09-26T10:00:00Z' },
      { id: 'sc', unclassified: true, createdAt: '2026-09-27T10:00:00Z' },
      { id: 'c', unclassified: false, createdAt: '2026-09-10T10:00:00Z', lastVideoAt: '2026-09-27T09:00:00Z' },
    ];
    expect(sortProjects(list).map((p) => p.id)).toEqual(['sc', 'c', 'b', 'a']);
  });
});
