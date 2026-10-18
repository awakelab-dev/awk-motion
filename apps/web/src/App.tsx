import { SpendConfirmHost } from '@/lib/spend';
import { ChangeConfirmHost } from '@/lib/confirm';
import { ChevronLeft, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppInfo, AuthUser, RunState } from '@wilox/shared';
import { setSeeAllAllowed } from '@/lib/see-all';
import { UsersView } from '@/components/admin/UsersView';
import { AccountView } from '@/components/auth/AccountView';
import { LoginView } from '@/components/auth/LoginView';
import { Composer, type RecreatePrefill } from '@/components/Composer';
import { Header } from '@/components/Header';
import { EmptyState, RunPanel } from '@/components/RunPanel';
import { ProjectsView, type ProjectFilter } from '@/components/projects/ProjectsView';
import { StudioView } from '@/components/studio/StudioView';
import { QueueView } from '@/components/queue/QueueView';
import { DownloadsView } from '@/components/downloads/DownloadsView';
import { ReviewsView } from '@/components/reviews/ReviewsView';
import { requestClipEditor } from '@/lib/clip-open';
import { TrashView } from '@/components/trash/TrashView';
import { Toasts, type Toast } from '@/components/queue/Toasts';
import { ApiError, api, authApi, projectsApi, subscribe, UNAUTHORIZED_EVENT } from '@/lib/api';
import { askNotifications, browserNotify, QueueProvider } from '@/lib/queue';
import { BatchesProvider, GO_EVENT, notifyBatch } from '@/lib/batches';
import type { DownloadBatchInfo, ReviewActivity } from '@wilox/shared';
import { kLabel, useReviewActivity } from '@/lib/review';
import { notifyTitle } from '@/lib/brand';

const readRunId = () => new URLSearchParams(location.search).get('run');
/**
 * Pestañas (hito 4, ADR-036): Proyectos · Generar · Temas; Proyectos es la pantalla de inicio.
 * "video" (ADR-053) es la pantalla de un video abierto: cuelga de su proyecto, sin formulario de video nuevo.
 */
export type View = 'proyectos' | 'generar' | 'video' | 'temas' | 'cola' | 'descargas' | 'observaciones' | 'papelera' | 'usuarios' | 'cuenta';
const VIEWS: View[] = ['proyectos', 'generar', 'temas', 'cola', 'descargas', 'observaciones', 'papelera', 'usuarios', 'cuenta'];
const readView = (): View => {
  const p = new URLSearchParams(location.search);
  if (p.has('run')) return 'video';
  const v = p.get('view');
  if (v === 'estudio') return 'temas'; // dirección antigua de la pestaña "Estudio"
  return v && VIEWS.includes(v as View) ? (v as View) : 'proyectos';
};
/** Dirección de cada pantalla: la home de Proyectos no lleva parámetros. */
const setUrl = (params: Record<string, string | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  history.replaceState(null, '', `${location.pathname}${p.size ? `?${p}` : ''}`);
};

/** Sesión (hito 3): sin usuario se muestra el login; con usuario, la app de siempre. */
export function App() {
  /** undefined = comprobando; null = sin sesión. */
  const [me, setMe] = useState<AuthUser | null>();
  const [apiDown, setApiDown] = useState(false);

  // Al arrancar con `pnpm dev`, Vite suele estar listo antes que la API: se reintenta hasta conectar.
  useEffect(() => {
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () =>
      authApi.me().then(
        (u) => (setMe(u), setApiDown(false)),
        (e: unknown) => {
          if (e instanceof ApiError && e.status === 401) {
            setMe(null);
            setApiDown(false);
            return;
          }
          attempt += 1;
          if (attempt >= 3) setApiDown(true);
          timer = setTimeout(check, Math.min(5000, 800 * attempt));
        },
      );
    void check();
    const onUnauthorized = () => setMe(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
      if (timer) clearTimeout(timer);
    };
  }, []);

  const logout = async () => {
    await authApi.logout().catch(() => undefined);
    setMe(null);
    history.replaceState(null, '', location.pathname);
  };

  if (me === undefined)
    return (
      <div className="text-muted-foreground grid min-h-dvh place-items-center text-xs">
        <span className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" /> {apiDown ? 'No se pudo conectar con la API; reintentando…' : 'Conectando…'}
        </span>
      </div>
    );
  if (me === null) return <LoginView onLogin={setMe} />;
  // key: al cambiar de usuario se descarta todo el estado de la sesión anterior.
  return <Workspace key={me.id} me={me} onLogout={logout} />;
}

function Workspace({ me, onLogout }: { me: AuthUser; onLogout: () => void }) {
  // «Ver los de todos» (hito 11): solo el admin.
  setSeeAllAllowed(me.role === 'admin');
  const [info, setInfo] = useState<AppInfo>();
  const [infoError, setInfoError] = useState<string>();
  const [run, setRun] = useState<RunState>();
  const [runId, setRunId] = useState<string | null>(readRunId());
  const [view, setView] = useState<View>(() => {
    const v = readView();
    return v === 'usuarios' && me.role !== 'admin' ? 'proyectos' : v;
  });
  /** Proyecto elegido en "Proyectos" (id o '' = todos). */
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>(() => new URLSearchParams(location.search).get('project') ?? '');
  /** Proyecto donde van los videos nuevos del Composer (null = "Sin clasificar"). */
  const [targetProject, setTargetProject] = useState<string | null>(() => {
    try {
      return localStorage.getItem('wilox:targetProject') || null;
    } catch {
      return null;
    }
  });
  const chooseTarget = (id: string | null) => {
    setTargetProject(id);
    try {
      if (id) localStorage.setItem('wilox:targetProject', id);
      else localStorage.removeItem('wilox:targetProject');
    } catch {
      /* sin almacenamiento: solo esta sesión */
    }
  };

  const loadInfo = useCallback(() => {
    let attempt = 0;
    const tryLoad = () =>
      api.info().then(
        (i) => (setInfo(i), setInfoError(undefined)),
        (e: Error) => {
          if (e instanceof ApiError && e.status === 401) return;
          attempt += 1;
          if (attempt >= 3) setInfoError(e.message);
          setTimeout(tryLoad, Math.min(5000, 800 * attempt));
        },
      );
    void tryLoad();
  }, []);

  const go = (v: View) => {
    // Pulsar "Proyectos" estando ya en Proyectos vuelve a la home; desde un video, a su proyecto;
    // desde otra pestaña, al proyecto que estaba abierto.
    const project = v !== 'proyectos' || view === 'proyectos' ? '' : view === 'video' && run?.projectId ? run.projectId : projectFilter;
    if (v === 'proyectos') setProjectFilter(project);
    if (v === 'generar') {
      // "Generar" es siempre un video nuevo (en el proyecto activo); los videos se abren desde Proyectos o la Cola.
      setRun(undefined);
      setRunId(null);
    }
    setView(v);
    if (v === 'proyectos') setUrl({ project });
    else setUrl({ view: v });
    if (v === 'generar') loadInfo(); // temas recién guardados en Temas
  };

  useEffect(() => {
    loadInfo();
    // Vuelta desde el OAuth de Higgsfield
    const p = new URLSearchParams(location.search);
    if (p.has('higgsfield')) {
      p.delete('higgsfield');
      history.replaceState(null, '', `${location.pathname}${p.size ? `?${p}` : ''}`);
    }
  }, [loadInfo]);

  /** Cambia cada vez que se abre un video, aunque sea el mismo: se vuelve a suscribir (ADR-053). */
  const [openNonce, setOpenNonce] = useState(0);
  useEffect(() => {
    if (!runId) return;
    return subscribe(runId, setRun, () => {
      setRun(undefined);
      setRunId(null);
      setView('proyectos');
      setUrl({});
    });
  }, [runId, openNonce]);
  // El proyecto del video abierto pasa a ser el proyecto activo (el de "Generar").
  useEffect(() => {
    if (run?.projectId) chooseTarget(run.projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.projectId]);

  const selectProject = useCallback((f: ProjectFilter) => {
    setProjectFilter(f);
    setUrl({ project: f });
  }, []);

  /** Abrir un video del historial en la pantalla de siempre (ver, retomar, descargar). */
  const openRun = (id: string) => {
    // Reabrir el mismo video no lo vacía: antes quedaba en blanco porque la suscripción no se renovaba (ADR-053).
    if (id !== runId) setRun(undefined);
    setRunId(id);
    setOpenNonce((n) => n + 1);
    setView('video');
    setUrl({ run: id });
    window.scrollTo({ top: 0 });
  };

  const generateIn = (projectId: string) => {
    chooseTarget(projectId);
    setPrefill(undefined);
    go('generar');
  };

  const [prefill, setPrefill] = useState<RecreatePrefill>();
  /** Recrear (ADR-033): el Composer se rellena con este video y queda enlazado a él. */
  const recreate = (r: RunState) => {
    setPrefill({ key: Date.now(), parentId: r.id, text: r.text, theme: r.theme, voiceId: r.voiceId, musicTrack: r.musicTrack ?? null, soundMode: r.soundMode ?? 'model', script: r.script });
    if (r.projectId) chooseTarget(r.projectId);
    go('generar');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const onCreated = (s: RunState) => {
    setRun(s);
    setRunId(s.id);
    setView('video');
    setUrl({ run: s.id });
    window.scrollTo({ top: 0 });
    askNotifications(); // aviso del navegador cuando un video espere aprobación (hito 5)
  };

  /** Avisos de la cola (hito 5): un video quedó esperando tu aprobación. */
  const [toasts, setToasts] = useState<Toast[]>([]);
  const closeToast = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const onAwaiting = (v: { id: string; textPreview: string; projectName: string }) => {
    const open = () => openRunRef.current(v.id);
    setToasts((t) => [
      ...t.filter((x) => x.id !== v.id),
      { id: v.id, title: 'Un video espera tu aprobación', body: `${v.projectName} · ${v.textPreview}`, action: { label: 'Revisar fotogramas', onClick: open } },
    ]);
    browserNotify(notifyTitle('fotogramas listos'), `${v.projectName}: ${v.textPreview}`, open);
  };
  /**
   * «Ir» desde «Observaciones» (T8 y T11): abre el video y, con los clips listos, «Editar clip» del clip al que toca la
   * observación, donde Opus la analiza. Una del video en el plano Ki es del clip i (K00, del clip 1); una del storyboard
   * en Ki, del clip i (el que termina en Ki; K00, del clip 1). Sin clips listos, lleva a la tarjeta del fotograma o del
   * clip, resaltada un momento.
   */
  const openAt = (generationId: string, keyframeIndex: number | undefined, kind: 'comment' | 'video') => {
    if (keyframeIndex !== undefined) requestClipEditor({ generationId, index: Math.max(1, keyframeIndex), analyze: true, returnTo: 'observaciones' });
    openRun(generationId);
    const ids =
      keyframeIndex === undefined ? [] : kind === 'video' ? [`clip-${keyframeIndex}`, `kf-${keyframeIndex}`] : [`kf-${keyframeIndex}`, `clip-${keyframeIndex}`];
    let n = 0;
    const t = setInterval(() => {
      const el = [...ids, 'revision'].map((id) => document.getElementById(id)).find(Boolean);
      if (el || ++n > 40) {
        clearInterval(t);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Resaltado con estilo en línea: React no lo pisa si la tarjeta cambia de clase al cargar.
        const h = el as HTMLElement;
        h.style.outline = '2px solid var(--color-warning, #f5b041)';
        h.style.outlineOffset = '3px';
        h.dataset.obsFocus = '1';
        setTimeout(() => {
          h.style.outline = '';
          h.style.outlineOffset = '';
          delete h.dataset.obsFocus;
        }, 2500);
      }
    }, 250);
  };
  const openRunRef = useRef(openRun);
  openRunRef.current = openRun;

  /** Lotes de descarga (ADR-087): aviso cuando uno queda listo o falla. */
  const onBatch = (b: DownloadBatchInfo) => {
    const open = () => goRef.current('descargas');
    const ok = b.status === 'ready';
    setToasts((t) => [
      ...t.filter((x) => x.id !== b.id),
      { id: b.id, title: ok ? 'Lote de descargas listo' : 'El lote de descargas falló', body: `${b.projectName} · ${b.videos} video${b.videos === 1 ? '' : 's'}`, action: { label: 'Ver descargas', onClick: open } },
    ]);
    notifyBatch(b, open);
  };
  const goRef = useRef(go);
  goRef.current = go;

  /** Revisión del cliente (ADR-098): aviso cuando llega una observación o la aprobación del storyboard. */
  useReviewActivity((a: ReviewActivity) => {
    const open = () => {
      openRunRef.current(a.generationId);
      // Cuando el video termina de cargar, a su tarjeta de revisión.
      let n = 0;
      const t = setInterval(() => {
        const el = document.getElementById('revision');
        if (el || ++n > 20) {
          clearInterval(t);
          el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 250);
    };
    const approval = a.kind === 'approval';
    const title = approval
      ? 'El cliente aprobó el storyboard'
      : a.kind === 'video'
        ? `Observación del cliente sobre el video en ${kLabel(a.keyframeIndex)}`
        : `Observación del cliente en ${kLabel(a.keyframeIndex)}`;
    const body = approval ? `${a.projectName} · ${a.videoTitle} · ${a.author}` : `${a.projectName} · ${a.author}: ${a.text.length > 120 ? `${a.text.slice(0, 118)}…` : a.text}`;
    setToasts((t) => [...t.filter((x) => x.id !== a.id), { id: a.id, title, body, action: { label: 'Ver revisión', onClick: open } }]);
    browserNotify(notifyTitle(title), body, open);
  });
  useEffect(() => {
    const onGo = (e: Event) => {
      const v = (e as CustomEvent<string>).detail as View;
      if (VIEWS.includes(v)) goRef.current(v);
    };
    window.addEventListener(GO_EVENT, onGo);
    return () => window.removeEventListener(GO_EVENT, onGo);
  }, []);

  /** Volver al proyecto del video (ADR-053): desde ahí se lanza otro video con «Nuevo video aquí». */
  const backToProject = () => {
    const id = run?.projectId ?? targetProject ?? '';
    setProjectFilter(id);
    setView('proyectos');
    setUrl({ project: id });
  };

  return (
    <QueueProvider onAwaiting={onAwaiting}>
    <BatchesProvider onReady={onBatch}>
    <div className="min-h-dvh">
      <SpendConfirmHost />
      <ChangeConfirmHost />
      <Header info={info} me={me} onRefresh={loadInfo} view={view} onView={go} onLogout={onLogout} />
      {view === 'temas' ? (
        <StudioView info={info} />
      ) : view === 'proyectos' ? (
        <ProjectsView me={me} selected={projectFilter} onSelect={selectProject} onOpen={openRun} onGenerateIn={generateIn} />
      ) : view === 'cola' ? (
        <QueueView onOpen={openRun} />
      ) : view === 'descargas' ? (
        <DownloadsView />
      ) : view === 'observaciones' ? (
        <ReviewsView onGo={openAt} />
      ) : view === 'papelera' ? (
        <TrashView onOpenProject={() => go('proyectos')} />
      ) : view === 'usuarios' && me.role === 'admin' ? (
        <UsersView me={me} />
      ) : view === 'cuenta' ? (
        <AccountView me={me} />
      ) : view === 'video' ? (
        <main className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 pb-16 sm:px-6">
          <BackToProject projectId={run?.projectId} onBack={backToProject} />
          <RunPanel run={run} onOpen={openRun} onCreated={onCreated} onRecreate={recreate} />
        </main>
      ) : (
        <main className="mx-auto grid max-w-[1400px] gap-6 px-4 pb-16 sm:px-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
          <Composer
            info={info}
            infoError={infoError}
            disabled={false}
            onCreated={onCreated}
            onStudio={() => go('temas')}
            projectId={targetProject}
            onProjects={() => go('proyectos')}
            prefill={prefill}
            onPrefillClear={() => setPrefill(undefined)}
          />
          <EmptyState />
        </main>
      )}
      <Toasts items={toasts} onClose={closeToast} />
    </div>
    </BatchesProvider>
    </QueueProvider>
  );
}

/** Migas del video abierto (ADR-053): vuelve a su proyecto, donde está «Nuevo video aquí». */
function BackToProject({ projectId, onBack }: { projectId?: string; onBack: () => void }) {
  const [name, setName] = useState<string>();
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    // all=1: el admin puede estar viendo un video de otro usuario (a un usuario normal no le cambia nada).
    projectsApi.list(true, true).then(
      (r) => alive && setName(r.projects.find((p) => p.id === projectId)?.name),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [projectId]);
  return (
    <button
      type="button"
      onClick={onBack}
      className="text-muted-foreground hover:text-foreground inline-flex w-fit cursor-pointer items-center gap-1 text-xs"
      title="Volver al proyecto"
    >
      <ChevronLeft className="size-3.5" /> Proyectos <span className="opacity-50">/</span>{' '}
      <span className="text-foreground font-medium">{name ?? (projectId ? '…' : 'Proyecto')}</span>
    </button>
  );
}
