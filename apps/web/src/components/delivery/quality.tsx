import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EXPORT_COMPRESSIONS, EXPORT_HEIGHTS, ORIGINAL_QUALITY, isOriginalQuality, type ExportEstimate, type ExportQuality } from '@wilox/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const KEY = 'wilox:exportQuality';
/** MB decimales, como los muestra el Finder del Mac. */
export const mbText = (b: number) => (b >= 1e7 ? `${(b / 1e6).toFixed(0)} MB` : `${(b / 1e6).toFixed(1)} MB`);

/** Resolución y compresión de las descargas (hito 7, ADR-085): por defecto el original; se recuerda la última elegida. */
export function useStoredQuality(): [ExportQuality, (q: ExportQuality) => void] {
  const [q, setQ] = useState<ExportQuality>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as ExportQuality | null;
      if (v && EXPORT_HEIGHTS.includes(v.height) && EXPORT_COMPRESSIONS.some((c) => c.id === v.compression)) return v;
    } catch {
      /* sin almacenamiento: el original */
    }
    return ORIGINAL_QUALITY;
  });
  const set = (v: ExportQuality) => {
    setQ(v);
    try {
      localStorage.setItem(KEY, JSON.stringify(v));
    } catch {
      /* sin almacenamiento */
    }
  };
  return [q, set];
}

/** Peso estimado de la descarga (se pide al cambiar la opción; el servidor lo guarda). */
export function useEstimate(kind: 'generations' | 'projects', id: string | undefined, q: ExportQuality, enabled = true) {
  const [est, setEst] = useState<ExportEstimate>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!id || !enabled) return;
    let live = true;
    setLoading(true);
    setEst(undefined);
    const t = setTimeout(() => {
      api.exportEstimate(kind, id, q).then(
        (e) => live && setEst(e),
        () => live && setEst(undefined),
      ).finally(() => live && setLoading(false));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [kind, id, q.height, q.compression, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return { est, loading };
}

const chip = (on: boolean) =>
  cn('cursor-pointer rounded-full border px-2.5 py-1 text-[11px] transition-colors', on ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground');

/** Selector de resolución y compresión con el peso estimado. */
export function QualityFields({ value, onChange, est, loading, disabled, when = 'al descargar' }: { value: ExportQuality; onChange: (q: ExportQuality) => void; est?: ExportEstimate; loading?: boolean; disabled?: boolean; when?: string }) {
  return (
    <div className={cn('grid gap-2', disabled && 'pointer-events-none opacity-50')}>
      <div className="flex flex-wrap gap-1.5">
        {EXPORT_HEIGHTS.map((h) => (
          <button key={h} type="button" className={chip(value.height === h)} onClick={() => onChange({ ...value, height: h })}>
            {h === 1440 ? '1440p original' : `${h}p`}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {EXPORT_COMPRESSIONS.map((c) => (
          <button key={c.id} type="button" title={`${c.hint} (H.264 CRF ${c.crf})`} className={chip(value.compression === c.id)} onClick={() => onChange({ ...value, compression: c.id })}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
        {loading ? (
          <>
            <Loader2 className="size-3 animate-spin" /> Calculando el peso…
          </>
        ) : est ? (
          <span>
            Peso {est.exact ? '' : 'estimado '}
            <span className="text-foreground font-medium">{est.exact ? '' : '≈ '}{mbText(est.bytes)}</span>
            {isOriginalQuality(value) ? ' · el final tal cual, sin recodificar' : ` · se prepara ${when} (el original no se toca) y se reutiliza si la pides igual`}
          </span>
        ) : (
          <span>Sin estimación del peso.</span>
        )}
      </div>
    </div>
  );
}
