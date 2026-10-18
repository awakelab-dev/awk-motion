import { Hourglass, X } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

export interface Toast {
  id: string;
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}

/** Avisos flotantes (hito 5): un video quedó esperando tu aprobación. Se cierran solos a los 20 s. */
export function Toasts({ items, onClose }: { items: Toast[]; onClose: (id: string) => void }) {
  useEffect(() => {
    const timers = items.map((t) => setTimeout(() => onClose(t.id), 20_000));
    return () => timers.forEach(clearTimeout);
  }, [items, onClose]);
  if (!items.length) return null;
  return (
    <div className="fixed right-4 bottom-4 z-50 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
      {items.map((t) => (
        <div key={t.id} className="bg-card flex gap-3 rounded-xl border p-3 shadow-2xl">
          <Hourglass className="text-warning mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t.title}</div>
            <p className="text-muted-foreground line-clamp-2 text-xs">{t.body}</p>
            {t.action && (
              <Button
                size="sm"
                className="mt-2"
                onClick={() => {
                  t.action!.onClick();
                  onClose(t.id);
                }}
              >
                {t.action.label}
              </Button>
            )}
          </div>
          <button type="button" onClick={() => onClose(t.id)} className="text-muted-foreground hover:text-foreground h-fit cursor-pointer" title="Cerrar">
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
