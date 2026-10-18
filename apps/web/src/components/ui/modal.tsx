import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/** Ventana emergente sencilla (hito 5): se cierra con Esc, con la X o al pulsar fuera. */
export function Modal({ title, onClose, children, className }: { title: ReactNode; onClose: () => void; children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Con un pop-up sobre otro (p. ej. el aviso de gasto sobre «Editar clip»), Esc cierra solo el de arriba.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const all = document.querySelectorAll('[role="dialog"]');
      if (all[all.length - 1] === box.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  // En un portal sobre <body>: si no, el pop-up queda atrapado en el contexto de apilamiento de su
  // tarjeta (p. ej. el formulario de Generar es "sticky") y los fotogramas se dibujan por encima.
  return createPortal(
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} role="dialog" aria-modal className={cn('bg-card flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border shadow-2xl', className)}>
        <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5">
          <div className="text-sm font-semibold">{title}</div>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer" aria-label="Cerrar">
            <X className="size-4" />
          </button>
        </div>
        <div className="overflow-y-auto p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
