import { CheckCircle2, Check, Copy, ExternalLink, Film, Link2, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ProjectShareKind, ProjectShareState, ProjectShareVideo, ProjectSummary } from '@wilox/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { projectsApi } from '@/lib/api';
import { cn } from '@/lib/utils';

const KINDS: { kind: ProjectShareKind; title: string; icon: typeof Film; about: string; eligible: (v: ProjectShareVideo) => boolean; status: (v: ProjectShareVideo) => string }[] = [
  {
    kind: 'review',
    title: 'Aprobación del storyboard',
    icon: CheckCircle2,
    about:
      'El cliente ve el storyboard de cada video con la locución: deja observaciones en cada fotograma o lo aprueba. Las ves en cada video, como las del link de revisión.',
    eligible: (v) => v.hasKeyframes,
    status: (v) => (v.hasKeyframes ? 'storyboard' : 'sin fotogramas'),
  },
  {
    kind: 'videos',
    title: 'Revisión de los videos',
    icon: Film,
    about:
      'Después de aprobar: el cliente ve cada video terminado con las miniaturas de sus planos debajo (avanzan al reproducir) y deja observaciones en el plano que quiera cambiar. Sin aprobación.',
    eligible: (v) => v.hasFinal,
    status: (v) => (v.hasFinal ? 'video terminado' : 'sin final aún'),
  },
];

/**
 * Links del proyecto completo, cada uno aparte (T6b, ADR-116): **Aprobación del storyboard** (T6, ADR-112) y **Revisión de
 * los videos** terminados. Cada link con sus videos (todos, también los que se agreguen, o los elegidos), «Link nuevo» y
 * «Desactivar».
 */
export function ProjectShareDialog({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const [s, setS] = useState<ProjectShareState>();
  const [tab, setTab] = useState<ProjectShareKind>('review');
  const [error, setError] = useState<string>();

  useEffect(() => {
    projectsApi.share(project.id).then(setS, (e: Error) => setError(e.message));
  }, [project.id]);

  return (
    <Modal title={`Compartir «${project.name}»`} onClose={onClose} className="max-w-2xl">
      {!s ? (
        <div className="grid place-items-center p-8">{error ? <p className="text-destructive text-sm">{error}</p> : <Loader2 className="text-muted-foreground size-5 animate-spin" />}</div>
      ) : (
        <div className="grid gap-4 text-xs">
          <div className="grid grid-cols-2 gap-1 rounded-lg border p-1">
            {KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                onClick={() => setTab(k.kind)}
                className={cn('flex cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-medium', tab === k.kind ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                <k.icon className="size-3.5" /> {k.title}
                {s.links[k.kind] && <span className="bg-success size-1.5 rounded-full" title="Link activo" />}
              </button>
            ))}
          </div>
          {KINDS.filter((k) => k.kind === tab).map((k) => (
            <LinkSection key={k.kind} spec={k} project={project} state={s} onState={setS} />
          ))}
        </div>
      )}
    </Modal>
  );
}

function LinkSection({ spec, project, state, onState }: { spec: (typeof KINDS)[number]; project: ProjectSummary; state: ProjectShareState; onState: (s: ProjectShareState) => void }) {
  const link = state.links[spec.kind];
  const [all, setAll] = useState(link ? link.all : true);
  const [picked, setPicked] = useState<Set<string>>(new Set(link ? link.videoIds : state.videos.map((v) => v.id)));
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  const act = async (key: string, fn: () => Promise<ProjectShareState>) => {
    setBusy(key);
    setError(undefined);
    try {
      const st = await fn();
      const l = st.links[spec.kind];
      setAll(l ? l.all : true);
      setPicked(new Set(l ? l.videoIds : st.videos.map((v) => v.id)));
      onState(st);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const body = (renew?: boolean) => ({ kind: spec.kind, videoIds: all ? null : [...picked], renew });
  const changed = !!link && (link.all !== all || (!all && (link.videoIds.length !== picked.size || link.videoIds.some((id) => !picked.has(id)))));
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('No se pudo copiar: selecciona el link y cópialo a mano.');
    }
  };
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const ready = state.videos.filter(spec.eligible).length;

  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground leading-snug">{spec.about}</p>

      {link && (
        <div className="grid gap-2 rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <Badge variant="success">Activo</Badge>
            <span className="text-muted-foreground">
              {link.all ? 'Todos los videos (también los nuevos)' : `${link.videoIds.length} video${link.videoIds.length === 1 ? '' : 's'} elegido${link.videoIds.length === 1 ? '' : 's'}`} · creado el{' '}
              {new Date(link.createdAt).toLocaleDateString('es-CL')}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <input readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} className="bg-background h-8 min-w-0 flex-1 basis-64 rounded-md border px-2 font-mono text-[10.5px]" />
            <Button size="sm" variant="outline" onClick={() => void copy()}>
              {copied ? <Check /> : <Copy />} {copied ? 'Copiado' : 'Copiar'}
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href={link.url} target="_blank" rel="noreferrer">
                <ExternalLink /> Abrir
              </a>
            </Button>
          </div>
        </div>
      )}

      <section className="grid gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium">Qué ve el cliente</span>
          <span className="text-muted-foreground text-[10.5px]">
            {ready} de {state.videos.length} con {spec.kind === 'videos' ? 'video terminado' : 'storyboard'}: los demás aparecen cuando estén listos
          </span>
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="radio" checked={all} onChange={() => setAll(true)} /> Todos los videos del proyecto (también los que agregues después)
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="radio" checked={!all} onChange={() => setAll(false)} /> Solo los que elija
        </label>
        <div className={cn('max-h-[34vh] overflow-y-auto rounded-md border', all && 'pointer-events-none opacity-60')}>
          {state.videos.length === 0 && <div className="text-muted-foreground p-3">El proyecto aún no tiene videos.</div>}
          {state.videos.map((v, i) => {
            const open = spec.kind === 'videos' ? v.openVideoComments : v.openComments;
            return (
              <label key={v.id} className="hover:bg-secondary/40 flex cursor-pointer items-center gap-2.5 border-b px-2.5 py-1.5 last:border-b-0">
                <input type="checkbox" checked={all || picked.has(v.id)} onChange={() => toggle(v.id)} disabled={all} />
                <span className="text-muted-foreground w-6 shrink-0 text-right font-mono text-[10.5px]">{i + 1}</span>
                <span className={cn('min-w-0 flex-1 truncate', !spec.eligible(v) && 'text-muted-foreground')} title={v.title}>
                  {v.title}
                </span>
                <span className="text-muted-foreground shrink-0 text-[10.5px]">{spec.status(v)}</span>
                {spec.kind === 'review' && v.approvedAt ? <Badge variant="success">Aprobado</Badge> : open ? <Badge variant="warning">{open} obs.</Badge> : null}
              </label>
            );
          })}
        </div>
      </section>

      {error && <p className="text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {!link ? (
          <Button disabled={!!busy || (!all && picked.size === 0)} onClick={() => void act('create', () => projectsApi.saveShare(project.id, body()))}>
            {busy === 'create' ? <Loader2 className="animate-spin" /> : <Link2 />} Crear link
          </Button>
        ) : (
          <>
            <Button disabled={!!busy || !changed || (!all && picked.size === 0)} onClick={() => void act('save', () => projectsApi.saveShare(project.id, body()))}>
              {busy === 'save' ? <Loader2 className="animate-spin" /> : <Check />} Guardar los videos
            </Button>
            <Button
              variant="outline"
              disabled={!!busy}
              onClick={() => window.confirm('¿Cambiar por un link nuevo? El actual deja de funcionar.') && void act('renew', () => projectsApi.saveShare(project.id, body(true)))}
            >
              {busy === 'renew' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Link nuevo
            </Button>
            <Button
              variant="ghost"
              disabled={!!busy}
              onClick={() =>
                window.confirm('¿Desactivar el link? El cliente ya no podrá abrirlo; las observaciones se conservan.') && void act('remove', () => projectsApi.removeShare(project.id, spec.kind))
              }
            >
              {busy === 'remove' ? <Loader2 className="animate-spin" /> : <Trash2 />} Desactivar
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
