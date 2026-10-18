import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error módulo .mjs sin tipos (packages/prompts/test)
import { dump } from '../../../../packages/prompts/test/golden.mjs';

/**
 * Hito 2: los temas pasan a ser datos. Los prompts de los 3 temas base deben seguir siendo
 * idénticos carácter por carácter a los del hito 1 aceptado (golden.json, volcado antes del refactor).
 */
describe('prompts de los temas base (golden del hito 1)', () => {
  const golden = JSON.parse(readFileSync(new URL('../../../../packages/prompts/test/golden.json', import.meta.url), 'utf8'));
  it('no cambian', () => {
    expect(JSON.parse(JSON.stringify(dump()))).toEqual(golden);
  });
});
