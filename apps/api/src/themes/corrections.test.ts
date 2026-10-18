import { describe, expect, it } from 'vitest';
import { briefSignature, themeOutOfSync, type ThemeBrief } from '@wilox/shared';
import { themeProposalUserText } from '@wilox/prompts';

const base: ThemeBrief = {
  name: 'Banco',
  description: 'Corporativo, sobrio, fondos claros con acentos naranjos y fotos de personas en oficinas.',
  imageryMode: 'auto',
};
const c = (id: string, text: string, active = true) => ({ id, text, active, createdAt: '2026-10-01T12:00:00Z' });

describe('correcciones del tema (ADR-042)', () => {
  it('la firma cambia con la descripción, las correcciones activas y las referencias, no con el nombre', () => {
    const sig = briefSignature(base, ['ref_01.jpg']);
    expect(briefSignature({ ...base, name: 'Otro' }, ['ref_01.jpg'])).toBe(sig);
    expect(briefSignature({ ...base, description: base.description + ' Más aire.' }, ['ref_01.jpg'])).not.toBe(sig);
    expect(briefSignature(base, [])).not.toBe(sig);
    const withC = { ...base, corrections: [c('a', 'Fondo azul marino')] };
    expect(briefSignature(withC, ['ref_01.jpg'])).not.toBe(sig);
    // Una corrección desactivada no pesa: la firma vuelve a la de sin correcciones.
    expect(briefSignature({ ...base, corrections: [c('a', 'Fondo azul marino', false)] }, ['ref_01.jpg'])).toBe(sig);
  });

  it('pendiente de regenerar solo si la firma aplicada no coincide (temas antiguos: no se avisa)', () => {
    expect(themeOutOfSync(base, [])).toBe(false);
    const applied = { signature: briefSignature(base, []), version: 3, at: '' };
    expect(themeOutOfSync({ ...base, applied }, [])).toBe(false);
    expect(themeOutOfSync({ ...base, applied, corrections: [c('a', 'Sin naranjo')] }, [])).toBe(true);
  });

  it('el mensaje de Opus lista las correcciones activas en orden, marca la nueva y dice que mandan', () => {
    const brief = { ...base, corrections: [c('a', 'Acento verde en vez de naranjo'), c('b', 'Sin fotos de oficinas', false), c('c', 'Títulos más grandes')] };
    const fresh = themeProposalUserText(brief, 0);
    expect(fresh).toContain('CLIENT CORRECTIONS');
    expect(fresh).toContain('OVERRIDE the description');
    expect(fresh).toContain('1. Acento verde en vez de naranjo\n2. Títulos más grandes');
    expect(fresh).not.toContain('Sin fotos de oficinas');
    expect(fresh).toContain('from the description and ALL the corrections above');
    const style = { info: { id: 'x', name: 'x', description: '', swatches: [] } } as never;
    const revise = themeProposalUserText(brief, 0, { current: style, newCorrectionId: 'c' });
    expect(revise).toContain('2. [NEW] Títulos más grandes');
    expect(revise).toContain('Apply the NEW correction #2');
    expect(revise).toContain('CURRENT THEME');
  });

  it('sin correcciones el mensaje no cambia de forma', () => {
    const text = themeProposalUserText(base, 2);
    expect(text).not.toContain('CLIENT CORRECTIONS');
    expect(text).toContain('2 reference images are attached below.');
    expect(text.endsWith('Design the complete theme. Return only the JSON.')).toBe(true);
  });
});
