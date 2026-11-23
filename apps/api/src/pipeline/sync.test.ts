import { describe, expect, it } from 'vitest';
import { firstSaid, normWord, syncAnchors, textTokens } from './sync.js';

const W = (text: string, paragraph = 0) => text.split(' ').map((word) => ({ word, paragraph }));

describe('el clip empieza con el primer texto en pantalla que dice la voz (hito 13a, ADR-181/183)', () => {
  it('normaliza tildes, mayúsculas y signos', () => {
    expect(normWord('Pétalos,')).toBe('petalos');
    expect(normWord('«AGUA»')).toBe('agua');
  });

  it('mueve el ancla a la primera palabra de la frase clave', () => {
    const words = W('El agua es vital. Las gotas caen sobre los pétalos de las flores y alimentan los ríos del valle.');
    const r = syncAnchors(words, [
      { anchorWordIndex: 0, pfc: 'agua' },
      { anchorWordIndex: 9, pfc: 'Las gotas caen' },
    ]);
    expect(r.anchors).toEqual([0, 4]);
    expect(r.moved).toEqual([{ shot: 1, from: 9, to: 4, by: 'Las gotas caen' }]);
  });

  it('si el título del fotograma se dice antes que la frase clave, el ancla va al título (caso «EJE VERTICAL» / «dB HL»)', () => {
    const words = W('En su eje horizontal se indican las frecuencias, y en su eje vertical, u ordenada, los niveles de audición expresados en dB HL. En este gráfico');
    const r = syncAnchors(words, [
      { anchorWordIndex: 2, pfc: 'eje horizontal' },
      { anchorWordIndex: 21, pfc: 'dB HL', keyframe: { texts: ['EJE VERTICAL', 'ORDENADA', 'niveles de audición', 'dB HL'] } },
    ]);
    // «eje vertical» (11) antes que «dB HL» (21); «eje horizontal» (2) queda fuera: es del plano anterior.
    expect(r.anchors).toEqual([2, 11]);
    expect(r.moved[0].by).toBe('EJE VERTICAL');
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

  it('una palabra suelta solo cuenta si el texto es de una palabra y no es de enlace', () => {
    const words = W('Hoy veremos cómo cuidar el agua en casa con pequeñas acciones diarias para todos.');
    const r = syncAnchors(words, [
      { anchorWordIndex: 0, pfc: 'hoy' },
      { anchorWordIndex: 11, pfc: 'Ahorro doméstico', keyframe: { texts: ['PEQUEÑAS ACCIONES / diarias', 'EL', 'AGUA'] } },
    ]);
    // «AGUA» (5) se dice antes que «pequeñas acciones» (9); «EL» no cuenta.
    expect(r.anchors).toEqual([0, 5]);
  });

  it('una frase de varias palabras necesita sus dos primeras (no basta una palabra repetida antes)', () => {
    const words = W('Obtener los umbrales es el comienzo. Ahora bien, obtener un umbral es solo una parte del proceso.');
    const r = syncAnchors(words, [
      { anchorWordIndex: 0, pfc: 'inicio' },
      { anchorWordIndex: 9, pfc: 'obtener un umbral', keyframe: { texts: ['OBTENER UN UMBRAL'] } },
    ]);
    expect(r.anchors).toEqual([0, 8]);
  });

  it('no cruza el ancla del plano anterior ni la del siguiente', () => {
    const words = W('agua uno dos tres agua cuatro cinco seis siete agua ocho');
    const r = syncAnchors(words, [
      { anchorWordIndex: 0, pfc: 'inicio' },
      { anchorWordIndex: 5, pfc: 'agua' },
      { anchorWordIndex: 8, pfc: 'siete' },
    ]);
    expect(r.anchors).toEqual([0, 4, 8]);
  });

  it('sin coincidencias, deja el ancla de Opus', () => {
    const words = W('una frase sin relación con la palabra clave del plano');
    expect(syncAnchors(words, [{ anchorWordIndex: 0, pfc: 'x' }, { anchorWordIndex: 5, pfc: 'Fotosíntesis' }]).anchors).toEqual([0, 5]);
  });
});

describe('«Dividir en dos» modo extend: dónde se dice un texto del fotograma (hito 13a, ADR-184)', () => {
  const words = W('Ya conoces el oído medio y el umbral en dB HL. ¡Te invitamos a comenzar el siguiente módulo!');
  it('encuentra la primera vez que la voz dice el texto dentro del tramo', () => {
    expect(firstSaid(words, 'OÍDO MEDIO', 0, words.length - 1)).toBe(3);
    expect(firstSaid(words, '¡TE INVITAMOS A COMENZAR!', 0, words.length - 1)).toBe(11);
  });
  it('fuera del tramo o sin coincidencia, no lo encuentra', () => {
    expect(firstSaid(words, 'OÍDO MEDIO', 5, words.length - 1)).toBeUndefined();
    expect(firstSaid(words, 'Audiometría tonal', 0, words.length - 1)).toBeUndefined();
  });
  it('las palabras de un texto se comparan normalizadas', () => {
    expect(textTokens('¡Te invitamos!')).toEqual(['te', 'invitamos']);
  });
});
