import { AlertTriangle, CheckCircle2, Clock3, FolderOpen, Hourglass, ImageIcon, Loader2, PauseCircle, PlayCircle, RotateCcw, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { QueueOverview, QueueResourceInfo, QueueVideo } from '@wilox/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, subscribeQueue } from '@/lib/api';
import { SeeAllToggle, useSeeAll } from '@/lib/see-all';
import { confirmSpend } from '@/lib/spend';
import { STATE_LABEL, useQueue } from '@/lib/queue';
import { cn } from '@/lib/utils';

const STEP: Record<string, string> = {
  queued: 'En cola',
  voice: 'Locución',
  timings: 'Tiempos por palabra',
  storyboard: 'Storyboard (Opus)',
  keyframes: 'Fotogramas',
  awaiting_approval: 'Revisión de fotogramas',
  clips: 'Clips',
  post: 'SFX y congelados',
  render: 'Render final',
  error: 'Error',
  done: 'Listo',
  paused: 'Detenido',
};

const RES_SHORT: Record<string, string> = {
  elevenlabs: 'voz',
  anthropic: 'Opus',
  openai: 'imágenes',
  minimax: 'clips',
  higgsfield: 'Higgsfield',
  ffmpeg: 'ffmpeg',
};

const VARIANT: Record<QueueVideo['state'], 'default' | 'warning' | 'destructive' | 'secondary'> = {
  queued: 'secondary',
  working: 'default',
  awaiting: 'warning',
  error: 'destructive',
  paused: 'secondary',
};

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });

function ResourceCard({ r }: { r: QueueResourceInfo }) {
  const pct = Math.min(100, Math.round((r.running / Math.max(1, r.capacity)) * 100));
  const paused = r.pausedUntil && Date.parse(r.pausedUntil) > Date.now();
  return (
    <div className="rounded-lg border bg-card/40 p-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">{r.label}</span>
        {paused ? (
          <Badge variant="warning" title="El proveedor falló varias veces seguidas: se reanuda solo.">
            <PauseCircle /> pausado hasta {fmtTime(r.pausedUntil!)}
          </Badge>
        ) : (
          <span className="text-muted-foreground tabular-nums">
            {r.running} / {r.capacity}
            {r.capacity < r.max ? ` (máx. ${r.max})` : ''}
          </span>
        )}
      </div>
      <div className="bg-secondary mt-2 h-1.5 overflow-hidden rounded-full">
        <div className={cn('h-full rounded-full transition-all', paused ? 'bg-warning' : 'bg-primary')} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-muted-foreground mt-1.5 flex justify-between text-[11px] tabular-nums">
        <span>{r.queued} en espera</span>
        {r.perMinute ? (
          <span>
            {r.usedLastMinute} / {r.perMinute} por minuto
          </span>
        ) : (
          <span>{r.usedLastMinute} en el último minuto</span>
        )}
      </div>
    </div>
  );
}

function VideoRow({ v, onOpen }: { v: QueueVideo; onOpen: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const retry = async () => {
    const ok = await confirmSpend({
      title: 'Reintentar',
      body: 'Retoma el video desde el paso que falló; lo ya hecho no se vuelve a pagar.',
      workNote: 'Vuelve a llamar al proveedor del paso que falló (locución, Opus, imágenes o clips) y sigue con lo pendiente.',
      action: 'Reintentar',
    });
    if (!ok) return;
    setBusy(true);
    setErr(undefined);
    try {
      await api.retry(v.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const resume = async () => {
    const ok = await confirmSpend({
      title: 'Reanudar el video',
      body: 'Vuelve a la cola con su prioridad y sigue desde donde quedó; lo ya hecho no se vuelve a pagar.',
      workNote: 'Genera lo que quede pendiente del video (locución, fotogramas o clips).',
      action: 'Reanudar',
    });
    if (!ok) return;
    setBusy(true);
    setErr(undefined);
    try {
      await api.resume(v.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const res = Object.entries(v.byResource);
  return (
    <div className="flex flex-col gap-3 border-b py-3 last:border-0 sm:flex-row sm:items-center">
      <div className="w-8 shrink-0 text-center">
        {v.position ? (
          <span className="font-mono text-lg font-semibold tabular-nums" title="Posición en la cola global (orden de lanzamiento)">
            {v.position}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </div>
      <button
        type="button"
        onClick={() => onOpen(v.id)}
        className="bg-secondary relative aspect-video w-32 shrink-0 cursor-pointer overflow-hidden rounded-md border sm:w-36"
        title="Abrir"
      >
        {v.thumbnailUrl ? (
          <img src={v.thumbnailUrl} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <span className="text-muted-foreground grid size-full place-items-center">
            {v.state === 'working' || v.state === 'queued' ? <Loader2 className="size-4 animate-spin" /> : <ImageIcon className="size-4" />}
          </span>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={VARIANT[v.state]}>
            {v.state === 'working' ? (
              <Loader2 className="animate-spin" />
            ) : v.state === 'awaiting' ? (
              <Hourglass />
            ) : v.state === 'error' ? (
              <AlertTriangle />
            ) : v.state === 'paused' ? (
              <PauseCircle />
            ) : (
              <Clock3 />
            )}
            {STATE_LABEL[v.state]}
          </Badge>
          {v.state !== 'paused' && <span className="text-xs font-medium">{STEP[v.status] ?? v.status}</span>}
          <span className="text-muted-foreground text-[11px]">
            {v.projectName} · {v.themeName ?? ''} · lanzado {fmtTime(v.createdAt)}
          </span>
        </div>
        <p className="mt-1 line-clamp-1 text-sm">{v.textPreview}</p>
        <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <span className="line-clamp-1">{v.error ?? v.message}</span>
          {v.keyframes.total > 0 && (
            <span className="tabular-nums">
              fotogramas {v.keyframes.ready}/{v.keyframes.total}
            </span>
          )}
          {v.clips.total > 0 && (
            <span className="tabular-nums">
              clips {v.clips.ready}/{v.clips.total}
            </span>
          )}
          {res.map(([r, n]) => (
            <span key={r} className="bg-secondary rounded px-1.5 py-0.5 tabular-nums">
              {RES_SHORT[r] ?? r}: {n.running ? `${n.running} en marcha` : ''}
              {n.running && n.queued ? ' · ' : ''}
              {n.queued ? `${n.queued} en cola` : ''}
            </span>
          ))}
          {v.tasks.retrying > 0 && <span className="text-warning">{v.tasks.retrying} reintentando tras un límite del proveedor</span>}
        </div>
        {err && <p className="text-destructive mt-1 text-xs">{err}</p>}
      </div>
      <div className="flex shrink-0 gap-2">
        {v.state === 'error' && (
          <Button size="sm" variant="outline" onClick={retry} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />} Reintentar
          </Button>
        )}
        {v.state === 'paused' && (
          <Button size="sm" variant="outline" onClick={resume} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <PlayCircle />} Reanudar
          </Button>
        )}
        <Button size="sm" variant={v.state === 'awaiting' ? 'default' : 'secondary'} onClick={() => onOpen(v.id)}>
          <FolderOpen /> {v.state === 'awaiting' ? 'Revisar' : 'Abrir'}
        </Button>
      </div>
    </div>
  );
}

/** Reanudar todos los detenidos (ADR-053): cada uno vuelve a la cola con su prioridad. */
function ResumeAll({ ids }: { ids: string[] }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  return (
    <span className="flex items-center gap-2">
      {err && <span className="text-destructive font-normal">{err}</span>}
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={async (e) => {
          e.preventDefault(); // no pliega la sección
          const ok = await confirmSpend({
            title: `Reanudar ${ids.length} video${ids.length === 1 ? '' : 's'}`,
            body: 'Vuelven a la cola con su prioridad y siguen desde donde quedaron; lo ya hecho no se vuelve a pagar.',
            workNote: 'Genera lo que quede pendiente de cada video (locución, fotogramas o clips).',
            action: 'Reanudar',
          });
          if (!ok) return;
          setBusy(true);
          setErr(undefined);
          const r = await Promise.allSettled(ids.map((id) => api.resume(id)));
          const bad = r.filter((x) => x.status === 'rejected').length;
          if (bad) setErr(`${bad} no se ${bad === 1 ? 'pudo' : 'pudieron'} reanudar`);
          setBusy(false);
        }}
      >
        {busy ? <Loader2 className="animate-spin" /> : <PlayCircle />} Reanudar todos ({ids.length})
      </Button>
    </span>
  );
}

/**
 * Vista "Cola" (hito 5, ADR-045): todos mis videos en curso con su fase y su posición en la cola global,
 * los que esperan mi aprobación, los que fallaron (24 h) y el uso de cada proveedor.
 */
export function QueueView({ onOpen }: { onOpen: (id: string) => void }) {
  const { overview: mine } = useQueue();
  // «Ver los de todos» (hito 11): el admin ve también los videos de los proyectos de los demás (la cabecera sigue con lo suyo).
  const seeAll = useSeeAll();
  const [everyone, setEveryone] = useState<QueueOverview>();
  useEffect(() => {
    setEveryone(undefined);
    if (seeAll) return subscribeQueue(setEveryone, true);
  }, [seeAll]);
  const overview = seeAll ? everyone : mine;
  if (!overview)
    return (
      <main className="text-muted-foreground mx-auto flex max-w-[1400px] items-center gap-2 px-4 text-xs sm:px-6">
        <Loader2 className="size-3.5 animate-spin" /> Cargando la cola…
      </main>
    );
  const order: QueueVideo['state'][] = ['awaiting', 'working', 'queued', 'error'];
  // Los detenidos no están en la cola (ADR-052): van aparte, plegados, para reanudarlos.
  const stopped = overview.videos.filter((v) => v.state === 'paused');
  const videos = overview.videos.filter((v) => v.state !== 'paused').sort(
    (a, b) => order.indexOf(a.state) - order.indexOf(b.state) || (a.position ?? 1e9) - (b.position ?? 1e9) || a.createdAt.localeCompare(b.createdAt),
  );
  return (
    <main className="mx-auto grid max-w-[1400px] gap-6 px-4 pb-16 sm:px-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            Cola <SeeAllToggle />
          </CardTitle>
          <CardDescription>
            Videos en curso de todos tus proyectos (también los compartidos contigo y los públicos). Se atienden por orden de lanzamiento (las correcciones van con la prioridad de su video); un
            video que espera tu aprobación no ocupa capacidad y uno con error no frena a los demás.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {videos.length ? (
            videos.map((v) => <VideoRow key={v.id} v={v} onOpen={onOpen} />)
          ) : (
            <p className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
              <CheckCircle2 className="size-4" /> No hay videos en curso.
            </p>
          )}
          {stopped.length > 0 && (
            <details className="mt-4 rounded-lg border px-3">
              <summary className="text-muted-foreground flex cursor-pointer items-center justify-between gap-2 py-2.5 text-xs font-medium">
                <span>Detenidos ({stopped.length}) · fuera de la cola hasta que los reanudes</span>
                <ResumeAll ids={stopped.map((v) => v.id)} />
              </summary>
              {stopped.map((v) => (
                <VideoRow key={v.id} v={v} onOpen={onOpen} />
              ))}
            </details>
          )}
        </CardContent>
      </Card>
      <Card className="h-fit lg:sticky lg:top-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="text-primary size-4" /> Uso por proveedor
          </CardTitle>
          <CardDescription>Huecos ocupados / capacidad. Ante un límite del proveedor la capacidad baja sola y se recupera.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {overview.resources.map((r) => (
            <ResourceCard key={r.resource} r={r} />
          ))}
        </CardContent>
      </Card>
    </main>
  );
}

/** Indicador de la cabecera: en cola · generando · esperando aprobación · con error. */
export function QueueIndicator({ active, onClick }: { active: boolean; onClick: () => void }) {
  const { overview } = useQueue();
  const c = overview?.counts;
  const items = c
    ? ([
        ['queued', c.queued, Clock3, 'text-muted-foreground'],
        ['working', c.working, Loader2, 'text-primary'],
        ['awaiting', c.awaiting, Hourglass, 'text-warning'],
        ['error', c.error, AlertTriangle, 'text-destructive'],
      ] as const)
    : [];
  const total = c ? c.queued + c.working + c.awaiting + c.error : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      title="Cola: en cola · generando · esperan tu aprobación · con error"
      className={cn(
        'inline-flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
        active ? 'bg-secondary text-foreground' : 'bg-card/60 text-muted-foreground hover:text-foreground',
      )}
    >
      <span className="font-medium">Cola</span>
      {total === 0 ? (
        <span className="text-muted-foreground">vacía</span>
      ) : (
        items
          .filter(([, n]) => n > 0)
          .map(([k, n, Icon, color]) => (
            <span key={k} className={cn('inline-flex items-center gap-1 tabular-nums', color)}>
              <Icon className={cn('size-3.5', k === 'working' && 'animate-spin')} /> {n}
            </span>
          ))
      )}
    </button>
  );
}
