import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { QueueOverview, QueueVideo } from '@wilox/shared';
import { subscribeQueue } from '@/lib/api';
import { brand } from '@/lib/brand';

export interface QueueNotice {
  id: string;
  video: QueueVideo;
}

const Ctx = createContext<{ overview?: QueueOverview; byId: Map<string, QueueVideo> }>({ byId: new Map() });

/** Resumen de la cola (hito 5) para toda la app; avisa cuando un video queda esperando aprobación. */
export function QueueProvider({ children, onAwaiting }: { children: ReactNode; onAwaiting: (v: QueueVideo) => void }) {
  const [overview, setOverview] = useState<QueueOverview>();
  const prev = useRef<Map<string, QueueVideo['state']> | undefined>(undefined);
  const notify = useRef(onAwaiting);
  notify.current = onAwaiting;
  useEffect(
    () =>
      subscribeQueue((o) => {
        setOverview(o);
        const before = prev.current;
        const now = new Map(o.videos.map((v) => [v.id, v.state]));
        // Solo los que pasan a esperar aprobación (no los que ya esperaban al abrir la app).
        if (before) for (const v of o.videos) if (v.state === 'awaiting' && before.get(v.id) !== 'awaiting') notify.current(v);
        prev.current = now;
      }),
    [],
  );
  // Título de la pestaña: (n) con los videos que esperan aprobación.
  useEffect(() => {
    const n = overview?.counts.awaiting ?? 0;
    document.title = n ? `(${n}) ${brand.name}` : brand.name;
  }, [overview?.counts.awaiting]);
  const byId = new Map((overview?.videos ?? []).map((v) => [v.id, v]));
  return <Ctx.Provider value={{ overview, byId }}>{children}</Ctx.Provider>;
}

export const useQueue = () => useContext(Ctx);

/** Pide permiso para las notificaciones del navegador (se llama al lanzar un video: gesto del usuario). */
export function askNotifications() {
  try {
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
  } catch {
    /* sin notificaciones */
  }
}

export function browserNotify(title: string, body: string, onClick: () => void) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    const n = new Notification(title, { body, tag: 'wilox-aprobacion' });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    /* sin notificaciones */
  }
}

export const STATE_LABEL: Record<QueueVideo['state'], string> = {
  queued: 'En cola',
  working: 'Generando',
  awaiting: 'Espera tu aprobación',
  error: 'Con error',
  paused: 'Detenido',
};
