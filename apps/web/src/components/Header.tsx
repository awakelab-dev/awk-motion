import { Clapperboard, FolderKanban, Link2, Loader2, LogOut, Palette, PlugZap, UserRound, Users } from 'lucide-react';
import { useState } from 'react';
import type { AppInfo, AuthUser } from '@wilox/shared';
import { QueueIndicator } from '@/components/queue/QueueView';
import { DownloadsIndicator } from '@/components/downloads/DownloadsView';
import { TrashIndicator } from '@/components/trash/TrashView';
import { ReviewsIndicator } from '@/components/reviews/ReviewsView';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { brand } from '@/lib/brand';
import { cn } from '@/lib/utils';
import type { View } from '@/App';

/** Pestañas principales; la marca elige cuáles se ven y en qué orden (`brand.nav`, ADR-150). */
const NAV = {
  proyectos: ['Proyectos', FolderKanban],
  generar: ['Generar', Clapperboard],
  temas: ['Temas', Palette],
} as const;

const MODE_LABEL = { mcp: 'Modo MCP · Higgsfield', api: 'Modo API · MiniMax · OpenAI · ElevenLabs', mock: 'Modo MOCK · local' } as const;

/** Isotipo de la marca: su imagen o, sin ella, el dibujado de la identidad neutra (ADR-008, ADR-150). */
export function Logo() {
  if (brand.logo.mark) return <img src={brand.logo.mark} alt="" className="size-9 shrink-0 object-contain" />;
  return (
    <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[var(--mark-from)] to-[var(--mark-to)] shadow-[0_8px_30px_-8px_color-mix(in_srgb,var(--mark-from)_70%,transparent)]">
      <svg viewBox="0 0 32 32" className="size-5" aria-hidden>
        <path d="M6 10l4 12 6-10 6 10 4-12" stroke="#0b0b0e" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/**
 * Logo y nombre del producto (cabecera e inicio de sesión). Con logo completo: el logo y, si la marca lo pide, una
 * etiqueta al lado (ej. «Motion»); sin él, el isotipo y la etiqueta (o, sin etiqueta, el nombre).
 */
export function BrandLockup({ tagline, taglineClass }: { tagline?: string; taglineClass?: string }) {
  const text = (title: string) => (
    <div>
      <div className="text-[15px] font-semibold tracking-tight">{title}</div>
      {tagline && <div className={cn('text-muted-foreground text-[11px]', taglineClass)}>{tagline}</div>}
    </div>
  );
  if (brand.logo.full)
    return (
      <div className="flex min-w-0 items-center gap-3">
        <img src={brand.logo.full} alt={brand.name} style={{ height: brand.logo.fullHeight }} className="w-auto shrink-0" />
        {brand.logo.label && (
          <>
            <span className="bg-border h-6 w-px shrink-0" aria-hidden />
            {text(brand.logo.label)}
          </>
        )}
      </div>
    );
  return (
    <>
      <Logo />
      {text(brand.logo.label ?? brand.name)}
    </>
  );
}

const tab = (active: boolean) =>
  cn(
    'inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
    active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
  );

export function Header({
  info,
  me,
  onRefresh,
  view,
  onView,
  onLogout,
}: {
  info?: AppInfo;
  me: AuthUser;
  onRefresh: () => void;
  view: View;
  onView: (v: View) => void;
  onLogout: () => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const hf = info?.higgsfield;

  const connect = async () => {
    setConnecting(true);
    try {
      const s = await api.higgsfieldStart();
      if (s.authUrl) window.location.href = s.authUrl;
      else onRefresh();
    } finally {
      setConnecting(false);
    }
  };

  return (
    <header className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3 px-4 py-5 sm:px-6">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <BrandLockup tagline={brand.tagline} taglineClass="hidden md:block" />
        <nav className="flex max-w-full overflow-x-auto rounded-lg border bg-card/60 p-0.5 sm:ml-2">
          {brand.nav.map((v) => [v, ...NAV[v]] as const).map(([v, label, Icon]) => (
            // Un video abierto cuelga de su proyecto (ADR-053): se marca "Proyectos".
            <button key={v} type="button" onClick={() => onView(v)} className={tab(view === v || (v === 'proyectos' && view === 'video'))}>
              <Icon className="size-3.5" /> {label}
            </button>
          ))}
        </nav>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <QueueIndicator active={view === 'cola'} onClick={() => onView('cola')} />
        <DownloadsIndicator active={view === 'descargas'} onClick={() => onView('descargas')} />
        <ReviewsIndicator active={view === 'observaciones'} onClick={() => onView('observaciones')} />
        {/* Se trabaja en modo API: solo se avisa si la app corre en otro modo (MCP o mock). */}
        {info && info.mode !== 'api' && <Badge variant={info.mode === 'mock' ? 'warning' : 'secondary'}>{MODE_LABEL[info.mode]}</Badge>}
        {hf &&
          (hf.connected ? (
            <Badge variant="success">
              <Link2 /> Higgsfield conectado
            </Badge>
          ) : me.role === 'admin' ? (
            <Button size="sm" variant="outline" onClick={connect} disabled={connecting} title={hf.error}>
              {connecting ? <Loader2 className="animate-spin" /> : <PlugZap />} Conectar Higgsfield
            </Button>
          ) : (
            <Badge variant="warning" title="La conexión con Higgsfield la hace el administrador.">
              <PlugZap /> Higgsfield sin conectar
            </Badge>
          ))}
        <nav className="flex items-center rounded-lg border bg-card/60 p-0.5">
          <TrashIndicator active={view === 'papelera'} onClick={() => onView('papelera')} />
          {me.role === 'admin' && (
            <button type="button" onClick={() => onView('usuarios')} className={tab(view === 'usuarios')}>
              <Users className="size-3.5" /> Usuarios
            </button>
          )}
          <button type="button" onClick={() => onView('cuenta')} className={tab(view === 'cuenta')} title={me.email}>
            <UserRound className="size-3.5" /> <span className="max-w-[160px] truncate">{me.name ?? me.email}</span>
          </button>
          <button type="button" onClick={onLogout} className={tab(false)} title="Cerrar sesión">
            <LogOut className="size-3.5" />
          </button>
        </nav>
      </div>
    </header>
  );
}
