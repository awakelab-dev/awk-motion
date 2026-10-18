import { useEffect, useRef } from 'react';
import type { ReviewActivity } from '@wilox/shared';
import { reviewApi } from '@/lib/api';

/**
 * Avisos de la revisión del cliente (hito 8, ADR-098): cada 30 s (o al volver a la pestaña) se piden las
 * observaciones y aprobaciones nuevas desde la consulta anterior. Solo lo que llega con la app abierta.
 */
export function useReviewActivity(onItem: (a: ReviewActivity) => void) {
  const cb = useRef(onItem);
  cb.current = onItem;
  useEffect(() => {
    let since: string | undefined;
    let closed = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight || closed) return;
      inFlight = true;
      try {
        const page = await reviewApi.activity(since);
        if (closed) return;
        // La primera consulta solo fija el punto de partida.
        if (since) for (const a of page.items) cb.current(a);
        since = page.items.at(-1)?.createdAt && since ? page.items.at(-1)!.createdAt : page.now;
      } catch {
        /* API reiniciándose: se reintenta en la próxima vuelta */
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 30_000);
    const onVisible = () => !document.hidden && void tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      closed = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}

export const kLabel = (i?: number) => (i === undefined ? '' : `K${String(i).padStart(2, '0')}`);
