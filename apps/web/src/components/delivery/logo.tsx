import { ImageIcon } from 'lucide-react';
import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ClipLogo, DownloadLogo, LogoCorner, LogoEffect, LogoInfo, LogoSettings } from '@wilox/shared';
import { cn } from '@/lib/utils';

/** Piezas del logo de la entrega (hito 6, ADR-066): superposición, esquina y ajustes globales del proyecto. */

export const CORNERS: { id: LogoCorner; label: string }[] = [
  { id: 'tl', label: 'Arriba izq.' },
  { id: 'tr', label: 'Arriba der.' },
  { id: 'bl', label: 'Abajo izq.' },
  { id: 'br', label: 'Abajo der.' },
];
export const EFFECTS: { id: LogoEffect; label: string }[] = [
  { id: 'none', label: 'Ninguno' },
  { id: 'shadow', label: 'Sombra' },
  { id: 'glow', label: 'Brillo' },
  { id: 'dark', label: 'Fondo negro' },
  { id: 'light', label: 'Fondo blanco' },
];
export const cornerLabel = (c: LogoCorner) => CORNERS.find((x) => x.id === c)!.label;

export const readAsDataUrl = (f: File) =>
  new Promise<string>((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => ko(new Error('No se pudo leer el archivo.'));
    r.readAsDataURL(f);
  });

/** Aviso entre vistas: el logo o los ajustes del proyecto cambiaron (las tarjetas de clips se actualizan). */
export const DELIVERY_EVENT = 'wilox-delivery-changed';
export const notifyDelivery = () => window.dispatchEvent(new Event(DELIVERY_EVENT));

/**
 * El logo (o un marcador si el proyecto aún no tiene) sobre un cuadro 16:9, en proporción a su ancho, igual
 * que en el reproductor: ancho y margen en % del ancho del video (el margen vertical se pasa a % del alto).
 */
export function LogoOverlay({ src, aspect, settings, corner, className }: { src?: string; aspect?: number; settings: LogoSettings; corner?: LogoCorner; className?: string }) {
  const c = corner ?? settings.corner;
  const s = settings;
  const pad = s.effect === 'dark' || s.effect === 'light' ? s.widthPct * 0.08 : 0;
  const style: CSSProperties = {
    width: `${s.widthPct + 2 * pad}%`,
    opacity: s.opacity,
    [c[0] === 't' ? 'top' : 'bottom']: `${(s.marginPct * 16) / 9}%`,
    [c[1] === 'l' ? 'left' : 'right']: `${s.marginPct}%`,
    // padding en % se mide sobre el ancho del cuadro, como el margen del reproductor.
    padding: pad ? `${(pad / (s.widthPct + 2 * pad)) * 100}%` : undefined,
    background: s.effect === 'dark' ? 'rgba(0,0,0,.45)' : s.effect === 'light' ? 'rgba(255,255,255,.72)' : undefined,
    borderRadius: pad ? 6 : undefined,
    filter: s.effect === 'shadow' ? 'drop-shadow(0 1px 3px rgba(0,0,0,.6))' : s.effect === 'glow' ? 'drop-shadow(0 0 4px rgba(255,255,255,.95))' : undefined,
  };
  return (
    <div className={cn('pointer-events-none absolute transition-all duration-200', className)} style={style}>
      {src ? (
        <img src={src} alt="" className="block w-full" />
      ) : (
        <div
          className="grid w-full place-items-center rounded-[3px] border border-dashed border-white/80 bg-white/15 text-white/90"
          style={{ aspectRatio: aspect ?? 3 }}
          title="Aquí va el logo"
        >
          <span className="flex items-center gap-0.5 text-[clamp(6px,1.4cqw,11px)] leading-none font-medium">
            <ImageIcon className="size-[1.2em]" /> Logo
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Cuatro botones en las esquinas de un cuadro para elegir dónde va el logo (se ven al pasar el ratón). Pulsar la
 * esquina donde ya está el logo lo quita de ese clip (ADR-067); pulsar otra lo pone ahí.
 */
export function CornerHotspots({ value, onPick, disabled }: { value: ClipLogo; onPick: (c: ClipLogo) => void; disabled?: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      {CORNERS.map((c) => (
        <button
          key={c.id}
          type="button"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onPick(value === c.id ? 'none' : c.id);
          }}
          title={value === c.id ? 'Quitar el logo de este clip' : `Logo ${cornerLabel(c.id).toLowerCase()}`}
          className={cn(
            'pointer-events-auto absolute size-5 cursor-pointer rounded-full border-2 shadow transition-transform hover:scale-110',
            c.id[0] === 't' ? 'top-1.5' : 'bottom-1.5',
            c.id[1] === 'l' ? 'left-1.5' : 'right-1.5',
            value === c.id ? 'border-white bg-[var(--primary)]' : 'border-white/80 bg-black/50',
          )}
        />
      ))}
    </div>
  );
}

/** Logo de un clip: esquina (2×2) o sin logo; sin elegir, la del proyecto (`inherited`). */
export function CornerPicker({ value, onChange, inherited, disabled }: { value?: ClipLogo; onChange: (c: ClipLogo | null) => void; inherited: LogoCorner; disabled?: boolean }) {
  const shown = value ?? inherited;
  const pick = (c: ClipLogo) => onChange(c === inherited ? null : c);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <div className="grid grid-cols-2 gap-1 rounded-md border p-1" role="radiogroup" aria-label="Esquina del logo">
        {CORNERS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={shown === c.id}
            disabled={disabled}
            title={cornerLabel(c.id)}
            onClick={() => pick(c.id)}
            className={cn('h-4 w-7 cursor-pointer rounded-[3px]', shown === c.id ? 'bg-primary' : 'bg-secondary hover:bg-muted-foreground/40')}
          />
        ))}
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => pick('none')}
        className={cn('cursor-pointer rounded border px-2 py-1 text-[11px]', shown === 'none' ? 'border-primary bg-primary/15 font-medium' : 'hover:bg-secondary')}
      >
        Sin logo
      </button>
      <span className="text-muted-foreground text-[11px]">
        {shown === 'none' ? 'Este clip va sin logo.' : `${cornerLabel(shown)}${value ? '' : ' (la del proyecto)'}.`}
      </span>
    </div>
  );
}

/**
 * Ajustes globales del logo: esquina, ancho, margen, opacidad y realce. En el proyecto la esquina es la de por
 * defecto; en una descarga (`cornerAll`) es la "Esquina de los clips": sin elegir, la de cada clip; elegida,
 * manda sobre todas (los clips sin logo siguen sin logo, ADR-067).
 */
export function LogoSettingsFields({
  settings,
  onChange,
  cornerAll,
}: {
  settings: LogoSettings;
  onChange: (s: LogoSettings) => void;
  cornerAll?: { value?: LogoCorner; onChange: (c?: LogoCorner) => void };
}) {
  const set = <K extends keyof LogoSettings>(k: K, v: LogoSettings[K]) => onChange({ ...settings, [k]: v });
  const btn = (active: boolean) => cn('cursor-pointer rounded border px-1 py-1.5 text-[11px]', active ? 'border-primary bg-primary/15 font-medium' : 'hover:bg-secondary');
  return (
    <div className="grid gap-2 text-xs">
      <div className="grid gap-1">
        <div className="text-muted-foreground">{cornerAll ? 'Esquina de los clips' : 'Esquina por defecto'}</div>
        {cornerAll && (
          <button type="button" onClick={() => cornerAll.onChange(undefined)} className={btn(!cornerAll.value)}>
            La de cada clip
          </button>
        )}
        <div className="grid grid-cols-4 gap-1">
          {CORNERS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => (cornerAll ? cornerAll.onChange(c.id) : set('corner', c.id))}
              className={btn(cornerAll ? cornerAll.value === c.id : settings.corner === c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <Slider label="Ancho" value={settings.widthPct} min={4} max={30} step={0.5} unit="%" onChange={(v) => set('widthPct', v)} />
      <Slider label="Margen" value={settings.marginPct} min={0} max={8} step={0.5} unit="%" onChange={(v) => set('marginPct', v)} />
      <Slider label="Opacidad" value={Math.round(settings.opacity * 100)} min={20} max={100} step={5} unit="%" onChange={(v) => set('opacity', v / 100)} />
      <div className="grid gap-1">
        <div className="text-muted-foreground">Realce</div>
        <div className="flex flex-wrap gap-1">
          {EFFECTS.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => set('effect', e.id)}
              className={cn('cursor-pointer rounded border px-2 py-1 text-[11px]', settings.effect === e.id ? 'border-primary bg-primary/15 font-medium' : 'hover:bg-secondary')}
            >
              {e.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Slider({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="grid grid-cols-[64px_1fr_44px] items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="accent-[var(--primary)]" />
      <span className="text-right font-mono tabular-nums">
        {value}
        {unit}
      </span>
    </label>
  );
}

/** Cuadro 16:9 de muestra (sin video) para ver el logo con los ajustes. */
export function LogoStage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn('relative aspect-video w-full overflow-hidden rounded-lg border [container-type:inline-size]', className)}
      style={{ background: 'linear-gradient(135deg, #1f2937 0%, #334155 45%, #64748b 100%)' }}
    >
      {children}
    </div>
  );
}

/** Elegir el logo de una descarga: el del proyecto, otro solo para esa descarga (no se guarda) o ninguno. */
export type LogoChoice = { kind: 'project' } | { kind: 'none' } | { kind: 'once'; fileName: string; data: string };

export const toDownloadLogo = (c: LogoChoice): DownloadLogo => (c.kind === 'once' ? { fileName: c.fileName, data: c.data } : c.kind);
/** URL para mostrar el logo elegido (undefined = sin logo). */
export const choiceSrc = (c: LogoChoice, project?: LogoInfo) => (c.kind === 'once' ? c.data : c.kind === 'project' ? project?.url : undefined);

/** Logo de la descarga: del proyecto, otro solo para esta descarga o sin logo. */
export function LogoSourceFields({ project, choice, onChange }: { project?: LogoInfo; choice: LogoChoice; onChange: (c: LogoChoice) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setError(undefined);
    if (f.size > 5 * 1024 * 1024) return setError('El logo pesa más de 5 MB.');
    if (!/\.(png|svg)$/i.test(f.name) && !/image\/(png|svg\+xml)/.test(f.type)) return setError('El logo debe ser un PNG o un SVG.');
    onChange({ kind: 'once', fileName: f.name, data: await readAsDataUrl(f) });
  };
  const opt = (active: boolean) => cn('flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border p-2 text-left', active && 'border-primary bg-primary/10');
  return (
    <div className="grid gap-1.5 text-xs">
      <input ref={file} type="file" accept="image/png,image/svg+xml,.svg,.png" hidden onChange={(e) => void pick(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
      <button type="button" className={opt(choice.kind === 'project')} onClick={() => onChange({ kind: 'project' })} disabled={!project}>
        {project ? <img src={project.url} alt="" className="h-6 max-w-16 object-contain" /> : <ImageIcon className="text-muted-foreground size-4" />}
        <span className="min-w-0">
          <span className="font-medium">Del proyecto</span>
          <span className="text-muted-foreground block truncate text-[11px]">{project ? project.fileName : 'El proyecto no tiene logo.'}</span>
        </span>
      </button>
      <button type="button" className={opt(choice.kind === 'once')} onClick={() => file.current?.click()}>
        {choice.kind === 'once' ? <img src={choice.data} alt="" className="h-6 max-w-16 object-contain" /> : <ImageIcon className="text-muted-foreground size-4" />}
        <span className="min-w-0">
          <span className="font-medium">{choice.kind === 'once' ? 'Otro logo (cambiar)' : 'Otro logo, solo para esta descarga'}</span>
          <span className="text-muted-foreground block truncate text-[11px]">
            {choice.kind === 'once' ? `${choice.fileName} · no se guarda en el proyecto` : 'Para entregar el mismo video a otra empresa. No se guarda.'}
          </span>
        </span>
      </button>
      <button type="button" className={opt(choice.kind === 'none')} onClick={() => onChange({ kind: 'none' })}>
        <span className="text-muted-foreground grid size-4 place-items-center">∅</span>
        <span className="font-medium">Sin logo</span>
      </button>
      {error && <div className="text-destructive text-[11px]">{error}</div>}
    </div>
  );
}
