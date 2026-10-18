import { FolderOpen, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { TRASH_RETENTION_DAYS, type TrashResponse } from '@wilox/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChangeCancelled } from '@/lib/confirm';
import { trashApi } from '@/lib/api';
import { TRASH_EVENT, trashChanged } from '@/lib/trash';
import { cn } from '@/lib/utils';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' });
const daysLeft = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));

/**
 * Papelera (hito 9, T3d, ADR-106): proyectos (con sus videos) y videos eliminados. Se restauran o se eliminan
 * definitivamente; a los 180 días se eliminan solos. Lo eliminado definitivamente ya no se ve (se conserva, inaccesible).
 */
export function TrashView({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const [data, setData] = useState<TrashResponse>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();

  const load = () => trashApi.list().then(setData, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const act = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setError(undefined);
    setInfo(undefined);
    try {
      await fn();
      if (done) setInfo(done);
      await load();
      trashChanged();
    } catch (e) {
      if (!(e instanceof ChangeCancelled)) setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const forever = (kind: 'project' | 'video', id: string, label: string) =>
    window.confirm(`¿Eliminar definitivamente ${label}? Dejarás de verlo y no se podrá restaurar desde la app.`) &&
    void act(`del-${id}`, () => trashApi.remove(kind, id), 'Eliminado definitivamente.');

  const empty = () =>
    window.confirm('¿Vaciar la papelera? Todo lo que hay en ella se elimina definitivamente y dejarás de verlo.') &&
    void act('empty', () => trashApi.empty(), 'Papelera vaciada.');

  const total = (data?.projects.length ?? 0) + (data?.videos.length ?? 0);

  return (
    <main className="mx-auto flex max-w-[1100px] flex-col gap-4 px-4 pb-16 sm:px-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Trash2 className="text-muted-foreground size-4" /> Papelera
              </CardTitle>
              <CardDescription>
                Los proyectos (con sus videos) y los videos que eliminaste. Puedes restaurarlos; a los {TRASH_RETENTION_DAYS} días se eliminan solos. Lo que
                elimines definitivamente deja de verse.
              </CardDescription>
            </div>
            {total > 0 && (
              <Button size="sm" variant="outline" disabled={!!busy} onClick={empty}>
                {busy === 'empty' ? <Loader2 className="animate-spin" /> : <Trash2 />} Vaciar la papelera
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="grid gap-5">
          {error && <p className="text-destructive text-sm">{error}</p>}
          {info && <p className="text-muted-foreground text-sm">{info}</p>}
          {!data ? (
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          ) : total === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">La papelera está vacía.</p>
          ) : (
            <>
              {data.projects.length > 0 && (
                <section className="grid gap-2">
                  <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">Proyectos</div>
                  {data.projects.map((p) => (
                    <Row
                      key={p.id}
                      thumb={p.thumbnailUrl}
                      icon
                      title={p.name}
                      meta={`${p.videos} video${p.videos === 1 ? '' : 's'} · eliminado el ${fmtDate(p.trashedAt)} · se elimina solo en ${daysLeft(p.expiresAt)} días`}
                      busy={busy}
                      id={p.id}
                      onRestore={() =>
                        void act(`res-${p.id}`, () => trashApi.restore('project', p.id), `«${p.name}» restaurado con sus videos.`)
                      }
                      onDelete={() => forever('project', p.id, `el proyecto «${p.name}» y sus ${p.videos} video${p.videos === 1 ? '' : 's'}`)}
                    />
                  ))}
                </section>
              )}
              {data.videos.length > 0 && (
                <section className="grid gap-2">
                  <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">Videos</div>
                  {data.videos.map((v) => (
                    <Row
                      key={v.summary.id}
                      thumb={v.summary.thumbnailUrl}
                      title={v.summary.textPreview}
                      meta={`de «${v.projectName}»${v.projectGone ? ' (ya no está: vuelve a «Sin clasificar»)' : ''} · eliminado el ${fmtDate(v.trashedAt)} · se elimina solo en ${daysLeft(v.expiresAt)} días`}
                      busy={busy}
                      id={v.summary.id}
                      onRestore={() =>
                        void act(`res-${v.summary.id}`, () => trashApi.restore('video', v.summary.id), v.projectGone ? 'Video restaurado en «Sin clasificar».' : `Video restaurado en «${v.projectName}».`)
                      }
                      onDelete={() => forever('video', v.summary.id, 'este video')}
                    />
                  ))}
                </section>
              )}
            </>
          )}
        </CardContent>
      </Card>
      <p className="text-muted-foreground text-center text-[11px]">
        Tras restaurar, el proyecto o el video vuelve a «Proyectos».{' '}
        <button type="button" className="text-primary cursor-pointer hover:underline" onClick={() => onOpenProject('')}>
          Ir a Proyectos
        </button>
      </p>
    </main>
  );
}

function Row(props: {
  id: string;
  thumb?: string;
  icon?: boolean;
  title: string;
  meta: string;
  busy?: string;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const { id, busy } = props;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border p-2.5">
      <div className={cn('bg-secondary relative aspect-video w-28 shrink-0 overflow-hidden rounded-md', !props.thumb && 'grid place-items-center')}>
        {props.thumb ? <img src={props.thumb} alt="" loading="lazy" className="size-full object-cover opacity-70 grayscale" /> : props.icon ? <FolderOpen className="text-muted-foreground size-5" /> : null}
      </div>
      <div className="min-w-0 flex-1 basis-56">
        <div className="line-clamp-2 text-sm font-medium">{props.title}</div>
        <div className="text-muted-foreground mt-0.5 text-[11px]">{props.meta}</div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" variant="outline" disabled={!!busy} onClick={props.onRestore}>
          {busy === `res-${id}` ? <Loader2 className="animate-spin" /> : <RotateCcw />} Restaurar
        </Button>
        <Button size="sm" variant="ghost" disabled={!!busy} onClick={props.onDelete} title="Eliminar definitivamente">
          {busy === `del-${id}` ? <Loader2 className="animate-spin" /> : <Trash2 />} Eliminar
        </Button>
      </div>
    </div>
  );
}

/** Botón discreto de la cabecera: la papelera, con cuántos elementos tiene. */
export function TrashIndicator({ active, onClick }: { active: boolean; onClick: () => void }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const load = () => trashApi.count().then((r) => setCount(r.count), () => undefined);
    void load();
    const t = setInterval(load, 60_000);
    window.addEventListener(TRASH_EVENT, load);
    return () => {
      clearInterval(t);
      window.removeEventListener(TRASH_EVENT, load);
    };
  }, []);
  return (
    <button
      type="button"
      onClick={onClick}
      title={count ? `Papelera: ${count} elemento${count === 1 ? '' : 's'}` : 'Papelera (vacía)'}
      className={cn(
        'relative grid size-8 cursor-pointer place-items-center rounded-md transition-colors',
        active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60',
      )}
    >
      <Trash2 className="size-3.5" />
      {count > 0 && (
        <span className="bg-muted-foreground text-background absolute -top-0.5 -right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full px-0.5 text-[9px] leading-none font-semibold tabular-nums">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}
