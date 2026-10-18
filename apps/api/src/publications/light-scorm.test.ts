import { describe, expect, it } from 'vitest';
import { lightScormFileName, lightScormReadme } from './publications.service.js';

describe('SCORM liviano (T4, ADR-108)', () => {
  const at = new Date('2026-10-12T15:30:00Z');
  it('nombre del paquete: versión, nube, calidad, uno por video y fecha (UTC−3)', () => {
    expect(lightScormFileName('Curso de Higiene', '1.2', false, { height: 1440, compression: 'high' }, 1, at)).toBe('wilox_Curso_de_Higiene_scorm12-nube_1video_20261012-1230.zip');
    expect(lightScormFileName('Lavado de manos.', '1.2', false, { height: 1440, compression: 'high' }, 1, at)).toBe('wilox_Lavado_de_manos_scorm12-nube_1video_20261012-1230.zip');
    expect(lightScormFileName('Curso de Higiene', '2004', true, { height: 720, compression: 'balanced' }, 12, at)).toBe('wilox_Curso_de_Higiene_scorm2004-nube_720p_uno-por-video_12videos_20261012-1230.zip');
  });
  it('el LEEME dice de dónde se carga cada video y qué pasa al despublicar', () => {
    const t = lightScormReadme('1.2', [{ title: 'Higiene de manos', url: 'https://media.example/p/abc/video.mp4' }]);
    expect(t).toContain('SCORM 1.2 liviano');
    expect(t).toContain('despublica');
    expect(t).toContain('https://media.example/p/abc/video.mp4');
  });
});
