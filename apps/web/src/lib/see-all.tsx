import { Users } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';

/**
 * «Ver los de todos» (hito 11, ADR-142): el administrador ve por defecto lo suyo (y lo compartido con él) y, con este
 * interruptor, los proyectos, observaciones, descargas y la cola de todos los usuarios. Uno solo para las cuatro
 * pantallas; se recuerda en este navegador. Los contadores de la cabecera y los avisos siguen siendo los suyos.
 */
const KEY = 'wilox:see-all';
let allowed = false;
let value = (() => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
})();
const listeners = new Set<() => void>();

/** Lo fija la app al iniciar sesión: solo el admin puede ver lo de todos. */
export function setSeeAllAllowed(isAdmin: boolean) {
  allowed = isAdmin;
  listeners.forEach((l) => l());
}

export function setSeeAll(v: boolean) {
  value = v;
  try {
    localStorage.setItem(KEY, v ? '1' : '0');
  } catch {
    /* sin almacenamiento: dura lo que la pestaña */
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

/** true si el admin tiene encendido «Ver los de todos». */
export function useSeeAll(): boolean {
  return useSyncExternalStore(subscribe, () => allowed && value);
}

/** `all=1` para las consultas de las listas cuando corresponde. */
export const seeAllParam = (on: boolean) => (on ? 'all=1' : '');

/** El interruptor (solo lo ve el admin). */
export function SeeAllToggle({ className }: { className?: string }) {
  const isAllowed = useSyncExternalStore(subscribe, () => allowed);
  const on = useSeeAll();
  if (!isAllowed) return null;
  return (
    <label
      className={cn('text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs', on && 'border-primary/50 text-foreground', className)}
      title="Administrador: ver también lo de los demás usuarios (proyectos, observaciones, descargas y cola)"
    >
      <input type="checkbox" checked={on} onChange={(e) => setSeeAll(e.target.checked)} className="accent-primary" />
      <Users className="size-3.5" /> Ver los de todos
    </label>
  );
}
