import { describe, expect, it } from 'vitest';
import { splitFamilies } from './typography.service.js';

describe('nombres de fuentes (ADR-094)', () => {
  it('separa por comas, punto y coma, saltos de línea y "y"', () => {
    expect(splitFamilies('Roboto, Oswald')).toEqual(['Roboto', 'Oswald']);
    expect(splitFamilies('Poppins y Roboto')).toEqual(['Poppins', 'Roboto']);
    expect(splitFamilies('Poppins, Roboto y Oswald')).toEqual(['Poppins', 'Roboto', 'Oswald']);
    expect(splitFamilies('Lato; Open Sans\nMontserrat')).toEqual(['Lato', 'Open Sans', 'Montserrat']);
    expect(splitFamilies('Work Sans and DM Serif Display')).toEqual(['Work Sans', 'DM Serif Display']);
  });
  it('no parte nombres que contienen una "y" o una "e" dentro de una palabra', () => {
    expect(splitFamilies('Playfair Display, Bebas Neue')).toEqual(['Playfair Display', 'Bebas Neue']);
    expect(splitFamilies('Yeseva One')).toEqual(['Yeseva One']);
  });
  it('mayúscula inicial si viene todo en minúsculas; respeta lo demás', () => {
    expect(splitFamilies('open sans y roboto')).toEqual(['Open Sans', 'Roboto']);
    expect(splitFamilies('IBM Plex Sans, PT Serif')).toEqual(['IBM Plex Sans', 'PT Serif']);
    expect(splitFamilies('"Roboto".')).toEqual(['Roboto']);
  });
});
