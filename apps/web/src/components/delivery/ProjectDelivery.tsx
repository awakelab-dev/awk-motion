import { ImageIcon, ImagePlus, Loader2, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { LogoSettings, ProjectDelivery, ProjectSummary, VideoDelivery } from '@wilox/shared';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DELIVERY_EVENT, LogoOverlay, LogoSettingsFields, LogoStage, notifyDelivery, readAsDataUrl } from './logo';

const same = (a?: LogoSettings, b?: LogoSettings) => JSON.stringify(a) === JSON.stringify(b);
export const aspectOf = (d?: { logo?: ProjectDelivery['logo'] }) => (d?.logo?.width && d.logo.height ? d.logo.width / d.logo.height : undefined);

/** Entrega del proyecto (logo y ajustes), recargada cuando otra vista la cambia. */
export function useProjectDelivery(projectId: string | undefined) {
  const [d, setD] = useState<ProjectDelivery>();
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    const load = () => api.projectDelivery(projectId).then((x) => alive && setD(x), () => undefined);
    void load();
    window.addEventListener(DELIVERY_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(DELIVERY_EVENT, load);
    };
  }, [projectId]);
  return [d, setD] as const;
}

/** Entrega de un video (logo y ajustes del proyecto, esquinas por clip), recargada cuando cambia. */
export function useVideoDelivery(id: string, enabled = true) {
  const [d, setD] = useState<VideoDelivery>();
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => api.videoDelivery(id).then((x) => alive && setD(x), () => undefined);
    void load();
    window.addEventListener(DELIVERY_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(DELIVERY_EVENT, load);
    };
  }, [id, enabled]);
  return [d, setD] as const;
}

/**
 * Logo del proyecto en su cabecera (ADR-066): el logo o un marcador; abre el diálogo para subirlo y
 * definir sus ajustes globales (tamaño, margen, realce, opacidad y esquina por defecto).
 */
export function ProjectLogoButton({ project }: { project: ProjectSummary }) {
  const [d, setD] = useProjectDelivery(project.id);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={d?.logo ? `Logo del proyecto: ${d.logo.fileName}` : 'Subir el logo del proyecto'}
        className={cn(
          'hover:border-primary/60 flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2 text-xs transition-colors',
          !d?.logo && 'text-muted-foreground border-dashed',
        )}
      >
        {d?.logo ? (
          <img src={d.logo.url} alt="Logo del proyecto" className="h-5 max-w-24 object-contain" />
        ) : (
          <>
            <ImageIcon className="size-3.5" /> Logo
          </>
        )}
      </button>
      {open && d && <ProjectLogoDialog projectId={project.id} delivery={d} onChange={setD} onClose={() => setOpen(false)} />}
    </>
  );
}

function ProjectLogoDialog({ projectId, delivery, onChange, onClose }: { projectId: string; delivery: ProjectDelivery; onChange: (d: ProjectDelivery) => void; onClose: () => void }) {
  const [settings, setSettings] = useState(delivery.settings);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const file = useRef<HTMLInputElement>(null);
  const act = async (label: string, fn: () => Promise<ProjectDelivery>) => {
    setBusy(label);
    setError(undefined);
    try {
      onChange(await fn());
      notifyDelivery();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const changed = !same(settings, delivery.settings);
  return (
    <Modal title="Logo del proyecto" onClose={onClose} className="max-w-4xl">
      <div className="grid gap-5 md:grid-cols-[1fr_300px]">
        <div className="grid min-w-0 content-start gap-2">
          <LogoStage>
            <LogoOverlay src={delivery.logo?.url} aspect={aspectOf(delivery)} settings={settings} />
          </LogoStage>
          <p className="text-muted-foreground text-[11px]">
            El logo se dibuja sobre el video al reproducirlo (no se graba en el MP4), así el mismo video se puede entregar con otro logo. Tamaño, margen,
            realce y opacidad valen para todos los videos del proyecto; la esquina se puede cambiar en cada clip (en las tarjetas de clips del video o al
            descargarlo). Al descargar también se puede usar otro logo solo para esa descarga.
          </p>
        </div>
        <div className="grid min-w-0 content-start gap-4 text-xs">
          <section className="grid gap-2">
            <input
              ref={file}
              type="file"
              accept="image/png,image/svg+xml,.svg,.png"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void act('logo', async () => api.uploadLogo(projectId, f.name, await readAsDataUrl(f)));
              }}
            />
            {delivery.logo ? (
              <div className="bg-secondary flex items-center gap-2 rounded-md p-2">
                <img src={delivery.logo.url} alt="" className="h-8 max-w-24 object-contain" />
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-[11px]">{delivery.logo.fileName}</span>
              </div>
            ) : (
              <div className="text-muted-foreground rounded-md border border-dashed p-2 text-[11px]">Sin logo: en los videos se ve un marcador donde irá. PNG o SVG, mejor con transparencia (hasta 5 MB).</div>
            )}
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" onClick={() => file.current?.click()} disabled={!!busy}>
                {busy === 'logo' ? <Loader2 className="animate-spin" /> : <ImagePlus />} {delivery.logo ? 'Cambiar' : 'Subir PNG o SVG'}
              </Button>
              {delivery.logo && (
                <Button size="sm" variant="ghost" onClick={() => void act('logo', () => api.removeLogo(projectId))} disabled={!!busy} title="Quitar el logo del proyecto">
                  <Trash2 /> Quitar
                </Button>
              )}
            </div>
          </section>
          <section className="grid gap-2">
            <div className="font-medium">Ajustes (todos los videos)</div>
            <LogoSettingsFields settings={settings} onChange={setSettings} />
          </section>
          {error && <div className="text-destructive">{error}</div>}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void act('save', () => api.setProjectDelivery(projectId, settings))} disabled={!!busy || !changed}>
              {busy === 'save' ? <Loader2 className="animate-spin" /> : <Save />} Guardar ajustes
            </Button>
            {changed && (
              <button type="button" className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1 text-[11px]" onClick={() => setSettings(delivery.settings)}>
                <RotateCcw className="size-3" /> Deshacer
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
