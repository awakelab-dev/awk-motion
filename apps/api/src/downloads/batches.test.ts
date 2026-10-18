import { describe, expect, it } from 'vitest';
import { batchEntryName, batchFileName, batchReadme } from './batches.service.js';

/** Lotes de descarga (hito 7, ADR-087). */
describe('lotes de descarga', () => {
  const at = new Date('2026-10-08T18:07:00Z'); // 15:07 en Fortaleza

  it('el ZIP lleva proyecto, formato, calidad, cantidad de videos y fecha local', () => {
    expect(batchFileName('Productividad Laboral', 'scorm12', undefined, 40, at)).toBe('wilox_Productividad_Laboral_scorm12_40videos_20261008-1507.zip');
    expect(batchFileName('Ñandú & cía', 'single', { height: 720, compression: 'light' }, 3, at)).toBe('wilox_Nandu_cia_html1_720p_3videos_20261008-1507.zip');
  });

  it('cada archivo conserva el nombre de su descarga individual con el orden delante', () => {
    expect(batchEntryName(0, 9, 'P_x.zip')).toBe('01_P_x.zip');
    expect(batchEntryName(11, 12, 'P_y_1080p.mp4')).toBe('12_P_y_1080p.mp4');
    expect(batchEntryName(4, 150, 'P_z.html')).toBe('005_P_z.html');
  });

  it('el LEEME lista los archivos y los videos que no entraron con su motivo', () => {
    const txt = batchReadme({
      projectName: 'P',
      format: 'single',
      quality: { height: 1080, compression: 'balanced' },
      entries: [{ name: '01_P_a.html', title: 'Uno' }],
      skipped: [{ id: 'b', title: 'Dos', reason: 'El video pesa más de 40 MB' }],
      at,
    });
    expect(txt).toContain('Formato: Un solo .html · 1080p · equilibrada');
    expect(txt).toContain('01_P_a.html  ·  Uno');
    expect(txt).toContain('No entraron (1):');
    expect(txt).toContain('Dos (b): El video pesa más de 40 MB');
    expect(txt.endsWith('\r\n')).toBe(true);
  });
});

describe('todo por «Descargas» (T5a, ADR-109)', () => {
  it('un solo video: el nombre del paquete mismo (el SCORM, su .zip listo para el LMS)', async () => {
    const { videoPackageName } = await import('../delivery/packages.service.js');
    expect(videoPackageName('Curso A', '20261011-170810-dark-9666de', 'scorm12')).toBe('Curso_A_20261011-170810-dark-9666de_scorm12.zip');
    expect(videoPackageName('Curso A', 'x1', 'scorm2004', { height: 720, compression: 'balanced' })).toBe('Curso_A_x1_720p_scorm2004.zip');
    expect(videoPackageName('Curso A', 'x1', 'single')).toBe('Curso_A_x1.html');
    expect(videoPackageName('Curso A', 'x1', 'mp4')).toBe('Curso_A_x1.mp4');
    expect(videoPackageName('Curso A', 'x1', 'html')).toBe('Curso_A_x1.zip');
  });
  it('ZIP del proyecto: nombre del lote con «proyecto»', () => {
    expect(batchFileName('Curso A', 'project-zip', undefined, 6, new Date('2026-10-11T19:23:00Z'))).toBe('wilox_Curso_A_proyecto_6videos_20261011-1623.zip');
  });
});
