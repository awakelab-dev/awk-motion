import { Check, CheckCircle2, Copy, ExternalLink, Link2, Loader2, MessageSquare, RefreshCw, RotateCcw, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ReviewComment, RunState, VideoReview } from '@wilox/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { reviewApi } from '@/lib/api';
import { cn } from '@/lib/utils';

const kLabel = (i: number) => `K${String(i).padStart(2, '0')}`;
const fmt = (iso: string) => new Date(iso).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

interface ReviewCtx {
  review?: VideoReview;
  setReview: (r: VideoReview) => void;
  refresh: () => void;
  /** Fotograma elegido desde un contador (la tarjeta muestra solo sus observaciones). */
  focus?: number;
  setFocus: (i: number | undefined) => void;
}
const Ctx = createContext<ReviewCtx>({ setReview: () => undefined, refresh: () => undefined, setFocus: () => undefined });
export const useReview = () => useContext(Ctx);

/** Revisión del video abierto (hito 8, ADR-098): se consulta al abrirlo y cada 20 s con la pestaña a la vista. */
export function ReviewProvider({ runId, children }: { runId: string; children: ReactNode }) {
  const [review, setReview] = useState<VideoReview>();
  const [focus, setFocus] = useState<number>();
  const live = useRef(runId);
  live.current = runId;
  const refresh = useCallback(() => {
    const id = runId;
    reviewApi.state(id).then(
      (r) => live.current === id && setReview(r),
      () => undefined,
    );
  }, [runId]);
  useEffect(() => {
    setReview(undefined);
    setFocus(undefined);
    refresh();
    const t = setInterval(() => !document.hidden && refresh(), 20_000);
    return () => clearInterval(t);
  }, [refresh]);
  return <Ctx.Provider value={{ review, setReview, refresh, focus, setFocus }}>{children}</Ctx.Provider>;
}

/** Contador de observaciones sin resolver de un fotograma; lleva a la tarjeta de revisión. */
export function ReviewBadge({ index, className }: { index: number; className?: string }) {
  const { review, setFocus } = useReview();
  const n = review?.openByKeyframe[String(index)] ?? 0;
  if (!n) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setFocus(index);
        document.getElementById('revision')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }}
      className={cn('bg-warning text-background inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold', className)}
      title={`${n} observación${n === 1 ? '' : 'es'} del cliente sin resolver en ${kLabel(index)}`}
    >
      <MessageSquare className="size-3" /> {n}
    </button>
  );
}

/**
 * Revisión del cliente (hito 8, A4, ADR-098): el link de la presentación del storyboard (sin sesión), la
 * aprobación del cliente y sus observaciones por fotograma, que se marcan como resueltas.
 */
export function ReviewCard({ run }: { run: RunState }) {
  const { review, setReview, focus, setFocus } = useReview();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const act = async (key: string, fn: () => Promise<VideoReview>) => {
    setBusy(key);
    setError(undefined);
    try {
      setReview(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const copy = async () => {
    if (!review?.link) return;
    try {
      await navigator.clipboard.writeText(review.link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('No se pudo copiar: selecciona el link y cópialo a mano.');
    }
  };

  const kfOf = (i: number) => run.keyframes.find((k) => k.index === i);
  // Abiertas: pendientes y en curso; las resueltas y las archivadas (ADR-140), con «ver todas».
  const visible = (review?.comments ?? []).filter((c) => (showAll || (!c.resolvedAt && !c.archivedAt)) && (focus === undefined || c.keyframeIndex === focus));
  const groups = new Map<number, ReviewComment[]>();
  for (const c of visible) {
    const i = c.keyframeIndex ?? 0;
    groups.set(i, [...(groups.get(i) ?? []), c]);
  }
  const total = review?.comments.length ?? 0;

  return (
    <Card id="revision" className={cn('scroll-mt-4', review && review.open > 0 && 'border-warning/40')}>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="text-primary size-4" /> Revisión del cliente
            {review && review.open > 0 && <Badge variant="warning">{review.open} sin resolver</Badge>}
          </CardTitle>
          <CardDescription>
            Un link sin sesión con los fotogramas como slides y la locución de cada tramo: el cliente deja observaciones en cada fotograma y puede aprobar
            el storyboard. Muestra siempre los fotogramas vigentes. «Link nuevo» o «Desactivar» dejan sin efecto el anterior; las observaciones se
            conservan. Aquí también llegan las observaciones sobre el video terminado (link «Revisión de los videos» del proyecto), marcadas «Video».
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 text-xs">
        {!review ? (
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
        ) : (
          <>
            {review.link ? (
              <div className="flex flex-wrap items-center gap-2">
                <input readOnly value={review.link.url} onFocus={(e) => e.target.select()} className="bg-background h-8 min-w-0 flex-1 rounded-md border px-2 font-mono text-[11px]" />
                <Button size="sm" onClick={() => void copy()} disabled={!!busy}>
                  {copied ? <Check /> : <Copy />} {copied ? 'Copiado' : 'Copiar'}
                </Button>
                <Button asChild size="sm" variant="outline">
                  <a href={review.link.url} target="_blank" rel="noreferrer">
                    <ExternalLink /> Abrir
                  </a>
                </Button>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void act('new', () => reviewApi.createLink(run.id))}>
                  <RefreshCw /> Link nuevo
                </Button>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void act('off', () => reviewApi.removeLink(run.id))}>
                  <X /> Desactivar
                </Button>
              </div>
            ) : (
              <div>
                <Button size="sm" disabled={!!busy || !run.keyframes.some((k) => k.url)} onClick={() => void act('new', () => reviewApi.createLink(run.id))}>
                  {busy === 'new' ? <Loader2 className="animate-spin" /> : <Link2 />} Crear link de revisión
                </Button>
              </div>
            )}

            {review.approval && (
              <div className={cn('flex flex-wrap items-center gap-2 rounded-md border p-2.5', review.approval.outdated ? 'border-warning/40 bg-warning/10' : 'border-success/40 bg-success/10')}>
                <CheckCircle2 className={cn('size-4', review.approval.outdated ? 'text-warning' : 'text-success')} />
                <span className="font-medium">
                  Aprobado por {review.approval.author} · {fmt(review.approval.createdAt)}
                </span>
                {review.approval.outdated && <span className="text-warning">Sobre una versión anterior: cambió algún fotograma desde entonces.</span>}
              </div>
            )}

            {total > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Observaciones</span>
                {focus !== undefined && (
                  <button type="button" onClick={() => setFocus(undefined)} className="border-primary bg-primary/10 text-primary inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]">
                    {kLabel(focus)} <X className="size-3" />
                  </button>
                )}
                <button type="button" onClick={() => setShowAll((v) => !v)} className="text-primary ml-auto cursor-pointer text-[11px] hover:underline">
                  {showAll ? 'Solo sin resolver' : `Ver también las resueltas (${total - review.open})`}
                </button>
              </div>
            )}
            {total > 0 && groups.size === 0 && <p className="text-muted-foreground">{focus !== undefined ? `Nada pendiente en ${kLabel(focus)}.` : 'Todas las observaciones están resueltas.'}</p>}
            {[...groups.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([i, list]) => {
                const k = kfOf(i);
                return (
                  <div key={i} className="grid gap-2 rounded-lg border p-2.5 sm:grid-cols-[150px_1fr]">
                    <div className="grid content-start gap-1">
                      {k?.url ? <img src={k.url} alt={kLabel(i)} className="aspect-video w-full rounded-md border object-cover" loading="lazy" /> : <div className="bg-secondary aspect-video rounded-md" />}
                      <span className="font-mono text-[10.5px]">
                        {kLabel(i)}
                        {k && k.version > 1 ? ` · v${k.version}` : ''}
                      </span>
                    </div>
                    <div className="grid content-start gap-2">
                      {list.map((c) => (
                        <div key={c.id} className={cn('bg-background/50 rounded-md border p-2', (c.resolvedAt || c.archivedAt) && 'opacity-60')}>
                          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                            <span className="font-semibold">{c.author}</span>
                            <span className="text-muted-foreground">{fmt(c.createdAt)}</span>
                            {c.kind === 'video' && <Badge>Video</Badge>}
                            {c.outdated && <Badge variant="warning">{c.kind === 'video' ? 'Sobre un final anterior' : `Sobre v${c.keyframeVersion}`}</Badge>}
                            {c.resolvedAt && !c.archivedAt && <Badge variant="success">Resuelta</Badge>}
                            {c.archivedAt && <Badge variant="secondary">Archivada</Badge>}
                            {c.status === 'progress' && <Badge>En curso</Badge>}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="ml-auto h-6 px-2 text-[11px]"
                              disabled={!!busy}
                              onClick={() => void act(c.id, () => reviewApi.resolve(c.id, !c.resolvedAt))}
                            >
                              {busy === c.id ? <Loader2 className="animate-spin" /> : c.resolvedAt ? <RotateCcw /> : <Check />} {c.resolvedAt ? 'Reabrir' : 'Resuelta'}
                            </Button>
                          </div>
                          <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed">{c.text}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            {total === 0 && review.link && <p className="text-muted-foreground">Aún no hay observaciones del cliente.</p>}
          </>
        )}
        {error && <p className="text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
