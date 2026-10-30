import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Check,
  Clapperboard,
  Copy,
  Download,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Hourglass,
  Inbox,
  Loader2,
  PauseCircle,
  Pencil,
  PlayCircle,
  Search,
  Share2,
  Trash2,
  X,
  Globe,
  Mic,
  Crown,
  Users,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { TRASH_RETENTION_DAYS, type AuthUser, type DuplicateProjectResponse, type GenerationSummary, type HistoryResponse, type HistoryStatus, type HistoryTotals, type ProjectsResponse, type ProjectSummary, type RunStatus, voiceTrialLabel } from '@wilox/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ChangeCancelled } from '@/lib/confirm';
import { publishedText } from '@/lib/published';
import { trashChanged } from '@/lib/trash';
import { api, batchesApi, projectsApi } from '@/lib/api';
import { goTo, useBatches } from '@/lib/batches';
import { confirmSpend } from '@/lib/spend';
import { cn } from '@/lib/utils';
import { useVoiceName } from '@/lib/voices';
import { STATE_LABEL, askNotifications, useQueue } from '@/lib/queue';
import { ProjectLogoButton } from '@/components/delivery/ProjectDelivery';
import { ProjectDownloadDialog } from '@/components/downloads/ProjectDownloadDialog';
import { ProjectRevoiceDialog } from '@/components/projects/ProjectRevoiceDialog';
import { ProjectShareDialog } from '@/components/projects/ProjectShareDialog';
import { ProjectAccessDialog, userLabel } from '@/components/projects/ProjectAccessDialog';
import { SeeAllToggle, useSeeAll } from '@/lib/see-all';

/** Proyecto abierto: id, o '' = home de Proyectos. 'none' (antiguo "Sin proyecto") lleva a "Sin clasificar". */
export type ProjectFilter = string;

const field =
  'bg-background/60 border-input focus-visible:border-ring focus-visible:ring-ring/30 h-9 rounded-md border px-3 text-sm outline-none focus-visible:ring-2';

const dateFmt = new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium', timeStyle: 'short' });
const fmtDate = (iso?: string) => (iso ? dateFmt.format(new Date(iso)) : '—');
const fmtDur = (s: number) => {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m} min ${r} s` : `${r} s`;
};
const fmtUsd = (n: number) => n.toLocaleString('es-CL', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

const STATUS: Record<RunStatus, { label: string; variant: 'success' | 'warning' | 'destructive' | 'default' }> = {
  done: { label: 'Listo', variant: 'success' },
  awaiting_approval: { label: 'Esperando aprobación', variant: 'warning' },
  error: { label: 'Con error', variant: 'destructive' },
  queued: { label: 'En cola', variant: 'default' },
  voice: { label: 'Locución', variant: 'default' },
  timings: { label: 'Tiempos', variant: 'default' },
  storyboard: { label: 'Storyboard', variant: 'default' },
  keyframes: { label: 'Fotogramas', variant: 'default' },
  clips: { label: 'Clips', variant: 'default' },
  post: { label: 'SFX', variant: 'default' },
  render: { label: 'Render', variant: 'default' },
  paused: { label: 'Detenido', variant: 'default' },
};

function Totals({ t }: { t?: HistoryTotals }) {
  if (!t) return null;
  return (
    <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
      <span>
        <b className="text-foreground">{t.videos}</b> video{t.videos === 1 ? '' : 's'}
      </span>
      <span>
        <b className="text-foreground">{fmtDur(t.durationSec)}</b> de video
      </span>
      <span title="Lo gastado en los proveedores (USD)">
        <b className="text-foreground">{fmtUsd(t.costUsd)}</b>
      </span>
    </div>
  );
}

/**
 * De quién es y quién más lo ve (hito 11, ADR-142): «Compartido · de Ana», «Público», «Compartido con 2», «de Ana»
 * (el admin viendo lo de todos) y «suspendido» si el dueño lo está.
 */
function AccessBadges({ p, overlay }: { p: ProjectSummary; overlay?: boolean }) {
  const a = p.access;
  const cls = overlay ? 'bg-background/80 backdrop-blur' : undefined;
  const owner = userLabel(a.owner);
  const out: ReactNode[] = [];
  if (a.role !== 'owner')
    out.push(
      <Badge key="owner" variant={a.owner.active ? 'secondary' : 'destructive'} className={cls} title={`Dueño: ${owner}${a.owner.active ? '' : ' (suspendido)'}`}>
        <Crown /> {owner}
        {a.owner.active ? '' : ' · suspendido'}
      </Badge>,
    );
  if (a.public)
    out.push(
      <Badge key="pub" variant="default" className={cls} title="Público: lo ven y lo gestionan todos los usuarios de la app">
        <Globe /> Público
      </Badge>,
    );
  else if (a.role === 'shared')
    out.push(
      <Badge key="sh" variant="default" className={cls} title="Compartido contigo">
        <Users /> Compartido
      </Badge>,
    );
  else if (a.shared > 0)
    out.push(
      <Badge key="n" variant="default" className={cls} title={`Compartido con ${a.shared} usuario${a.shared === 1 ? '' : 's'}`}>
        <Users /> {a.shared}
      </Badge>,
    );
  return <>{out}</>;
}

function NewProjectForm({ onCreated, onCancel }: { onCreated: (p: ProjectSummary) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onCreated(await projectsApi.create(name, description || undefined));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="grid gap-2 rounded-lg border p-3">
      <input autoFocus placeholder="Nombre (curso, lección, cliente…)" value={name} onChange={(e) => setName(e.target.value)} className={field} />
      <input placeholder="Descripción (opcional)" value={description} onChange={(e) => setDescription(e.target.value)} className={field} />
      {error && <p className="text-destructive text-xs">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={busy || name.trim().length < 2}>
          {busy ? <Loader2 className="animate-spin" /> : <Check />} Crear
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function ProjectHeader({
  project,
  me,
  onChanged,
  onGenerate,
  onDeleted,
  onDuplicated,
}: {
  project: ProjectSummary;
  me: AuthUser;
  onChanged: (p: ProjectSummary) => void;
  onGenerate: () => void;
  onDeleted: () => void;
  onDuplicated: (r: DuplicateProjectResponse) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [revoicing, setRevoicing] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  // Hito 11 (ADR-142): papelera, archivo y compartir son del dueño (compartir, también del admin).
  const isOwner = project.access.role === 'owner';
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setName(project.name);
    setDescription(project.description ?? '');
    setEditing(false);
    setConfirmDelete(false);
  }, [project.id, project.name, project.description]);

  // Detener / reanudar los videos sin final del proyecto (hito 5, ADR-052). Los que tienen final no cuentan.
  const { overview } = useQueue();
  const mine = overview?.videos.filter((v) => v.projectId === project.id) ?? [];
  const activeN = mine.filter((v) => v.state !== 'paused').length;
  const stoppedN = mine.filter((v) => v.state === 'paused').length;
  const [info, setInfo] = useState<string>();
  const toggleAll = async (stop: boolean) => {
    if (
      !stop &&
      !(await confirmSpend({
        title: `Reanudar ${stoppedN} video${stoppedN === 1 ? '' : 's'} detenido${stoppedN === 1 ? '' : 's'}`,
        body: 'Vuelven a la cola con su prioridad y siguen desde donde quedaron; lo ya hecho no se vuelve a pagar.',
        workNote: 'Genera lo que quede pendiente de cada video (locución, fotogramas o clips).',
        action: 'Reanudar',
      }))
    )
      return;
    setBusy(true);
    setError(undefined);
    setInfo(undefined);
    try {
      if (stop) {
        const r = await projectsApi.pause(project.id);
        setInfo(r.paused ? `${r.paused} video${r.paused === 1 ? '' : 's'} detenido${r.paused === 1 ? '' : 's'}.` : 'No hay videos sin final que detener.');
      } else {
        const r = await projectsApi.resume(project.id);
        setInfo(`${r.resumed} video${r.resumed === 1 ? '' : 's'} vuelve${r.resumed === 1 ? '' : 'n'} a la cola.`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Eliminar (T3d, ADR-106): el proyecto va a la papelera con sus videos (se restaura durante 180 días). */
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await projectsApi.remove(project.id);
      trashChanged();
      onDeleted();
    } catch (err) {
      if (!(err instanceof ChangeCancelled)) setError((err as Error).message);
      setConfirmDelete(false);
      setBusy(false);
    }
  };

  /** Duplicar (T3e, ADR-107): «(copia)» con el mismo logo y sus videos, sin costo; luego se le cambia el logo. */
  const duplicate = async () => {
    const n = project.totals.videos;
    if (
      !window.confirm(
        `¿Duplicar «${project.name}»? Se crea «${project.name} (copia)» con el mismo logo y una copia de ${n === 1 ? 'su video' : `sus ${n} videos`}, sin costo. Después puedes cambiarle el logo sin tocar el original.`,
      )
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      onDuplicated(await projectsApi.duplicate(project.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async (body: Parameters<typeof projectsApi.update>[1]) => {
    setBusy(true);
    setError(undefined);
    try {
      onChanged(await projectsApi.update(project.id, body));
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      {editing ? (
        <form
          className="grid w-full max-w-lg gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ name, description: description || null });
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} className={field} autoFocus />
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Descripción" className={field} />
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={busy || name.trim().length < 2}>
              <Check /> Guardar
            </Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setEditing(false)}>
              <X /> Cancelar
            </Button>
          </div>
        </form>
      ) : (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {project.unclassified && <Inbox className="text-primary size-4.5 shrink-0" />}
            <h2 className="truncate text-lg font-semibold tracking-tight">{project.name}</h2>
            {project.unclassified && <Badge variant="secondary">Fijo</Badge>}
            {project.archived && <Badge variant="secondary">Archivado</Badge>}
            <AccessBadges p={project} />
          </div>
          {!isOwner && (
            <p className="text-muted-foreground mt-0.5 text-xs">
              {project.access.role === 'shared'
                ? `Proyecto de ${userLabel(project.access.owner)}, compartido contigo.`
                : project.access.role === 'public'
                  ? `Proyecto público de ${userLabel(project.access.owner)}.`
                  : `Proyecto de ${userLabel(project.access.owner)}${project.access.owner.active ? '' : ' (suspendido)'}: lo ves como administrador.`}{' '}
              Puedes gestionarlo todo; la papelera, el archivo y con quién se comparte son de su dueño.
            </p>
          )}
          {project.description && <p className="text-muted-foreground mt-0.5 text-sm">{project.description}</p>}
          {project.defaults?.voiceId && (
            <p className="text-muted-foreground mt-1 text-xs" title="La voz del último video: la que hereda un video nuevo del proyecto">
              <VoiceName id={project.defaults.voiceId} /> <span className="opacity-70">· voz del proyecto</span>
            </p>
          )}
        </div>
      )}
      {!editing && (
        <div className="flex flex-wrap gap-2">
          {!project.archived && (
            <Button size="sm" onClick={onGenerate}>
              <Clapperboard /> Nuevo video aquí
            </Button>
          )}
          {activeN > 0 && (
            <Button size="sm" variant="outline" onClick={() => void toggleAll(true)} disabled={busy} title="Saca de la cola los videos de este proyecto que aún no tienen final">
              <PauseCircle /> Detener en curso
            </Button>
          )}
          {stoppedN > 0 && (
            <Button size="sm" variant="outline" onClick={() => void toggleAll(false)} disabled={busy} title="Vuelven a la cola con su prioridad y siguen desde donde quedaron">
              <PlayCircle /> Reanudar detenidos ({stoppedN})
            </Button>
          )}
          <ProjectLogoButton project={project} />
          <Button size="sm" variant="outline" disabled={!project.totals.videos} onClick={() => setRevoicing(true)} title="Volver a locutar varios videos en un solo pedido cada uno, con la misma voz: sin cambios de tono entre párrafos">
            <Mic /> Rehacer la locución
          </Button>
          <Button size="sm" variant="outline" disabled={!project.totals.videos} onClick={() => setDownloading(true)} title="Todo el proyecto en un paquete (ZIP o SCORM) o un archivo por video">
            <Download /> Descargar
          </Button>
          <Button size="sm" variant="outline" disabled={!project.totals.videos} onClick={() => setSharing(true)} title="Un link para el cliente: la revisión de cada video y los videos terminados">
            <Share2 /> Compartir
          </Button>
          {(!project.unclassified || me.role === 'admin') && (
            <Button size="sm" variant="outline" onClick={() => setAccessOpen(true)} title="Con qué usuarios de la app se comparte este proyecto, o hacerlo público para todos">
              <Users /> Acceso
            </Button>
          )}
          {/* "Sin clasificar" es fijo (ADR-035): no se renombra ni se archiva. */}
          {!project.unclassified && (
            <>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <Pencil /> Editar
              </Button>
              <Button size="sm" variant="outline" disabled={busy || (!!project.copying && project.copying.done + project.copying.failed < project.copying.total)} onClick={() => void duplicate()} title="Copia del proyecto con sus videos, sin costo (p. ej. para otro logo)">
                <Copy /> Duplicar
              </Button>
              {isOwner && (
                <>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => save({ archived: !project.archived })}>
                    {project.archived ? <ArchiveRestore /> : <Archive />} {project.archived ? 'Desarchivar' : 'Archivar'}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDelete(true)} title="Eliminar el proyecto">
                    <Trash2 /> Eliminar
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      )}
      {confirmDelete && (
        <div className="border-destructive/30 bg-destructive/10 flex w-full flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm">
          <span>
            ¿Eliminar el proyecto <b>{project.name}</b>
            {project.totals.videos > 0 ? ` y sus ${project.totals.videos} video${project.totals.videos === 1 ? '' : 's'}` : ''}? Va a la papelera: puedes
            restaurarlo durante {TRASH_RETENTION_DAYS} días.
          </span>
          <span className="flex gap-2">
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>
              {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} Mandar a la papelera
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>
              Cancelar
            </Button>
          </span>
        </div>
      )}
      {error && <p className="text-destructive w-full text-xs">{error}</p>}
      {info && <p className="text-muted-foreground w-full text-xs">{info}</p>}
      {downloading && <ProjectDownloadDialog project={project} onClose={() => setDownloading(false)} />}
      {sharing && <ProjectShareDialog project={project} onClose={() => setSharing(false)} />}
      {revoicing && <ProjectRevoiceDialog project={project} onClose={() => setRevoicing(false)} onStarted={askNotifications} />}
      {accessOpen && <ProjectAccessDialog project={project} me={me} onClose={() => setAccessOpen(false)} onChanged={() => onChanged(project)} />}
    </div>
  );
}

function VideoCard({
  g: initial,
  projects,
  project,
  onOpen,
  onMoved,
  onRemoved,
  onDuplicated,
  order,
}: {
  g: GenerationSummary;
  projects: ProjectSummary[];
  /** Su proyecto: la papelera es del dueño (hito 11, ADR-142). */
  project: ProjectSummary;
  onOpen: (id: string) => void;
  onMoved: (g: GenerationSummary) => void;
  onRemoved: (id: string) => void;
  onDuplicated: (g: GenerationSummary) => void;
  /** Lugar en el proyecto y cambiarlo a mano, de a uno (ADR-162); sin el campo (con filtros), no se muestra. */
  order?: { position: number; first: boolean; last: boolean; move: (direction: 'earlier' | 'later') => Promise<void> };
}) {
  const [moving, setMoving] = useState(false);
  const [dup, setDup] = useState(false);
  const [info, setInfo] = useState<'zip'>();
  const { refresh: refreshBatches } = useBatches();
  const [dupTarget, setDupTarget] = useState(initial.projectId);
  const [error, setError] = useState<string>();
  // Estado en vivo desde la cola (hito 5): fase y posición en la cola global. Al salir de la cola
  // (terminado) se vuelve a pedir la fila para ver su miniatura, duración y costo finales.
  const live = useQueue().byId.get(initial.id);
  const [fresh, setFresh] = useState<GenerationSummary>();
  const wasLive = useRef(false);
  useEffect(() => {
    if (live) wasLive.current = true;
    else if (wasLive.current) {
      wasLive.current = false;
      api.summary(initial.id).then(setFresh, () => undefined);
    }
  }, [live, initial.id]);
  useEffect(() => setFresh(undefined), [initial]);
  const g = fresh ?? initial;
  const st = live ? { label: `${STATE_LABEL[live.state]}${live.position ? ` · n.º ${live.position}` : ''}`, variant: live.state === 'awaiting' ? ('warning' as const) : live.state === 'error' ? ('destructive' as const) : ('default' as const) } : STATUS[g.status];
  const move = async (value: string) => {
    setMoving(true);
    setError(undefined);
    try {
      onMoved(await api.move(g.id, value));
    } catch (err) {
      if (!(err instanceof ChangeCancelled)) setError((err as Error).message);
    } finally {
      setMoving(false);
    }
  };
  /** Eliminar (T3d, ADR-106): va a la papelera; si está publicado, el servidor avisa que primero hay que despublicar. */
  const remove = async () => {
    if (!g.published && !window.confirm(`¿Eliminar este video? Va a la papelera: puedes restaurarlo durante ${TRASH_RETENTION_DAYS} días.`)) return;
    setMoving(true);
    setError(undefined);
    try {
      await api.trashVideo(g.id);
      trashChanged();
      onRemoved(g.id);
    } catch (err) {
      if (!(err instanceof ChangeCancelled)) setError((err as Error).message);
    } finally {
      setMoving(false);
    }
  };
  /** ZIP completo (T5a, ADR-109): se arma en «Descargas», como todas las descargas. */
  const zip = async () => {
    setMoving(true);
    setError(undefined);
    setInfo(undefined);
    try {
      await batchesApi.create({ projectId: g.projectId, format: 'zip', videoIds: [g.id] });
      askNotifications();
      refreshBatches();
      setInfo('zip');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setMoving(false);
    }
  };

  /** Duplicar (T3e, ADR-107): sin costo, en este proyecto o en otro (toma el logo del proyecto donde queda). */
  const duplicate = async () => {
    setMoving(true);
    setError(undefined);
    try {
      onDuplicated(await api.duplicate(g.id, dupTarget === g.projectId ? undefined : dupTarget));
      setDup(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setMoving(false);
    }
  };
  const targetName = projects.find((p) => p.id === dupTarget)?.name ?? 'este proyecto';
  return (
    <Card className="flex flex-col overflow-hidden">
      <button type="button" onClick={() => onOpen(g.id)} className="group relative block aspect-video cursor-pointer bg-black/40">
        {g.thumbnailUrl ? (
          <img src={g.thumbnailUrl} alt="" loading="lazy" className="size-full object-cover transition-opacity group-hover:opacity-90" />
        ) : (
          <span className="text-muted-foreground grid size-full place-items-center text-xs">Sin fotogramas</span>
        )}
        <span className="absolute top-2 left-2">
          <Badge variant={st.variant} className="bg-background/80 backdrop-blur">
            {st.label}
          </Badge>
        </span>
        {g.published && (
          <span className="absolute top-2 right-2">
            <Badge variant="success" className="bg-background/80 backdrop-blur" title={`Publicado: ${publishedText(g.published)}. Sus cambios los verá el cliente.`}>
              <Globe /> Publicado
            </Badge>
          </span>
        )}
        {g.durationSec !== undefined && (
          <span className="bg-background/80 absolute right-2 bottom-2 rounded px-1.5 py-0.5 font-mono text-[11px] backdrop-blur">{fmtDur(g.durationSec)}</span>
        )}
      </button>
      <CardContent className="flex flex-1 flex-col gap-2 py-3">
        <p className="line-clamp-2 text-sm leading-snug">{g.textPreview}</p>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          <span>{g.themeName ?? g.theme}</span>·{g.voiceId && <><VoiceName id={g.voiceId} />·</>}<span>{fmtDate(g.createdAt)}</span>·
          <span title="Lo gastado en los proveedores (USD)">{fmtUsd(g.costUsd)}</span>
          {g.mode !== 'mcp' && <Badge variant="secondary">{g.mode.toUpperCase()}</Badge>}
          {g.parentId && (
            <span className="inline-flex items-center gap-1" title={`Versión de ${g.parentId}`}>
              <GitBranch className="size-3" /> versión
            </span>
          )}
          {g.copyOf && (
            <span className="inline-flex items-center gap-1" title={`Duplicado de ${g.copyOf}`}>
              <Copy className="size-3" /> copia
            </span>
          )}
          {order && (
            <span className="ml-auto inline-flex items-center gap-0.5" title="Lugar del video en el proyecto">
              <button
                type="button"
                disabled={order.first || moving}
                onClick={() => void order.move('earlier').catch((e: Error) => setError(e.message))}
                className="hover:text-foreground cursor-pointer rounded p-0.5 disabled:cursor-default disabled:opacity-30"
                title="Mover antes"
                aria-label="Mover antes"
              >
                <ChevronLeft className="size-3.5" />
              </button>
              <span className="min-w-5 text-center font-mono">{order.position}</span>
              <button
                type="button"
                disabled={order.last || moving}
                onClick={() => void order.move('later').catch((e: Error) => setError(e.message))}
                className="hover:text-foreground cursor-pointer rounded p-0.5 disabled:cursor-default disabled:opacity-30"
                title="Mover después"
                aria-label="Mover después"
              >
                <ChevronRight className="size-3.5" />
              </button>
            </span>
          )}
          {g.voiceTrial && (
            <Badge variant="warning" title="Copia hecha para la prueba de voz (hito 10)">
              Prueba de voz · {voiceTrialLabel(g.voiceTrial)}
            </Badge>
          )}
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" onClick={() => onOpen(g.id)}>
            <FolderOpen /> Abrir
          </Button>
          <Button size="sm" variant="outline" disabled={moving} onClick={() => void zip()} title="ZIP completo (final, clips, voz, fotogramas y prompts): se arma en «Descargas»">
            <Download /> ZIP
          </Button>
          <select
            value={g.projectId}
            disabled={moving}
            onChange={(e) => void move(e.target.value)}
            className={cn(field, 'h-8 min-w-0 flex-1 cursor-pointer px-2 text-xs')}
            title="Mover a otro proyecto"
          >
            {projects
              // Hito 11 (ADR-142): sacarlo hacia un proyecto de otro dueño es solo del dueño de este proyecto.
              .filter((p) => (!p.archived || p.id === g.projectId) && (project.access.role === 'owner' || p.access.owner.id === project.access.owner.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          <Button size="sm" variant="ghost" disabled={moving} onClick={() => (setDupTarget(g.projectId), setDup((v) => !v))} title="Duplicar (sin costo; p. ej. para otro logo)" className="px-2">
            <Copy />
          </Button>
          {project.access.role === 'owner' && (
            <Button size="sm" variant="ghost" disabled={moving} onClick={() => void remove()} title="Eliminar (va a la papelera)" className="px-2">
              <Trash2 />
            </Button>
          )}
        </div>
        {dup && (
          <div className="bg-secondary/40 grid gap-2 rounded-lg border p-2.5 text-xs">
            <div className="font-medium">Duplicar este video</div>
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground shrink-0">Queda en</span>
              <select value={dupTarget} disabled={moving} onChange={(e) => setDupTarget(e.target.value)} className={cn(field, 'h-8 min-w-0 flex-1 cursor-pointer px-2 text-xs')}>
                {projects
                  .filter((p) => !p.archived)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.id === g.projectId ? ' (este)' : ''}
                    </option>
                  ))}
              </select>
            </label>
            <p className="text-muted-foreground leading-snug">
              Sin costo: copia los fotogramas, los clips, la locución y el final. El duplicado lleva el logo de «{targetName}». No copia publicaciones, links ni
              observaciones del cliente.
            </p>
            <div className="flex gap-2">
              <Button size="sm" disabled={moving} onClick={() => void duplicate()}>
                {moving ? <Loader2 className="animate-spin" /> : <Copy />} Duplicar
              </Button>
              <Button size="sm" variant="ghost" disabled={moving} onClick={() => setDup(false)}>
                Cancelar
              </Button>
            </div>
          </div>
        )}
        {info === 'zip' && (
          <p className="text-muted-foreground text-xs">
            ZIP completo en preparación.{' '}
            <button type="button" className="text-primary cursor-pointer hover:underline" onClick={() => goTo('descargas')}>
              Ver descargas
            </button>
          </p>
        )}
        {error && <p className="text-destructive text-xs">{error}</p>}
      </CardContent>
    </Card>
  );
}

/** Sin tildes ni mayúsculas, para filtrar proyectos por nombre. */
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

/** Tarjeta de la home: miniatura del último video, número de videos, duración, costo en USD y fecha del último video. */
function ProjectCard({ p, onOpen }: { p: ProjectSummary; onOpen: () => void }) {
  const t = p.totals;
  // Videos de este proyecto que esperan mi aprobación (hito 5): para encontrarlos rápido en una lista larga.
  const { overview } = useQueue();
  const awaiting = overview?.videos.filter((v) => v.projectId === p.id && v.state === 'awaiting').length ?? 0;
  const stopped = overview?.videos.filter((v) => v.projectId === p.id && v.state === 'paused').length ?? 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group bg-card text-card-foreground flex cursor-pointer flex-col overflow-hidden rounded-xl border text-left transition-colors hover:border-white/20',
        p.unclassified && 'border-dashed',
      )}
    >
      <div className="relative aspect-video bg-black/40">
        {p.thumbnailUrl ? (
          <img src={p.thumbnailUrl} alt="" loading="lazy" className="size-full object-cover transition-opacity group-hover:opacity-90" />
        ) : (
          <span className="text-muted-foreground grid size-full place-items-center">
            {p.unclassified ? <Inbox className="size-7 opacity-60" /> : <FolderOpen className="size-7 opacity-60" />}
          </span>
        )}
        <span className="absolute top-2 left-2 flex gap-1.5">
          {p.unclassified && (
            <Badge variant="secondary" className="bg-background/80 backdrop-blur">
              <Inbox /> Fijo
            </Badge>
          )}
          {p.archived && (
            <Badge variant="secondary" className="bg-background/80 backdrop-blur">
              <Archive /> Archivado
            </Badge>
          )}
          <AccessBadges p={p} overlay />
        </span>
        {(awaiting > 0 || stopped > 0) && (
          <span className="absolute top-2 right-2 flex gap-1.5">
            {stopped > 0 && (
              <span
                className="bg-background/85 text-muted-foreground inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-semibold tabular-nums backdrop-blur"
                title={`${stopped} video${stopped === 1 ? '' : 's'} detenido${stopped === 1 ? '' : 's'}`}
              >
                <PauseCircle className="size-3.5" /> {stopped}
              </span>
            )}
            {awaiting > 0 && (
              <span
                className="bg-background/85 text-warning border-warning/40 inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-semibold tabular-nums backdrop-blur"
                title={`${awaiting} video${awaiting === 1 ? '' : 's'} esperando tu aprobación`}
              >
                <Hourglass className="size-3.5" /> {awaiting}
              </span>
            )}
          </span>
        )}
        {t.videos > 0 && (
          <span className="bg-background/80 absolute right-2 bottom-2 rounded px-1.5 py-0.5 font-mono text-[11px] backdrop-blur">{fmtDur(t.durationSec)}</span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 px-4 py-3">
        <div className="truncate text-sm font-semibold tracking-tight">{p.name}</div>
        {p.description && <p className="text-muted-foreground line-clamp-2 text-xs leading-snug">{p.description}</p>}
        <div className="text-muted-foreground mt-auto flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-1 text-[11px]">
          <span>
            <b className="text-foreground">{t.videos}</b> video{t.videos === 1 ? '' : 's'}
          </span>
          {p.published ? (
            <span className="text-success inline-flex items-center gap-1" title="Videos publicados (Rise 360, SCORM liviano o a mano): sus cambios los verá el cliente">
              <Globe className="size-3" /> {p.published} publicado{p.published === 1 ? '' : 's'}
            </span>
          ) : null}
          {t.videos > 0 && (
            <>
              ·<span title="Lo gastado en los proveedores (USD)">{fmtUsd(t.costUsd)}</span>
            </>
          )}
        </div>
        <div className="text-muted-foreground text-[11px]">{p.lastVideoAt ? `Último video: ${fmtDate(p.lastVideoAt)}` : 'Aún sin videos'}</div>
      </div>
    </button>
  );
}

/** Home de Proyectos (hito 4, ADR-036): solo proyectos, "Sin clasificar" primero y fijo. */
function ProjectsHome({
  data,
  me,
  error,
  onOpen,
  onCreated,
}: {
  data?: ProjectsResponse;
  me: AuthUser;
  error?: string;
  onOpen: (id: string) => void;
  onCreated: (p: ProjectSummary) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  // Hito 11 (ADR-142): filtro por dueño (útil con «Ver los de todos» o con muchos proyectos compartidos).
  const [owner, setOwner] = useState('');
  const seeAll = useSeeAll();
  // El «Sin clasificar» vacío de otro usuario (el admin viendo los de todos) no aporta nada en la home.
  const all = (data?.projects ?? []).filter((p) => !(p.unclassified && p.access.role !== 'owner' && !p.totals.videos));
  const owners = useMemo(() => {
    const m = new Map<string, { id: string; label: string; active: boolean; n: number }>();
    for (const p of all) {
      const o = m.get(p.access.owner.id) ?? { id: p.access.owner.id, label: userLabel(p.access.owner), active: p.access.owner.active, n: 0 };
      o.n += 1;
      m.set(o.id, o);
    }
    return [...m.values()].sort((a, b) => Number(b.id === me.id) - Number(a.id === me.id) || a.label.localeCompare(b.label));
  }, [all, me.id]);
  useEffect(() => {
    if (owner && !owners.some((o) => o.id === owner)) setOwner('');
  }, [owner, owners]);
  const archived = all.filter((p) => p.archived).length;
  const needle = fold(q.trim());
  const list = all.filter((p) => (showArchived || !p.archived) && (!needle || fold(p.name).includes(needle)) && (!owner || p.access.owner.id === owner));
  const own = all.filter((p) => !p.unclassified && !p.archived).length;

  return (
    <main className="mx-auto flex max-w-[1400px] flex-col gap-5 px-4 pb-16 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Proyectos</h1>
          <p className="text-muted-foreground mt-0.5 text-sm">
            {data
              ? `${own} proyecto${own === 1 ? '' : 's'} y «Sin clasificar» · ${data.all.videos} video${data.all.videos === 1 ? '' : 's'} · ${fmtDur(data.all.durationSec)} de video`
              : 'Cargando…'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SeeAllToggle />
          {owners.length > 1 && (
            <select value={owner} onChange={(e) => setOwner(e.target.value)} className={cn(field, 'cursor-pointer')} title="Dueño del proyecto">
              <option value="">{seeAll ? 'Todos los usuarios' : 'Míos y compartidos'}</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.id === me.id ? 'Míos' : `De ${o.label}`}
                  {o.active ? '' : ' (suspendido)'} · {o.n}
                </option>
              ))}
            </select>
          )}
          {all.length > 6 && (
            <label className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar proyecto" className={cn(field, 'w-52 pl-8')} />
            </label>
          )}
          {archived > 0 && (
            <label className="text-muted-foreground flex cursor-pointer items-center gap-1.5 px-1 text-xs">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="accent-primary" /> Archivados ({archived})
            </label>
          )}
          <Button size="sm" onClick={() => setCreating(true)} disabled={creating}>
            <FolderPlus /> Nuevo proyecto
          </Button>
        </div>
      </div>
      {creating && (
        <div className="max-w-md">
          <NewProjectForm
            onCreated={(p) => {
              setCreating(false);
              onCreated(p);
            }}
            onCancel={() => setCreating(false)}
          />
        </div>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}
      {!data && !error && (
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 className="size-3.5 animate-spin" /> Cargando proyectos…
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {list.map((p) => (
          <ProjectCard key={p.id} p={p} onOpen={() => onOpen(p.id)} />
        ))}
      </div>
      {data && needle && !list.length && <p className="text-muted-foreground text-sm">Ningún proyecto se llama así.</p>}
    </main>
  );
}

/** Un proyecto abierto: lo que hacía la pantalla Proyectos del hito 3 (ADR-032), solo con sus videos. */
function ProjectDetail({
  project,
  projects,
  me,
  onBack,
  onChanged,
  onDeleted,
  onOpen,
  onGenerate,
  onDuplicated: onDuplicatedProject,
  notice,
}: {
  project: ProjectSummary;
  projects: ProjectSummary[];
  me: AuthUser;
  onBack: () => void;
  onChanged: () => void;
  onDeleted: () => void;
  onOpen: (id: string) => void;
  onGenerate: () => void;
  onDuplicated: (r: DuplicateProjectResponse) => void;
  /** Aviso al abrir (p. ej. tras duplicar el proyecto). */
  notice?: string;
}) {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [theme, setTheme] = useState('');
  const [status, setStatus] = useState<HistoryStatus | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<HistoryResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  // Duplicando (T3e, ADR-107): se refresca el proyecto cada 3 s y la lista cada vez que llega un video copiado.
  const copying = project.copying;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!copying) return;
    const t = setInterval(onChanged, 3000);
    return () => clearInterval(t);
  }, [!!copying, onChanged]);
  useEffect(() => {
    if (copying) setTick((t) => t + 1);
  }, [copying?.done]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const query = useMemo(
    () => ({ q: debouncedQ || undefined, project: project.id, theme: theme || undefined, status: status || undefined, from: from || undefined, to: to || undefined }),
    [debouncedQ, project.id, theme, status, from, to],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.history({ ...query, limit: 30 }).then(
      (r) => !cancelled && (setData(r), setError(undefined), setLoading(false)),
      (e: Error) => !cancelled && (setError(e.message), setLoading(false)),
    );
    return () => {
      cancelled = true;
    };
  }, [query, tick]);

  const more = async () => {
    if (!data) return;
    setLoading(true);
    try {
      const r = await api.history({ ...query, offset: data.items.length, limit: 30 });
      setData({ ...r, items: [...data.items, ...r.items] });
    } finally {
      setLoading(false);
    }
  };

  /** Al moverlo a otro proyecto, el video sale de esta lista. */
  const onMoved = (g: GenerationSummary) => {
    setData((d) => (d ? { ...d, items: d.items.filter((x) => x.id !== g.id || g.projectId === project.id), total: d.total - (g.projectId === project.id ? 0 : 1) } : d));
    onChanged();
  };

  /**
   * Duplicado en este proyecto: va al final (los videos del proyecto van en secuencia, el más antiguo primero, ADR-160);
   * si aún no está cargado el final de la lista, solo cambia el total. En otro proyecto, solo cambian los totales.
   */
  const onDuplicated = (g: GenerationSummary) => {
    if (g.projectId === project.id) setData((d) => (d ? { ...d, items: d.items.length >= d.total ? [...d.items, g] : d.items, total: d.total + 1 } : d));
    onChanged();
  };

  /**
   * Cambiar el lugar de un video, de a uno (ADR-162): se intercambia con el de al lado; si el vecino no está cargado
   * (más allá de «Cargar más»), se vuelve a pedir la lista.
   */
  const moveVideo = async (id: string, direction: 'earlier' | 'later') => {
    const r = await api.moveVideo(id, direction);
    if (!r.swappedWith) return;
    setData((d) => {
      if (!d) return d;
      const i = d.items.findIndex((x) => x.id === id);
      const j = d.items.findIndex((x) => x.id === r.swappedWith);
      if (i < 0 || j < 0) {
        setTick((t) => t + 1);
        return d;
      }
      const items = [...d.items];
      [items[i], items[j]] = [items[j], items[i]];
      return { ...d, items };
    });
  };

  /** Al mandarlo a la papelera, el video sale de esta lista. */
  const onRemoved = (id: string) => {
    setData((d) => (d ? { ...d, items: d.items.filter((x) => x.id !== id), total: d.total - 1 } : d));
    onChanged();
  };

  const filtered = !!(debouncedQ || theme || status || from || to);

  return (
    <main className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 pb-16 sm:px-6">
      <div>
        <Button size="sm" variant="ghost" onClick={onBack} className="-ml-2">
          <ArrowLeft /> Proyectos
        </Button>
      </div>
      <Card>
        <CardContent className="flex flex-col gap-4">
          <ProjectHeader project={project} me={me} onChanged={onChanged} onGenerate={onGenerate} onDeleted={onDeleted} onDuplicated={onDuplicatedProject} />
          {notice && <p className="text-muted-foreground -mt-2 text-xs">{notice}</p>}
          {copying && (
            <div className="bg-secondary/40 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
              {copying.done + copying.failed < copying.total ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="text-primary size-3.5" />}
              {copying.done + copying.failed < copying.total
                ? `Copiando los videos del proyecto original: ${copying.done} de ${copying.total}…`
                : `Copia terminada: ${copying.done} video${copying.done === 1 ? '' : 's'}${copying.failed ? ` (${copying.failed} no se pudo copiar)` : ''}.`}
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto_auto]">
            <label className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder='Buscar en la locución: palabras, "frase exacta", -excluir'
                className={cn(field, 'w-full pl-8')}
              />
            </label>
            <select value={theme} onChange={(e) => setTheme(e.target.value)} className={cn(field, 'cursor-pointer')}>
              <option value="">Todos los temas</option>
              {data?.themes.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name} ({t.count})
                </option>
              ))}
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value as HistoryStatus | '')} className={cn(field, 'cursor-pointer')}>
              <option value="">Todos los estados</option>
              <option value="done">Listos</option>
              <option value="awaiting_approval">Esperando aprobación</option>
              <option value="working">En curso</option>
              <option value="error">Con error</option>
              <option value="paused">Detenidos</option>
            </select>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={field} title="Desde" />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={field} title="Hasta" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Totals t={data?.totals} />
            {filtered && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setQ('');
                  setTheme('');
                  setStatus('');
                  setFrom('');
                  setTo('');
                }}
              >
                <X /> Quitar filtros
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-destructive text-sm">{error}</p>}
      {data && !data.items.length && !loading && !copying && (
        <Card className="text-muted-foreground grid min-h-40 place-items-center border-dashed p-6 text-center text-sm">
          {filtered
            ? 'Ningún video cumple los filtros.'
            : project.unclassified
              ? 'Aquí quedan los videos que aún no están en ningún proyecto. Ahora mismo no hay ninguno.'
              : project.archived
                ? 'Este proyecto está archivado y no tiene videos.'
                : 'Aún no hay videos en este proyecto: pulsa «Nuevo video aquí».'}
        </Card>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {data?.items.map((g, i) => (
          <VideoCard
            key={g.id}
            g={g}
            projects={projects}
            project={project}
            onOpen={onOpen}
            onMoved={onMoved}
            onRemoved={onRemoved}
            onDuplicated={onDuplicated}
            order={filtered ? undefined : { position: i + 1, first: i === 0, last: i === data.total - 1, move: (dir) => moveVideo(g.id, dir) }}
          />
        ))}
      </div>
      {loading && (
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 className="size-3.5 animate-spin" /> Cargando…
        </div>
      )}
      {data && data.items.length < data.total && !loading && (
        <Button variant="outline" onClick={more} className="self-center">
          Cargar más ({data.total - data.items.length})
        </Button>
      )}
    </main>
  );
}

/**
 * Pantalla "Proyectos" (hito 4, ADR-036), la de inicio: la home muestra solo los proyectos ("Sin
 * clasificar" primero) y al abrir uno se ven sus videos con búsqueda, filtros, totales, ZIP, mover y
 * "Nuevo video aquí" (ADR-032).
 */
export function ProjectsView({
  me,
  selected,
  onSelect,
  onOpen,
  onGenerateIn,
}: {
  me: AuthUser;
  selected: ProjectFilter;
  onSelect: (p: ProjectFilter) => void;
  onOpen: (id: string) => void;
  onGenerateIn: (projectId: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectsResponse>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<{ id: string; text: string }>();

  // Siempre con los archivados: la home los oculta salvo que se pidan, y un archivado se puede abrir.
  // «Ver los de todos» (hito 11): el admin pide también los de los demás usuarios.
  const seeAll = useSeeAll();
  const loadProjects = useCallback(() => {
    projectsApi.list(true, seeAll).then(
      (r) => (setProjects(r), setError(undefined)),
      (e: Error) => setError(e.message),
    );
  }, [seeAll]);
  useEffect(loadProjects, [loadProjects]);

  const current = projects?.projects.find((p) => p.id === selected);
  useEffect(() => {
    if (!projects || !selected) return;
    // Dirección antigua (?project=none, "Sin proyecto"): ahora es "Sin clasificar".
    if (selected === 'none') onSelect(projects.unclassifiedId);
    // Un proyecto que ya no existe (eliminado): vuelta a la home.
    else if (!current) onSelect('');
  }, [selected, projects, current, onSelect]);

  if (selected && !projects && !error)
    return (
      <main className="text-muted-foreground mx-auto flex max-w-[1400px] items-center gap-2 px-4 text-xs sm:px-6">
        <Loader2 className="size-3.5 animate-spin" /> Cargando…
      </main>
    );
  if (current && projects)
    return (
      <ProjectDetail
        key={current.id}
        project={current}
        projects={projects.projects}
        me={me}
        onBack={() => onSelect('')}
        onChanged={loadProjects}
        onDeleted={() => {
          onSelect('');
          loadProjects();
        }}
        onOpen={onOpen}
        onGenerate={() => onGenerateIn(current.id)}
        notice={notice?.id === current.id ? notice.text : undefined}
        onDuplicated={(r) => {
          // El proyecto nuevo se abre ya; sus videos van llegando (T3e, ADR-107).
          setProjects((d) => (d ? { ...d, projects: [...d.projects, r.project] } : d));
          setNotice({
            id: r.project.id,
            text: `Duplicado de «${current.name}», con su logo.${r.skipped ? ` ${r.skipped} video${r.skipped === 1 ? ' no se copió porque se está' : 's no se copiaron porque se están'} generando.` : ''} Para ponerle otro logo, pulsa el logo de la cabecera: el original no cambia.`,
          });
          onSelect(r.project.id);
          loadProjects();
        }}
      />
    );
  return (
    <ProjectsHome
      data={projects}
      me={me}
      error={error}
      onOpen={onSelect}
      onCreated={(p) => {
        // Se añade ya a la lista para poder abrirlo sin esperar a la recarga.
        setProjects((d) => (d ? { ...d, projects: [...d.projects, p] } : d));
        onSelect(p.id);
        loadProjects();
      }}
    />
  );
}

/** Voz del video (ElevenLabs), con su nombre. */
function VoiceName({ id }: { id: string }) {
  const name = useVoiceName(id);
  return (
    <span className="inline-flex items-center gap-1" title={`Voz de ElevenLabs · ${id}`}>
      <Mic className="size-3" /> {name}
    </span>
  );
}
