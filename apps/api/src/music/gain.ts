/** Volumen de la música en la mezcla (docs/06): 0.1 con el track de referencia. */
export const MUSIC_BASE_VOLUME = 0.1;

/**
 * Ganancia (dB) para que un track suene como el de referencia (MUSIC_PATH): ref − lufs, con tope
 * ±maxDb. Sin medida de alguno de los dos, 0 (se mezcla a 0.1 como siempre).
 */
export function musicGainDb(lufs: number | undefined, refLufs: number | undefined, maxDb: number): number {
  if (lufs === undefined || refLufs === undefined || !Number.isFinite(lufs) || !Number.isFinite(refLufs)) return 0;
  const g = Math.max(-maxDb, Math.min(maxDb, refLufs - lufs));
  return Math.round(g * 10) / 10;
}

/** Volumen final del track: 0.1 × 10^(dB/20), redondeado (con 0 dB queda exactamente 0.1). */
export function musicVolume(gainDb: number): number {
  return Number((MUSIC_BASE_VOLUME * 10 ** (gainDb / 20)).toFixed(4));
}
