import { AlertTriangle, AudioLines, Captions, Check, ChevronDown, ChevronRight, Film, ImageIcon, Loader2, MessageSquare, Play, RefreshCw, Repeat, RotateCcw, Scissors, Sparkles, Undo2, Wand2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ClipAdvice, ClipSplitInfo, ClipFeedback, ClipLogo, ClipSoundMode, ClipState, KeyframeRefUpload, KeyframeState, RunState, VideoDelivery } from '@wilox/shared';
import { KeyframeRefsField } from '@/components/KeyframeRefs';
import { clipSoundTitle, soundOf } from '@/components/SoundPicker';
import { CornerPicker, LogoOverlay } from '@/components/delivery/logo';
import { aspectOf } from '@/components/delivery/ProjectDelivery';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea } from '@/components/ui/textarea';
import { api, reviewApi } from '@/lib/api';
import { REVIEWS_CHANGED_EVENT } from '@/lib/clip-open';
import { confirmSpend, useCostText } from '@/lib/spend';
import { cn } from '@/lib/utils';
import { CaptionOverlay, useVttCues } from '@/lib/captions';

const FPS = 24;

/**
 * Editar un clip (hito 6, ADR-067): todo lo que se puede cambiar de un clip en un solo lugar, con sus
 * fotogramas (versión vigente): regenerarlo con una indicación, su sonido, la locución de su tramo, corregir
 * sus fotogramas y el logo. Con los clips listos, la sección de fotogramas deja de verse en la página.
 */
export function ClipEditor({
  run,
  c,
  delivery,
  onLogo,
  onRevoice,
  onClose,
  autoAnalyze = false,
}: {
  run: RunState;
  c: ClipState;
  /** Abierto desde «Observaciones»: Opus analiza las observaciones al abrir (si no hay una sugerencia vigente). */
  autoAnalyze?: boolean;
  delivery?: VideoDelivery;
  onLogo: (v: ClipLogo | null) => Promise<void>;
  /** Abre «Rehacer audio» del fotograma final del clip (Ki narra el tramo del clip i). */
  onRevoice: (k: KeyframeState) => void;
  onClose: () => void;
}) {
  /** Costo de un clip en USD (hito 11: sin créditos). */
  const clipCost = useCostText({ clips: 1 });
  const kStart = run.keyframes.find((k) => k.index === c.index - 1);
  const kEnd = run.keyframes.find((k) => k.index === c.index);
  const done = run.status === 'done';
  // Con el final al día se sigue corrigiendo mientras se regeneran clips o se vuelve a unir el final (ADR-171).
  const live = canCorrectLive(run);
  const anyWorking = run.keyframes.some((k) => k.status === 'generating' || k.activity);
  const logoHere = delivery ? (delivery.clipCorners[String(c.index)] ?? delivery.settings.corner) : undefined;
  const [zoom, setZoom] = useState<{ url?: string; label: string }>();
  // Ver el clip dentro del video final, como lo ve el cliente (ADR-165): por defecto, si el video tiene final.
  const inFinal = delivery?.clips.find((x) => x.index === c.index);
  const [view, setView] = useState<'video' | 'clip'>();
  const shown = view ?? (run.finalUrl && inFinal ? 'video' : 'clip');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const act = async (label: string, fn: () => Promise<unknown>, close = false) => {
    setBusy(label);
    setError(undefined);
    try {
      await fn();
      if (close) onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const correctFrames = () =>
    act(
      'frames',
      async () => {
        await api.reopen(run.id);
        setTimeout(() => document.getElementById('fotogramas')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
      },
      true,
    );

  return (
    <Modal
      title={
        <span>
          Editar <span className="font-mono">clip{String(c.index).padStart(2, '0')}</span>
          {c.version > 1 ? ` · v${c.version}` : ''} <span className="text-muted-foreground font-normal">· {c.title}</span>
        </span>
      }
      onClose={onClose}
      className="max-w-6xl"
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="grid min-w-0 content-start gap-3">
          {run.finalUrl && inFinal && (
            <div className="flex gap-1 text-xs">
              {(
                [
                  ['video', 'En el video (como lo ve el cliente)'],
                  ['clip', 'Solo el clip'],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={cn('cursor-pointer rounded-md border px-2.5 py-1', shown === v ? 'border-primary bg-primary/10' : 'hover:border-white/20')}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {shown === 'video' && run.finalUrl && inFinal && delivery ? (
            <FinalAtClip run={run} c={c} delivery={delivery} />
          ) : (
          <div className="relative overflow-hidden rounded-lg border bg-black [container-type:inline-size]">
            {c.url && c.status === 'ready' ? (
              <>
                <video key={c.url} src={c.url} controls loop playsInline className="aspect-video w-full" />
                {/* El logo donde irá en este clip (o «Sin logo»): cambia al elegir la esquina a la derecha. */}
                {delivery &&
                  (logoHere === 'none' ? (
                    <span className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 rounded bg-black/60 px-2 py-0.5 text-[11px] text-white/90">Sin logo en este clip</span>
                  ) : (
                    <LogoOverlay src={delivery.logo?.url} aspect={aspectOf(delivery)} settings={delivery.settings} corner={logoHere} />
                  ))}
              </>
            ) : (
              <div className={cn('grid aspect-video place-items-center', c.status === 'generating' && 'shimmer')}>
                {c.status === 'error' ? <AlertTriangle className="text-destructive size-5" /> : <Loader2 className="text-muted-foreground size-5 animate-spin" />}
              </div>
            )}
          </div>
          )}
          <div className="text-muted-foreground flex flex-wrap gap-x-3 font-mono text-[11px]">
            <span>
              {(inFinal?.startSec ?? c.startFrame / FPS).toFixed(2)}–{(inFinal?.endSec ?? c.slotEndFrame / FPS).toFixed(2)} s del final
            </span>
            {c.ssimEnd !== undefined && (
              <span>
                SSIM {c.ssimStart?.toFixed(3) ?? '–'} / {c.ssimEnd.toFixed(3)}
              </span>
            )}
            {c.note && <span className="font-sans">Indicación: {c.note}</span>}
          </div>
          <KeyframeProposals run={run} />
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              { k: kStart, label: 'Fotograma inicial' },
              { k: kEnd, label: 'Fotograma final' },
            ].map(({ k, label }) => (
              <FrameCard key={label} run={run} k={k} label={label} editable={live} onZoom={(x) => setZoom(x)} />
            ))}
          </div>
        </div>

        <div className="grid min-w-0 content-start gap-4 text-xs">
          <ClipFeedbackPanel run={run} c={c} autoAnalyze={autoAnalyze} editable={live} onUseNote={setNote} />
          <section className="grid gap-2">
            <div className="font-medium">Regenerar el clip</div>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Indicación opcional (p. ej. más movimiento en la foto)" />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() =>
                  void confirmSpend({
                    title: `Regenerar clip${String(c.index).padStart(2, '0')}`,
                    body: 'Se genera una versión nueva del clip (con tu indicación, si hay) y después se vuelve a renderizar el final.',
                    work: { clips: 1 },
                    action: 'Regenerar clip',
                  }).then((ok) => (ok ? act('regen', () => api.regenerateClip(run.id, c.index, note || undefined), true) : undefined))
                } disabled={!!busy || c.status === 'generating' || c.status === 'pending'}>
                {busy === 'regen' ? <Loader2 className="animate-spin" /> : <RotateCcw />} Regenerar clip
              </Button>
              <span className="text-muted-foreground text-[11px]">{clipCost ? `${clipCost}; después` : 'Después'} se vuelve a renderizar el final.</span>
            </div>
          </section>

          {done && c.status === 'ready' && <ClipSplitSection run={run} c={c} onDone={onClose} />}

          {done && c.status === 'ready' && <ClipSoundControl run={run} c={c} />}

          {done && kEnd && (
            <section className="grid gap-2">
              <div className="font-medium">Locución del tramo</div>
              <div>
                <Button size="sm" variant="outline" onClick={() => onRevoice(kEnd)} disabled={anyWorking} title="Escuchar la locución de este tramo, cambiar una pausa entre dos palabras (sin costo) o rehacerla">
                  <AudioLines /> Rehacer audio o pausa
                </Button>
              </div>
            </section>
          )}

          <section className="grid gap-2">
            <div className="font-medium">Fotogramas</div>
            <div className="text-muted-foreground text-[11px]">
              Regenera el fotograma inicial o el final aquí mismo (debajo del clip): queda como propuesta y, al aplicarla, se rehacen solo los clips que cambian.
              También puedes volver a la vista de revisión de todos los fotogramas.
            </div>
            <div>
              <Button size="sm" variant="outline" onClick={() => void correctFrames()} disabled={!!busy || !done}>
                {busy === 'frames' ? <Loader2 className="animate-spin" /> : <ImageIcon />} Ir a la revisión de fotogramas
              </Button>
            </div>
          </section>

          {delivery && (
            <section className="grid gap-2">
              <div className="font-medium">Logo en este clip</div>
              <CornerPicker
                value={delivery.clipCorners[String(c.index)]}
                inherited={delivery.settings.corner}
                disabled={busy === 'logo'}
                onChange={(v) => void act('logo', () => onLogo(v))}
              />
            </section>
          )}

          {error && <div className="text-destructive">{error}</div>}
        </div>
      </div>
      {zoom?.url &&
        createPortal(
          <div className="fixed inset-0 z-[110] grid place-items-center bg-black/85 p-4" onClick={() => setZoom(undefined)}>
            <img src={zoom.url} alt={zoom.label} className="max-h-full max-w-full rounded-lg" />
            <button className="absolute top-4 right-4 cursor-pointer rounded-full bg-white/10 p-2" aria-label="Cerrar">
              <X className="size-5" />
            </button>
          </div>,
          document.body,
        )}
    </Modal>
  );
}

/**
 * Fotograma de un clip (ADR-071): versión vigente o propuesta. Con el video terminado se regenera aquí mismo
 * (con indicación o con la sugerencia de Opus); la imagen nueva queda como propuesta hasta «Aplicar».
 */
/** Antes del clip se ve un poco del anterior, para oír cómo entra (s). */
const PREROLL_SEC = 1;

/**
 * El video final con el logo de cada tramo y los subtítulos, como lo ve el cliente, empezando en este clip (ADR-165):
 * así se escucha la locución y se ve la sincronía sin abrir el video en otra pestaña ni adelantarlo a mano. «Repetir el
 * clip» lo vuelve a su inicio al terminar su tramo.
 */
function FinalAtClip({ run, c, delivery }: { run: RunState; c: ClipState; delivery: VideoDelivery }) {
  const video = useRef<HTMLVideoElement>(null);
  const range = delivery.clips.find((x) => x.index === c.index)!;
  const from = Math.max(0, range.startSec - PREROLL_SEC);
  const [t, setT] = useState(from);
  const [loop, setLoop] = useState(false);
  const [captions, setCaptions] = useState(false);
  const cues = useVttCues(captions ? api.subtitlesUrl(run.id, 'vtt', run.finalUrl) : undefined);
  // El logo del tramo que se está viendo (cada clip o inserto tiene su esquina, o ninguna).
  const here = delivery.clips.find((x) => t >= x.startSec && t < x.endSec);
  const corner = here ? (delivery.clipCorners[String(here.index)] ?? delivery.settings.corner) : delivery.settings.corner;
  const start = (play: boolean) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = from;
    if (play) void v.play().catch(() => undefined);
  };
  return (
    <div className="grid gap-1.5">
      <div className="relative overflow-hidden rounded-lg border bg-black [container-type:inline-size]">
        <video
          ref={video}
          key={run.finalUrl}
          src={run.finalUrl}
          controls
          playsInline
          preload="auto"
          className="aspect-video w-full"
          onLoadedMetadata={() => start(true)}
          onTimeUpdate={(e) => {
            const now = e.currentTarget.currentTime;
            setT(now);
            if (loop && now >= range.endSec) start(true);
          }}
        />
        {corner !== 'none' && <LogoOverlay src={delivery.logo?.url} aspect={aspectOf(delivery)} settings={delivery.settings} corner={corner} />}
        <CaptionOverlay video={video} cues={cues} on={captions} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Button size="sm" variant="outline" onClick={() => start(true)} title={`Desde ${PREROLL_SEC} s antes del clip`}>
          <Play /> Desde el clip
        </Button>
        <Button size="sm" variant={loop ? 'default' : 'ghost'} onClick={() => setLoop((v) => !v)} title="Al terminar el tramo del clip, vuelve a su inicio">
          <Repeat /> Repetir el clip
        </Button>
        <Button size="sm" variant={captions ? 'default' : 'ghost'} onClick={() => setCaptions((v) => !v)}>
          <Captions /> Subtítulos
        </Button>
        <span className="text-muted-foreground font-mono text-[11px]">
          {t.toFixed(1)} s · clip {range.startSec.toFixed(1)}–{range.endSec.toFixed(1)} s
          {t >= range.startSec && t < range.endSec ? ' · ahora en este clip' : ''}
        </span>
      </div>
    </div>
  );
}

function FrameCard({ run, k, label, editable, onZoom }: { run: RunState; k?: KeyframeState; label: string; editable: boolean; onZoom: (k: { url?: string; label: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  // Imágenes de referencia del editor (hito 13, ADR-170): siempre con indicación.
  const [refs, setRefs] = useState<KeyframeRefUpload[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  if (!k) return <div className="text-muted-foreground grid place-items-center rounded-lg border p-4 text-xs">{label}: no hay.</div>;
  const name = `K${String(k.index).padStart(2, '0')}`;
  const working = k.status === 'generating' || !!k.activity;
  const call = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await fn();
      setOpen(false);
      setNote('');
      setRefs([]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const regen = async (useSuggestion: boolean) => {
    const ok = await confirmSpend({
      title: `Regenerar ${name}`,
      body: (
        <>
          {useSuggestion
            ? 'Se genera una imagen nueva con el plano que sugirió Opus'
            : refs.length
              ? `Opus mira ${refs.length === 1 ? 'la imagen' : `las ${refs.length} imágenes`} y reescribe el plano con tu indicación; se genera una imagen nueva con ${refs.length === 1 ? 'ella' : 'ellas'} como referencia`
              : 'Opus reescribe el plano con tu indicación y se genera una imagen nueva'}
          ; Opus la revisa. Queda como propuesta: los clips no cambian hasta que la apliques.
        </>
      ),
      work: { images: 1, llm: useSuggestion ? 1 : note.trim() ? 2 : 1 },
      action: 'Regenerar',
    });
    if (ok) await call(() => api.regenerate(run.id, k.index, useSuggestion ? { useSuggestion: true } : { note: note.trim() || undefined, ...(refs.length ? { refs } : {}) }));
  };
  const suggestion = k.review?.verdict === 'improve' && k.review.revisedScene;
  const needsNote = refs.length > 0 && !note.trim();
  return (
    <div className={cn('overflow-hidden rounded-lg border bg-background/40 text-xs', k.previous && 'border-warning/50')}>
      <button type="button" className="relative block aspect-video w-full cursor-zoom-in bg-secondary" onClick={() => onZoom(k)} disabled={!k.url}>
        {k.url && k.status !== 'generating' && <img src={k.url} alt={k.label} className={cn('size-full object-cover', working && 'opacity-40')} loading="lazy" />}
        <span className="absolute top-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white">
          {name}
          {k.version > 1 ? ` · v${k.version}` : ''}
        </span>
        {k.previous && !working && <span className="bg-warning/90 absolute top-2 right-2 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-black">Propuesta</span>}
        {working && (
          <span className="absolute inset-x-0 bottom-2 mx-auto flex w-fit items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[11px] text-white">
            <Loader2 className="size-3 animate-spin" /> {k.activity ?? 'Generando…'}
          </span>
        )}
      </button>
      <div className="grid gap-1.5 p-2.5">
        <div className="text-muted-foreground text-[11px]">{label}</div>
        <div className="font-medium">{k.label.replace(/^K\d+ · /, '')}</div>
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
        {k.review && !working &&
          (k.review.verdict === 'ok' ? (
            <div className="text-success flex items-center gap-1 text-[11px]">
              <Check className="size-3" /> Opus: composición correcta
            </div>
          ) : (
            <div className="text-warning text-[11px]">Opus sugiere: {k.review.issues}</div>
          ))}
        {k.previous && (
          <button type="button" onClick={() => onZoom({ url: k.previous!.url, label: k.previous!.label })} className="flex cursor-zoom-in items-center gap-2 rounded-md border p-1 text-left">
            {k.previous.url && <img src={k.previous.url} alt="" className="h-9 w-16 rounded object-cover" />}
            <span className="text-muted-foreground text-[11px]">Vigente: v{k.previous.version} (con la que están hechos los clips)</span>
          </button>
        )}
        {editable && !open && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Button size="sm" variant="outline" disabled={working || busy} onClick={() => setOpen(true)}>
              <RefreshCw /> {k.previous ? 'Regenerar otra vez' : 'Regenerar fotograma'}
            </Button>
            {k.previous && (
              <Button size="sm" variant="ghost" disabled={working || busy} onClick={() => void call(() => api.discardKeyframe(run.id, k.index))} title="Vuelve la versión vigente">
                <Undo2 /> Descartar
              </Button>
            )}
          </div>
        )}
        {editable && open && (
          <div className="grid gap-1.5 pt-1">
            <Textarea rows={3} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="¿Qué debe cambiar? Vacío = otra versión del mismo plano." />
            <KeyframeRefsField runId={run.id} index={k.index} value={refs} onChange={setRefs} disabled={busy} compact />
            {needsNote && <div className="text-warning text-[11px]">Escribe qué hacer con las imágenes.</div>}
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" disabled={busy || needsNote} onClick={() => void regen(false)}>
                {busy ? <Loader2 className="animate-spin" /> : <Wand2 />} Regenerar
              </Button>
              {suggestion && (
                <Button size="sm" variant="secondary" disabled={busy || refs.length > 0} onClick={() => void regen(true)}>
                  <Wand2 /> Sugerencia de Opus
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
            </div>
          </div>
        )}
        {err && <div className="text-destructive text-[11px]">{err}</div>}
      </div>
    </div>
  );
}

/**
 * Video con final en el que se sigue corrigiendo (ADR-171): terminado, con clips regenerándose o con el final volviéndose
 * a unir. Regenerar fotogramas y clips y aplicar propuestas van a la cola sin esperar a lo demás.
 */
export const canCorrectLive = (run: RunState) => !!run.finalUrl && ['done', 'clips', 'post', 'render'].includes(run.status);

/** Versión vigente de cada fotograma (la de los clips) mientras hay propuestas. */
const keyVersion = (run: RunState, i: number) => run.keyframes.find((k) => k.index === i)?.version ?? 1;

/** Clips que se rehacen al aplicar las propuestas: los hechos con otra versión de sus fotogramas. */
export function affectedClips(run: RunState) {
  return run.clips.filter((c) => c.status === 'ready' && c.builtWith && (c.builtWith[0] !== keyVersion(run, c.index - 1) || c.builtWith[1] !== keyVersion(run, c.index)));
}

/**
 * Propuestas de fotogramas sin aplicar (ADR-071): qué clips se rehacen y el botón para aplicarlas (con aviso de
 * gasto). Se muestra en «Editar clip» y sobre las tarjetas de clips.
 */
export function KeyframeProposals({ run }: { run: RunState }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const proposals = run.keyframes.filter((k) => k.previous);
  if (!proposals.length || !canCorrectLive(run)) return null;
  const working = run.keyframes.some((k) => k.status === 'generating' || k.activity);
  const affected = affectedClips(run);
  const apply = async () => {
    const ok = await confirmSpend({
      title: 'Aplicar las propuestas de fotogramas',
      body: `Se rehacen ${affected.map((c) => `clip${String(c.index).padStart(2, '0')}`).join(', ')} con los fotogramas nuevos y después el render (se conserva el final anterior).`,
      work: { clips: affected.length },
      action: 'Aplicar y rehacer clips',
    });
    if (!ok) return;
    setBusy(true);
    setErr(undefined);
    try {
      await api.applyKeyframes(run.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-warning/40 bg-warning/10 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs">
      <div>
        <div className="font-medium">
          Propuesta{proposals.length > 1 ? 's' : ''} sin aplicar: {proposals.map((k) => `K${String(k.index).padStart(2, '0')}`).join(', ')}
        </div>
        <div className="text-muted-foreground text-[11px]">
          {working
            ? 'Esperando a que termine la regeneración…'
            : affected.length
              ? `Al aplicar se rehacen ${affected.map((c) => `clip${String(c.index).padStart(2, '0')}`).join(', ')} y el render. El video sigue igual hasta entonces.`
              : 'No cambia ningún clip.'}
        </div>
        {err && <div className="text-destructive">{err}</div>}
      </div>
      <Button size="sm" onClick={() => void apply()} disabled={busy || working}>
        {busy ? <Loader2 className="animate-spin" /> : <Check />} Aplicar y rehacer clips
      </Button>
    </div>
  );
}

/**
 * Sonido de un clip (hito 6, ADR-059): el clip de la izquierda suena con el audio que trajo el modelo; si trae
 * música o habla, se silencia o se pasa a sintetizado sin regenerar el clip (solo ffmpeg).
 */
function ClipSoundControl({ run, c }: { run: RunState; c: ClipState }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const set = async (mode: ClipSoundMode | null) => {
    setBusy(true);
    setErr(undefined);
    try {
      await api.changeClipSound(run.id, c.index, mode);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const model = soundOf(run.soundMode) === 'model';
  return (
    <section className="grid gap-2">
      <div className="font-medium">Sonido del clip</div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={c.soundMode ?? ''}
          onChange={(e) => void set((e.target.value || null) as ClipSoundMode | null)}
          disabled={busy}
          className="border-input bg-background/60 h-8 cursor-pointer rounded-md border px-2 text-xs disabled:opacity-50"
        >
          <option value="">{clipSoundTitle(undefined)}</option>
          <option value="mute">{clipSoundTitle('mute')}</option>
          <option value="synth">{clipSoundTitle('synth')}</option>
        </select>
        {busy && <Loader2 className="size-3.5 animate-spin" />}
      </div>
      <div className="text-muted-foreground text-[11px]">
        {model && c.soundLufs !== undefined ? (c.soundLufs === null ? 'El modelo no trajo sonido en este clip. ' : `Sonido del modelo: ${c.soundLufs} LUFS antes de normalizar. `) : ''}
        El clip de la izquierda suena con el audio que trajo el modelo. Solo ffmpeg, sin costo.
      </div>
      {err && <div className="text-destructive">{err}</div>}
    </section>
  );
}

const kName = (i: number) => `K${String(i).padStart(2, '0')}`;
const fmtWhen = (iso: string) => new Date(iso).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const STATUS_LABEL = { pending: 'Pendiente', progress: 'En curso', resolved: 'Resuelta', archived: 'Archivada' } as const;

/**
 * Observaciones del cliente sobre este clip y sugerencia de Opus (hito 9, T11, ADR-122). Plegable: el encabezado dice
 * cuántas hay abiertas; al abrirlo, cada una con su autor, dónde la escribió (storyboard o video) y su estado. Opus
 * propone qué regenerar (el clip, el fotograma inicial o el final) con la indicación lista; «Aplicar» lanza ese cambio
 * (con aviso de gasto) y deja las observaciones «En curso».
 */
function ClipFeedbackPanel({ run, c, autoAnalyze, editable, onUseNote }: { run: RunState; c: ClipState; autoAnalyze: boolean; editable: boolean; onUseNote: (n: string) => void }) {
  const [fb, setFb] = useState<ClipFeedback>();
  const [open, setOpen] = useState(autoAnalyze);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [tried, setTried] = useState(false);
  const load = useCallback(() => reviewApi.clipFeedback(run.id, c.index).then(setFb, (e: Error) => setError(e.message)), [run.id, c.index]);
  useEffect(() => {
    void load();
  }, [load]);
  // El servidor solo manda las abiertas (pendientes y en curso): lo resuelto ya no se muestra aquí (T11b).
  const openComments = fb?.comments ?? [];

  const analyze = useCallback(async () => {
    setBusy('advice');
    setError(undefined);
    try {
      setFb(await reviewApi.clipAdvice(run.id, c.index));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }, [run.id, c.index]);
  // Desde «Observaciones»: si hay abiertas y no hay sugerencia vigente, Opus las analiza al abrir.
  useEffect(() => {
    if (!autoAnalyze || tried || !fb) return;
    setTried(true);
    if (openComments.length && (!fb.advice || fb.advice.stale)) void analyze();
  }, [autoAnalyze, tried, fb, openComments.length, analyze]);

  /** Tras aplicar: las observaciones que vio Opus y siguen pendientes pasan a «En curso». */
  const markInProgress = async (a: ClipAdvice) => {
    const pending = fb?.comments.filter((x) => a.commentIds.includes(x.id) && x.status === 'pending') ?? [];
    await Promise.all(pending.map((x) => reviewApi.setStatus(x.id, 'progress').catch(() => undefined)));
    window.dispatchEvent(new Event(REVIEWS_CHANGED_EVENT));
    void load();
  };

  const apply = async (a: ClipAdvice, act: ClipAdvice['actions'][number], i: number) => {
    const k = act.target === 'clip' ? undefined : run.keyframes.find((x) => x.index === (act.target === 'start' ? c.index - 1 : c.index));
    const ok = await confirmSpend(
      act.target === 'clip'
        ? {
            title: `Regenerar clip${String(c.index).padStart(2, '0')}`,
            body: `Con la indicación: «${act.instruction}». Después se vuelve a renderizar el final.`,
            work: { clips: 1 },
            action: 'Regenerar clip',
          }
        : {
            title: `Regenerar ${kName(k!.index)}`,
            body: `Opus reescribe el plano con este cambio: «${act.instruction}» y se genera una imagen nueva. Queda como propuesta: los clips no cambian hasta que la apliques.`,
            work: { images: 1, llm: 2 },
            action: 'Regenerar',
          },
    );
    if (!ok) return;
    setBusy(`act${i}`);
    setError(undefined);
    try {
      // Al modelo de video va la versión en inglés; el equipo ve y edita la española.
      if (act.target === 'clip') await api.regenerateClip(run.id, c.index, act.modelInstruction || act.instruction);
      else await api.regenerate(run.id, k!.index, { note: act.instruction });
      await markInProgress(a);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  if (!fb || !openComments.length) return null;
  const a = fb.advice;
  return (
    <section className={cn('grid gap-2 rounded-lg border p-2.5', openComments.length ? 'border-warning/40 bg-warning/5' : '')}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex cursor-pointer items-center gap-1.5 text-left font-medium">
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <MessageSquare className="text-warning size-3.5" /> Observaciones del cliente
        <span className="text-muted-foreground font-normal">
          · {openComments.length} abierta{openComments.length === 1 ? '' : 's'}
        </span>
      </button>
      {open && (
        <div className="grid max-h-56 gap-1.5 overflow-y-auto pr-1">
          {fb.comments.map((x) => (
            <div key={x.id} className={cn('bg-background/60 rounded-md border p-2', x.status === 'resolved' && 'opacity-60')}>
              <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
                <span className="font-semibold">{x.author}</span>
                <span className="text-muted-foreground">{fmtWhen(x.createdAt)}</span>
                <span className="inline-flex items-center gap-1 rounded bg-secondary px-1.5">
                  {x.kind === 'video' ? <Film className="size-3" /> : <ImageIcon className="size-3" />}
                  {x.kind === 'video' ? `Video · plano ${kName(x.keyframeIndex)}` : `Storyboard · ${kName(x.keyframeIndex)}${x.keyframeIndex === c.index ? ' (final)' : ' (inicial)'}`}
                </span>
                <span className={cn('rounded px-1.5', x.status === 'pending' ? 'bg-warning/15 text-warning' : x.status === 'progress' ? 'bg-primary/15 text-primary' : 'bg-success/15 text-success')}>
                  {STATUS_LABEL[x.status]}
                </span>
                {x.outdated && <span className="text-warning">sobre una versión anterior</span>}
              </div>
              <p className="mt-1 text-[12px] leading-snug whitespace-pre-wrap">{x.text}</p>
            </div>
          ))}
        </div>
      )}

      {openComments.length > 0 && (
        <div className="grid gap-1.5">
          {busy === 'advice' ? (
            <div className="text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin" /> Opus analiza las observaciones de este clip…
            </div>
          ) : a ? (
            <div className="bg-background/60 grid gap-1.5 rounded-md border p-2">
              <div className="flex items-center gap-1.5 font-medium">
                <Sparkles className="text-primary size-3.5" /> Sugerencia de Opus
                {a.stale && <span className="text-warning text-[10.5px] font-normal">· desactualizada</span>}
              </div>
              <p className="text-[12px] leading-snug">{a.summary}</p>
              {a.actions.length === 0 && <p className="text-muted-foreground text-[11px]">No propone cambios en este clip.</p>}
              {a.actions.map((act, i) => (
                <div key={i} className="grid gap-1 rounded-md border p-1.5">
                  <div className="text-[11px] font-medium">
                    {act.target === 'clip' ? 'Regenerar el clip' : `Regenerar el fotograma ${act.target === 'start' ? 'inicial' : 'final'} (${kName(act.target === 'start' ? c.index - 1 : c.index)})`}
                  </div>
                  <p className="bg-secondary/60 rounded px-1.5 py-1 text-[12px] leading-snug">{act.instruction}</p>
                  <p className="text-muted-foreground text-[10.5px]">{act.why}</p>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" disabled={!!busy || !editable} onClick={() => void apply(a, act, i)} title={editable ? undefined : 'Disponible con el video terminado'}>
                      {busy === `act${i}` ? <Loader2 className="animate-spin" /> : <Check />} Aplicar
                    </Button>
                    {act.target === 'clip' && (
                      <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => onUseNote(act.instruction)} title="La deja en «Regenerar el clip» para editarla">
                        Usar como indicación
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              {a.notes && <p className="text-muted-foreground text-[10.5px]">Notas: {a.notes}</p>}
              <div>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={!!busy} onClick={() => void analyze()}>
                  <RefreshCw /> Analizar de nuevo
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void analyze()}>
                <Sparkles /> Pedir sugerencia a Opus
              </Button>
            </div>
          )}
        </div>
      )}
      {error && <div className="text-destructive text-[11px]">{error}</div>}
    </section>
  );
}

/**
 * «Dividir en dos» (hito 10, T3, ADR-130): si el tramo del clip da para dos clips completos, un fotograma intermedio en
 * una palabra cerca de la mitad y dos clips (del inicial al intermedio y del intermedio al final). Todo automático.
 */
function ClipSplitSection({ run, c, onDone }: { run: RunState; c: ClipState; onDone: () => void }) {
  const [info, setInfo] = useState<ClipSplitInfo>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    let alive = true;
    api.splitInfo(run.id, c.index).then(
      (x) => alive && setInfo(x),
      () => alive && setInfo(undefined),
    );
    return () => {
      alive = false;
    };
  }, [run.id, c.index, c.version, c.startFrame, c.slotEndFrame, run.status]);
  if (!info) return null;
  const nn = (n: number) => String(n).padStart(2, '0');
  const split = async () => {
    const ok = await confirmSpend({
      title: `Dividir clip${nn(c.index)} en dos`,
      body: `Opus escribe un fotograma intermedio en «${info.cutWord}» (${info.cutSec?.toFixed(1)} s). clip${nn(c.index)} pasa a ir hasta ese fotograma (${info.firstSec?.toFixed(1)} s) y un clip nuevo va de ahí al fotograma final (${info.secondSec?.toFixed(1)} s); los clips y fotogramas siguientes se renumeran. Se vuelve a unir el final y el anterior se conserva.`,
      work: { images: 1, clips: 2, llm: 1 },
      action: 'Dividir en dos',
    });
    if (!ok) return;
    setBusy(true);
    setErr(undefined);
    try {
      await api.splitClip(run.id, c.index);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="grid gap-2">
      <div className="font-medium">Dividir en dos</div>
      <div className="text-muted-foreground text-[11px]">
        El tramo de este clip dura {info.slotSec.toFixed(1)} s ({Math.min(info.slotSec, 5.17).toFixed(1)} s animados y el resto congelado).
        {info.available
          ? ` Se corta en «${info.cutWord}» (${info.cutSec?.toFixed(1)} s): dos clips de ${info.firstSec?.toFixed(1)} s y ${info.secondSec?.toFixed(1)} s.`
          : ` ${info.reason}`}
      </div>
      {info.available && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void split()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Scissors />} Dividir en dos
          </Button>
          <span className="text-muted-foreground text-[11px]">1 fotograma, 2 clips y Opus.</span>
        </div>
      )}
      {err && <div className="text-destructive">{err}</div>}
    </section>
  );
}

