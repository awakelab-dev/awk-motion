import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Subtítulos dibujados por la app sobre el video (hito 6, ADR-063), no por el navegador: cada navegador
 * elige su tamaño (Safari los hacía enormes al 100 % y diminutos al 60 %). Aquí la letra es proporcional al
 * ancho del video, igual en todos, y la misma regla usa el reproductor HTML de la descarga.
 */

export interface VttCue {
  start: number;
  end: number;
  text: string;
}

/** Proporción de la letra respecto del ancho del video (≈ 26 px con el video a 1600 px). */
export const CAPTION_SIZE = 0.016;

const time = (t: string) => {
  const [h, m, s] = t.trim().replace(',', '.').split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

/** WebVTT → subtítulos (solo lo que generamos: tiempos y texto). */
export function parseVtt(vtt: string): VttCue[] {
  const cues: VttCue[] = [];
  for (const block of vtt.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    cues.push({ start: time(a), end: time(b.trim().split(' ')[0]), text: lines.slice(i + 1).join(' ').trim() });
  }
  return cues;
}

/** Descarga y lee los subtítulos de una URL (.vtt). */
export function useVttCues(url: string | undefined) {
  const [cues, setCues] = useState<VttCue[]>([]);
  useEffect(() => {
    if (!url) return setCues([]);
    let alive = true;
    fetch(url, { credentials: 'include' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => alive && setCues(parseVtt(t)))
      .catch(() => alive && setCues([]));
    return () => {
      alive = false;
    };
  }, [url]);
  return cues;
}

/** Subtítulo activo del video y tamaño de letra según su ancho. */
export function CaptionOverlay({ video, cues, on }: { video: RefObject<HTMLVideoElement | null>; cues: VttCue[]; on: boolean }) {
  const [text, setText] = useState('');
  const [size, setSize] = useState(16);
  const [paused, setPaused] = useState(true);
  const raf = useRef(0);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const ro = new ResizeObserver(() => setSize(Math.max(12, Math.round(v.clientWidth * CAPTION_SIZE))));
    ro.observe(v);
    const tick = () => {
      const t = v.currentTime;
      setText(cues.find((c) => t >= c.start && t < c.end)?.text ?? '');
      if (!v.paused) raf.current = requestAnimationFrame(tick);
    };
    const start = () => {
      setPaused(v.paused);
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(tick);
    };
    const pause = () => setPaused(true);
    v.addEventListener('pause', pause);
    v.addEventListener('play', start);
    v.addEventListener('seeked', start);
    v.addEventListener('timeupdate', start);
    tick();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf.current);
      v.removeEventListener('pause', pause);
      v.removeEventListener('play', start);
      v.removeEventListener('seeked', start);
      v.removeEventListener('timeupdate', start);
    };
  }, [video, cues]);

  if (!on || !text) return null;
  return (
    // Bien abajo mientras se reproduce (ADR-064); en pausa sube para no quedar bajo los controles del navegador.
    <div
      className="pointer-events-none absolute inset-x-0 flex justify-center px-[4%] transition-[bottom] duration-200"
      style={{ bottom: `${Math.round(paused ? size * 2.6 : Math.max(6, size * 0.45))}px` }}
    >
      <span className="rounded-[0.3em] px-[0.5em] py-[0.15em] text-center leading-snug text-white" style={{ fontSize: size, background: 'rgb(0 0 0 / 0.6)' }}>
        {text}
      </span>
    </div>
  );
}
