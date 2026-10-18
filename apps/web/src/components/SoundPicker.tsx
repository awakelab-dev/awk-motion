import type { ClipSoundMode, SoundMode } from '@wilox/shared';
import { cn } from '@/lib/utils';

/** Nombres del sonido de los clips (hito 6, ADR-059). */
export const SOUND_TITLES: Record<SoundMode, string> = {
  model: 'Del modelo',
  synth: 'Sintetizado',
  none: 'Sin sonido',
};

const SOUND_HINTS: Record<SoundMode, string> = {
  model: 'El audio que genera MiniMax con cada clip, normalizado y bajo la voz.',
  synth: 'Efectos sintetizados en el Mac según el movimiento (como antes del hito 6).',
  none: 'Solo voz y música.',
};

/** Sonido efectivo de un video (los anteriores al hito 6 no lo tienen: se hicieron con SFX sintetizados). */
export const soundOf = (mode: SoundMode | undefined): SoundMode => mode ?? 'synth';

export const soundTitle = (mode: SoundMode | undefined, gainDb?: number) =>
  `${SOUND_TITLES[soundOf(mode)]}${soundOf(mode) === 'model' && gainDb ? ` ${gainDb > 0 ? '+' : ''}${gainDb} dB` : ''}`;

export const clipSoundTitle = (mode: ClipSoundMode | undefined) => (mode === 'mute' ? 'Silenciado' : mode === 'synth' ? 'Sintetizado' : 'El del video');

/** Selector segmentado: del modelo · sintetizado · sin sonido. */
export function SoundPicker({ value, onChange, disabled }: { value: SoundMode; onChange: (m: SoundMode) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-1.5">
      <div className="bg-background/60 inline-flex w-full rounded-md border p-0.5">
        {(Object.keys(SOUND_TITLES) as SoundMode[]).map((m) => (
          <button
            key={m}
            type="button"
            disabled={disabled}
            onClick={() => onChange(m)}
            className={cn(
              'h-8 flex-1 cursor-pointer rounded px-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              value === m ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {SOUND_TITLES[m]}
          </button>
        ))}
      </div>
      <div className="text-muted-foreground text-[11px]">{SOUND_HINTS[value]}</div>
    </div>
  );
}

/** Ajuste del sonido del modelo en pasos de 3 dB (−12 a +12). */
export function GainStepper({ value, onChange, disabled }: { value: number; onChange: (db: number) => void; disabled?: boolean }) {
  const step = (d: number) => onChange(Math.max(-12, Math.min(12, value + d)));
  return (
    <div className="inline-flex items-center gap-1 text-xs">
      <button type="button" className="hover:bg-secondary h-7 w-7 cursor-pointer rounded border disabled:opacity-50" onClick={() => step(-3)} disabled={disabled || value <= -12}>
        −
      </button>
      <span className="w-16 text-center font-mono tabular-nums">{value > 0 ? `+${value}` : value} dB</span>
      <button type="button" className="hover:bg-secondary h-7 w-7 cursor-pointer rounded border disabled:opacity-50" onClick={() => step(3)} disabled={disabled || value >= 12}>
        +
      </button>
    </div>
  );
}
