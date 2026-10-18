import {
  AlertTriangle,
  AudioLines,
  Captions,
  Check,
  CheckCircle2,
  Clapperboard,
  CloudUpload,
  Download,
  Copy,
  FileText,
  Film,
  GitBranch,
  Globe,
  ImageIcon,
  Images,
  Link2,
  Loader2,
  Music,
  Volume2,
  PauseCircle,
  Pencil,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Plus,
  SlidersHorizontal,
  Trash2,
  Wand2,
  X,
  Mic,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RUN_STEPS, type PublicationInfo, type ClipLogo, type ClipState, type InsertState, type VideoDelivery, type VideoShare, type KeyframeState, type MediaRulePlan, type MusicTrackInfo, type PromptSummary, type RunState, type SoundMode } from '@wilox/shared';
import { MusicPicker, trackTitle } from '@/components/MusicPicker';
import { DownloadDialog } from '@/components/DownloadDialog';
import { PublicationsPanel } from '@/components/delivery/PublicationsPanel';
import { publishedText } from '@/lib/published';
import { affectedClips, ClipEditor, KeyframeProposals } from '@/components/ClipEditor';
import { InsertDialog } from '@/components/InsertDialog';
import { CornerHotspots, LogoOverlay } from '@/components/delivery/logo';
import { aspectOf, useVideoDelivery } from '@/components/delivery/ProjectDelivery';
import { GainStepper, SoundPicker, soundOf, soundTitle } from '@/components/SoundPicker';
import { RegenerateDialog, RevoiceDialog } from '@/components/KeyframeDialogs';
import { ReviewBadge, ReviewCard, ReviewProvider } from '@/components/ReviewCard';
import { useQueue } from '@/lib/queue';
import { CaptionOverlay, useVttCues } from '@/lib/captions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { clipsFor, confirmSpend, useCostText } from '@/lib/spend';
import { cn } from '@/lib/utils';
import { useVoiceName } from '@/lib/voices';
import { CLIP_OPEN_EVENT, takeClipRequest } from '@/lib/clip-open';
import { goTo } from '@/lib/batches';

const FPS = 24;
const order = (s: RunState['status']) => RUN_STEPS.findIndex((x) => x.status === s);

export function RunPanel({
  run,
  onOpen,
  onCreated,
  onRecreate,
}: {
  /** undefined mientras carga el video abierto. */
  run?: RunState;
  /** Abrir otra generación (la versión de la que sale). */
  onOpen: (id: string) => void;
  /** Se creó una versión nueva (cambio de texto): se abre. */
  onCreated: (s: RunState) => void;
  /** Recrear: rellena el Composer con este video. */
  onRecreate: (run: RunState) => void;
}) {
  if (!run)
    return (
      <Card className="bg-card/40 grid min-h-[320px] place-items-center border-dashed">
        <span className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Cargando el video…
        </span>
      </Card>
    );
  const finished = run.status === 'done' || (run.status === 'error' && run.clips.some((c) => c.status === 'ready'));
  const clipsReady = run.clips.length > 0 && run.clips.every((c) => c.status === 'ready');
  return (
    <ReviewProvider runId={run.id}>
    <div className="flex min-w-0 flex-col gap-6">
      <Progress run={run} onOpen={onOpen} />
      {run.status === 'error' && <ErrorBox run={run} />}
      {run.finalUrl && (run.status === 'done' || run.status === 'awaiting_approval' || order(run.status) > order('awaiting_approval')) && (
        // En una corrección (o mientras se rehace), el final vigente sigue a la vista.
        <FinalVideo run={run} note={run.status === 'done' ? undefined : 'Final vigente · hay una corrección en curso'} />
      )}
      {finished && <Corrections run={run} onCreated={onCreated} onRecreate={onRecreate} />}
      {/* Revisión del cliente (ADR-098): desde que hay fotogramas. */}
      {run.keyframes.some((k) => k.url) && <ReviewCard run={run} />}
      {/* Con los clips listos, los fotogramas se ven en «Editar clip» (ADR-067); vuelven al corregirlos. */}
      {run.keyframes.length > 0 && (run.status === 'awaiting_approval' || !clipsReady) && <Keyframes run={run} />}
      {(order(run.status) >= order('clips') || finished) && run.clips.length > 0 && (
        // Con final, los clips se siguen regenerando mientras otros están en marcha o se une el final (ADR-091).
        <Clips run={run} canRegenerate={finished || (!!run.finalUrl && ['clips', 'post', 'render'].includes(run.status))} />
      )}
      <Prompts run={run} />
      <Log run={run} />
    </div>
    </ReviewProvider>
  );
}

export function EmptyState() {
  const steps = [
    ['Locución', 'TTS por párrafo y tiempos por palabra'],
    ['Storyboard', 'Opus elige las PFC y escribe los superprompts'],
    ['Fotogramas', 'GPT Image 2.5 genera K0…Kn para que los apruebes'],
    ['Video', 'MiniMax H3 anima cada par en paralelo; SFX, congelados y render'],
  ];
  return (
    // Fija y a la altura de la pantalla: el contenido queda centrado aunque la columna del formulario crezca.
    <Card className="bg-card/40 grid min-h-[520px] place-items-center self-start border-dashed lg:sticky lg:top-6 lg:h-[calc(100dvh-8rem)]">
      <div className="max-w-md px-6 py-10 text-center">
        <div className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl border bg-secondary">
          <Clapperboard className="text-primary size-6" />
        </div>
        <div className="text-lg font-semibold tracking-tight">Del texto al video, con un punto de control</div>
        <p className="text-muted-foreground mt-2 text-sm">El video final dura exactamente lo mismo que la locución.</p>
        <ol className="mt-7 grid gap-2.5 text-left">
          {steps.map(([t, d], i) => (
            <li key={t} className="flex gap-3 rounded-lg border bg-background/40 px-3.5 py-2.5">
              <span className="text-primary font-mono text-xs leading-5">{String(i + 1).padStart(2, '0')}</span>
              <span className="text-sm">
                <span className="font-medium">{t}</span> <span className="text-muted-foreground">· {d}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}

function useElapsed(since: string, running: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function Progress({ run, onOpen }: { run: RunState; onOpen: (id: string) => void }) {
  const current = order(run.status);
  // Costo del video en USD (hito 11: sin créditos), con lo gastado en todos sus trabajos; se pide de nuevo al cambiar de fase.
  const [costUsd, setCostUsd] = useState<number>();
  useEffect(() => {
    let alive = true;
    api.summary(run.id).then((s) => alive && setCostUsd(s.costUsd), () => undefined);
    return () => {
      alive = false;
    };
  }, [run.id, run.status, run.finalUrl]);
  const paused = run.status === 'paused';
  const running = !['done', 'error', 'awaiting_approval', 'paused'].includes(run.status);
  const elapsed = useElapsed(run.createdAt, run.status !== 'done' && run.status !== 'error' && !paused);
  const live = useQueue().byId.get(run.id);
  /** Detener / reanudar (hito 5, ADR-052): solo videos que aún no tienen final. */
  const canPause = !run.finalUrl && !['done', 'paused'].includes(run.status);
  const [toggling, setToggling] = useState(false);
  const [toggleErr, setToggleErr] = useState<string>();
  const toggle = async () => {
    if (paused) {
      const ok = await confirmSpend({
        title: 'Reanudar el video',
        body: 'Vuelve a la cola con su prioridad y sigue desde donde quedó; lo ya hecho no se vuelve a pagar.',
        workNote: 'Genera lo que quede pendiente del video (locución, fotogramas o clips).',
        action: 'Reanudar',
      });
      if (!ok) return;
    }
    setToggling(true);
    setToggleErr(undefined);
    try {
      await (paused ? api.resume(run.id) : api.pause(run.id));
    } catch (e) {
      setToggleErr((e as Error).message);
    } finally {
      setToggling(false);
    }
  };
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium">
              {running && <Loader2 className="text-primary size-4 animate-spin" />}
              {run.status === 'done' && <CheckCircle2 className="text-success size-4" />}
              {run.status === 'error' && <AlertTriangle className="text-destructive size-4" />}
              {paused && <PauseCircle className="text-warning size-4" />}
              <span className="truncate">{run.message}</span>
              {live?.position && (
                <Badge variant="secondary" title="Posición en la cola global (orden de lanzamiento de los videos)">
                  n.º {live.position} en la cola
                </Badge>
              )}
            </div>
            {toggleErr && <div className="text-destructive mt-1 text-[11px]">{toggleErr}</div>}
            {run.parentId && (
              <button
                type="button"
                onClick={() => onOpen(run.parentId!)}
                className="text-primary mt-1 inline-flex cursor-pointer items-center gap-1 text-[11px] hover:underline"
              >
                <GitBranch className="size-3" /> Versión de <span className="font-mono">{run.parentId}</span>
              </button>
            )}
            <div className="text-muted-foreground mt-1 font-mono text-[11px]">
              {run.id} ·{' '}
              {(running || run.status === 'awaiting_approval') && !run.finalUrl
                ? elapsed
                : new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(run.createdAt))}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {(canPause || paused) && (
              <Button
                variant={paused ? 'default' : 'outline'}
                size="sm"
                onClick={toggle}
                disabled={toggling}
                title={paused ? 'Vuelve a la cola con su prioridad y sigue desde donde quedó' : 'Sale de la cola hasta que lo reanudes (lo que ya está en marcha termina)'}
              >
                {toggling ? <Loader2 className="animate-spin" /> : paused ? <PlayCircle /> : <PauseCircle />} {paused ? 'Reanudar' : 'Detener'}
              </Button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-8">
          {RUN_STEPS.map((st, i) => {
            const done = run.status === 'done' || i < current;
            const active = i === current && run.status !== 'done';
            const failed = run.status === 'error' && active;
            return (
              <div key={st.status} className="flex flex-col gap-1.5">
                <div
                  className={cn(
                    'h-1 rounded-full bg-secondary',
                    done && 'bg-primary',
                    active && !failed && st.status !== 'awaiting_approval' && 'bg-primary/50 shimmer',
                    active && !failed && st.status === 'awaiting_approval' && 'bg-warning',
                    failed && 'bg-destructive',
                  )}
                />
                <div className={cn('text-[10.5px] leading-tight', done || active ? 'text-foreground' : 'text-muted-foreground')}>{st.label}</div>
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">Tema {run.themeName ?? run.theme}</Badge>
          <VoiceBadge id={run.voiceId} />
          <Badge variant="secondary">Modo {run.mode.toUpperCase()}</Badge>
          {run.durationSec !== undefined && (
            <Badge variant="secondary">
              Voz {run.durationSec.toFixed(2)} s · {run.totalFrames} f
            </Badge>
          )}
          {run.clips.length > 0 && <Badge variant="secondary">{run.clips.length} clips IA</Badge>}
          {!!costUsd && <Badge variant="default" title="Lo gastado en los proveedores en este video (todos sus trabajos)">{costUsd.toLocaleString('es-CL', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })}</Badge>}
        </div>
      </CardContent>
    </Card>
  );
}

function ErrorBox({ run }: { run: RunState }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4 sm:flex-row sm:items-center sm:justify-between">
      <pre className="text-destructive max-h-40 overflow-auto font-sans text-xs whitespace-pre-wrap">{run.error}</pre>
      <Button
        variant="secondary"
        onClick={async () => {
          const ok = await confirmSpend({
            title: 'Reintentar',
            body: 'Retoma el video desde el paso que falló; lo ya hecho no se vuelve a pagar.',
            workNote: 'Vuelve a llamar al proveedor del paso que falló (locución, Opus, imágenes o clips) y sigue con lo pendiente.',
            action: 'Reintentar',
          });
          if (!ok) return;
          setBusy(true);
          api.retry(run.id).finally(() => setBusy(false));
        }}
        disabled={busy}
      >
        {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />} Reintentar
      </Button>
    </div>
  );
}

function FinalVideo({ run, note }: { run: RunState; note?: string }) {
  // Con insertos (ADR-073) el final dura la locución más lo que ocupa cada inserto listo.
  const extra = (run.inserts ?? [])
    .filter((x) => x.status === 'ready')
    .reduce((n, x) => {
      const own = (x.deliveredFrames ?? 0) + (x.transition?.status === 'ready' && x.transition.enabled !== false ? (x.transition.deliveredFrames ?? 0) : 0);
      return n + Math.max(own, x.voice === 'text' && x.voiceSec ? Math.ceil((0.3 + x.voiceSec + 0.4) * FPS) : 0);
    }, 0);
  const expected = (run.totalFrames ?? 0) + extra;
  const exact = run.finalFrames === expected;
  const video = useRef<HTMLVideoElement>(null);
  // Subtítulos (hito 6, ADR-063): los dibuja la app, apagados por defecto, con letra proporcional al video.
  const [captions, setCaptions] = useState(false);
  // Descarga (hito 6, ADR-065): HTML con portada, subtítulos y logo por defecto, o solo el MP4.
  const [downloading, setDownloading] = useState(false);
  const [sharing, setSharing] = useState(false);
  // Publicar en la nube (hito 9, ADR-101): URLs estables para Rise 360 o un SCORM liviano.
  const [publishing, setPublishing] = useState(false);
  // Estado «Publicado» (T3c, ADR-105): sus cambios los verá el cliente.
  const [pubs, setPubs] = useState<PublicationInfo[]>();
  useEffect(() => {
    api.publications(run.id).then(setPubs, () => setPubs([]));
  }, [run.id, publishing, run.finalUrl]);
  const pubUses = [...new Set((pubs ?? []).flatMap((p) => (p.uses.length ? p.uses : ['manual' as const])))];
  const cues = useVttCues(captions ? api.subtitlesUrl(run.id, 'vtt', run.finalUrl) : undefined);
  return (
    <Card className="overflow-hidden">
      {note && <div className="border-warning/30 bg-warning/10 text-warning border-b px-4 py-2 text-xs font-medium">{note}</div>}
      <div className="relative">
        <video ref={video} key={run.finalUrl} src={run.finalUrl} controls className="aspect-video w-full bg-black" />
        <CaptionOverlay video={video} cues={cues} on={captions} />
      </div>
      {downloading && <DownloadDialog run={run} onClose={() => setDownloading(false)} />}
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Film className="text-primary size-4" />
          <span className="font-medium">{run.finalUrl!.split('?')[0].split('/').pop()}</span>
          <span className="text-muted-foreground">
            2560×1440 · 24 fps · {((run.finalFrames ?? 0) / FPS).toFixed(3)} s
          </span>
          <span className="text-muted-foreground inline-flex items-center gap-1" title="Música de fondo">
            <Music className="size-3.5" /> {trackTitle(run.musicTrack)}
          </span>
          <span className="text-muted-foreground inline-flex items-center gap-1" title="Sonido de los clips">
            <Volume2 className="size-3.5" /> {soundTitle(run.soundMode, run.soundGainDb)}
          </span>
          {pubUses.length > 0 && (
            <Badge variant="success" title="Sus cambios (clips, audio, música, logo, portada…) los verá el cliente en unos minutos; la app avisa antes de cada cambio.">
              <Globe /> Publicado · {publishedText(pubUses)}
            </Badge>
          )}
          <Badge variant={exact ? 'success' : 'warning'}>
            {exact ? <Check /> : <AlertTriangle />} {run.finalFrames} / {expected} frames {extra ? `(locución ${run.totalFrames} + insertos ${extra})` : 'de la locución'}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={captions ? 'default' : 'outline'}
            size="sm"
            onClick={() => setCaptions((v) => !v)}
            title={captions ? 'Ocultar subtítulos' : 'Mostrar subtítulos sobre el video'}
          >
            <Captions /> {captions ? 'Subtítulos: sí' : 'Subtítulos: no'}
          </Button>
          <Button asChild variant="outline" size="sm" title="Subtítulos para CapCut, YouTube o Moodle">
            <a href={api.subtitlesUrl(run.id, 'srt', run.finalUrl, true)}>
              <Captions /> .srt
            </a>
          </Button>
          <Button asChild variant="outline" size="sm" title="Subtítulos WebVTT (los del reproductor HTML)">
            <a href={api.subtitlesUrl(run.id, 'vtt', run.finalUrl, true)}>
              <Captions /> .vtt
            </a>
          </Button>
          <Button variant={sharing ? 'default' : 'outline'} size="sm" onClick={() => setSharing((v) => !v)} title="Link para que otra persona vea el video sin iniciar sesión">
            <Link2 /> Compartir
          </Button>
          <Button variant={publishing ? 'default' : 'outline'} size="sm" onClick={() => setPublishing((v) => !v)} title="Publicar el video en la nube con direcciones que no caducan (Rise 360, SCORM liviano)">
            <CloudUpload /> Publicar
          </Button>
          <Button onClick={() => setDownloading(true)} disabled={!run.projectId}>
            <Download /> Descargar
          </Button>
        </div>
      </CardContent>
      {sharing && <SharePanel run={run} />}
      {publishing && <PublicationsPanel generationId={run.id} />}
    </Card>
  );
}

/**
 * Link para compartir (hito 7, ADR-083): cualquiera con el link ve el final vigente en el reproductor de las
 * descargas (portada, logo del proyecto y subtítulos encendidos), sin iniciar sesión.
 */
function SharePanel({ run }: { run: RunState }) {
  const [share, setShare] = useState<VideoShare | null>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    api.videoDelivery(run.id).then((d) => setShare(d.share ?? null), (e: Error) => setError(e.message));
  }, [run.id]);
  const act = async (fn: () => Promise<VideoDelivery>) => {
    setBusy(true);
    setError(undefined);
    try {
      const d = await fn();
      setShare(d.share ?? null);
      setCopied(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('No se pudo copiar: selecciona el link y cópialo a mano.');
    }
  };
  return (
    <div className="grid gap-2 border-t px-6 py-4 text-xs">
      <p className="text-muted-foreground text-[11px] leading-relaxed">
        Cualquiera con el link ve el video sin iniciar sesión: con audio, subtítulos (encendidos) y el logo del proyecto. Muestra siempre el final
        vigente, así que sigue sirviendo después de corregir el video. «Link nuevo» o «Desactivar» dejan sin efecto el anterior.
      </p>
      {share === undefined ? (
        <Loader2 className="size-4 animate-spin" />
      ) : share ? (
        <div className="flex flex-wrap items-center gap-2">
          <input readOnly value={share.url} onFocus={(e) => e.target.select()} className="bg-background h-8 min-w-0 flex-1 rounded-md border px-2 font-mono text-[11px]" />
          <Button size="sm" onClick={copy} disabled={busy}>
            {copied ? <Check /> : <Copy />} {copied ? 'Copiado' : 'Copiar'}
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={share.url} target="_blank" rel="noreferrer">
              <PlayCircle /> Abrir
            </a>
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => api.createShare(run.id))}>
            <RefreshCw /> Link nuevo
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => api.removeShare(run.id))}>
            <X /> Desactivar
          </Button>
        </div>
      ) : (
        <div>
          <Button size="sm" disabled={busy} onClick={() => void act(() => api.createShare(run.id))}>
            {busy ? <Loader2 className="animate-spin" /> : <Link2 />} Crear link
          </Button>
        </div>
      )}
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}

function Keyframes({ run }: { run: RunState }) {
  const reviewing = run.status === 'awaiting_approval';
  const clipsCost = useCostText({ clips: run.clips.length });
  const [approving, setApproving] = useState(false);
  const [err, setErr] = useState<string>();
  const [zoom, setZoom] = useState<KeyframeState>();
  const ready = run.keyframes.filter((k) => k.status === 'ready' && !k.activity).length;
  const working = run.keyframes.filter((k) => k.status === 'generating' || k.activity).length;
  const allReady = ready === run.keyframes.length;
  // Corrección de un video terminado: cuántos clips se rehacen al aprobar (los que cambiaron de fotograma).
  const kv = (i: number) => run.keyframes.find((k) => k.index === i)?.version ?? 1;
  const affected = run.clips.filter((c) => c.status === 'ready' && c.builtWith && (c.builtWith[0] !== kv(c.index - 1) || c.builtWith[1] !== kv(c.index))).length;
  const correcting = run.clips.length > 0 && run.clips.every((c) => c.status === 'ready');
  const unchanged = correcting && !affected && !!run.finalUrl;

  const approve = async () => {
    // Aviso antes de gastar (ADR-069): generar o rehacer clips. Sin clips nuevos (solo render) no gasta.
    const clips = correcting ? affected : run.clips.length;
    if (clips > 0) {
      const ok = await confirmSpend({
        title: correcting ? 'Aprobar y rehacer clips' : 'Aprobar y generar el video',
        body: correcting
          ? `Se rehacen los ${clips} clips cuyos fotogramas cambiaron y después el render (se conserva el final anterior).`
          : `Se generan los ${clips} clips de video en paralelo y después el render del final.`,
        work: { clips },
        action: correcting ? 'Rehacer clips' : 'Generar clips',
      });
      if (!ok) return;
    }
    setApproving(true);
    setErr(undefined);
    try {
      await api.approve(run.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setApproving(false);
    }
  };

  return (
    <Card id="fotogramas" className={cn(reviewing && 'border-warning/40')}>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ImageIcon className="text-primary size-4" /> Fotogramas clave
          </CardTitle>
          <CardDescription>
            {reviewing
              ? 'Revisa texto y composición. Cada clip anima del fotograma anterior al siguiente.'
              : `${ready} de ${run.keyframes.length} listos`}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {run.keyframes.map((k) => (
          <KeyframeCard key={k.index} run={run} k={k} reviewing={reviewing} onZoom={() => setZoom(k)} />
        ))}
      </CardContent>
      {reviewing && (
        <div className="bg-card/95 sticky bottom-0 flex flex-col gap-3 rounded-b-xl border-t px-5 py-4 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs">
            <div className="font-medium">
              {allReady
                ? `${run.keyframes.length} fotogramas listos`
                : working
                  ? `Regenerando ${working} fotograma${working > 1 ? 's' : ''}…`
                  : `Faltan ${run.keyframes.length - ready} fotogramas`}
            </div>
            <div className="text-muted-foreground">
              {correcting
                ? affected
                  ? `Al aprobar se rehacen ${affected} clip${affected > 1 ? 's' : ''} (cambiaron sus fotogramas) y el render.`
                  : unchanged
                    ? 'Sin cambios en los fotogramas: al aprobar el video vuelve a quedar terminado, sin gastar nada.'
                    : 'Al aprobar se rehacen el post y el render con la locución nueva (sin clips nuevos).'
                : `Al aprobar se generan ${run.clips.length} clips en paralelo${clipsCost ? ` · ${clipsCost} de video` : ''}.`}
            </div>
            {err && <div className="text-destructive mt-1">{err}</div>}
          </div>
          <Button size="lg" onClick={approve} disabled={!allReady || approving}>
            {approving ? <Loader2 className="animate-spin" /> : <Check />}{' '}
            {unchanged ? 'Volver al video terminado' : correcting ? (affected ? 'Aprobar y rehacer clips' : 'Aprobar y renderizar') : 'Aprobar y generar video'}
          </Button>
        </div>
      )}
      {zoom?.url &&
        createPortal(
        <div className="fixed inset-0 z-[100] grid place-items-center bg-black/85 p-4" onClick={() => setZoom(undefined)}>
          <img src={zoom.url} alt={zoom.label} className="max-h-full max-w-full rounded-lg" />
          <button className="absolute top-4 right-4 cursor-pointer rounded-full bg-white/10 p-2" aria-label="Cerrar">
            <X className="size-5" />
          </button>
        </div>,
          document.body,
        )}
    </Card>
  );
}

function KeyframeCard({ run, k, reviewing, onZoom }: { run: RunState; k: KeyframeState; reviewing: boolean; onZoom: () => void }) {
  /** Pop-ups (hito 5): regenerar con indicación y rehacer el audio del tramo. */
  const [dialog, setDialog] = useState<'regen' | 'voice'>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const clip = run.clips.find((c) => c.index === k.index);
  const working = k.status === 'generating' || !!k.activity;
  const anyWorking = run.keyframes.some((x) => x.status === 'generating' || x.activity);
  // Rehacer audio: Ki (i ≥ 1) narra el tramo del clip i; en la revisión o con el video terminado.
  const canRevoice = k.index >= 1 && !!clip && (reviewing || run.status === 'done') && !anyWorking;

  const regen = async (useSuggestion = false) => {
    const ok = await confirmSpend({
      title: `Aplicar la sugerencia en K${String(k.index).padStart(2, '0')}`,
      body: 'Se genera una imagen nueva con el plano que sugirió Opus; Opus la revisa.',
      work: { images: 1, llm: 1 },
      action: 'Aplicar sugerencia',
    });
    if (!ok) return;
    setBusy(true);
    setErr(undefined);
    try {
      await api.regenerate(run.id, k.index, useSuggestion ? { useSuggestion: true } : {});
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id={`kf-${k.index}`} className="relative flex flex-col scroll-mt-4 overflow-hidden rounded-lg border bg-background/40">
      <button type="button" className="relative aspect-video cursor-zoom-in bg-secondary" onClick={onZoom} disabled={!k.url}>
        {k.url && k.status !== 'generating' && k.status !== 'error' ? (
          <img src={k.url} alt={k.label} className={cn('size-full object-cover transition-opacity', working && 'opacity-40')} loading="lazy" />
        ) : (
          <div className={cn('grid size-full place-items-center', k.status === 'generating' && 'shimmer')}>
            {k.status === 'error' ? (
              <AlertTriangle className="text-destructive size-5" />
            ) : (
              <Loader2 className="text-muted-foreground size-5 animate-spin" />
            )}
          </div>
        )}
        {working && k.activity && (
          <span className="absolute inset-x-0 bottom-2 mx-auto flex w-fit items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[11px] text-white">
            <Loader2 className="size-3 animate-spin" /> {k.activity}
          </span>
        )}
        <span className="absolute top-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white">
          K{String(k.index).padStart(2, '0')}
          {k.version > 1 ? ` · v${k.version}` : ''}
        </span>
      </button>
      <ReviewBadge index={k.index} className="absolute top-2 right-2" />
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="text-xs font-medium">{k.label.replace(/^K\d+ · /, '')}</div>
        {clip && (
          <div className="text-muted-foreground font-mono text-[10.5px]">
            clip{String(clip.index).padStart(2, '0')} · {(clip.startFrame / FPS).toFixed(2)}–{(clip.slotEndFrame / FPS).toFixed(2)} s
          </div>
        )}
        {k.texts.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {k.texts.map((t) => (
              <span key={t} className="rounded bg-secondary px-1.5 py-0.5 text-[10.5px]">
                {t}
              </span>
            ))}
          </div>
        )}
        {k.error && <div className="text-destructive text-[11px]">{k.error}</div>}
        {k.review && k.status === 'ready' && !working && (
          k.review.verdict === 'ok' ? (
            <div className="text-success flex items-center gap-1 text-[11px]">
              <Check className="size-3" /> Opus: composición correcta
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 rounded-md border border-warning/30 bg-warning/10 p-2 text-[11px]">
              <div className="text-warning font-medium">Opus sugiere mejorar</div>
              <div className="text-foreground/80">{k.review.issues}</div>
              {reviewing && k.review.revisedScene && (
                <Button size="sm" variant="secondary" className="self-start" onClick={() => regen(true)} disabled={busy || working}>
                  {busy ? <Loader2 className="animate-spin" /> : <Wand2 />} Aplicar sugerencia
                </Button>
              )}
            </div>
          )
        )}
        {(reviewing || canRevoice) && (
          <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
            {reviewing && (
              <Button size="sm" variant={k.status === 'error' ? 'default' : 'outline'} onClick={() => setDialog('regen')} disabled={working}>
                <RefreshCw /> Regenerar
              </Button>
            )}
            {canRevoice && (
              <Button size="sm" variant="outline" onClick={() => setDialog('voice')} title="Escuchar y rehacer la locución de este tramo">
                <AudioLines /> Rehacer audio
              </Button>
            )}
          </div>
        )}
        {err && <div className="text-destructive text-[11px]">{err}</div>}
        {dialog === 'regen' && <RegenerateDialog run={run} k={k} onClose={() => setDialog(undefined)} />}
        {dialog === 'voice' && <RevoiceDialog run={run} k={k} onClose={() => setDialog(undefined)} />}
      </div>
    </div>
  );
}

function Clips({ run, canRegenerate }: { run: RunState; canRegenerate: boolean }) {
  // Logo por clip (ADR-066): el logo del proyecto (o un marcador) en la esquina de cada clip; se cambia aquí.
  const hasReady = run.clips.some((c) => c.status === 'ready');
  const [delivery, setDelivery] = useVideoDelivery(run.id, !!run.projectId && hasReady);
  const [cornerErr, setCornerErr] = useState<string>();
  // Clic en otra esquina: el logo va ahí; clic en la esquina donde ya está: ese clip va sin logo (ADR-067).
  // La esquina del proyecto se guarda como "sin elegir" (sigue a la del proyecto si cambia).
  const saveLogo = async (index: number, v: ClipLogo | null) => {
    setDelivery(await api.setVideoDelivery(run.id, { clipCorners: { [index]: v } }));
  };
  const pickCorner = async (index: number, v: ClipLogo) => {
    setCornerErr(undefined);
    try {
      await saveLogo(index, delivery && v === delivery.settings.corner ? null : v);
    } catch (e) {
      setCornerErr((e as Error).message);
    }
  };
  // Editar un clip (ADR-067): todo lo de un clip en un pop-up; «Rehacer audio» abre su propio pop-up.
  const [editing, setEditing] = useState<number>();
  const [autoAnalyze, setAutoAnalyze] = useState(false);
  const [returnTo, setReturnTo] = useState<string>();
  const [revoice, setRevoice] = useState<KeyframeState>();
  const edited = run.clips.find((c) => c.index === editing);
  // Desde «Observaciones» (T11, ADR-122): abre «Editar clip» de ese clip y Opus analiza sus observaciones.
  useEffect(() => {
    const take = () => {
      if (!canRegenerate) return;
      const r = takeClipRequest(run.id);
      if (!r || !run.clips.some((c) => c.index === r.index)) return;
      setAutoAnalyze(r.analyze);
      setReturnTo(r.returnTo);
      setEditing(r.index);
    };
    take();
    window.addEventListener(CLIP_OPEN_EVENT, take);
    return () => window.removeEventListener(CLIP_OPEN_EVENT, take);
  }, [run.id, run.clips, canRegenerate]);
  const pendingClips = new Set(run.keyframes.some((k) => k.previous) ? affectedClips(run).map((c) => c.index) : []);
  // Insertos (ADR-073) en su lugar de la línea de tiempo: antes del clip siguiente a su posición.
  const [inserting, setInserting] = useState(false);
  // Los insertos se agregan con los clips en marcha o terminados (ADR-075): corren por su lado en la cola.
  const canInsert = run.clips.length > 0 && ['clips', 'post', 'render', 'done', 'error'].includes(run.status);
  const timeline: { clip?: ClipState; insert?: InsertState }[] = [];
  for (let p = 0; p <= run.clips.length; p++) {
    for (const x of (run.inserts ?? []).filter((y) => y.after === p).sort((a, b) => a.id - b.id)) timeline.push({ insert: x });
    if (p < run.clips.length) timeline.push({ clip: run.clips[p] });
  }
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="grid gap-1.5">
        <CardTitle className="flex items-center gap-2">
          <Film className="text-primary size-4" /> Clips de video
        </CardTitle>
        <CardDescription>
          Se generan en paralelo; cada uno tarda unos 9 minutos.
          {canRegenerate && ' «Editar clip» reúne todo lo de un clip: regenerarlo con una indicación, su sonido, la locución del tramo, sus fotogramas y el logo.'}
          {delivery &&
            ' El logo se ve donde irá en cada clip: pasa el ratón por el clip y elige la esquina que no tape el contenido; pulsa la esquina donde ya está para quitarlo de ese clip.'}
          {cornerErr && <span className="text-destructive block">{cornerErr}</span>}
        </CardDescription>
        </div>
        {canInsert && (
          <Button size="sm" variant="outline" onClick={() => setInserting(true)} title="Un clip generado entre dos clips, o un video subido como portada o cierre">
            <Plus /> Insertar o subir
          </Button>
        )}
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="col-span-full empty:hidden">
          <KeyframeProposals run={run} />
        </div>
        {timeline.map((item) => {
          if (item.insert)
            return <InsertCard key={`x${item.insert.id}`} run={run} ins={item.insert} delivery={delivery} onPick={(k) => void pickCorner(-item.insert!.id, k)} canEdit={canInsert} />;
          const c = item.clip!;
          return (
          <div key={c.index} id={`clip-${c.index}`} className="scroll-mt-4 overflow-hidden rounded-lg border bg-background/40">
            <div className="group relative aspect-video bg-secondary [container-type:inline-size]">
              {c.url && c.status === 'ready' ? (
                <>
                  {/*
                    Imagen fija (Ki, el estado final del clip) y el video solo al pasar el mouse: con muchos clips, cargar
                    todos a la vez agota las conexiones del navegador hacia S3 y algunas tarjetas quedaban en negro.
                  */}
                  <ClipPreview url={c.url} poster={run.keyframes.find((k) => k.index === c.index)?.url} />
                  {delivery && <LogoLayer delivery={delivery} index={c.index} onPick={(k) => void pickCorner(c.index, k)} />}
                </>
              ) : (
                <div className={cn('grid size-full place-items-center', c.status === 'generating' && 'shimmer')}>
                  {c.status === 'error' ? <AlertTriangle className="text-destructive size-5" /> : <Loader2 className="text-muted-foreground size-5 animate-spin" />}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 px-3 py-2 text-[11px]">
              <span className="flex items-center gap-1.5 font-mono">
                clip{String(c.index).padStart(2, '0')}
                {c.version > 1 ? ` v${c.version}` : ''}
                <ReviewBadge index={c.index} />
              </span>
              <span className="text-muted-foreground truncate">
                {c.status === 'ready'
                  ? c.ssimEnd !== undefined
                    ? `SSIM ${c.ssimStart?.toFixed(3) ?? '–'} / ${c.ssimEnd.toFixed(3)}`
                    : 'listo'
                  : c.status === 'error'
                    ? c.error
                    : c.status === 'pending'
                      ? 'en cola…'
                      : 'generando…'}
              </span>
            </div>
            {c.note && <div className="text-muted-foreground px-3 pb-2 text-[11px]">Indicación: {c.note}</div>}
            {pendingClips.has(c.index) && <div className="text-warning px-3 pb-2 text-[11px]">Cambió un fotograma: se rehace al aplicar la propuesta.</div>}
            {canRegenerate && c.status !== 'generating' && c.status !== 'pending' && (
              <div className="px-3 pb-3">
                <Button size="sm" variant="outline" className="w-full" onClick={() => setEditing(c.index)}>
                  <SlidersHorizontal /> Editar clip
                </Button>
              </div>
            )}
          </div>
          );
        })}
      </CardContent>
      {inserting && <InsertDialog run={run} onClose={() => setInserting(false)} />}
      {edited && (
        <ClipEditor
          run={run}
          c={edited}
          delivery={delivery}
          onLogo={(v) => saveLogo(edited.index, v)}
          onRevoice={(k) => {
            setEditing(undefined);
            setRevoice(k);
          }}
          onClose={() => {
            setEditing(undefined);
            setAutoAnalyze(false);
            // Abierto desde «Observaciones»: al cerrar se vuelve a esa lista, donde estaba (T11b).
            if (returnTo) {
              setReturnTo(undefined);
              goTo(returnTo);
            }
          }}
          autoAnalyze={autoAnalyze}
        />
      )}
      {revoice && <RevoiceDialog run={run} k={revoice} onClose={() => setRevoice(undefined)} />}
    </Card>
  );
}

/** Logo (o «Sin logo») sobre una tarjeta de clip o de inserto, con las esquinas para cambiarlo (ADR-066/067). */
function LogoLayer({ delivery, index, onPick }: { delivery: VideoDelivery; index: number; onPick: (v: ClipLogo) => void }) {
  const v = delivery.clipCorners[String(index)] ?? delivery.settings.corner;
  return (
    <>
      {v === 'none' ? (
        <span className="pointer-events-none absolute top-1.5 left-1/2 -translate-x-1/2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white/90">Sin logo</span>
      ) : (
        <LogoOverlay src={delivery.logo?.url} aspect={aspectOf(delivery)} settings={delivery.settings} corner={v} />
      )}
      <CornerHotspots value={v} onPick={onPick} />
    </>
  );
}

/** Tarjeta de un inserto (ADR-073): clip generado o video subido, con su locución, regenerar y quitar. */
function InsertCard({ run, ins, delivery, onPick, canEdit }: { run: RunState; ins: InsertState; delivery?: VideoDelivery; onPick: (v: ClipLogo) => void; canEdit: boolean }) {
  const clipCost = useCostText({ clips: 1 });
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const n = run.clips.length;
  const label = ins.kind === 'upload' ? (ins.after === 0 ? 'Portada subida' : 'Cierre subido') : 'Clip insertado';
  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setErr(undefined);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const regen = async () => {
    const ok = await confirmSpend({ title: `Regenerar el clip insertado ${ins.id}`, body: 'Se genera otra versión del clip insertado y se vuelve a unir el final.', work: { clips: 1 }, action: 'Regenerar' });
    if (ok) await act('regen', () => api.regenerateInsert(run.id, ins.id));
  };
  const transition = async () => {
    const ok = await confirmSpend({
      title: ins.transition ? 'Regenerar la transición' : 'Agregar una transición',
      body: `MiniMax desplaza ${ins.after === 0 ? 'los elementos del último cuadro de la portada hacia el primer fotograma del clip01' : 'los elementos del último cuadro del último clip hacia el primer cuadro del cierre'}, sin deformarlos (2 s), y se vuelve a unir el final. Solo cambia este inserto.`,
      work: { clips: 1 },
      action: ins.transition ? 'Regenerar' : 'Agregar',
    });
    if (ok) await act('trans', () => api.insertTransition(run.id, ins.id, {}));
  };
  const remove = () => window.confirm(`¿Quitar «${label}»? El video vuelve a su largo sin este inserto (sin costo).`) && void act('remove', () => api.removeInsert(run.id, ins.id));
  // Cada inserto se edita por su lado; solo se espera lo que está en marcha en él (ADR-075).
  const insBusy = ins.status === 'generating' || (ins.kind === 'generated' && ins.status === 'pending');
  const transBusy = ins.transition?.status === 'generating' || ins.transition?.status === 'pending';
  const free = run.status !== 'paused';
  return (
    <div className="border-primary/40 overflow-hidden rounded-lg border border-dashed bg-background/40">
      <div className="group relative aspect-video bg-secondary [container-type:inline-size]">
        {ins.url && ins.status === 'ready' ? (
          <>
            <video src={ins.url} muted loop playsInline className="size-full object-cover" onMouseEnter={(e) => void e.currentTarget.play()} onMouseLeave={(e) => e.currentTarget.pause()} />
            {delivery && <LogoLayer delivery={delivery} index={-ins.id} onPick={onPick} />}
          </>
        ) : (
          <div className={cn('grid size-full place-items-center', ins.status === 'generating' && 'shimmer')}>
            {ins.status === 'error' ? <AlertTriangle className="text-destructive size-5" /> : <Loader2 className="text-muted-foreground size-5 animate-spin" />}
          </div>
        )}
        <span className="bg-primary/90 text-primary-foreground pointer-events-none absolute bottom-1.5 left-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium">{label}</span>
      </div>
      <div className="grid gap-1 px-3 py-2 text-[11px]">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono">
            inserto {ins.id}
            {ins.version > 1 ? ` v${ins.version}` : ''}
          </span>
          <span className="text-muted-foreground truncate">
            {ins.after === 0 ? 'al principio' : ins.after === n ? 'al final' : `entre clip${String(ins.after).padStart(2, '0')} y clip${String(ins.after + 1).padStart(2, '0')}`}
            {ins.deliveredFrames ? ` · ${(ins.deliveredFrames / 24).toFixed(1)} s` : ''}
          </span>
        </div>
        <div className="text-muted-foreground">{ins.voice === 'text' ? `Locución: «${ins.text}»` : 'Pausa en la voz'}</div>
        {ins.note && <div className="text-muted-foreground">Indicación: {ins.note}</div>}
        {ins.upload && (
          <div className="text-muted-foreground">
            {ins.upload.width}×{ins.upload.height} · {ins.upload.fit === 'contain' ? 'con bandas' : ins.upload.fit === 'cover' ? 'recortado' : 'estirado'} · {ins.upload.keepAudio ? 'con su audio' : 'sin su audio'}
          </div>
        )}
        {ins.upload && (
          // Transición con el clip vecino (ADR-074): agregarla, regenerarla o quitarla.
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn(ins.transition?.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
              Transición {ins.after === 0 ? 'al clip01' : 'desde el último clip'}:{' '}
              {!ins.transition
                ? 'no'
                : ins.transition.enabled === false && ins.transition.status !== 'error'
                  ? `desactivada (guardada${ins.transition.status === 'ready' ? '' : ', se sigue generando'})`
                  : ins.transition.status === 'ready'
                  ? `${((ins.transition.deliveredFrames ?? 0) / 24).toFixed(1)} s`
                  : ins.transition.status === 'error'
                    ? ins.transition.error ?? 'error'
                    : ins.transition.status === 'pending'
                      ? ins.after === 0
                        ? 'en cola…'
                        : 'en cola (empieza cuando esté el último clip)…'
                      : 'generando…'}
            </span>
            {ins.transition?.url && ins.transition.status === 'ready' && (
              <a href={ins.transition.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                ver
              </a>
            )}
            {canEdit && free && (
              <>
                <button type="button" className="text-primary cursor-pointer hover:underline disabled:opacity-50" disabled={!!busy || transBusy} onClick={() => void transition()}>
                  {ins.transition ? 'regenerar' : `agregar${clipCost ? ` (${clipCost})` : ''}`}
                </button>
                {ins.transition && (
                  // Activar o desactivar sin gastar (ADR-086): la transición se conserva y el final se vuelve a unir.
                  <label className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1">
                    <input
                      type="checkbox"
                      checked={ins.transition.enabled !== false}
                      disabled={!!busy}
                      onChange={(e) => void act('trans', () => api.insertTransition(run.id, ins.id, { enabled: e.target.checked }))}
                    />
                    activa
                  </label>
                )}
              </>
            )}
          </div>
        )}
        {ins.error && <div className="text-destructive">{ins.error}</div>}
        {err && <div className="text-destructive">{err}</div>}
      </div>
      {canEdit && free && (
        <div className="flex gap-1.5 px-3 pb-3">
          {ins.kind === 'generated' && (
            <Button size="sm" variant="outline" className="flex-1" onClick={() => void regen()} disabled={!!busy || insBusy}>
              {busy === 'regen' ? <Loader2 className="animate-spin" /> : <RotateCcw />} Regenerar
            </Button>
          )}
          <Button size="sm" variant="ghost" className="flex-1" onClick={remove} disabled={!!busy || ins.status === 'generating' || ins.transition?.status === 'generating'}>
            {busy === 'remove' ? <Loader2 className="animate-spin" /> : <Trash2 />} Quitar
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Hora de una entrada del registro en la zona horaria de quien mira (la del navegador), con el día si no
 * es de hoy. El servidor guarda la hora en UTC.
 */
function logTime(iso: string) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' })} ${time}`;
}

/** Registro del video: lo más reciente arriba, con la hora local de quien mira. */
function Log({ run }: { run: RunState }) {
  const entries = [...run.log].reverse();
  return (
    <details className="text-muted-foreground rounded-xl border bg-card/60 px-5 py-3 text-xs">
      <summary className="cursor-pointer select-none">Registro ({run.log.length})</summary>
      <div className="mt-3 max-h-72 overflow-auto font-mono text-[11px] leading-relaxed">
        {entries.map((l, i) => (
          <div key={run.log.length - i} className={cn(l.level === 'error' && 'text-destructive', l.level === 'warn' && 'text-warning')}>
            <span className="opacity-50" title={new Date(l.at).toLocaleString('es-CL')}>
              {logTime(l.at)}
            </span>{' '}
            {l.message}
          </div>
        ))}
      </div>
    </details>
  );
}

/** Prompts guardados de la generación (hito 3): lista desde la BD y contenido al elegir uno. */
function Prompts({ run }: { run: RunState }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<PromptSummary[]>();
  const [selected, setSelected] = useState<string>();
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    api.prompts(run.id).then(setList, (e: Error) => setError(e.message));
  }, [open, run.id, run.status]);

  const show = (name: string) => {
    setSelected(name);
    setContent(undefined);
    api.prompt(run.id, name).then(setContent, (e: Error) => setContent(`Error: ${e.message}`));
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FileText className="text-primary size-4" /> Prompts
          </CardTitle>
          <CardDescription>Todos los superprompts y respuestas de Opus de este video, con sus versiones.</CardDescription>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? 'Ocultar' : 'Ver'}
        </Button>
      </CardHeader>
      {open && (
        <CardContent className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
          <div className="flex max-h-96 flex-col gap-0.5 overflow-auto">
            {error && <p className="text-destructive text-xs">{error}</p>}
            {!list && !error && <Loader2 className="text-muted-foreground size-4 animate-spin" />}
            {list?.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => show(p.name)}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1 text-left font-mono text-[11px]',
                  selected === p.name ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-accent/60',
                )}
              >
                <span className="truncate">{p.name}</span>
                <span className="shrink-0 opacity-60">{p.kind}</span>
              </button>
            ))}
            {list && !list.length && <p className="text-muted-foreground text-xs">Sin prompts guardados.</p>}
          </div>
          <pre className="bg-background/60 max-h-96 min-h-24 overflow-auto rounded-lg border p-3 text-[11px] leading-relaxed whitespace-pre-wrap">
            {selected ? (content ?? 'Cargando…') : 'Elige un prompt de la lista.'}
          </pre>
        </CardContent>
      )}
    </Card>
  );
}

/** Corregir, cambiar el texto o recrear un video terminado (hito 3, ADR-033). */
function Corrections({
  run,
  onCreated,
  onRecreate,
}: {
  run: RunState;
  onCreated: (s: RunState) => void;
  onRecreate: (run: RunState) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(run.text);
  const [busy, setBusy] = useState<'reopen' | 'version' | 'music' | 'sound' | 'rule' | 'revoice'>();
  /** «Rehacer la locución» (ADR-134): toda la locución en un solo pedido, con la misma voz. */
  const revoiceAll = async () => {
    const chars = run.paragraphs.reduce((n, p) => n + (p.spokenText ?? p.text).length, 0);
    const ok = await confirmSpend({
      title: 'Rehacer la locución',
      body: 'Se vuelve a locutar todo el video en un solo pedido, con la misma voz y el mismo texto, para que no cambie de tono, velocidad ni acento entre párrafos. Los fotogramas y los clips no cambian: se rehacen el post y el final (el anterior se conserva).',
      work: { ttsChars: chars },
      action: 'Rehacer la locución',
    });
    if (!ok) return;
    setBusy('revoice');
    setError(undefined);
    try {
      await api.revoiceAll(run.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const [error, setError] = useState<string>();
  useEffect(() => setText(run.text), [run.id, run.text]);
  /** Cambiar la música (hito 5): solo vuelve a renderizar, sin costo de proveedores. */
  const [musicOpen, setMusicOpen] = useState(false);
  const [tracks, setTracks] = useState<MusicTrackInfo[]>([]);
  const [track, setTrack] = useState<string | null>(run.musicTrack ?? null);
  useEffect(() => setTrack(run.musicTrack ?? null), [run.id, run.musicTrack]);
  const openMusic = () => {
    setMusicOpen((v) => !v);
    if (!tracks.length) api.music().then((r) => setTracks(r.tracks), (e: Error) => setError(e.message));
  };
  const changeMusic = async () => {
    setBusy('music');
    setError(undefined);
    try {
      await api.changeMusic(run.id, track);
      setMusicOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  /** Cambiar el sonido (hito 6, ADR-059): del modelo, sintetizado o sin sonido, y el ajuste en dB. Solo ffmpeg. */
  const [soundOpen, setSoundOpen] = useState(false);
  const [sound, setSound] = useState<SoundMode>(soundOf(run.soundMode));
  const [gain, setGain] = useState(run.soundGainDb ?? 0);
  useEffect(() => {
    setSound(soundOf(run.soundMode));
    setGain(run.soundGainDb ?? 0);
  }, [run.id, run.soundMode, run.soundGainDb]);
  const soundChanged = sound !== soundOf(run.soundMode) || (sound === 'model' && gain !== (run.soundGainDb ?? 0));
  const changeSound = async () => {
    setBusy('sound');
    setError(undefined);
    try {
      await api.changeSound(run.id, { mode: sound, ...(sound === 'model' ? { gainDb: gain } : {}) });
      setSoundOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  /** «Aplicar la regla a este video» (hito 7, ADR-082): solo en videos terminados con fotos en marcos. */
  const [rulePlan, setRulePlan] = useState<MediaRulePlan>();
  const [ruleOpen, setRuleOpen] = useState(false);
  const [ruleAlsoVideo, setRuleAlsoVideo] = useState(false);
  useEffect(() => {
    if (run.status !== 'done') return setRulePlan(undefined);
    api.mediaRulePlan(run.id).then(setRulePlan, () => setRulePlan(undefined));
  }, [run.id, run.status, run.finalUrl]);
  const ruleClips = rulePlan ? rulePlan.changes.length + (ruleAlsoVideo ? rulePlan.videoClips.length : 0) : 0;
  const applyRule = async () => {
    if (!rulePlan) return;
    const ok = await confirmSpend({
      title: 'Aplicar la regla a este video',
      body: `Las imágenes de cada fotograma pasan a ser video o foto según cuántas haya. Se rehacen ${ruleClips} clip(s) y el render; los fotogramas no cambian y el final anterior se conserva.`,
      work: { clips: ruleClips },
      action: 'Aplicar y rehacer',
    });
    if (!ok) return;
    setBusy('rule');
    setError(undefined);
    try {
      await api.applyMediaRule(run.id, ruleAlsoVideo);
      setRuleOpen(false);
      setRuleAlsoVideo(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const reopen = async () => {
    setBusy('reopen');
    setError(undefined);
    try {
      await api.reopen(run.id);
      document.getElementById('fotogramas')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const newVersion = async () => {
    const ok = await confirmSpend({
      title: 'Crear una versión nueva',
      body: 'Es un video nuevo con el texto cambiado: se locuta, Opus arma el storyboard y se generan los fotogramas. Los clips, al aprobarlos (con otro aviso).',
      work: { ttsChars: text.trim().length, llm: 3, images: clipsFor(text) + 1 },
      approx: true,
      action: 'Crear versión',
    });
    if (!ok) return;
    setBusy('version');
    setError(undefined);
    try {
      onCreated(await api.newVersion(run.id, text));
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wand2 className="text-primary size-4" /> Corregir o rehacer
        </CardTitle>
        <CardDescription>
          Corregir vuelve a la revisión de fotogramas: regenera los que quieras y, al aprobar, solo se rehacen los clips afectados y el render (se
          conserva el final anterior). Cambiar el texto crea una versión nueva enlazada a esta; recrear lleva este video al formulario para lanzarlo
          de nuevo. Las dos heredan la música y el sonido.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={reopen} disabled={!!busy}>
            {busy === 'reopen' ? <Loader2 className="animate-spin" /> : <ImageIcon />} Corregir fotogramas
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing((v) => !v)} disabled={!!busy}>
            <Pencil /> Cambiar el texto
          </Button>
          <Button size="sm" variant="outline" onClick={() => onRecreate(run)} disabled={!!busy}>
            <Copy /> Recrear
          </Button>
          {run.status === 'done' && (
            <Button size="sm" variant="outline" onClick={openMusic} disabled={!!busy}>
              <Music /> Cambiar música
            </Button>
          )}
          {run.status === 'done' && (
            <Button size="sm" variant="outline" onClick={() => setSoundOpen((v) => !v)} disabled={!!busy}>
              <Volume2 /> Cambiar sonido
            </Button>
          )}
          {run.status === 'done' && rulePlan?.available && (
            <Button size="sm" variant="outline" onClick={() => setRuleOpen((v) => !v)} disabled={!!busy}>
              <Images /> Animación de las imágenes
            </Button>
          )}
          {run.status === 'done' && run.mode !== 'mcp' && (
            <Button size="sm" variant="outline" onClick={() => void revoiceAll()} disabled={!!busy} title="Toda la locución en un solo pedido, con la misma voz: sin cambios de tono entre párrafos">
              {busy === 'revoice' ? <Loader2 className="animate-spin" /> : <Mic />} Rehacer la locución
            </Button>
          )}
        </div>
        {ruleOpen && run.status === 'done' && rulePlan?.available && (
          <div className="grid gap-2 text-xs">
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              Aplica a este video la regla «según cuántas haya» (de izquierda a derecha o de arriba abajo: 1 imagen → video · 2 → video + foto · 3 →
              video + foto + video · 4 → todas fotos). Solo se rehacen los clips que cambian, con el prompt nuevo; los fotogramas no se tocan.
              {rulePlan.rule === 'byCount' && ' Este video ya tiene la regla.'}
            </p>
            {rulePlan.changes.length ? (
              <ul className="grid gap-0.5 font-mono text-[11px]">
                {rulePlan.changes.map((c) => (
                  <li key={c.clip}>
                    clip{String(c.clip).padStart(2, '0')}: {c.before} → {c.after}
                  </li>
                ))}
                <li className="text-muted-foreground font-sans">V = video · F = foto</li>
              </ul>
            ) : (
              <p className="text-[11px]">Ningún clip cambia: la asignación de video y foto ya cumple la regla.</p>
            )}
            {rulePlan.videoClips.length > 0 && (
              <label className="flex cursor-pointer items-center gap-2 text-[11px]">
                <input type="checkbox" checked={ruleAlsoVideo} onChange={(e) => setRuleAlsoVideo(e.target.checked)} disabled={!!busy} />
                Rehacer también los {rulePlan.videoClips.length} clips con marcos de video que ya cumplen (para que se animen con el prompt nuevo)
              </label>
            )}
            {rulePlan.blocked && <p className="text-amber-500 text-[11px]">{rulePlan.blocked}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={applyRule} disabled={!!busy || !!rulePlan.blocked || !ruleClips}>
                {busy === 'rule' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Aplicar y rehacer {ruleClips} clip(s)
              </Button>
            </div>
          </div>
        )}
        {musicOpen && run.status === 'done' && (
          <div className="grid gap-2">
            <MusicPicker tracks={tracks} value={track} onChange={setTrack} disabled={!!busy} />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={changeMusic} disabled={!!busy || track === (run.musicTrack ?? null)}>
                {busy === 'music' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Volver a renderizar
              </Button>
              <span className="text-muted-foreground text-[11px]">
                Solo se vuelve a renderizar (sin costo de proveedores) y queda un final nuevo; el anterior se conserva.
              </span>
            </div>
          </div>
        )}
        {soundOpen && run.status === 'done' && (
          <div className="grid gap-2">
            <SoundPicker value={sound} onChange={setSound} disabled={!!busy} />
            {sound === 'model' && (
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="text-muted-foreground">Volumen del sonido del modelo:</span>
                <GainStepper value={gain} onChange={setGain} disabled={!!busy} />
                <span className="text-muted-foreground">0 dB = la sonoridad de los SFX de antes.</span>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={changeSound} disabled={!!busy || !soundChanged}>
                {busy === 'sound' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Aplicar
              </Button>
              <span className="text-muted-foreground text-[11px]">
                Solo ffmpeg, sin costo: se cambia el sonido de los clips sin recodificar el video y queda un final nuevo.
              </span>
            </div>
          </div>
        )}
        {editing && (
          <div className="grid gap-2">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={newVersion} disabled={!!busy || text.trim().length < 20 || text.trim() === run.text.trim()}>
                {busy === 'version' ? <Loader2 className="animate-spin" /> : <GitBranch />} Crear versión nueva
              </Button>
              <span className="text-muted-foreground text-[11px]">Mismo tema (la copia de este video), misma voz y mismo proyecto; empieza por la locución.</span>
            </div>
          </div>
        )}
        {error && <p className="text-destructive text-xs">{error}</p>}
      </CardContent>
    </Card>
  );
}

/**
 * Vista previa de un clip en su tarjeta: la imagen del fotograma Ki (el estado final del clip) y el video sin precargar;
 * al pasar el mouse se carga y se reproduce. Sin fotograma, el video carga solo su primer cuadro.
 */
function ClipPreview({ url, poster }: { url: string; poster?: string }) {
  return (
    <video
      src={url}
      poster={poster}
      preload={poster ? 'none' : 'metadata'}
      muted
      loop
      playsInline
      className="size-full object-cover"
      onMouseEnter={(e) => void e.currentTarget.play().catch(() => undefined)}
      onMouseLeave={(e) => e.currentTarget.pause()}
    />
  );
}

/** Voz de ElevenLabs del video, con su nombre. */
function VoiceBadge({ id }: { id?: string }) {
  const name = useVoiceName(id);
  if (!id) return null;
  return (
    <Badge variant="secondary" title={`Voz de ElevenLabs · ${id}`}>
      <Mic className="size-3" /> Voz {name}
    </Badge>
  );
}
