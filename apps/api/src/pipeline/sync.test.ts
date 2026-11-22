import { describe, expect, it } from 'vitest';
import { normWord, syncAnchors } from './sync.js';

const W = (text: string, paragraph = 0) => text.split(' ').map((word) => ({ word, paragraph }));

describe('palabra clave al inicio del clip (hito 13a, T5, ADR-181)', () => {
  it('normaliza tildes, mayúsculas y signos', () => {
    expect(normWord('Pétalos,')).toBe('petalos');
    expect(normWord('«AGUA»')).toBe('agua');
  });

  it('mueve el ancla a la primera palabra de la frase clave', () => {
    const words = W('El agua es vital. Las gotas caen sobre los pétalos de las flores y alimentan los ríos del valle.');
    // Opus ancló el plano 2 en «pétalos» (10) pero su frase clave es «las gotas caen» (4).
    const r = syncAnchors(words, [
      { anchorWordIndex: 0, pfc: 'agua' },
      { anchorWordIndex: 9, pfc: 'Las gotas caen' },
    ]);
    expect(r.anchors).toEqual([0, 4]);
    expect(r.moved).toEqual([{ shot: 1, from: 9, to: 4, by: 'pfc' }]);
  });

  it('no mueve un ancla que ya está bien, ni el primer plano de un párrafo', () => {
    const words = [...W('Primer párrafo con su idea principal.'), ...W('Segundo párrafo habla de los ríos.', 1)];
    const r = syncAnchors(words, [
      { anchorWordIndex: 0, pfc: 'primer párrafo' },
      { anchorWordIndex: 6, pfc: 'los ríos' },
    ]);
    expect(r.anchors).toEqual([0, 6]);
    expect(r.moved).toEqual([]);
  });

  it('si la frase clave no es literal, usa el comienzo de un texto en pantalla', () => {
    const words = W('Hoy veremos cómo cuidar el agua en casa con pequeñas acciones diarias para todos.');
    const r = syncAnchors(words, [
      { anchorWordIndex: 0, pfc: 'hoy' },
      { anchorWordIndex: 11, pfc: 'Ahorro doméstico', keyframe: { texts: ['PEQUEÑAS ACCIONES / diarias'] } },
    ]);
    expect(r.anchors).toEqual([0, 9]);
    expect(r.moved[0].by).toBe('texto');
  });

  it('no cruza el ancla del plano anterior ni la del siguiente', () => {
    const words = W('agua uno dos tres agua cuatro cinco seis siete agua ocho');
    const r = syncAnchors(words, [
      { anchorWordIndex: 0, pfc: 'inicio' },
      { anchorWordIndex: 5, pfc: 'agua' },
      { anchorWordIndex: 8, pfc: 'siete' },
    ]);
    // «agua» más cercana a 5 dentro de (0, 8): la 4.
    expect(r.anchors).toEqual([0, 4, 8]);
  });

  it('sin coincidencias, deja el ancla de Opus', () => {
    const words = W('una frase sin relación con la palabra clave del plano');
    expect(syncAnchors(words, [{ anchorWordIndex: 0, pfc: 'x' }, { anchorWordIndex: 5, pfc: 'Fotosíntesis' }]).anchors).toEqual([0, 5]);
  });
});
