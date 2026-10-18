import { AlertTriangle, CheckCircle2, Clock3, Download, Layers, Link2, Loader2, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BATCH_RETENTION_DAYS, qualityLabel, type DownloadBatchInfo } from '@wilox/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { batchFormatInfo, isPublishedBatch } from '@/components/downloads/formats';
import { FormatTile } from '@/components/downloads/FormatTile';
import { LinksPanel } from '@/components/downloads/LinksPanel';
import { mbText } from '@/components/delivery/quality';
import { batchesApi } from '@/lib/api';
import { isWorking, useBatches } from '@/lib/batches';
import { cn } from '@/lib/utils';
import { SeeAllToggle, useSeeAll } from '@/lib/see-all';

const STATUS: Record<DownloadBatchInfo['status'], { label: string; variant: 'default' | 'secondary' | 'success' | 'destructive' }> = {
  queued: { label: 'En cola', variant: 'secondary' },
  preparing: { label: 'Armando', variant: 'default' },
  packing: { label: 'Cerrando el ZIP', variant: 'default' },
  ready: { label: 'Listo', variant: 'success' },
  error: { label: 'Con error', variant: 'destructive' },
};
const LOGO = { project: 'logo del proyecto', none: 'sin logo', other: 'otro logo' } as const;

const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const daysLeft = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
const elapsed = (from: string, to?: string) => {
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
};

function BatchRow({ b, onChanged }: { b: DownloadBatchInfo; onChanged: () => void }) {
  const [busy, setBusy] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string>();
  const activeLinks = b.links.filter((l) => !l.disabled && !l.expired).length;
  const [linksOpen, setLinksOpen] = useState(false);
  const st = isPublishedBatch(b) && (b.status === 'preparing' || b.status === 'queued') ? { label: 'Publicando', variant: 'default' as const } : STATUS[b.status];
  const working = isWorking(b);
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setErr(undefined);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
      setConfirm(false);
    }
  };
  const download = () => {
    window.location.href = batchesApi.fileUrl(b.id);
    setTimeout(onChanged, 1500); // el contador de descargas
  };
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 border-b py-3.5 last:border-b-0">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <FormatTile format={b.format} className="self-start" />
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              {b.projectName}
              {b.videoTitle && <span className="text-muted-foreground font-normal"> · {b.videoTitle}</span>}
            </span>
            <Badge variant={st.variant}>
              {b.status === 'ready' ? <CheckCircle2 /> : b.status === 'error' ? <AlertTriangle /> : b.status === 'queued' ? <Clock3 /> : <Loader2 className="animate-spin" />}
              {st.label}
              {b.status === 'queued' && b.position ? ` · ${b.position}.º` : ''}
            </Badge>
            {b.stale && (
              <Badge variant="warning" title="Algún video (o el logo del proyecto) cambió desde que se armó: «Actualizar» la vuelve a armar y sus links siguen igual">
                Desactualizada
              </Badge>
            )}
          </div>
          <div className="text-muted-foreground mt-0.5 text-[11px]">
            {batchFormatInfo(b).title} · {qualityLabel(b.quality)}
            {batchFormatInfo(b).logo ? ` · ${b.format === 'rise' ? (b.logo === 'project' ? 'logo del proyecto dibujado' : 'sin logo') : LOGO[b.logo]}` : ''} · {b.videos} video{b.videos === 1 ? '' : 's'} · pedido el {fmtDateTime(b.createdAt)}
          </div>
          <div className="text-muted-foreground mt-0.5 truncate font-mono text-[10.5px]" title={b.fileName}>
            {b.fileName}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {b.status === 'ready' && (
            <Button size="sm" onClick={download}>
              <Download /> Descargar{b.bytes ? ` · ${b.bytes < 1e6 ? `${Math.max(1, Math.round(b.bytes / 1e3))} KB` : mbText(b.bytes)}` : ''}
            </Button>
          )}
          {b.stale && (
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void act('refresh', () => batchesApi.refresh(b.id))} title="Volver a armarla con los videos y el logo de hoy; sus links siguen igual">
              {busy === 'refresh' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Actualizar
            </Button>
          )}
          {b.status !== 'error' && (
            <Button size="sm" variant={linksOpen ? 'secondary' : 'outline'} onClick={() => setLinksOpen((v) => !v)} title="Links de descarga para el cliente">
              <Link2 /> Link{activeLinks ? ` · ${activeLinks}` : ''}
            </Button>
          )}
          {b.status === 'error' && (
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void act('retry', () => batchesApi.retry(b.id))}>
              {busy === 'retry' ? <Loader2 className="animate-spin" /> : <RotateCcw />} Reintentar
            </Button>
          )}
          {confirm ? (
            <>
              <Button size="sm" variant="destructive" disabled={!!busy} onClick={() => void act('remove', () => batchesApi.remove(b.id))}>
                {busy === 'remove' ? <Loader2 className="animate-spin" /> : <Trash2 />} {working ? 'Detener y eliminar' : activeLinks ? `Eliminar (y ${activeLinks === 1 ? 'su link' : `sus ${activeLinks} links`})` : 'Eliminar'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                Cancelar
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirm(true)} title={working ? 'Detener el lote y eliminarlo' : 'Eliminar el lote y su ZIP del servidor'}>
              <Trash2 />
            </Button>
          )}
        </div>
      </div>

      {working && (
        <div className="grid gap-1">
          <div className="bg-secondary h-1.5 overflow-hidden rounded-full">
            <div className="bg-primary h-full rounded-full transition-all" style={{ width: `${Math.round(b.progress * 100)}%` }} />
          </div>
          <div className="text-muted-foreground flex flex-wrap justify-between gap-x-3 text-[11px] tabular-nums">
            <span>
              {b.status === 'queued' && !isPublishedBatch(b)
                ? b.position && b.position > 1
                  ? `Espera a ${b.position - 1} lote${b.position - 1 === 1 ? '' : 's'} antes`
                  : 'Empieza en cuanto termine el lote en curso'
                : (b.stage ?? 'Preparando')}
            </span>
            <span>
              {b.done} de {b.videos} video{b.videos === 1 ? '' : 's'} · {Math.round(b.progress * 100)} %{b.startedAt ? ` · ${elapsed(b.startedAt)}` : ''}
            </span>
          </div>
        </div>
      )}

      {(b.status === 'ready' || b.status === 'error') && (
        <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          {b.status === 'ready' && (
            <span>
              Descargado {b.downloads} {b.downloads === 1 ? 'vez' : 'veces'}
              {b.lastDownloadAt ? ` (la última el ${fmtDateTime(b.lastDownloadAt)})` : ''}
            </span>
          )}
          {b.finishedAt && b.startedAt && <span>Armado en {elapsed(b.startedAt, b.finishedAt)}</span>}
          {b.expiresAt ? (
            <span>Se borra en {daysLeft(b.expiresAt)} día{daysLeft(b.expiresAt) === 1 ? '' : 's'}</span>
          ) : (
            b.status === 'ready' && <span>Se guarda mientras tenga un link sin caducidad</span>
          )}
        </div>
      )}
      {linksOpen && b.status !== 'error' && <LinksPanel b={b} onChanged={onChanged} />}
      {b.error && <div className="text-destructive text-[11px]">{b.error}</div>}
      {b.skipped.length > 0 && (
        <details className="text-[11px]">
          <summary className="text-warning cursor-pointer">
            {b.skipped.length} video{b.skipped.length === 1 ? '' : 's'} no {b.skipped.length === 1 ? 'entró' : 'entraron'}
          </summary>
          <ul className="text-muted-foreground mt-1 grid gap-0.5 pl-4">
            {b.skipped.map((s) => (
              <li key={s.id} className="list-disc">
                <span className="text-foreground">{s.title}</span>: {s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {err && <div className="text-destructive text-[11px]">{err}</div>}
    </div>
  );
}

/**
 * Control de descargas (hito 7, ADR-087): los lotes de todos tus proyectos, con su estado, el avance del que se
 * está armando, el lugar en la cola, el peso, cuántas veces se bajó cada ZIP y cuándo se borra.
 */
export function DownloadsView() {
  const { batches: mine, refresh: refreshMine } = useBatches();
  // «Ver los de todos» (hito 11): el admin ve también las de los proyectos de los demás (cada 5 s mientras está abierta).
  const seeAll = useSeeAll();
  const [everyone, setEveryone] = useState<DownloadBatchInfo[]>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!seeAll) return setEveryone(undefined);
    let alive = true;
    const load = () => batchesApi.list(true).then((l) => alive && setEveryone(l), () => undefined);
    void load();
    const t = setInterval(() => !document.hidden && void load(), 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [seeAll, tick]);
  const batches = seeAll ? everyone : mine;
  const refresh = () => (seeAll ? setTick((t) => t + 1) : refreshMine());
  if (!batches)
    return (
      <main className="text-muted-foreground mx-auto flex max-w-[1400px] items-center gap-2 px-4 text-xs sm:px-6">
        <Loader2 className="size-3.5 animate-spin" /> Cargando las descargas…
      </main>
    );
  const working = batches.filter(isWorking).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const rest = batches.filter((b) => !isWorking(b));
  return (
    <main className="mx-auto grid max-w-[1100px] gap-6 px-4 pb-16 sm:px-6">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="text-primary size-4" /> Descargas
            <SeeAllToggle className="ml-auto" />
          </CardTitle>
          <CardDescription>
            Todas las descargas de tus proyectos y de los compartidos contigo (botón «Descargar» del video o del proyecto): un video, un SCORM, el ZIP completo, un archivo por video, el código para Rise 360…
            Se arman en el servidor (de a una, por orden de llegada; Rise y SCORM liviano mientras se publican sus videos) y cada archivo queda{' '}
            {BATCH_RETENTION_DAYS} días (o mientras tenga un link vigente); puedes cerrar la app mientras tanto. Con «Link» le mandas al cliente un link de
            descarga, sin bajar el archivo a tu computador.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-1">
          {batches.length === 0 ? (
            <p className="text-muted-foreground py-6 text-sm">Aún no hay descargas. Pídelas desde un proyecto: «Descargar» → «Un archivo por video».</p>
          ) : (
            <>
              {working.length > 0 && (
                <section className={cn(rest.length > 0 && 'mb-4')}>
                  <div className="text-muted-foreground mb-1 text-[11px] font-medium tracking-wide uppercase">En curso</div>
                  {working.map((b) => (
                    <BatchRow key={b.id} b={b} onChanged={refresh} />
                  ))}
                </section>
              )}
              {rest.length > 0 && (
                <section>
                  <div className="text-muted-foreground mb-1 text-[11px] font-medium tracking-wide uppercase">Disponibles</div>
                  {rest.map((b) => (
                    <BatchRow key={b.id} b={b} onChanged={refresh} />
                  ))}
                </section>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

/** Botón de la cabecera: lotes en curso y listos. */
export function DownloadsIndicator({ active, onClick }: { active: boolean; onClick: () => void }) {
  const { batches } = useBatches();
  const working = batches?.filter(isWorking).length ?? 0;
  const ready = batches?.filter((b) => b.status === 'ready').length ?? 0;
  const failed = batches?.filter((b) => b.status === 'error').length ?? 0;
  return (
    <button
      type="button"
      onClick={onClick}
      title="Descargas: lotes en curso · listos · con error"
      className={cn(
        'inline-flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
        active ? 'bg-secondary text-foreground' : 'bg-card/60 text-muted-foreground hover:text-foreground',
      )}
    >
      <span className="font-medium">Descargas</span>
      {working > 0 && (
        <span className="text-primary inline-flex items-center gap-1 tabular-nums">
          <Loader2 className="size-3.5 animate-spin" /> {working}
        </span>
      )}
      {ready > 0 && (
        <span className="text-success inline-flex items-center gap-1 tabular-nums">
          <Download className="size-3.5" /> {ready}
        </span>
      )}
      {failed > 0 && (
        <span className="text-destructive inline-flex items-center gap-1 tabular-nums">
          <AlertTriangle className="size-3.5" /> {failed}
        </span>
      )}
    </button>
  );
}
