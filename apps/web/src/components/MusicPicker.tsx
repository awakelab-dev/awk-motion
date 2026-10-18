import { Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { MusicTrackInfo } from '@wilox/shared';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

/** "Sin música" en el <select> (los nombres de archivo nunca están vacíos). */
const NONE = '';

export const fmtDuration = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
export const trackTitle = (name: string | null | undefined) => (name ? name.replace(/\.[^.]+$/, '') : 'Sin música');

/**
 * Selector de música de fondo (hito 5, ADR-044): los tracks de assets/music/ con su duración, la escucha
 * previa y "Sin música". La lista viene de la carpeta: un track nuevo aparece sin tocar código.
 */
export function MusicPicker({
  tracks,
  value,
  onChange,
  disabled,
}: {
  tracks: MusicTrackInfo[];
  /** null = "Sin música". */
  value: string | null;
  onChange: (track: string | null) => void;
  disabled?: boolean;
}) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  const stop = () => {
    audio.current?.pause();
    audio.current = null;
    setPlaying(false);
  };
  // Al cambiar de track o salir de la pantalla, la escucha previa se detiene.
  useEffect(() => stop, []);
  useEffect(() => stop(), [value]);

  const toggle = () => {
    if (!value) return;
    if (playing) return stop();
    stop();
    const a = new Audio(api.musicAudioUrl(value));
    a.onended = () => setPlaying(false);
    audio.current = a;
    void a.play().then(
      () => setPlaying(true),
      () => setPlaying(false),
    );
  };

  const missing = !!value && !tracks.some((t) => t.name === value);

  return (
    <div className="flex gap-2">
      <select
        value={value ?? NONE}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled}
        className="border-input bg-background/60 h-9 w-full min-w-0 cursor-pointer rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
      >
        <option value={NONE}>Sin música</option>
        {missing && <option value={value!}>{trackTitle(value)} (ya no está en la carpeta)</option>}
        {tracks.map((t) => (
          <option key={t.name} value={t.name}>
            {t.title} · {fmtDuration(t.durationSec)}
          </option>
        ))}
      </select>
      <Button variant="secondary" size="icon" onClick={toggle} disabled={!value || missing} title={playing ? 'Detener' : 'Escuchar el track'}>
        {playing ? <Pause /> : <Play />}
      </Button>
    </div>
  );
}
