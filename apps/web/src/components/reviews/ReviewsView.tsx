import { Archive, CheckCircle2, CircleDot, Clock, Copy, ExternalLink, Film, Image as ImageIcon, Loader2, MessageSquare, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReviewCommentStatus, ReviewInbox, ReviewInboxItem } from '@wilox/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { reviewApi } from '@/lib/api';
import { kLabel } from '@/lib/review';
import { REVIEWS_CHANGED_EVENT } from '@/lib/clip-open';
import { cn } from '@/lib/utils';
import { SeeAllToggle, useSeeAll } from '@/lib/see-all';

const fmt = (iso: string) => new Date(iso).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const STATUS: Record<ReviewCommentStatus, { label: string; icon: typeof Clock; tone: string }> = {
  pending: { label: 'Pendiente', icon: CircleDot, tone: 'text-warning border-warning/40 bg-warning/10' },
  progress: { label: 'En curso', icon: Clock, tone: 'text-primary border-primary/40 bg-primary/10' },
  resolved: { label: 'Resuelta', icon: CheckCircle2, tone: 'text-success border-success/40 bg-success/10' },
  archived: { label: 'Archivada', icon: Archive, tone: 'text-muted-foreground border-border bg-secondary' },
};
const ORDER: ReviewCommentStatus[] = ['pending', 'progress', 'resolved', 'archived'];

/** «Todas» no incluye las archivadas (ADR-140): solo se ven en su pestaña. */
type Filter = ReviewCommentStatus | 'open' | 'all';
const inTab = (f: Filter, s: ReviewCommentStatus) => (f === 'open' ? s === 'pending' || s === 'progress' : f === 'all' ? s !== 'archived' : s === f);
/** Texto para «Iguales» (ADR-140): sin diferencias de mayúsculas ni de espacios. */
const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
type KindFilter = 'all' | 'comment' | 'video';

/** Evento para refrescar el contador de la cabecera al cambiar un estado. */
const CHANGED = REVIEWS_CHANGED_EVENT;

/**
 * Lo que la lista recuerda al volver desde «Editar clip» (T11b): filtros, posición de la página y la observación de la
 * que se partió (se resalta un momento). Vive mientras la app esté abierta.
 */
const memo: { filter: Filter; project: string; kind: KindFilter; author: string; same?: string; scrollY?: number; focus?: string } = { filter: 'open', project: '', kind: 'all', author: '' };

/**
 * Pantalla «Observaciones» (T8, ADR-119): todas las observaciones del cliente de todos los proyectos (las del link de
 * aprobación del storyboard y las del link de revisión de los videos), con su miniatura, su estado (pendiente, en curso o
 * resuelta), filtros por estado, proyecto y tipo, y un salto al fotograma o clip para corregirlo.
 */
export function ReviewsView({ onGo }: { onGo: (generationId: string, keyframeIndex: number | undefined, kind: 'comment' | 'video') => void }) {
  const [inbox, setInbox] = useState<ReviewInbox>();
  const [filter, setFilterState] = useState<Filter>(memo.filter);
  const [project, setProjectState] = useState(memo.project);
  const [kind, setKindState] = useState<KindFilter>(memo.kind);
  const setFilter = (f: Filter) => setFilterState((memo.filter = f));
  const setProject = (p: string) => setProjectState((memo.project = p));
  const setKind = (k: KindFilter) => setKindState((memo.kind = k));
  // Autor y «Iguales» (ADR-140).
  const [author, setAuthorState] = useState(memo.author);
  const [same, setSameState] = useState<string | undefined>(memo.same);
  const setAuthor = (a: string) => setAuthorState((memo.author = a));
  const setSame = (t: string | undefined) => setSameState((memo.same = t));
  // Selección múltiple: se aplica a las marcadas que están a la vista.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** «Ir»: recuerda dónde estaba la lista para volver aquí al cerrar el editor. */
  const go = (it: ReviewInboxItem) => {
    memo.scrollY = window.scrollY;
    memo.focus = it.id;
    onGo(it.generationId, it.keyframeIndex, it.kind);
  };
  // Al volver: misma posición y la observación de la que se partió resaltada un momento.
  useEffect(() => {
    if (!inbox || memo.scrollY === undefined) return;
    const y = memo.scrollY;
    const focus = memo.focus;
    memo.scrollY = undefined;
    memo.focus = undefined;
    requestAnimationFrame(() => {
      window.scrollTo({ top: y });
      const el = focus ? document.getElementById(`obs-${focus}`) : null;
      if (el) {
        el.style.outline = '2px solid var(--color-warning, #f5b041)';
        el.style.outlineOffset = '2px';
        setTimeout(() => {
          el.style.outline = '';
          el.style.outlineOffset = '';
        }, 2500);
      }
    });
  }, [inbox]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  // «Ver los de todos» (hito 11): el admin ve también las de los proyectos de los demás.
  const seeAll = useSeeAll();
  const load = useCallback(() => {
    reviewApi.inbox(project || undefined, seeAll).then(
      (r) => {
        setInbox(r);
        setError(undefined);
      },
      (e: Error) => setError(e.message),
    );
  }, [project, seeAll]);
  useEffect(() => {
    load();
    const t = setInterval(() => !document.hidden && load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const setStatus = async (it: ReviewInboxItem, status: ReviewCommentStatus) => {
    if (it.status === status) return;
    setBusy(it.id);
    try {
      await reviewApi.setStatus(it.id, status);
      // Al instante en la lista; luego se recarga para las cuentas.
      setInbox((cur) => cur && { ...cur, items: cur.items.map((x) => (x.id === it.id ? { ...x, status } : x)) });
      window.dispatchEvent(new Event(CHANGED));
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  /** Varias a la vez (ADR-140): las marcadas que están a la vista. */
  const setStatusMany = async (ids: string[], status: ReviewCommentStatus) => {
    if (!ids.length) return;
    setBusy('batch');
    try {
      await reviewApi.setStatusMany(ids, status);
      const set = new Set(ids);
      setInbox((cur) => cur && { ...cur, items: cur.items.map((x) => (set.has(x.id) ? { ...x, status } : x)) });
      setSelected(new Set());
      window.dispatchEvent(new Event(CHANGED));
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  // Antes de «Iguales»: estado, tipo y autor. Con «Iguales», además el mismo texto.
  const base = useMemo(
    () => (inbox?.items ?? []).filter((x) => inTab(filter, x.status) && (kind === 'all' || x.kind === kind) && (!author || x.author === author)),
    [inbox, filter, kind, author],
  );
  const sameCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of base) m.set(norm(x.text), (m.get(norm(x.text)) ?? 0) + 1);
    return m;
  }, [base]);
  const items = useMemo(() => (same ? base.filter((x) => norm(x.text) === same) : base), [base, same]);
  const authors = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of inbox?.items ?? []) if (inTab(filter, x.status)) m.set(x.author, (m.get(x.author) ?? 0) + 1);
    return [...m].sort((a, b) => a[0].localeCompare(b[0], 'es'));
  }, [inbox, filter]);
  const visibleSelected = items.filter((x) => selected.has(x.id)).map((x) => x.id);
  const allSelected = items.length > 0 && visibleSelected.length === items.length;
  const toggle = (id: string) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  // Agrupadas por video (proyecto · video), los videos con lo más antiguo pendiente primero.
  const groups = useMemo(() => {
    const m = new Map<string, ReviewInboxItem[]>();
    for (const x of items) m.set(x.generationId, [...(m.get(x.generationId) ?? []), x]);
    for (const list of m.values()) list.sort((a, b) => (a.keyframeIndex ?? 0) - (b.keyframeIndex ?? 0) || a.createdAt.localeCompare(b.createdAt));
    return [...m.values()].sort((a, b) => a[0].projectName.localeCompare(b[0].projectName) || a[0].videoTitle.localeCompare(b[0].videoTitle));
  }, [items]);

  const c = inbox?.counts;
  const tabs: [Filter, string, number | undefined][] = [
    ['open', 'Abiertas', c && c.pending + c.progress],
    ['pending', 'Pendientes', c?.pending],
    ['progress', 'En curso', c?.progress],
    ['resolved', 'Resueltas', c?.resolved],
    ['all', 'Todas', c && c.pending + c.progress + c.resolved],
    ['archived', 'Archivadas', c?.archived],
  ];

  return (
    <main className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 pb-16 sm:px-6">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div className="grid gap-1.5">
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="text-primary size-4" /> Observaciones del cliente
            </CardTitle>
            <CardDescription>
              Todo lo que el cliente escribió en los links de revisión de tus proyectos y de los compartidos contigo: sobre el storyboard (aprobación) y sobre los videos terminados. Marca cada una como «En
              curso» mientras la corriges y «Resuelta» al terminar; «Archivada» guarda las que no son urgentes sin que estorben (solo se ven en su pestaña).
              «Filtrar iguales» junta las que tienen el mismo texto para cambiarlas todas de una vez; «Ir» abre el video en su fotograma o clip.
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <SeeAllToggle />
            <Button size="sm" variant="outline" onClick={load}>
              <RefreshCw /> Actualizar
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap rounded-lg border p-0.5">
              {tabs.map(([f, label, n]) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={cn('cursor-pointer rounded-md px-2.5 py-1 text-[12px] font-medium', filter === f ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground')}
                >
                  {label}
                  {n !== undefined && <span className="text-muted-foreground ml-1 tabular-nums">{n}</span>}
                </button>
              ))}
            </div>
            <select value={project} onChange={(e) => setProject(e.target.value)} className="bg-background h-8 max-w-[260px] rounded-md border px-2 text-[12px]">
              <option value="">Todos los proyectos</option>
              {inbox?.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.open ? ` · ${p.open} abiertas` : ''}
                </option>
              ))}
            </select>
            <select value={kind} onChange={(e) => setKind(e.target.value as KindFilter)} className="bg-background h-8 rounded-md border px-2 text-[12px]">
              <option value="all">Storyboard y video</option>
              <option value="comment">Solo storyboard</option>
              <option value="video">Solo video</option>
            </select>
            <select value={author} onChange={(e) => setAuthor(e.target.value)} className="bg-background h-8 max-w-[220px] rounded-md border px-2 text-[12px]" title="Autor">
              <option value="">Todos los autores</option>
              {author && !authors.some(([a]) => a === author) && <option value={author}>{author}</option>}
              {authors.map(([a, n]) => (
                <option key={a} value={a}>
                  {a} · {n}
                </option>
              ))}
            </select>
          </div>
          {same && (
            <div className="bg-secondary/50 flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5">
              <Copy className="text-primary size-3.5" />
              <span className="min-w-0 flex-1 truncate">
                Iguales a: <b>«{same.length > 120 ? `${same.slice(0, 118)}…` : same}»</b> · {items.length}
              </span>
              <button type="button" className="text-primary inline-flex cursor-pointer items-center gap-1 hover:underline" onClick={() => setSame(undefined)}>
                <X className="size-3.5" /> Quitar
              </button>
            </div>
          )}
          {items.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((x) => x.id)))} />
                Seleccionar todas ({items.length})
              </label>
              {visibleSelected.length > 0 && (
                <>
                  <span className="text-muted-foreground">· {visibleSelected.length} marcadas · marcar como</span>
                  {ORDER.map((st) => {
                    const S = STATUS[st];
                    return (
                      <Button key={st} size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={busy === 'batch'} onClick={() => void setStatusMany(visibleSelected, st)}>
                        {busy === 'batch' ? <Loader2 className="animate-spin" /> : <S.icon />} {S.label}
                      </Button>
                    );
                  })}
                  <button type="button" className="text-muted-foreground cursor-pointer hover:underline" onClick={() => setSelected(new Set())}>
                    Quitar selección
                  </button>
                </>
              )}
            </div>
          )}
          {error && <p className="text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {!inbox ? (
        <div className="grid place-items-center p-10">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground p-8 text-center text-sm">
            {filter === 'open' && !author && !same ? 'No hay observaciones abiertas. Todo al día.' : 'No hay observaciones con este filtro.'}
          </CardContent>
        </Card>
      ) : (
        groups.map((list) => {
          const first = list[0];
          const open = list.filter((x) => x.status === 'pending' || x.status === 'progress').length;
          return (
            <Card key={first.generationId}>
              <CardHeader className="flex-row items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="text-muted-foreground truncate text-[11px]">{first.projectName}</div>
                  <div className="truncate text-sm font-medium" title={first.videoTitle}>
                    {first.videoTitle}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {open > 0 && <Badge variant="warning">{open} abierta{open === 1 ? "" : "s"}</Badge>}
                  <Button size="sm" variant="outline" onClick={() => onGo(first.generationId, undefined, first.kind)}>
                    <ExternalLink /> Abrir el video
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="grid gap-2 pt-0">
                {list.map((it) => (
                  <Row
                    key={it.id}
                    it={it}
                    busy={busy === it.id}
                    checked={selected.has(it.id)}
                    onCheck={() => toggle(it.id)}
                    same={same ? 0 : (sameCount.get(norm(it.text)) ?? 1)}
                    onSame={() => {
                      setSame(norm(it.text));
                      setSelected(new Set());
                    }}
                    onStatus={(s) => void setStatus(it, s)}
                    onGo={() => go(it)}
                  />
                ))}
              </CardContent>
            </Card>
          );
        })
      )}
    </main>
  );
}

function Row({
  it,
  busy,
  checked,
  onCheck,
  same,
  onSame,
  onStatus,
  onGo,
}: {
  it: ReviewInboxItem;
  busy: boolean;
  checked: boolean;
  onCheck: () => void;
  /** Cuántas hay con el mismo texto en la vista (0 = ya filtrando por «Iguales»). */
  same: number;
  onSame: () => void;
  onStatus: (s: ReviewCommentStatus) => void;
  onGo: () => void;
}) {
  const label = it.kind === 'video' ? `Plano ${kLabel(it.keyframeIndex)}` : kLabel(it.keyframeIndex);
  return (
    <div
      id={`obs-${it.id}`}
      className={cn(
        'grid gap-3 rounded-lg border p-2.5 sm:grid-cols-[auto_160px_1fr_auto]',
        (it.status === 'resolved' || it.status === 'archived') && 'opacity-60',
        checked && 'border-primary/60 bg-primary/5',
      )}
    >
      <input type="checkbox" className="mt-1 size-4 cursor-pointer" checked={checked} onChange={onCheck} aria-label="Seleccionar" />
      <button type="button" onClick={onGo} className="group relative block cursor-pointer overflow-hidden rounded-md border text-left" title="Ir a este fotograma o clip">
        {it.thumb ? <img src={it.thumb} alt={label} loading="lazy" className="aspect-video w-full object-cover" /> : <div className="bg-secondary aspect-video w-full" />}
        <span className="absolute top-1 left-1 rounded bg-black/65 px-1.5 font-mono text-[10.5px] text-white">{kLabel(it.keyframeIndex)}</span>
      </button>
      <div className="grid min-w-0 content-start gap-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <Badge variant={it.kind === 'video' ? 'default' : 'secondary'}>
            {it.kind === 'video' ? <Film className="size-3" /> : <ImageIcon className="size-3" />} {it.kind === 'video' ? 'Video' : 'Storyboard'}
          </Badge>
          <span className="font-medium">{label}</span>
          <span className="font-semibold">{it.author}</span>
          <span className="text-muted-foreground">{fmt(it.createdAt)}</span>
          {it.outdated && (
            <Badge variant="warning">
              {it.kind === 'video' ? 'Sobre un final anterior' : `Sobre v${it.keyframeVersion}${it.currentVersion ? ` · hoy v${it.currentVersion}` : ''}`}
            </Badge>
          )}
        </div>
        <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{it.text}</p>
        {same > 1 && (
          <button type="button" onClick={onSame} className="text-primary inline-flex w-fit cursor-pointer items-center gap-1 text-[11px] hover:underline" title="Ver solo las observaciones con este mismo texto">
            <Copy className="size-3" /> Filtrar iguales ({same})
          </button>
        )}
      </div>
      <div className="flex flex-wrap content-start items-start gap-1.5 sm:w-[400px] sm:justify-end">
        <div className="flex rounded-md border p-0.5">
          {ORDER.map((s) => {
            const S = STATUS[s];
            const on = it.status === s;
            return (
              <button
                key={s}
                type="button"
                disabled={busy}
                onClick={() => onStatus(s)}
                className={cn('inline-flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-[11px] font-medium', on ? `border ${S.tone}` : 'text-muted-foreground hover:text-foreground border border-transparent')}
              >
                <S.icon className="size-3" /> {S.label}
              </button>
            );
          })}
        </div>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={onGo}>
          {busy ? <Loader2 className="animate-spin" /> : <ExternalLink />} Ir
        </Button>
      </div>
    </div>
  );
}

/** Indicador de la cabecera: observaciones pendientes y en curso (se consulta cada 30 s). */
export function ReviewsIndicator({ active, onClick }: { active: boolean; onClick: () => void }) {
  const [n, setN] = useState<{ pending: number; progress: number }>();
  useEffect(() => {
    let alive = true;
    const tick = () => reviewApi.count().then((r) => alive && setN(r), () => undefined);
    tick();
    const t = setInterval(() => !document.hidden && tick(), 30_000);
    window.addEventListener(CHANGED, tick);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener(CHANGED, tick);
    };
  }, []);
  return (
    <button
      type="button"
      onClick={onClick}
      title="Observaciones del cliente: pendientes · en curso"
      className={cn(
        'inline-flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
        active ? 'bg-secondary text-foreground' : 'bg-card/60 text-muted-foreground hover:text-foreground',
      )}
    >
      <span className="font-medium">Observaciones</span>
      {!!n?.pending && (
        <span className="text-warning inline-flex items-center gap-1 tabular-nums">
          <CircleDot className="size-3.5" /> {n.pending}
        </span>
      )}
      {!!n?.progress && (
        <span className="text-primary inline-flex items-center gap-1 tabular-nums">
          <Clock className="size-3.5" /> {n.progress}
        </span>
      )}
    </button>
  );
}
