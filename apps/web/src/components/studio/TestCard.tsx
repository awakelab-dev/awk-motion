import { AlertTriangle, Check, CheckCircle2, Film, Loader2, RefreshCw, Wand2, X } from 'lucide-react';
import { useState } from 'react';
import type { ThemeDetail, ThemeTest, ThemeTestFrame } from '@wilox/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { themesApi } from '@/lib/api';
import { confirmSpend } from '@/lib/spend';
import { cn } from '@/lib/utils';

const FIELD_LABEL: Record<string, string> = {
  videoBible: 'Bible de video',
  imageBible: 'Bible de imagen',
  clipBible: 'Bible de clip',
  avoid: 'AVOID',
  soundHint: 'Sonido',
  directorNotes: 'Notas del estilo',
  imagery: 'Imágenes',
};

/** Una prueba estándar: frames A/B, clip A→B, revisión de Opus y sugerencias aplicables. */
export function TestCard({ theme, test, latest }: { theme: ThemeDetail; test: ThemeTest; latest: boolean }) {
  const [error, setError] = useState<string>();
  const [zoom, setZoom] = useState<ThemeTestFrame>();
  const [picked, setPicked] = useState<number[]>();
  const running = ['queued', 'frames', 'review', 'clip', 'post'].includes(test.status);
  const stale = test.themeVersion !== theme.version;
  const clipBusy = test.clip.status === 'generating';
  const framesBusy = test.frames.some((f) => f.status === 'generating' || f.activity);

  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const pending = (test.suggestions ?? []).map((s, i) => ({ s, i })).filter((x) => !x.s.applied);
  const selected = picked ?? pending.map((x) => x.i);

  return (
    <Card className={cn(!latest && 'opacity-90')}>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
            {running && <Loader2 className="text-primary size-4 animate-spin" />}
            {test.status === 'done' && <CheckCircle2 className="text-success size-4" />}
            {test.status === 'error' && <AlertTriangle className="text-destructive size-4" />}
            <span>Prueba {test.n}</span>
            <span className="text-muted-foreground truncate text-xs font-normal">· {test.message}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant={stale ? 'warning' : 'secondary'} title={stale ? 'El tema cambió después de esta prueba' : undefined}>
              tema v{test.themeVersion}
              {stale ? ` · actual v${theme.version}` : ''}
            </Badge>
            {theme.thumbnailTest === test.n && <Badge variant="default">Miniatura</Badge>}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          {test.frames.map((f) => (
            <div key={f.key} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-1">
                <div className="text-xs font-medium">
                  {f.label} {f.version > 1 && <span className="text-muted-foreground font-normal">· v{f.version}</span>}
                </div>
                {f.review && (
                  <Badge variant={f.review.verdict === 'ok' ? 'success' : 'warning'}>{f.review.verdict === 'ok' ? 'OK' : 'Mejorable'}</Badge>
                )}
              </div>
              <button
                type="button"
                onClick={() => f.url && setZoom(f)}
                className="relative aspect-video cursor-zoom-in overflow-hidden rounded-lg border bg-secondary"
              >
                {f.url && <img src={f.url} alt={f.label} className={cn('size-full object-cover', (f.activity || f.status === 'generating') && 'opacity-40')} />}
                {(f.activity || f.status === 'generating') && (
                  <div className="text-muted-foreground absolute inset-0 grid place-items-center text-[11px]">
                    <span className="flex items-center gap-1.5">
                      <Loader2 className="size-3.5 animate-spin" /> {f.activity ?? 'Generando…'}
                    </span>
                  </div>
                )}
                {f.status === 'error' && !f.activity && (
                  <div className="text-destructive absolute inset-0 grid place-items-center p-3 text-[11px]">{f.error}</div>
                )}
              </button>
              {f.review?.issues && <div className="text-muted-foreground text-[11px] leading-snug">{f.review.issues}</div>}
              <Button
                size="sm"
                variant="ghost"
                className="self-start"
                disabled={f.status === 'generating' || !!f.activity || clipBusy}
                onClick={() =>
                  void confirmSpend({
                    title: `Regenerar el fotograma ${f.key}`,
                    body: 'Se genera una imagen nueva de este fotograma de la prueba y Opus vuelve a revisar la prueba.',
                    work: { images: 1, llm: 1 },
                    action: 'Regenerar',
                  }).then((ok) => (ok ? act(() => themesApi.regenerateFrame(theme.id, test.n, f.key)) : undefined))
                }
              >
                <RefreshCw /> Regenerar {f.key}
              </Button>
            </div>
          ))}

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-1">
              <div className="text-xs font-medium">
                Clip A→B {test.clip.version > 1 && <span className="text-muted-foreground font-normal">· v{test.clip.version}</span>}
              </div>
              {test.clip.ssimEnd !== undefined && (
                <Badge variant={test.clip.ssimEnd >= 0.94 ? 'success' : 'warning'} title="SSIM del último frame contra B">
                  SSIM {test.clip.ssimEnd.toFixed(3)}
                </Badge>
              )}
            </div>
            <div className="relative aspect-video overflow-hidden rounded-lg border bg-secondary">
              {test.clip.url && test.clip.status === 'ready' ? (
                <video src={test.clip.url} controls loop playsInline className="size-full bg-black object-cover" />
              ) : (
                <div className="text-muted-foreground absolute inset-0 grid place-items-center p-3 text-center text-[11px]">
                  {clipBusy ? (
                    <span className="flex items-center gap-1.5">
                      <Loader2 className="size-3.5 animate-spin" /> MiniMax genera el clip (≈9 min)…
                    </span>
                  ) : test.clip.status === 'error' ? (
                    <span className="text-destructive">{test.clip.error}</span>
                  ) : test.withClip ? (
                    'Esperando a los frames…'
                  ) : (
                    'Prueba sin clip'
                  )}
                </div>
              )}
            </div>
            {test.clip.fromFrames && <div className="text-muted-foreground text-[11px]">Hecho con {test.clip.fromFrames}</div>}
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              disabled={clipBusy || framesBusy || test.frames.some((f) => f.status !== 'ready')}
              onClick={() =>
                void confirmSpend({
                  title: test.clip.version ? 'Regenerar el clip de la prueba' : 'Generar el clip de la prueba',
                  body: 'Se genera el clip entre los dos fotogramas de la prueba.',
                  work: { clips: 1 },
                  action: test.clip.version ? 'Regenerar clip' : 'Generar clip',
                }).then((ok) => (ok ? act(() => themesApi.clip(theme.id, test.n)) : undefined))
              }
            >
              <Film /> {test.clip.version ? 'Regenerar clip' : 'Generar clip'}
            </Button>
          </div>
        </div>

        {(test.reviewSummary || pending.length > 0) && (
          <div className="flex flex-col gap-2 rounded-lg border bg-background/40 p-3">
            {test.reviewSummary && (
              <div className="text-xs leading-relaxed">
                <span className="text-primary font-medium">Opus · </span>
                {test.reviewSummary}
              </div>
            )}
            {(test.suggestions ?? []).map((s, i) => (
              <label key={i} className={cn('flex items-start gap-2 text-[11.5px]', s.applied ? 'opacity-60' : 'cursor-pointer')}>
                {s.applied ? (
                  <Check className="text-success mt-0.5 size-3.5 shrink-0" />
                ) : (
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selected.includes(i)}
                    disabled={theme.readOnly}
                    onChange={(e) => setPicked(e.target.checked ? [...selected, i] : selected.filter((x) => x !== i))}
                  />
                )}
                <span>
                  <span className="font-medium">{FIELD_LABEL[s.field] ?? s.field}:</span> {s.reason}
                  <details className="text-muted-foreground mt-1">
                    <summary className="cursor-pointer">Ver texto propuesto</summary>
                    <pre className="mt-1 font-mono text-[11px] whitespace-pre-wrap">{s.value}</pre>
                  </details>
                </span>
              </label>
            ))}
            {pending.length > 0 && !theme.readOnly && (
              <Button
                size="sm"
                variant="secondary"
                className="self-start"
                disabled={!selected.length}
                onClick={() =>
                  void confirmSpend({
                    title: 'Aplicar las sugerencias al tema',
                    body: `Opus incorpora ${selected.length} sugerencia${selected.length === 1 ? '' : 's'} al tema y crea la v${theme.version + 1}.`,
                    work: { llm: 1 },
                    action: 'Aplicar',
                  }).then((ok) => (ok ? act(() => themesApi.applySuggestions(theme.id, test.n, selected)) : undefined))
                }
              >
                <Wand2 /> Aplicar al tema ({selected.length}) · crea la v{theme.version + 1}
              </Button>
            )}
          </div>
        )}

        <details className="text-muted-foreground text-[11px]">
          <summary className="cursor-pointer">Superprompts de esta prueba</summary>
          <div className="mt-2 flex flex-col gap-2">
            {test.frames.map((f) => (
              <Prompt key={f.key} title={`${f.label} (v${f.version})`} text={f.prompt} />
            ))}
            <Prompt title="Clip A→B" text={test.clip.prompt} />
          </div>
        </details>

        {error && <div className="text-destructive text-xs">{error}</div>}
        {test.error && test.status === 'error' && <div className="text-destructive text-xs">{test.error}</div>}
      </CardContent>

      {zoom?.url && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/85 p-6" onClick={() => setZoom(undefined)}>
          <button type="button" className="absolute top-4 right-4 cursor-pointer" onClick={() => setZoom(undefined)}>
            <X className="size-5" />
          </button>
          <img src={zoom.url} alt={zoom.label} className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </Card>
  );
}

function Prompt({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-md border bg-background/40 p-2">
      <div className="text-foreground mb-1 font-medium">{title}</div>
      <pre className="font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap">{text}</pre>
    </div>
  );
}
