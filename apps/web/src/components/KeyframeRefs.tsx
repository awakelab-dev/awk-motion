import { ImagePlus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { KEYFRAME_REF_MAX_BYTES, KEYFRAME_REFS_MAX, type KeyframeMediaFrame, type KeyframeRefUpload } from '@wilox/shared';
import { readAsDataUrl } from '@/components/delivery/logo';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Posición del marco en español (el storyboard la escribe en inglés). */
const POSITIONS: [RegExp, string][] = [
  [/top\s*left/i, 'arriba a la izquierda'],
  [/top\s*right/i, 'arriba a la derecha'],
  [/bottom\s*left/i, 'abajo a la izquierda'],
  [/bottom\s*right/i, 'abajo a la derecha'],
  [/\bleft\b/i, 'izquierda'],
  [/\bright\b/i, 'derecha'],
  [/cent(er|re)/i, 'centro'],
  [/\btop\b/i, 'arriba'],
  [/\bbottom\b/i, 'abajo'],
];
const where = (p?: string) => (p ? (POSITIONS.find(([re]) => re.test(p))?.[1] ?? p) : undefined);

/**
 * Imágenes de referencia al regenerar un fotograma (hito 13, ADR-170): hasta 4 (PNG, JPG o WebP, ≤ 10 MB), numeradas en
 * el orden en que se suben. La indicación dice qué hacer con cada una; para nombrar los lugares se ven los marcos de
 * foto o video del fotograma.
 */
export function KeyframeRefsField({ runId, index, value, onChange, disabled, compact }: { runId: string; index: number; value: KeyframeRefUpload[]; onChange: (v: KeyframeRefUpload[]) => void; disabled?: boolean; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const [frames, setFrames] = useState<KeyframeMediaFrame[]>();
  useEffect(() => {
    let live = true;
    api.keyframeMediaFrames(runId, index).then(
      (f) => live && setFrames(f),
      () => live && setFrames([]),
    );
    return () => {
      live = false;
    };
  }, [runId, index]);

  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    setError(undefined);
    const next = [...value];
    for (const f of Array.from(list)) {
      if (next.length >= KEYFRAME_REFS_MAX) {
        setError(`Hasta ${KEYFRAME_REFS_MAX} imágenes.`);
        break;
      }
      if (!/^image\/(png|jpeg|webp)$/.test(f.type) && !/\.(png|jpe?g|webp)$/i.test(f.name)) {
        setError(`«${f.name}» no es PNG, JPG ni WebP.`);
        continue;
      }
      if (f.size > KEYFRAME_REF_MAX_BYTES) {
        setError(`«${f.name}» pesa más de ${KEYFRAME_REF_MAX_BYTES / 1024 / 1024} MB.`);
        continue;
      }
      next.push({ fileName: f.name, data: await readAsDataUrl(f) });
    }
    onChange(next);
  };

  return (
    <div className="grid gap-1.5 text-xs">
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => void add(e.target.files).finally(() => (e.target.value = ''))} />
      <div className="flex flex-wrap items-stretch gap-1.5">
        {value.map((r, i) => (
          <div key={`${r.fileName}-${i}`} className={cn('relative overflow-hidden rounded-md border', compact ? 'w-20' : 'w-28')} title={r.fileName}>
            <img src={r.data} alt="" className="bg-secondary aspect-video w-full object-contain" />
            <span className="absolute top-1 left-1 rounded bg-black/70 px-1 py-px text-[10px] font-medium text-white">Imagen {i + 1}</span>
            {!disabled && (
              <button
                type="button"
                title="Quitar"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                className="absolute top-1 right-1 grid size-4 cursor-pointer place-items-center rounded-full bg-black/70 text-white hover:bg-black"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        ))}
        {value.length < KEYFRAME_REFS_MAX && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => input.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void add(e.dataTransfer.files);
            }}
            className={cn(
              'text-muted-foreground hover:bg-secondary/50 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed px-2 py-1.5 disabled:cursor-not-allowed disabled:opacity-50',
              compact ? 'min-h-11 w-20' : 'min-h-16 w-28',
            )}
          >
            <ImagePlus className="size-4" />
            <span className="text-[10.5px] leading-tight">{value.length ? 'Otra imagen' : 'Imágenes de referencia'}</span>
          </button>
        )}
      </div>
      {error && <div className="text-destructive text-[11px]">{error}</div>}
      {value.length > 0 && (
        <div className="text-muted-foreground text-[11px] leading-snug">
          Di en la indicación qué hacer con cada una (es obligatoria): «la imagen 1 dentro del marco 2», «la imagen 2 en lugar de la foto del centro», «crea una ilustración nueva
          basada en la imagen 1»…
          {frames && frames.length > 0 && (
            <span className="mt-1 block">
              Marcos de este fotograma:{' '}
              {frames.map((f, i) => (
                <span key={i} className="bg-secondary text-foreground mr-1 inline-block rounded px-1.5 py-px" title={f.subject}>
                  Marco {i + 1}
                  {where(f.position) ? ` · ${where(f.position)}` : ''} · {f.kind === 'video' ? 'video' : 'foto'}
                </span>
              ))}
            </span>
          )}
          {frames && frames.length === 0 && <span className="mt-1 block">Este fotograma no tiene marcos de foto: di dónde va cada imagen o qué crear con ella.</span>}
        </div>
      )}
    </div>
  );
}
