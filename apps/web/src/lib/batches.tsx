import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DownloadBatchInfo } from '@wilox/shared';
import { batchesApi } from '@/lib/api';
import { browserNotify } from '@/lib/queue';
import { notifyTitle } from '@/lib/brand';

/** Ir a otra pantalla desde cualquier componente (p. ej. «Ver descargas» en el diálogo del lote). */
export const GO_EVENT = 'wilox:go';
export const goTo = (view: string) => window.dispatchEvent(new CustomEvent(GO_EVENT, { detail: view }));

interface BatchesCtx {
  batches?: DownloadBatchInfo[];
  refresh: () => void;
}
const Ctx = createContext<BatchesCtx>({ refresh: () => undefined });

export const isWorking = (b: DownloadBatchInfo) => b.status === 'queued' || b.status === 'preparing' || b.status === 'packing';

/**
 * Lotes de descarga del usuario (hito 7, ADR-087) para toda la app: se consultan cada 3 s mientras alguno se
 * arma y cada 30 s si no (o con la pestaña oculta). Avisa cuando un lote queda listo o falla.
 */
export function BatchesProvider({ children, onReady }: { children: ReactNode; onReady: (b: DownloadBatchInfo) => void }) {
  const [batches, setBatches] = useState<DownloadBatchInfo[]>();
  const prev = useRef<Map<string, DownloadBatchInfo['status']> | undefined>(undefined);
  const notify = useRef(onReady);
  notify.current = onReady;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tickRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let closed = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight || closed) return;
      inFlight = true;
      let working = false;
      try {
        const list = await batchesApi.list();
        if (closed) return;
        setBatches(list);
        working = list.some(isWorking);
        const before = prev.current;
        // Solo los que cambian estando la app abierta (no los que ya estaban listos al abrirla).
        if (before) for (const b of list) if ((b.status === 'ready' || b.status === 'error') && before.has(b.id) && before.get(b.id) !== b.status) notify.current(b);
        prev.current = new Map(list.map((b) => [b.id, b.status]));
      } catch {
        /* API reiniciándose: se reintenta en la próxima vuelta */
      } finally {
        inFlight = false;
        if (!closed) {
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => void tick(), document.hidden ? 30_000 : working ? 3000 : 30_000);
        }
      }
    };
    tickRef.current = () => {
      if (timer.current) clearTimeout(timer.current);
      void tick();
    };
    const onVisible = () => !document.hidden && tickRef.current();
    document.addEventListener('visibilitychange', onVisible);
    void tick();
    return () => {
      closed = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const refresh = useCallback(() => tickRef.current(), []);
  return <Ctx.Provider value={{ batches, refresh }}>{children}</Ctx.Provider>;
}

export const useBatches = () => useContext(Ctx);

/** Aviso del navegador cuando un lote queda listo (si la pestaña no está a la vista). */
export function notifyBatch(b: DownloadBatchInfo, onClick: () => void) {
  browserNotify(
    b.format === 'rise'
      ? b.status === 'ready'
        ? notifyTitle('código para Rise 360 listo')
        : notifyTitle('el código para Rise 360 falló')
      : b.light
        ? b.status === 'ready'
          ? notifyTitle('SCORM liviano listo')
          : notifyTitle('el SCORM liviano falló')
        : b.status === 'ready'
        ? notifyTitle('lote de descargas listo')
        : notifyTitle('el lote de descargas falló'),
    `${b.projectName}: ${b.videos} video${b.videos === 1 ? '' : 's'}`,
    onClick,
  );
}
