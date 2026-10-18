import { describe, expect, it } from 'vitest';
import { declinedPresetFor } from './higgsfield.providers.js';

// Error real del 25-09-2026 (clip04, preset "DROWN IN MUSIC").
const REAL = `Higgsfield generate_video_batch: Submitted 0/1 video generations.
- index 0: submission_failed — Preset "DROWN IN MUSIC" was recommended instead of submitting a job. Retry this index with declined_preset_id=f1821f84-945b-4cd1-9085-1f479db0028e.
Wait for the complete requested set with jobs_wait, then show it together with show_generation_by_ids using the collected indexed jobs.`;

describe('declinedPresetFor', () => {
  it('lee el id del texto del error por índice', () => {
    expect(declinedPresetFor(0, undefined, REAL)).toBe('f1821f84-945b-4cd1-9085-1f479db0028e');
    expect(declinedPresetFor(3, undefined, REAL)).toBeUndefined();
  });
  it('lee el id dentro del trabajo', () => {
    const job = { index: 3, error: 'Preset recommended', declined_preset_id: '24bae836-2c4a-48e0-89b6-49fcc0b21612' } as never;
    expect(declinedPresetFor(3, job, '')).toBe('24bae836-2c4a-48e0-89b6-49fcc0b21612');
  });
});
