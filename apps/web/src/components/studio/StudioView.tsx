import { Copy, Loader2, Lock, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { AppInfo, ThemeDetail } from '@wilox/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { themesApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { NewThemeForm } from './NewThemeForm';
import { ThemeWorkspace } from './ThemeWorkspace';

const readTheme = () => new URLSearchParams(location.search).get('theme');

/** Pestaña "Temas" (antes "Estudio", ADR-036): Mis temas (izquierda) y el tema seleccionado o el formulario (derecha). */
export function StudioView({ info }: { info?: AppInfo }) {
  const [themes, setThemes] = useState<ThemeDetail[]>();
  const [error, setError] = useState<string>();
  const [selected, setSelectedState] = useState<string | null>(readTheme());
  const [busy, setBusy] = useState<string>();

  const setSelected = (id: string | null) => {
    setSelectedState(id);
    const p = new URLSearchParams(location.search);
    if (id) p.set('theme', id);
    else p.delete('theme');
    history.replaceState(null, '', `${location.pathname}?${p}`);
  };

  const load = useCallback(() => {
    themesApi.list().then(
      (t) => (setThemes(t), setError(undefined)),
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(load, [load]);

  const duplicate = async (id: string) => {
    setBusy(id);
    try {
      const t = await themesApi.duplicate(id);
      load();
      setSelected(t.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async (t: ThemeDetail) => {
    if (!confirm(`¿Borrar el tema "${t.style.info.name}"? Se moverá a storage/themes/_papelera.`)) return;
    setBusy(t.id);
    try {
      await themesApi.remove(t.id);
      if (selected === t.id) setSelected(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <main className="mx-auto grid max-w-[1400px] gap-6 px-4 pb-16 sm:px-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
      <Card className="self-start">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle>Mis temas</CardTitle>
              <CardDescription>Los base son de solo lectura; duplícalos para partir de ellos.</CardDescription>
            </div>
            <Button size="sm" onClick={() => setSelected(null)} variant={selected ? 'secondary' : 'default'}>
              <Plus /> Nuevo
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {error && <div className="text-destructive text-xs">{error}</div>}
          {!themes && !error && <Loader2 className="text-muted-foreground mx-auto size-4 animate-spin" />}
          {themes?.map((t) => (
            <div
              key={t.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelected(t.id)}
              onKeyDown={(e) => e.key === 'Enter' && setSelected(t.id)}
              className={cn(
                'group flex cursor-pointer items-center gap-3 rounded-lg border p-2 transition-colors',
                selected === t.id ? 'border-primary bg-primary/5' : 'hover:bg-accent/60',
              )}
            >
              <Thumb t={t} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium">{t.style.info.name}</span>
                  {t.readOnly && <Lock className="text-muted-foreground size-3 shrink-0" />}
                </div>
                <div className="mt-1 flex gap-1">
                  {t.origin === 'base' ? (
                    <Badge variant="secondary">Base</Badge>
                  ) : t.status === 'saved' ? (
                    <Badge variant="success">Guardado</Badge>
                  ) : (
                    <Badge variant="warning">Borrador</Badge>
                  )}
                  {t.origin === 'custom' && <Badge variant="secondary">v{t.version}</Badge>}
                </div>
              </div>
              <div className="flex shrink-0 gap-0.5 opacity-60 group-hover:opacity-100">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  title="Duplicar"
                  disabled={busy === t.id}
                  onClick={(e) => (e.stopPropagation(), void duplicate(t.id))}
                >
                  {busy === t.id ? <Loader2 className="animate-spin" /> : <Copy />}
                </Button>
                {!t.readOnly && (
                  <Button size="icon" variant="ghost" className="size-7" title="Borrar" onClick={(e) => (e.stopPropagation(), void remove(t))}>
                    <Trash2 />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {selected ? (
        <ThemeWorkspace
          key={selected}
          id={selected}
          info={info}
          onChanged={load}
          onDuplicate={() => void duplicate(selected)}
          onGone={() => (setSelected(null), load())}
        />
      ) : (
        <NewThemeForm onCreated={(t) => (load(), setSelected(t.id))} />
      )}
    </main>
  );
}

export function Thumb({ t, className }: { t: ThemeDetail; className?: string }) {
  const sw = t.style.info.swatches;
  return (
    <div
      className={cn('relative aspect-video w-20 shrink-0 overflow-hidden rounded-md border', className)}
      style={{
        background: t.thumbnailUrl
          ? `center / cover no-repeat url("${t.thumbnailUrl}")`
          : sw.length
            ? `linear-gradient(135deg, ${sw[0]} 0%, ${sw[1] ?? sw[0]} 100%)`
            : 'var(--secondary)',
      }}
    >
      {!t.thumbnailUrl && (
        <div className="absolute right-1 bottom-1 flex gap-0.5">
          {sw.slice(0, 5).map((c, i) => (
            <span key={`${c}${i}`} className="size-1.5 rounded-full ring-1 ring-black/20" style={{ background: c }} />
          ))}
        </div>
      )}
    </div>
  );
}
