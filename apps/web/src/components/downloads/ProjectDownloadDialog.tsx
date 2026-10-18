import { CheckCircle2, Download, Layers, Loader2, RotateCcw } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  BATCH_FORMATS,
  BATCH_RETENTION_DAYS,
  SINGLE_HTML_MAX_BYTES,
  isOriginalQuality,
  qualityLabel,
  type BatchCandidate,
  type BatchFormat,
  type CreateBatchRequest,
  type DownloadRequest,
  type ExportEstimate,
  type LogoCorner,
  type LogoSettings,
  type ProjectSummary,
} from '@wilox/shared';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { LogoOverlay, LogoSettingsFields, LogoSourceFields, LogoStage, choiceSrc, toDownloadLogo, type LogoChoice } from '@/components/delivery/logo';
import { aspectOf, useProjectDelivery } from '@/components/delivery/ProjectDelivery';
import { QualityFields, mbText, useStoredQuality } from '@/components/delivery/quality';
import { BATCH_FORMAT_INFO } from '@/components/downloads/formats';
import { LightScormField } from '@/components/DownloadDialog';
import { api, batchesApi } from '@/lib/api';
import { goTo, useBatches } from '@/lib/batches';
import { askNotifications } from '@/lib/queue';
import { cn } from '@/lib/utils';

/**
 * Formatos de la descarga del proyecto (hito 9, T5b, ADR-113): los de cada video (un archivo por video; el SCORM, uno por
 * video, normal o liviano), el ZIP del proyecto y el código para Rise 360. Todos sobre los videos marcados.
 */
type Format = BatchFormat | 'project-zip' | 'rise';
const FORMATS: { id: Format; title: string; hint: string; logo: boolean }[] = [
  ...BATCH_FORMATS.map((id) => ({ id, ...BATCH_FORMAT_INFO[id] })),
  { id: 'project-zip', title: 'ZIP del proyecto', hint: 'Todo: una carpeta por video con el reproductor HTML, el final, subtítulos, clips, voz, fotogramas, prompts y ficha.', logo: true },
  {
    id: 'rise',
    title: 'Código para Rise 360',
    hint: 'Un documento con el código de cada video para pegar en bloques de código de Rise. Los videos se publican en la nube con el logo dibujado.',
    logo: true,
  },
];
const FORMAT_KEY = 'wilox:projectDownloadFormat';

const same = (a?: LogoSettings, b?: LogoSettings) => JSON.stringify(a) === JSON.stringify(b);
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' });
const scormVersion = (f: string) => (f === 'scorm12' ? '1.2' : f === 'scorm2004' ? '2004' : undefined);

function readFormat(): Format {
  try {
    const f = localStorage.getItem(FORMAT_KEY) as Format | null;
    return f && FORMATS.some((x) => x.id === f) ? f : 'html';
  } catch {
    return 'html';
  }
}

/**
 * Descarga del proyecto (hito 8, ADR-097; una sola zona desde el hito 9, T5b, ADR-113): los videos (todos marcados por
 * defecto), el formato, la resolución y compresión, y el logo con sus ajustes. Todo se arma en el servidor y queda en
 * «Descargas», desde donde se baja o se manda el link al cliente. Se recuerda el último formato.
 */
export function ProjectDownloadDialog({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const [d] = useProjectDelivery(project.id);
  const { refresh } = useBatches();
  const [format, setFormatState] = useState<Format>(readFormat);
  const setFormat = (f: Format) => {
    setFormatState(f);
    setError(undefined);
    try {
      localStorage.setItem(FORMAT_KEY, f);
    } catch {
      /* sin almacenamiento */
    }
  };
  const [logo, setLogo] = useState<LogoChoice>();
  const [settings, setSettings] = useState<LogoSettings>();
  const [cornerAll, setCornerAll] = useState<LogoCorner>();
  const [quality, setQuality] = useStoredQuality();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [candidates, setCandidates] = useState<BatchCandidate[]>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [est, setEst] = useState<ExportEstimate>();
  const [estimating, setEstimating] = useState(false);
  const [created, setCreated] = useState<false | 'batch' | 'rise' | 'light'>(false);
  // Rise 360: documento .html o .txt y subtítulos encendidos al empezar.
  const [riseDoc, setRiseDoc] = useState<'html' | 'txt'>('html');
  const [riseSubs, setRiseSubs] = useState(true);
  // SCORM liviano (T4, ADR-108): un SCORM por video con el video desde la nube.
  const [light, setLight] = useState(false);
  const lightVersion = scormVersion(format);
  const lightOn = light && !!lightVersion;
  const rise = format === 'rise';
  const info = FORMATS.find((f) => f.id === format)!;

  useEffect(() => {
    if (!d || logo) return;
    setLogo(d.logo ? { kind: 'project' } : { kind: 'none' });
    setSettings(d.settings);
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    batchesApi.candidates(project.id).then(
      (c) => {
        setCandidates(c);
        setSelected(new Set(c.map((v) => v.id)));
      },
      () => setCandidates([]),
    );
  }, [project.id]);

  const ids = useMemo(() => (candidates ?? []).filter((c) => selected.has(c.id)).map((c) => c.id), [candidates, selected]);
  // Peso de los videos marcados con la calidad elegida (se recalcula al cambiar la selección o la opción).
  useEffect(() => {
    if (!ids.length) return setEst(undefined);
    let live = true;
    setEstimating(true);
    setEst(undefined);
    const t = setTimeout(() => {
      batchesApi
        .estimate(ids, quality)
        .then(
          (e) => live && setEst(e),
          () => live && setEst(undefined),
        )
        .finally(() => live && setEstimating(false));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [ids.join(','), quality.height, quality.compression]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = !!d && !same(settings, d.settings);
  const usesLogo = info.logo && !rise;
  // El .html con el video dentro pesa ~4/3 (base64); los demás formatos, el video y poco más.
  const zipBytes = est ? Math.round(est.bytes * (format === 'single' ? 1.34 : 1.01)) : undefined;
  const ratio = est && candidates ? est.bytes / Math.max(1, candidates.filter((c) => selected.has(c.id)).reduce((n, c) => n + c.bytes, 0)) : 1;
  const tooBigFor = (c: BatchCandidate) => format === 'single' && c.bytes * ratio > SINGLE_HTML_MAX_BYTES;
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  /** Logo y ajustes de esta descarga (solo lo que cambia respecto del proyecto). */
  const logoFields = () => {
    const r: Pick<DownloadRequest, 'logo' | 'settings' | 'cornerAll'> = {};
    if (!logo || !usesLogo) return r;
    if (logo.kind !== 'project') r.logo = toDownloadLogo(logo);
    if (logo.kind !== 'none') {
      if (changed) r.settings = settings;
      if (cornerAll) r.cornerAll = cornerAll;
    }
    return r;
  };

  const prepare = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (rise) {
        // Se publica cada video en segundo plano y el documento queda en «Descargas» (T3b, ADR-104).
        await api.createRise('projects', project.id, { quality, logo: logo?.kind === 'project' && !!d?.logo, subtitlesOn: riseSubs, doc: riseDoc, videoIds: ids });
      } else if (lightOn) {
        await api.createLightScorm('projects', project.id, { version: lightVersion!, quality, ...logoFields(), videoIds: ids });
      } else {
        const r: CreateBatchRequest = { projectId: project.id, format, videoIds: ids, ...logoFields() };
        if (!isOriginalQuality(quality)) r.quality = quality;
        await batchesApi.create(r);
      }
      askNotifications(); // aviso del navegador cuando quede listo
      refresh();
      setCreated(rise ? 'rise' : lightOn ? 'light' : 'batch');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (created)
    return (
      <Modal title="Descarga en preparación" onClose={onClose} className="max-w-lg">
        <div className="grid gap-4 text-sm">
          <p className="flex items-start gap-2">
            <CheckCircle2 className="text-success mt-0.5 size-4 shrink-0" />
            <span>
              {created === 'batch'
                ? `El servidor arma «${info.title}» con ${ids.length} video${ids.length === 1 ? '' : 's'} en segundo plano.`
                : `El servidor publica en la nube los videos (lo ya publicado se reutiliza) y arma ${created === 'rise' ? 'el documento con su código' : 'el SCORM liviano'} en segundo plano.`}{' '}
              Puedes cerrar la app: queda {BATCH_RETENTION_DAYS} días en «Descargas», donde ves su avance y lo bajas o mandas el link (te avisa cuando esté listo).
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

  const ready = d && logo && settings && candidates;
  return (
    <Modal title={`Descargar «${project.name}»`} onClose={onClose} className="max-w-5xl">
      {!ready ? (
        <div className="grid place-items-center p-8">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-[1fr_320px]">
          <div className="grid min-w-0 content-start gap-4 text-xs">
            <section className="grid gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="font-medium">
                  Videos ({selected.size} de {candidates.length})
                </div>
                <div className="flex gap-3 text-[11px]">
                  <button type="button" className="text-primary cursor-pointer hover:underline" onClick={() => setSelected(new Set(candidates.map((c) => c.id)))}>
                    Todos
                  </button>
                  <button type="button" className="text-primary cursor-pointer hover:underline" onClick={() => setSelected(new Set())}>
                    Ninguno
                  </button>
                </div>
              </div>
              {candidates.length === 0 ? (
                <div className="text-muted-foreground rounded-md border p-3">El proyecto aún no tiene videos con final.</div>
              ) : (
                <div className="max-h-[38vh] overflow-y-auto rounded-md border">
                  {candidates.map((c, i) => (
                    <label key={c.id} className={cn('hover:bg-secondary/40 flex cursor-pointer items-center gap-2.5 border-b px-2.5 py-1.5 last:border-b-0', !selected.has(c.id) && 'opacity-55')}>
                      <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                      <span className="text-muted-foreground w-6 shrink-0 text-right font-mono text-[10.5px]">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate" title={c.title}>
                        {c.title}
                      </span>
                      {tooBigFor(c) && selected.has(c.id) && <span className="text-warning shrink-0 text-[10.5px]">no entra en .html</span>}
                      <span className="text-muted-foreground shrink-0 tabular-nums">{fmtDur(c.durationSec)}</span>
                      <span className="text-muted-foreground w-11 shrink-0 text-right tabular-nums">{fmtDate(c.createdAt)}</span>
                    </label>
                  ))}
                </div>
              )}
            </section>
            {usesLogo && logo.kind !== 'none' && (
              <section className="grid gap-2">
                <LogoStage>
                  <LogoOverlay src={choiceSrc(logo, d.logo)} aspect={aspectOf(d)} settings={settings} corner={cornerAll} />
                </LogoStage>
                <p className="text-muted-foreground text-[11px]">
                  {cornerAll
                    ? 'Todos los clips con logo lo llevan en esa esquina; los clips sin logo siguen sin logo.'
                    : 'Cada video usa la esquina elegida en cada clip y su portada (en la página del video); los que no tienen, la del proyecto.'}
                </p>
              </section>
            )}
          </div>

          <div className="grid min-w-0 content-start gap-4 text-xs">
            <section className="grid gap-2">
              <div className="font-medium">Formato</div>
              {FORMATS.map((f) => (
                <Fragment key={f.id}>
                  <label className={cn('flex cursor-pointer gap-2 rounded-md border p-2', format === f.id && 'border-primary bg-primary/10')}>
                    <input type="radio" name="pformat" checked={format === f.id} onChange={() => setFormat(f.id)} className="mt-0.5" />
                    <span>
                      <span className="font-medium">{f.title}</span>
                      <span className="text-muted-foreground block text-[11px]">{f.hint}</span>
                    </span>
                  </label>
                  {f.id === 'scorm2004' && lightVersion && <LightScormField checked={light} onChange={setLight} disabled={busy} />}
                </Fragment>
              ))}
            </section>
            <section className="grid gap-2">
              <div className="font-medium">Resolución y compresión</div>
              <QualityFields value={quality} onChange={setQuality} est={est} loading={estimating} disabled={busy} when={rise || lightOn ? 'al publicar' : undefined} />
              {format === 'project-zip' && <div className="text-muted-foreground text-[11px]">Solo los finales; clips, voz y fotogramas van originales.</div>}
            </section>
            {rise ? (
              <section className="grid gap-2">
                <div className="font-medium">Logo</div>
                {d.logo ? (
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
                      Con la esquina de cada clip y los ajustes del proyecto («Logo» del proyecto). Si cambian, los videos publicados se rehacen solos en las mismas
                      direcciones.
                    </div>
                  </div>
                ) : (
                  <div className="text-muted-foreground text-[11px]">El proyecto no tiene logo: los videos se publican sin logo.</div>
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
              <section className={cn('grid gap-2', !usesLogo && 'pointer-events-none opacity-50')}>
                <div className="font-medium">Logo</div>
                <LogoSourceFields project={d.logo} choice={logo} onChange={setLogo} />
              </section>
            )}
            {usesLogo && logo.kind !== 'none' && (
              <section className="grid gap-2">
                <div className="flex items-center justify-between">
                  <div className="font-medium">Ajustes del logo</div>
                  {(changed || cornerAll) && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1 text-[11px]"
                      onClick={() => {
                        setSettings(d.settings);
                        setCornerAll(undefined);
                      }}
                    >
                      <RotateCcw className="size-3" /> Los del proyecto
                    </button>
                  )}
                </div>
                <LogoSettingsFields settings={settings} onChange={setSettings} cornerAll={{ value: cornerAll, onChange: setCornerAll }} />
                <div className="text-muted-foreground text-[11px]">{changed || cornerAll ? 'Solo para esta descarga (no se guardan).' : 'Los del proyecto.'}</div>
              </section>
            )}
            {error && <div className="text-destructive">{error}</div>}
            <Button onClick={() => void prepare()} disabled={busy || !ids.length}>
              {busy ? <Loader2 className="animate-spin" /> : <Download />} Preparar · {info.title}
              {lightOn ? ' liviano' : ''} ({ids.length})
            </Button>
            <div className="text-muted-foreground text-[11px]">
              {format === 'project-zip' || rise
                ? ''
                : ids.length === 1
                  ? 'Con un solo video se entrega el archivo mismo (un SCORM, su .zip listo para el LMS). '
                  : 'Un archivo por video, en un ZIP (cada SCORM, su .zip listo para el LMS). '}
              {zipBytes && !lightOn && !rise ? `≈ ${mbText(zipBytes)}${isOriginalQuality(quality) ? '' : ` en ${qualityLabel(quality)}`}. ` : ''}Se arma en el servidor y queda en
              «Descargas»: desde ahí lo bajas o mandas el link.
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
