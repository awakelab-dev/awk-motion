import { Headphones } from 'lucide-react';
import { useState } from 'react';
import { VOICE_SPEED_MAX, VOICE_SPEED_MIN, VOICE_SPEED_STEP, type VoiceModel } from '@wilox/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Velocidad en texto: «0,85». */
export const speedText = (v: number) => v.toFixed(2).replace('.', ',');

/** Valores de 0,70 a 1,15 (paso 0,05). */
export const SPEEDS: number[] = Array.from({ length: Math.round((VOICE_SPEED_MAX - VOICE_SPEED_MIN) / VOICE_SPEED_STEP) + 1 }, (_, i) => Math.round((VOICE_SPEED_MIN + i * VOICE_SPEED_STEP) * 100) / 100);

/**
 * Velocidad de la narración (hito 13a, T2, ADR-178): botones de 0,70 a 1,15 y «Escuchar muestra» (una frase fija con la
 * voz y la versión del proyecto, estirada a la velocidad elegida). Más lenta = audio más largo y más congelado en los
 * videos; más rápida = menos congelado.
 */
export function SpeedPicker({
  value,
  onChange,
  model,
  voiceId,
  current,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  model: VoiceModel;
  voiceId?: string;
  /** Velocidad actual (se marca). */
  current?: number;
  disabled?: boolean;
}) {
  const [listen, setListen] = useState(false);
  const url = api.voiceSampleUrl({ voiceId, model, speed: value });
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-1">
        {SPEEDS.map((v) => (
          <button
            key={v}
            type="button"
            disabled={disabled}
            onClick={() => onChange(v)}
            className={cn(
              'cursor-pointer rounded-md border px-2 py-1 text-[11px] tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              Math.abs(v - value) < 1e-3 ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-secondary/60',
              current !== undefined && Math.abs(v - current) < 1e-3 && Math.abs(v - value) >= 1e-3 && 'border-primary/60',
            )}
            title={v === 1 ? 'La velocidad de la voz, sin estirar' : v < 1 ? 'Más pausada: más congelado en los videos' : 'Más rápida: menos congelado'}
          >
            {speedText(v)}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {listen ? (
          // La muestra se pide una vez por voz y versión; cada velocidad se estira en el servidor y queda guardada.
          <audio key={url} src={url} controls autoPlay className="h-8 max-w-full" />
        ) : (
          <button type="button" className="text-primary flex cursor-pointer items-center gap-1 text-[11px] hover:underline" onClick={() => setListen(true)}>
            <Headphones className="size-3.5" /> Escuchar muestra a {speedText(value)}
          </button>
        )}
        <span className="text-muted-foreground text-[10.5px]">Voz {model}</span>
      </div>
    </div>
  );
}
