import { AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';

/**
 * Avisos que pide el servidor antes de un cambio delicado (hito 9, T3c, ADR-105): cambiar un video publicado (el
 * cliente verá la nueva versión), el logo de un proyecto con videos publicados o mover un video a otro proyecto (toma
 * su logo). La API responde 409 `{ code: 'confirm', title, message, action }`; `req` muestra este aviso y, si se
 * confirma, repite el pedido con la cabecera `x-confirm-change: 1`.
 */
export interface ChangeConfirm {
  title: string;
  message: string;
  /** Sin acción: solo un aviso con «Entendido» (p. ej. no se puede eliminar lo publicado, T3d). */
  action?: string;
}

type Pending = ChangeConfirm & { resolve: (ok: boolean) => void };
let show: ((p: Pending) => void) | undefined;

export function confirmChange(c: ChangeConfirm): Promise<boolean> {
  if (!show) return Promise.resolve(window.confirm(`${c.title}\n\n${c.message}`));
  return new Promise((resolve) => show!({ ...c, resolve }));
}

/** Lo que se lanza si el usuario cancela el aviso, o tras un aviso que impide la acción (quien llamó puede ignorarlo). */
export class ChangeCancelled extends Error {
  constructor(message = 'Cambio cancelado: todo sigue igual.') {
    super(message);
  }
}

/** Monta el aviso (una vez, en la raíz de la app). */
export function ChangeConfirmHost() {
  const [p, setP] = useState<Pending>();
  useEffect(() => {
    show = setP;
    return () => {
      show = undefined;
    };
  }, []);
  if (!p) return null;
  const close = (ok: boolean) => {
    p.resolve(ok);
    setP(undefined);
  };
  return (
    <Modal title={p.title} onClose={() => close(false)} className="max-w-lg">
      <div className="grid gap-4 text-sm">
        <div className="border-warning/30 bg-warning/10 flex items-start gap-2 rounded-lg border p-3">
          <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" />
          <span>{p.message}</span>
        </div>
        <div className="flex justify-end gap-2">
          {p.action ? (
            <>
              <Button variant="ghost" onClick={() => close(false)} autoFocus>
                Cancelar
              </Button>
              <Button onClick={() => close(true)}>{p.action}</Button>
            </>
          ) : (
            <Button onClick={() => close(false)} autoFocus>
              Entendido
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
