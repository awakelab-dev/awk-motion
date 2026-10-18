import { CheckCircle2, CloudCog, Download, Layers, Loader2, RotateCcw, Save } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  SINGLE_HTML_MAX_BYTES,
  isOriginalQuality,
  qualityLabel,
  type BatchRequestFormat,
  type ClipLogo,
  type DownloadFormat,
  type DownloadRequest,
  type LogoCorner,
  type LogoSettings,
  type ProjectDelivery,
  type RunState,
  type VideoDelivery,
} from '@wilox/shared';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { LogoSettingsFields, LogoSourceFields, choiceSrc, notifyDelivery, toDownloadLogo, type LogoChoice } from '@/components/delivery/logo';
import { QualityFields, useEstimate, useStoredQuality } from '@/components/delivery/quality';
import { api, batchesApi } from '@/lib/api';
import { goTo, useBatches } from '@/lib/batches';
import { askNotifications } from '@/lib/queue';
import { cn } from '@/lib/utils';

/** Formato del diálogo: los de la descarga del video y el código para Rise 360 (hito 9, T3, ADR-103). */
type Format = DownloadFormat | 'rise';
const FORMATS: { id: Format; title: string; hint: string; logo: boolean }[] = [
  { id: 'html', title: 'HTML', hint: 'ZIP con index.html, el video y los subtítulos. Funciona sin internet, con doble clic o subido a Moodle.', logo: true },
  { id: 'scorm12', title: 'SCORM 1.2', hint: 'Paquete para Moodle u otro LMS: registra el video como visto (95 %) y retoma donde quedó.', logo: true },
  { id: 'scorm2004', title: 'SCORM 2004', hint: 'Igual que el 1.2, en la 4.ª edición (además informa el avance).', logo: true },
  { id: 'single', title: 'Un solo .html', hint: 'El video va dentro del HTML (pesa ~33 % más). Solo para videos de hasta 40 MB.', logo: true },
  { id: 'mp4', title: 'Solo el MP4', hint: 'El video tal cual, sin logo ni subtítulos.', logo: false },
  { id: 'zip', title: 'ZIP completo', hint: 'Todo: el final con su reproductor HTML, subtítulos, clips con su sonido, voz, fotogramas, prompts y ficha.', logo: true },
  {
    id: 'rise',
    title: 'Código para Rise 360',
    hint: 'Un documento con el código para pegar en un bloque «Embed» de Rise. El video y sus subtítulos se publican en la nube, con el logo dibujado; se prepara en segundo plano y queda en «Descargas».',
    logo: true,
  },
];
const mb = (b: number) => `${(b / 1e6).toFixed(0)} MB`;
/** Ajustes sin la esquina (la esquina por defecto es del proyecto; en la descarga se usa "Esquina de los clips"). */
const sameSettings = (a?: LogoSettings, b?: LogoSettings) => !!a && !!b && JSON.stringify({ ...a, corner: '' }) === JSON.stringify({ ...b, corner: '' });

/**
 * Descarga del final (hito 6, ADR-065 a ADR-067): HTML (por defecto), SCORM 1.2 o 2004, un solo .html, solo
 * el MP4 o el ZIP completo. El logo puede ser el del proyecto, otro solo para esta descarga o ninguno; los
 * ajustes son los del proyecto y se pueden cambiar para esta descarga o guardarlos en el proyecto. La
 * "Esquina de los clips" respeta por defecto la de cada clip (se elige en la página del video) o pone todos
 * en una. La portada es el final de un clip. Vista previa en vivo del reproductor que se descarga.
 */
export function DownloadDialog({ run, onClose }: { run: RunState; onClose: () => void }) {
  const [project, setProject] = useState<ProjectDelivery>();
  const [video, setVideo] = useState<VideoDelivery>();
  const [settings, setSettings] = useState<LogoSettings>();
  const [cornerAll, setCornerAll] = useState<LogoCorner>();
  const [logo, setLogo] = useState<LogoChoice>({ kind: 'project' });
  const [posterClip, setPosterClip] = useState<number>();
  const [format, setFormat] = useState<Format>('html');
  // Código para Rise 360: documento .html (con vista previa y «Copiar») o .txt, y subtítulos encendidos al empezar.
  const [riseDoc, setRiseDoc] = useState<'html' | 'txt'>('html');
  const [riseSubs, setRiseSubs] = useState(true);
  const [created, setCreated] = useState<false | 'rise' | 'light' | 'batch'>(false);
  // SCORM liviano (T4, ADR-108): el video en la nube, el paquete pesa unos KB.
  const [light, setLight] = useState(false);
  const isScorm = format === 'scorm12' || format === 'scorm2004';
  const lightOn = isScorm && light;
  const { refresh: refreshBatches } = useBatches();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const frame = useRef<HTMLIFrameElement>(null);
  // Resolución y compresión (hito 7, ADR-085): se elige en cada descarga; la última se recuerda.
  const [quality, setQuality] = useStoredQuality();
  const { est, loading: estimating } = useEstimate('generations', run.id, quality, !!video);
  const projectId = run.projectId!;

  useEffect(() => {
    Promise.all([api.projectDelivery(projectId), api.videoDelivery(run.id)]).then(
      ([p, v]) => {
        setProject(p);
        setVideo(v);
        setSettings(p.settings);
        setLogo(p.logo ? { kind: 'project' } : { kind: 'none' });
        setPosterClip(v.posterClip);
      },
      (e: Error) => setError(e.message),
    );
  }, [projectId, run.id]);

  // La vista previa se carga una vez; logo, ajustes, esquinas y portada llegan en vivo por postMessage.
  const src = useMemo(() => (video ? api.playerUrl(run.id, undefined, video.posterSec) : undefined), [run.id, !!video]); // eslint-disable-line react-hooks/exhaustive-deps
  const logoSrc = choiceSrc(logo, project?.logo);
  const clipCorners = useMemo<Record<string, ClipLogo>>(() => {
    if (!video) return {};
    if (!cornerAll) return video.clipCorners;
    return Object.fromEntries(video.clips.map((c) => [String(c.index), video.clipCorners[String(c.index)] === 'none' ? 'none' : cornerAll]));
  }, [video, cornerAll]);
  const posterSec = video?.clips.find((c) => c.index === posterClip)?.posterSec ?? video?.posterSec;
  const send = (extra: Record<string, unknown> = {}) =>
    settings && frame.current?.contentWindow?.postMessage({ type: 'wilox-delivery', settings, clipCorners, logo: logoSrc ?? null, ...extra }, window.location.origin);
  useEffect(() => send(), [settings, logoSrc, clipCorners]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (video && posterSec !== undefined) send({ poster: api.posterUrl(run.id, posterSec) });
  }, [posterSec]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const saveForProject = () =>
    act('project', async () => {
      setProject(await api.setProjectDelivery(projectId, { ...settings!, corner: project!.settings.corner }));
      notifyDelivery();
    });
  const download = () =>
    act('download', async () => {
      // La portada se guarda en el video; el logo de una sola vez, los ajustes y la esquina de todos, no.
      if (video && posterClip !== undefined && posterClip !== video.posterClip) setVideo(await api.setVideoDelivery(run.id, { posterClip }));
      if (format === 'rise') {
        // Se publica en segundo plano y el documento queda en «Descargas» (T3b, ADR-104).
        await api.createRise('generations', run.id, { quality, logo: logo.kind === 'project' && !!project?.logo, subtitlesOn: riseSubs, doc: riseDoc });
        askNotifications();
        refreshBatches();
        setCreated('rise');
        return;
      }
      const r: DownloadRequest = { format };
      if (FORMATS.find((f) => f.id === format)!.logo) {
        if (logo.kind !== 'project') r.logo = toDownloadLogo(logo);
        if (!sameSettings(settings, project?.settings)) r.settings = { ...settings!, corner: project!.settings.corner };
        if (cornerAll) r.cornerAll = cornerAll;
      }
      if (lightOn) {
        // Se publica el video en segundo plano y el SCORM queda en «Descargas» (T4, ADR-108).
        await api.createLightScorm('generations', run.id, { version: format === 'scorm12' ? '1.2' : '2004', quality, logo: r.logo, settings: r.settings, cornerAll: r.cornerAll });
      } else {
        // Todas las descargas se arman en «Descargas» (T5a, ADR-109): de ahí se bajan o se manda el link al cliente.
        await batchesApi.create({ projectId, format: format as BatchRequestFormat, videoIds: [run.id], logo: r.logo, settings: r.settings, cornerAll: r.cornerAll, quality: isOriginalQuality(quality) ? undefined : quality });
      }
      askNotifications();
      refreshBatches();
      setCreated(lightOn ? 'light' : 'batch');
    });

  // El tope de 40 MB del "Un solo .html" se mide con el peso ya comprimido (ADR-085).
  const tooBig = (est?.bytes ?? video?.finalBytes ?? 0) > SINGLE_HTML_MAX_BYTES;
  const changed = !!settings && !!project && !sameSettings(settings, project.settings);
  const noLogo = !FORMATS.find((f) => f.id === format)!.logo;

  if (created)
    return (
      <Modal title={created === 'rise' ? 'Código para Rise 360 en preparación' : created === 'light' ? 'SCORM liviano en preparación' : 'Descarga en preparación'} onClose={onClose} className="max-w-lg">
        <div className="grid gap-4 text-sm">
          <p className="flex items-start gap-2">
            <CheckCircle2 className="text-success mt-0.5 size-4 shrink-0" />
            <span>
              {created === 'batch'
                ? `El servidor arma «${FORMATS.find((f) => f.id === format)!.title}» en segundo plano${isOriginalQuality(quality) ? '' : ` (primero codifica el video en ${qualityLabel(quality)})`}.`
                : `El servidor publica el video en la nube y arma ${created === 'rise' ? 'el documento' : 'el paquete'} en segundo plano.`}{' '}
              Puedes cerrar la app: queda en «Descargas», donde ves su avance y lo bajas (te avisa cuando esté listo).
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                onClose();
                goTo('descargas');
              }}
            >
              <Layers /> Ver descargas
            </Button>
            <Button variant="outline" onClick={onClose}>
              Cerrar
            </Button>
          </div>
        </div>
      </Modal>
    );

  return (
    <Modal title="Descargar el video" onClose={onClose} className="max-w-6xl">
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="grid min-w-0 content-start gap-3">
          <div className="overflow-hidden rounded-lg border bg-black">
            {src ? (
              <iframe key={src} ref={frame} src={src} title="Vista previa del reproductor" className="aspect-video w-full" allow="fullscreen" onLoad={() => send()} />
            ) : (
              <div className="grid aspect-video place-items-center">
                <Loader2 className="text-muted-foreground size-5 animate-spin" />
              </div>
            )}
          </div>
          <p className="text-muted-foreground text-[11px]">
            Vista previa del reproductor que se descarga: portada, controles, subtítulos (botón CC, apagados por defecto) y logo. Atajos: espacio, flechas, c
            (subtítulos), f (pantalla completa). La posición del logo en cada clip se cambia en la página del video, sobre cada clip.
          </p>

          {video && video.clips.length > 0 && (
            <section className={cn('grid gap-1.5 text-xs', format === 'mp4' && 'pointer-events-none opacity-50')}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <div className="font-medium">Portada</div>
                <div className="text-muted-foreground text-[11px]">El final de un clip: ahí ya está todo dibujado.</div>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {video.clips.map((c) => (
                  <button
                    key={c.index}
                    type="button"
                    onClick={() => setPosterClip(c.index)}
                    title={c.title}
                    className={cn(
                      'w-28 shrink-0 cursor-pointer overflow-hidden rounded-md border-2 text-left transition-colors',
                      posterClip === c.index ? 'border-primary' : 'hover:border-muted-foreground/50 border-transparent',
                    )}
                  >
                    <img src={api.posterUrl(run.id, c.posterSec, 320)} alt="" loading="lazy" className="bg-secondary aspect-video w-full object-cover" />
                    <span className={cn('block px-1.5 py-0.5 font-mono text-[10.5px]', posterClip === c.index ? 'bg-primary/15' : 'bg-secondary/60')}>
                      {c.index > 0 ? `clip${String(c.index).padStart(2, '0')}` : c.title}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        <div className="grid min-w-0 content-start gap-4 text-xs">
          <section className="grid gap-2">
            <div className="font-medium">Formato</div>
            {FORMATS.map((f) => {
              const disabled = f.id === 'single' && tooBig;
              return (
                <Fragment key={f.id}>
                  <label className={cn('flex cursor-pointer gap-2 rounded-md border p-2', format === f.id && 'border-primary bg-primary/10', disabled && 'cursor-not-allowed opacity-50')}>
                    <input type="radio" name="format" checked={format === f.id} disabled={disabled} onChange={() => setFormat(f.id)} className="mt-0.5" />
                    <span>
                      <span className="font-medium">{f.title}</span>
                      <span className="text-muted-foreground block text-[11px]">
                        {f.hint}
                        {disabled ? ` Con ${qualityLabel(quality)} pesa ${mb(est?.bytes ?? video?.finalBytes ?? 0)}: elige una resolución o compresión menor.` : ''}
                      </span>
                    </span>
                  </label>
                  {/* SCORM liviano (T4): debajo de los dos SCORM, con el que esté elegido. */}
                  {f.id === 'scorm2004' && isScorm && <LightScormField checked={light} onChange={setLight} />}
                </Fragment>
              );
            })}
          </section>

          <section className="grid gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <div className="font-medium">Resolución y compresión</div>
              {format === 'zip' && <div className="text-muted-foreground text-[11px]">Solo el final; clips, voz y fotogramas van originales.</div>}
            </div>
            <QualityFields value={quality} onChange={setQuality} est={est} loading={estimating} disabled={!!busy} when={format === 'rise' || lightOn ? 'al publicar' : undefined} />
          </section>

          {format === 'rise' ? (
            <section className="grid gap-2">
              <div className="font-medium">Logo</div>
              {project?.logo ? (
                <div className="grid gap-1.5">
                  {(
                    [
                      ['project', 'El del proyecto, dibujado en el video'],
                      ['none', 'Sin logo'],
                    ] as const
                  ).map(([k, label]) => (
                    <label key={k} className="flex cursor-pointer items-center gap-2">
                      <input type="radio" name="riselogo" checked={(logo.kind === 'project') === (k === 'project')} onChange={() => setLogo({ kind: k })} />
                      {label}
                    </label>
                  ))}
                  <div className="text-muted-foreground text-[11px]">
                    Con la esquina de cada clip y el tamaño, el margen, el realce y la opacidad del proyecto (se cambian en «Logo» del proyecto). Se ve también en
                    pantalla completa. Si cambian, el video publicado se rehace solo en la misma dirección.
                  </div>
                </div>
              ) : (
                <div className="text-muted-foreground text-[11px]">El proyecto no tiene logo: el video se publica sin logo.</div>
              )}
              <div className="font-medium">Documento</div>
              <div className="flex flex-wrap gap-3">
                {(
                  [
                    ['html', '.html con vista previa y «Copiar»'],
                    ['txt', '.txt'],
                  ] as const
                ).map(([k, label]) => (
                  <label key={k} className="flex cursor-pointer items-center gap-2">
                    <input type="radio" name="risedoc" checked={riseDoc === k} onChange={() => setRiseDoc(k)} />
                    {label}
                  </label>
                ))}
              </div>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={riseSubs} onChange={(e) => setRiseSubs(e.target.checked)} />
                Subtítulos encendidos al empezar
              </label>
            </section>
          ) : (
            <section className={cn('grid gap-2', noLogo && 'pointer-events-none opacity-50')}>
              <div className="font-medium">Logo</div>
              <LogoSourceFields project={project?.logo} choice={logo} onChange={setLogo} />
            </section>
          )}

          {settings && logo.kind !== 'none' && format !== 'rise' && (
            <section className={cn('grid gap-2', noLogo && 'pointer-events-none opacity-50')}>
              <div className="flex items-center justify-between">
                <div className="font-medium">Ajustes del logo</div>
                {(changed || cornerAll) && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1 text-[11px]"
                    onClick={() => {
                      setSettings(project!.settings);
                      setCornerAll(undefined);
                    }}
                  >
                    <RotateCcw className="size-3" /> Los del proyecto
                  </button>
                )}
              </div>
              <LogoSettingsFields settings={settings} onChange={setSettings} cornerAll={{ value: cornerAll, onChange: setCornerAll }} />
              {cornerAll && <div className="text-muted-foreground text-[11px]">Todos los clips con logo lo llevan ahí en esta descarga; los clips sin logo siguen sin logo.</div>}
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={saveForProject} disabled={!!busy || !changed} title="Guardar ancho, margen, opacidad y realce como los del proyecto (todos sus videos)">
                  {busy === 'project' ? <Loader2 className="animate-spin" /> : <Save />} Guardar en el proyecto
                </Button>
                <span className="text-muted-foreground text-[11px]">{changed || cornerAll ? 'Solo para esta descarga.' : 'Los del proyecto.'}</span>
              </div>
            </section>
          )}

          {error && <div className="text-destructive">{error}</div>}
          <Button onClick={download} disabled={!!busy || !video || (format === 'single' && tooBig)}>
            {busy === 'download' ? <Loader2 className="animate-spin" /> : <Download />} Preparar · {FORMATS.find((f) => f.id === format)!.title}
            {lightOn ? ' liviano' : ''}
          </Button>
          <div className="text-muted-foreground text-[11px]">Se arma en el servidor y queda en «Descargas»: desde ahí la bajas o mandas el link.</div>
        </div>
      </div>
    </Modal>
  );
}

/** Casilla del SCORM liviano (hito 9, T4, ADR-108), en el diálogo del video y en el del proyecto. */
export function LightScormField({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cn('flex cursor-pointer gap-2 rounded-md border border-dashed p-2', checked && 'border-primary bg-primary/5', disabled && 'cursor-not-allowed opacity-50')}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
      <span>
        <span className="inline-flex items-center gap-1 font-medium">
          <CloudCog className="size-3.5" /> Video desde la nube (SCORM liviano)
        </span>
        <span className="text-muted-foreground block text-[11px]">
          El paquete pesa unos KB: el video se publica en la nube (con la calidad elegida) y el reproductor lo carga desde ahí; el logo, la portada y los subtítulos
          van adentro. Necesita internet. Si corriges el video, el curso ve la versión nueva solo; si lo despublicas, el SCORM deja de mostrarlo. Se prepara en
          segundo plano y queda en «Descargas».
        </span>
      </span>
    </label>
  );
}
