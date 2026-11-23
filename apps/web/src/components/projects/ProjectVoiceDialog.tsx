import { ArrowUpCircle, Gauge, Globe, Loader2, Timer } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { VOICE_SPEED_DEFAULT, type ProjectSummary, type ResyncResponse, type ResyncStatus, type SpeedBatchResponse, type SpeedCandidate, type ToV4Response, type ToV4Status } from '@wilox/shared';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { SpeedPicker, speedText } from '@/components/voice/SpeedPicker';
import { projectsApi } from '@/lib/api';
import { ChangeCancelled } from '@/lib/confirm';
import { confirmSpend } from '@/lib/spend';
import { cn } from '@/lib/utils';

const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const same = (a: number, b: number) => Math.abs(a - b) < 1e-3;

/**
 * Voz del proyecto (hito 13a, ADR-177/178/179): «Pasar a v4» un proyecto en v3 (solo el dueño, irreversible, con la
 * velocidad elegida con la muestra), la velocidad de la narración de sus videos nuevos y «Cambiar velocidad» de los
 * videos ya hechos (sin pedir voz ni clips: sin costo). Al abrir quedan marcados los videos cuya velocidad no es la elegida.
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
  // «Pasar a v4» (T3, ADR-179).
  const [v4, setV4] = useState<ToV4Status>();
  const [v4Speed, setV4Speed] = useState(voice.model === 'v4' ? voice.speed : VOICE_SPEED_DEFAULT);
  const [v4Result, setV4Result] = useState<ToV4Response>();
  const [v4Busy, setV4Busy] = useState(false);
  useEffect(() => {
    projectsApi.v4Status(project.id).then(setV4, () => undefined);
  }, [project.id, v4Result]);
  useEffect(() => {
    setSaved(voice.speed);
    setSpeed(voice.speed);
  }, [voice.model, voice.speed]);

  // «Reajustar sincronía» (T6, ADR-182).
  const [sync, setSync] = useState<ResyncStatus>();
  const [syncResult, setSyncResult] = useState<ResyncResponse>();
  const [syncBusy, setSyncBusy] = useState(false);
  useEffect(() => {
    projectsApi.resyncStatus(project.id).then(setSync, () => undefined);
  }, [project.id, syncResult]);
  const resync = async () => {
    setSyncBusy(true);
    setError(undefined);
    try {
      setSyncResult(await projectsApi.resync(project.id));
    } catch (e) {
      if (!(e instanceof ChangeCancelled)) setError((e as Error).message);
    } finally {
      setSyncBusy(false);
    }
  };

  const toV4 = async () => {
    if (!v4) return;
    const all = voice.model === 'v3';
    const ok = await confirmSpend({
      title: all ? 'Pasar el proyecto a v4' : `Pasar a v4 los ${v4.v3Videos} videos que faltan`,
      body: (
        <>
          {all && (
            <>
              <strong>Es irreversible:</strong> el proyecto queda en v4 (no se puede volver a v3) y sus videos nuevos nacen en v4 a {speedText(v4Speed)}.{' '}
            </>
          )}
          La locución de {v4.v3Videos === 1 ? 'su video' : `sus ${v4.v3Videos} videos`} en v3 se rehace en v4, párrafo por párrafo y a {speedText(v4Speed)}, en la
          cola. No se regeneran fotogramas ni clips; se rehacen el post y el final. Las pausas cambiadas a mano se pierden; las reglas de pronunciación y los tonos
          del guion se mantienen.
          {v4.waiting.length > 0 && ` ${v4.waiting.length} esperan a terminar lo que están haciendo y pasan solos después.`}
        </>
      ),
      work: { ttsV4Chars: v4.chars },
      action: 'Pasar a v4',
    });
    if (!ok) return;
    setV4Busy(true);
    setError(undefined);
    try {
      const r = await projectsApi.toV4(project.id, all ? v4Speed : voice.speed);
      setV4Result(r);
      onChanged({ ...project, voice: r.voice });
    } catch (e) {
      if (!(e instanceof ChangeCancelled)) setError((e as Error).message);
    } finally {
      setV4Busy(false);
    }
  };

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
        {v4Result ? (
          <section className="border-primary/40 bg-primary/5 grid gap-2 rounded-lg border p-3">
            <div className="font-medium">Proyecto en v4 a {speedText(v4Result.voice.speed)}</div>
            <p>
              {v4Result.started.length
                ? `${v4Result.started.length} video${v4Result.started.length === 1 ? '' : 's'} pasando a v4: se ven «en curso» en el proyecto y en «Cola».`
                : 'Ningún video empezó ahora.'}
              {v4Result.waiting.length > 0 && ` ${v4Result.waiting.length} esperan a terminar lo que están haciendo y pasan solos después.`}
            </p>
            {v4Result.waiting.length > 0 && (
              <ul className="text-muted-foreground grid gap-0.5">
                {v4Result.waiting.map((w) => (
                  <li key={w.id}>
                    «{w.title}»: {w.reason}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          v4 &&
          (voice.model === 'v3' || v4.v3Videos > 0) && (
            <section className="border-primary/40 bg-primary/5 grid gap-2 rounded-lg border p-3">
              <div className="font-medium">{voice.model === 'v3' ? 'Pasar a v4' : `${v4.v3Videos} video${v4.v3Videos === 1 ? '' : 's'} aún en v3`}</div>
              <p className="text-muted-foreground leading-relaxed">
                {voice.model === 'v3'
                  ? 'En v4 la locución se pide por párrafo, con el contexto de sus vecinos: suena mejor y «Rehacer audio» cambia solo ese párrafo. Pasar es irreversible y rehace la locución de todos los videos del proyecto (sin fotogramas ni clips nuevos). Elige la velocidad con la muestra de la voz v4.'
                  : `Quedaron en v3 (por ejemplo, porque estaban trabajando o tras un reinicio). Pasan a v4 a ${speedText(voice.speed)}, la velocidad del proyecto.`}
              </p>
              {!v4.canConvert ? (
                <p className="text-muted-foreground">Solo el dueño del proyecto puede pasarlo a v4.</p>
              ) : (
                <>
                  {voice.model === 'v3' && <SpeedPicker value={v4Speed} onChange={setV4Speed} model="v4" voiceId={project.defaults?.voiceId} disabled={v4Busy} />}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => void toV4()} disabled={v4Busy || !!busy}>
                      {v4Busy ? <Loader2 className="animate-spin" /> : <ArrowUpCircle />}{' '}
                      {voice.model === 'v3' ? `Pasar a v4 a ${speedText(v4Speed)}` : 'Pasar los que faltan a v4'}
                    </Button>
                    <span className="text-muted-foreground">
                      {v4.v3Videos} video{v4.v3Videos === 1 ? '' : 's'} · {v4.chars.toLocaleString('es-CL')} caracteres
                      {v4.published > 0 && ` · ${v4.published} publicado${v4.published === 1 ? '' : 's'}`}
                    </span>
                  </div>
                </>
              )}
            </section>
          )
        )}
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
        {(syncResult || (sync && sync.old > 0)) && (
          <section className="grid gap-2">
            <div className="font-medium">Sincronía de las palabras clave</div>
            {syncResult ? (
              <div className="grid gap-1">
                <p>
                  {syncResult.started.length
                    ? `${syncResult.started.length} video${syncResult.started.length === 1 ? '' : 's'} reajustándose (sin costo): se rehace el final de cada uno.`
                    : 'Ningún video empezó.'}
                </p>
                {syncResult.skipped.length > 0 && (
                  <ul className="text-muted-foreground grid gap-0.5">
                    {syncResult.skipped.map((s) => (
                      <li key={s.id}>
                        «{s.title}»: {s.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              sync && (
                <>
                  <p className="text-muted-foreground leading-relaxed">
                    {sync.old === 1 ? 'Un video tiene' : `${sync.old} videos tienen`} una sincronía anterior. «Reajustar sincronía» hace empezar cada clip 0,5 s antes de que la voz
                    diga el primer texto que muestra en pantalla. Sin costo: no pide voz, fotogramas ni clips; se rehace el final.
                    {sync.blocked.length > 0 && ` Ahora no se pueden ${sync.blocked.length} (trabajando o sin terminar): quedan para después.`}
                  </p>
                  <div>
                    <Button size="sm" variant="outline" onClick={() => void resync()} disabled={syncBusy || !!busy || sync.old === sync.blocked.length}>
                      {syncBusy ? <Loader2 className="animate-spin" /> : <Timer />} Reajustar sincronía de {sync.old - sync.blocked.length} video
                      {sync.old - sync.blocked.length === 1 ? '' : 's'}
                    </Button>
                  </div>
                </>
              )
            )}
          </section>
        )}
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
