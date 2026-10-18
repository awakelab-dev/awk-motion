import { AlertTriangle, Check, CloudUpload, Copy, ExternalLink, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { qualityLabel, type ExportQuality, type PublicationInfo } from '@wilox/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { mbText, QualityFields, useEstimate } from './quality';

/** Para ver en internet conviene una versión liviana: 1080p equilibrada por defecto. */
const DEFAULT_QUALITY: ExportQuality = { height: 1080, compression: 'balanced' };

const label = (q: ExportQuality, logo: boolean) => `${qualityLabel(q)}${logo ? ' · con logo' : ''}`;

const USE_LABEL: Record<string, string> = { manual: 'publicada a mano', rise: 'código para Rise 360', scorm: 'SCORM liviano' };

/**
 * Publicaciones del video (hito 9, T1, ADR-101): el final en una calidad, sus subtítulos y su portada en una carpeta
 * pública del bucket con URLs que no caducan (para Rise 360, el SCORM liviano o cualquier reproductor). Siguen al
 * final vigente; «Despublicar» borra la carpeta.
 */
export function PublicationsPanel({ generationId }: { generationId: string }) {
  const [list, setList] = useState<PublicationInfo[]>();
  const [quality, setQuality] = useState<ExportQuality>(DEFAULT_QUALITY);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<string>();
  // Logo dibujado en el video (T2, ADR-102): por defecto, si el proyecto tiene logo.
  const [hasLogo, setHasLogo] = useState(false);
  const [withLogo, setWithLogo] = useState(true);
  const { est, loading } = useEstimate('generations', generationId, quality);

  const load = () => api.publications(generationId).then(setList, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    api.videoDelivery(generationId).then((d) => setHasLogo(!!d.logo), () => setHasLogo(false));
  }, [generationId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Mientras algo se prepara, se consulta cada 3 s.
  const working = list?.some((p) => p.status === 'queued' || p.status === 'preparing');
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [working]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(undefined);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied(undefined), 2000);
    } catch {
      setError('No se pudo copiar: selecciona la dirección y cópiala a mano.');
    }
  };
  const remove = (p: PublicationInfo) => {
    const used = p.uses.filter((u) => u !== 'manual').map((u) => USE_LABEL[u]);
    const warn = used.length ? `\n\nSe usa en: ${used.join(', ')}. Lo que la use dejará de mostrar el video.` : '';
    if (window.confirm(`¿Despublicar ${label(p.quality, p.logo)}? Sus direcciones dejan de funcionar en unos minutos.${warn}`)) void act(`rm-${p.id}`, () => api.unpublish(p.id));
  };
  const logo = hasLogo && withLogo;
  const exists = list?.some((p) => qualityLabel(p.quality) === qualityLabel(quality) && p.logo === logo);

  return (
    <div className="grid gap-3 border-t px-6 py-4 text-xs">
      <p className="text-muted-foreground text-[11px] leading-relaxed">
        Publica el video en la nube con direcciones que no caducan: el MP4, sus subtítulos (.vtt) y la portada, para pegarlos en Rise 360, un SCORM
        liviano o cualquier reproductor. Siguen al final vigente: si corriges el video, se vuelve a publicar solo en las mismas direcciones (tarda unos
        minutos en verse). «Despublicar» las borra.
      </p>
      {list === undefined ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        list.map((p) => (
          <div key={p.id} className="grid gap-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{label(p.quality, p.logo)}</span>
              {p.status === 'ready' && !p.stale && (
                <Badge variant="success">
                  <Check /> Publicada{p.bytes ? ` · ${mbText(p.bytes)}` : ''}
                </Badge>
              )}
              {(p.status === 'queued' || p.status === 'preparing' || p.stale) && p.status !== 'error' && (
                <Badge variant="secondary">
                  <Loader2 className="animate-spin" />
                  {p.status === 'preparing' ? `Publicando… ${Math.round((p.progress ?? 0) * 100)} %` : p.stale ? 'Final nuevo: se vuelve a publicar' : 'En cola'}
                </Badge>
              )}
              {p.status === 'error' && (
                <Badge variant="destructive" title={p.error}>
                  <AlertTriangle /> Error
                </Badge>
              )}
              {p.uses.filter((u) => u !== 'manual').map((u) => (
                <Badge key={u} variant="secondary">
                  {USE_LABEL[u]}
                </Badge>
              ))}
              <span className="ml-auto flex gap-1.5">
                <Button size="sm" variant="outline" disabled={!!busy || p.status === 'preparing'} onClick={() => void act(`re-${p.id}`, () => api.republish(p.id))} title="Volver a publicar en las mismas direcciones (p. ej. tras cambiar la portada)">
                  {busy === `re-${p.id}` ? <Loader2 className="animate-spin" /> : <RefreshCw />} Volver a publicar
                </Button>
                <Button size="sm" variant="outline" disabled={!!busy || p.status === 'preparing'} onClick={() => remove(p)}>
                  {busy === `rm-${p.id}` ? <Loader2 className="animate-spin" /> : <Trash2 />} Despublicar
                </Button>
              </span>
            </div>
            {p.status === 'error' && p.error && <p className="text-destructive">{p.error}</p>}
            {p.publishedAt &&
              (
                [
                  ['Video (MP4)', p.urls.video],
                  ['Subtítulos (.vtt)', p.urls.subtitles],
                  ['Portada (JPEG)', p.urls.poster],
                ] as [string, string | undefined][]
              )
                .flatMap(([label, url]) => (url ? [[label, url] as const] : []))
                .map(([label, url]) => (
                  <div key={label} className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground w-28 shrink-0">{label}</span>
                    <input readOnly value={url} onFocus={(e) => e.target.select()} className="bg-background h-8 min-w-0 flex-1 rounded-md border px-2 font-mono text-[11px]" />
                    <Button size="sm" variant="outline" onClick={() => void copy(url)}>
                      {copied === url ? <Check /> : <Copy />} {copied === url ? 'Copiado' : 'Copiar'}
                    </Button>
                    <Button asChild size="sm" variant="ghost">
                      <a href={url} target="_blank" rel="noreferrer" title="Abrir">
                        <ExternalLink />
                      </a>
                    </Button>
                  </div>
                ))}
          </div>
        ))
      )}
      <div className="grid gap-2 rounded-md border border-dashed p-3">
        <span className="font-medium">Publicar en otra calidad o con logo</span>
        <QualityFields value={quality} onChange={setQuality} est={est} loading={loading} when="al publicar" />
        {hasLogo ? (
          <label className="flex items-start gap-2 text-[11px] leading-relaxed">
            <input type="checkbox" className="mt-0.5" checked={withLogo} onChange={(e) => setWithLogo(e.target.checked)} />
            <span>
              <span className="text-foreground font-medium">Con el logo del proyecto dibujado en el video</span>
              <span className="text-muted-foreground">
                {' '}
                · en la esquina de cada clip, con el tamaño, el margen, el realce y la opacidad del proyecto. Se ve en cualquier reproductor y en pantalla
                completa (Rise 360). Si cambias el logo, sus ajustes o la esquina de un clip, se vuelve a publicar solo en la misma dirección.
              </span>
            </span>
          </label>
        ) : (
          <p className="text-muted-foreground text-[11px]">El proyecto no tiene logo: se publica sin logo (súbelo con el botón «Logo» del proyecto para dibujarlo en el video).</p>
        )}
        <div>
          <Button size="sm" disabled={!!busy || exists} onClick={() => void act('new', () => api.publish(generationId, quality, logo))}>
            {busy === 'new' ? <Loader2 className="animate-spin" /> : <CloudUpload />} {exists ? 'Ya publicada así' : `Publicar en ${label(quality, logo)}`}
          </Button>
        </div>
      </div>
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}
