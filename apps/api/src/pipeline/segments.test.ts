import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clipSound, segmentKey, segmentReady, segmentStatus, soundKey, writeSegmentKey } from './segments.js';
import { modelSoundGainDb } from '../media/sound.js';
import { clipSegments, segmentsFor, type PlannedClip } from './timeline.js';

const plan: PlannedClip[] = [
  { shot: 0, startFrame: 0, slotEndFrame: 169 },
  { shot: 1, startFrame: 169, slotEndFrame: 250 },
];

async function dirWith(files: string[]) {
  const d = await mkdtemp(join(tmpdir(), 'segs-'));
  for (const f of files) await writeFile(join(d, f), 'x');
  return d;
}

describe('segmentos por clip (ADR-056)', () => {
  it('clipSegments da lo mismo que segmentsFor, clip por clip', () => {
    const all = segmentsFor(plan, () => 124);
    expect([...clipSegments(plan, 0, 124), ...clipSegments(plan, 1, 124)]).toEqual(all);
    expect(all.map((s) => [s.name, s.startFrame, s.endFrame])).toEqual([
      ['clip01', 0, 124],
      ['clip01ex', 124, 169],
      ['clip02', 169, 250],
    ]);
  });
});

describe('clave de los segmentos (ADR-055/056)', () => {
  const [clip, freeze] = clipSegments(plan, 0, 124);

  it('sin clave (segmentos de antes del hito 6) no valen', async () => {
    const d = await dirWith(['clip01.mp4', 'clip01_sound.wav']);
    expect(await segmentReady(d, clip, segmentKey(clip, 'clip01_ia_v1.mp4', 'sfx'))).toBe(false);
  });

  it('valen con la misma clave; otra versión del clip, otro sonido u otro largo los invalidan', async () => {
    const d = await dirWith(['clip01.mp4', 'clip01_sound.wav', 'clip01ex.mp4']);
    const k = segmentKey(clip, 'clip01_ia_v1.mp4', 'sfx');
    await writeSegmentKey(d, clip, k);
    expect(await segmentReady(d, clip, k)).toBe(true);
    expect(await segmentReady(d, clip, segmentKey(clip, 'clip01_ia_v2.mp4', 'sfx'))).toBe(false);
    expect(await segmentReady(d, clip, segmentKey(clip, 'clip01_ia_v1.mp4', 'model'))).toBe(false);
    expect(await segmentReady(d, clip, segmentKey({ ...clip, endFrame: 120 }, 'clip01_ia_v1.mp4', 'sfx'))).toBe(false);
    const kf = segmentKey(freeze, 'clip01_ia_v1.mp4', '', clip);
    await writeSegmentKey(d, freeze, kf);
    expect(await segmentReady(d, freeze, kf)).toBe(true);
  });

  it('la posición no cuenta: un clip desplazado con el mismo largo se reutiliza', async () => {
    const d = await dirWith(['clip01.mp4', 'clip01_sound.wav']);
    await writeSegmentKey(d, clip, segmentKey(clip, 'clip01_ia_v1.mp4', 'sfx'));
    const moved = { ...clip, startFrame: 12, endFrame: 136 };
    expect(await segmentReady(d, moved, segmentKey(moved, 'clip01_ia_v1.mp4', 'sfx'))).toBe(true);
  });

  it('un clip sin su WAV de sonido no vale', async () => {
    const d = await dirWith(['clip01.mp4']);
    const k = segmentKey(clip, 'clip01_ia_v1.mp4', 'sfx');
    await writeSegmentKey(d, clip, k);
    expect(await segmentReady(d, clip, k)).toBe(false);
  });
});

describe('sonido de los clips (ADR-059)', () => {
  const [clip] = clipSegments(plan, 0, 124);

  it('sonido efectivo: la excepción del clip manda; sin modo (antes del hito 6) es sintetizado', () => {
    expect(clipSound({}, {})).toBe('synth');
    expect(clipSound({ soundMode: 'model' }, {})).toBe('model');
    expect(clipSound({ soundMode: 'model' }, { soundMode: 'mute' })).toBe('none');
    expect(clipSound({ soundMode: 'none' }, { soundMode: 'synth' })).toBe('synth');
  });

  it('la clave del modelo cambia con el ajuste; la de los SFX es la de siempre', () => {
    expect(soundKey('synth', 3)).toBe('sfx');
    expect(soundKey('model', 0)).not.toBe(soundKey('model', -3));
  });

  it('si solo cambia el sonido, el video del segmento vale (se cambia la pista sin recodificar)', async () => {
    const d = await dirWith(['clip01.mp4', 'clip01_sound.wav']);
    await writeSegmentKey(d, clip, segmentKey(clip, 'clip01_ia_v1.mp4', soundKey('model', 0)));
    expect(await segmentStatus(d, clip, segmentKey(clip, 'clip01_ia_v1.mp4', soundKey('model', 0)))).toBe('ready');
    expect(await segmentStatus(d, clip, segmentKey(clip, 'clip01_ia_v1.mp4', soundKey('model', -3)))).toBe('sound');
    expect(await segmentStatus(d, clip, segmentKey(clip, 'clip01_ia_v2.mp4', soundKey('model', 0)))).toBe('missing');
  });

  it('ganancia hacia el objetivo, con tope y el ajuste del video', () => {
    expect(modelSoundGainDb(-13.2, -18.4, 12)).toBe(-5.2);
    expect(modelSoundGainDb(-40, -18.4, 12)).toBe(12);
    expect(modelSoundGainDb(-15.4, -18.4, 12, -3)).toBe(-6);
  });
});
