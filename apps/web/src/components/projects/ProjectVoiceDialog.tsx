import { Gauge, Globe, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ProjectSummary, SpeedBatchResponse, SpeedCandidate } from '@wilox/shared';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { SpeedPicker, speedText } from '@/components/voice/SpeedPicker';
import { projectsApi } from '@/lib/api';
import { ChangeCancelled } from '@/lib/confirm';
import { cn } from '@/lib/utils';

const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const same = (a: number, b: number) => Math.abs(a - b) < 1e-3;

/**
 * Voz del proyecto (hito 13a, ADR-177/178): la velocidad de la narración de sus videos nuevos, con la muestra, y
 * «Cambiar velocidad» de los videos ya hechos (sin pedir voz ni clips: sin costo). Al abrir quedan marcados los videos
 * cuya velocidad no es la elegida.
 */
export function ProjectVoiceDialog({ project, onClose, onChanged }: { project: ProjectSummary; onClose: () => void; onChanged: (p: ProjectSummary) => void }) {
  const voice = project.voice ?? { model: 'v3' as const, speed: 1 };
  const [speed, setSpeed] = useState(voice.speed);
  const [saved, setSaved] = useState(voice.speed);
  const [candidates, setCandidates] = useState<SpeedCandidate[]>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'save' | 'videos'>();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<SpeedBatchResponse>();

  useEffect(() => {
    projectsApi.speedCandidates(project.id).then(setCandidates, (e: Error) => (setError(e.message), setCandidates([])));
  }, [project.id]);
  // Marcados: los que se pueden cambiar y no están a la velocidad elegida.
  useEffect(() => {
    setSelected(new Set((candidates ?? []).filter((c) => c.available && !same(c.speed, speed)).map((c) => c.id)));
  }, [candidates, speed]);

  const available = useMemo(() => (candidates ?? []).filter((c) => c.available && !same(c.speed, speed)), [candidates, speed]);
  const chosen = available.filter((c) => selected.has(c.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const save = async () => {
    setBusy('save');
    setError(undefined);
    try {
      const v = await projectsApi.setVoice(project.id, speed);
      setSaved(v.speed);
      onChanged({ ...project, voice: v });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const apply = async () => {
    setBusy('videos');
    setError(undefined);
    try {
      setResult(await projectsApi.speed(project.id, chosen.map((c) => c.id), speed));
    } catch (e) {
      if (!(e instanceof ChangeCancelled)) setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Modal title={`Voz del proyecto · «${project.name}»`} onClose={onClose} className="max-w-3xl">
      <div className="grid gap-5 text-xs">
        <section className="grid gap-2">
          <div className="font-medium">Velocidad de la narración</div>
          <p className="text-muted-foreground leading-relaxed">
            Se aplica después de pedir la voz (sin cambiar el tono). Más pausada = audio más largo y más tiempo congelado en los videos; más rápida = menos
            congelado. Los clips no se regeneran.
          </p>
          <SpeedPicker value={speed} onChange={(v) => (setSpeed(v), setResult(undefined))} model={voice.model} voiceId={project.defaults?.voiceId} current={saved} disabled={!!busy} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void save()} disabled={!!busy || same(speed, saved)}>
              {busy === 'save' ? <Loader2 className="animate-spin" /> : <Gauge />} Usar {speedText(speed)} en los videos nuevos
            </Button>
            <span className="text-muted-foreground">Hoy: {speedText(saved)}</span>
          </div>
        </section>

        <section className="grid gap-2">
          <div className="font-medium">Videos ya hechos</div>
          {result ? (
            <div className="grid gap-2">
              <p>
                {result.started.length
                  ? `${result.started.length} video${result.started.length === 1 ? '' : 's'} en marcha a ${speedText(speed)}: se rehacen el post y el final (sin costo).`
                  : 'Ningún video empezó.'}
              </p>
              {result.skipped.length > 0 && (
                <ul className="text-muted-foreground grid gap-0.5">
                  {result.skipped.map((s) => (
                    <li key={s.id}>
                      «{s.title}»: {s.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : !candidates ? (
            <Loader2 className="text-muted-foreground size-4 animate-spin" />
          ) : candidates.length === 0 ? (
            <div className="text-muted-foreground rounded-md border p-3">El proyecto aún no tiene videos.</div>
          ) : (
            <>
              <p className="text-muted-foreground leading-relaxed">
                «Cambiar velocidad» estira la locución actual de los videos marcados a {speedText(speed)}: no pide voz ni clips (sin costo), recalcula el plan
                y rehace el final. Quedan marcados los que no están a {speedText(speed)}.
              </p>
              <div className="flex gap-3 text-[11px]">
                <button type="button" className="text-primary cursor-pointer hover:underline" onClick={() => setSelected(new Set(available.map((c) => c.id)))}>
                  Todos ({available.length})
                </button>
                <button type="button" className="text-primary cursor-pointer hover:underline" onClick={() => setSelected(new Set())}>
                  Ninguno
                </button>
              </div>
              <div className="max-h-[40vh] overflow-y-auto rounded-md border">
                {candidates.map((c, i) => {
                  const can = c.available && !same(c.speed, speed);
                  return (
                    <label
                      key={c.id}
                      title={c.reason}
                      className={cn('flex items-center gap-2.5 border-b px-2.5 py-1.5 last:border-b-0', can ? 'hover:bg-secondary/40 cursor-pointer' : 'cursor-not-allowed opacity-45')}
                    >
                      <input type="checkbox" checked={can && selected.has(c.id)} disabled={!can || !!busy} onChange={() => toggle(c.id)} />
                      <span className="text-muted-foreground w-6 shrink-0 text-right font-mono text-[10.5px]">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate" title={c.title}>
                        {c.title}
                      </span>
                      <span className="text-muted-foreground shrink-0 text-[10.5px]">{c.available ? `voz ${c.voiceModel} · ${speedText(c.speed)}` : c.reason}</span>
                      {c.published && <Globe className="text-success size-3.5 shrink-0" aria-label="Publicado" />}
                      <span className="text-muted-foreground shrink-0 tabular-nums">{fmtDur(c.durationSec)}</span>
                    </label>
                  );
                })}
              </div>
              <div>
                <Button size="sm" variant="outline" onClick={() => void apply()} disabled={!!busy || !chosen.length}>
                  {busy === 'videos' ? <Loader2 className="animate-spin" /> : <Gauge />} Cambiar velocidad de {chosen.length} video{chosen.length === 1 ? '' : 's'} a{' '}
                  {speedText(speed)}
                </Button>
              </div>
            </>
          )}
        </section>
        {error && <div className="text-destructive">{error}</div>}
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
