import { Globe, Loader2, Mic } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ProjectSummary, RevoiceBatchResponse, RevoiceCandidate } from '@wilox/shared';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { projectsApi } from '@/lib/api';
import { ChangeCancelled } from '@/lib/confirm';
import { confirmSpend } from '@/lib/spend';
import { cn } from '@/lib/utils';

const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' });
const fmtNum = (n: number) => n.toLocaleString('es-CL');

/**
 * «Rehacer la locución» de varios videos del proyecto (hito 10, T5, ADR-135): cada video marcado se vuelve a locutar
 * en un solo pedido, con la misma voz y el mismo texto (como su botón, ADR-134). Al abrir quedan marcados los que aún
 * tienen la locución por párrafo; «Todos» marca todos los que se pueden rehacer.
 */
export function ProjectRevoiceDialog({ project, onClose, onStarted }: { project: ProjectSummary; onClose: () => void; onStarted: () => void }) {
  const [candidates, setCandidates] = useState<RevoiceCandidate[]>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<RevoiceBatchResponse>();

  useEffect(() => {
    projectsApi.revoiceCandidates(project.id).then(
      (c) => {
        setCandidates(c);
        setSelected(new Set(c.filter((v) => v.available && v.voiceMode === 'paragraph').map((v) => v.id)));
      },
      (e: Error) => (setError(e.message), setCandidates([])),
    );
  }, [project.id]);

  const available = useMemo(() => (candidates ?? []).filter((c) => c.available), [candidates]);
  const chosen = available.filter((c) => selected.has(c.id));
  const chars = chosen.reduce((n, c) => n + c.chars, 0);
  const byParagraph = available.filter((c) => c.voiceMode === 'paragraph');
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const start = async () => {
    const n = chosen.length;
    const ok = await confirmSpend({
      title: `Rehacer la locución de ${n} video${n === 1 ? '' : 's'}`,
      body: 'Cada video se vuelve a locutar entero en un solo pedido, con la misma voz y el mismo texto, para que no cambie de tono, velocidad ni acento entre párrafos. Los fotogramas y los clips no cambian: se rehacen el post y el final (el anterior se conserva). Los videos esperan su turno en la cola.',
      work: { ttsChars: chars },
      action: `Rehacer ${n} ${n === 1 ? 'locución' : 'locuciones'}`,
    });
    if (!ok) return;
    setBusy(true);
    setError(undefined);
    try {
      setResult(await projectsApi.revoice(project.id, chosen.map((c) => c.id)));
      onStarted();
    } catch (e) {
      if (!(e instanceof ChangeCancelled)) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Rehacer la locución · «${project.name}»`} onClose={onClose} className="max-w-3xl">
      {!candidates ? (
        <div className="grid place-items-center p-8">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      ) : result ? (
        <div className="grid gap-3 text-sm">
          <p>
            {result.started.length
              ? `${result.started.length} video${result.started.length === 1 ? '' : 's'} en marcha. Se ven «en curso» en el proyecto y en «Cola»; cada uno queda listo con su final nuevo.`
              : 'Ningún video empezó.'}
          </p>
          {result.skipped.length > 0 && (
            <div className="grid gap-1 text-xs">
              <div className="font-medium">No empezaron:</div>
              <ul className="text-muted-foreground grid gap-0.5">
                {result.skipped.map((s) => (
                  <li key={s.id}>
                    «{s.title}»: {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <Button size="sm" onClick={onClose}>
              Cerrar
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 text-xs">
          <p className="text-muted-foreground leading-relaxed">
            Vuelve a locutar los videos marcados en un solo pedido cada uno, con la misma voz y el mismo texto, para quitar los cambios de tono, velocidad y
            acento entre párrafos. No se regeneran fotogramas ni clips. Al abrir quedan marcados los que aún tienen la locución por párrafo.
          </p>
          <section className="grid gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="font-medium">
                Videos ({chosen.length} de {available.length})
              </div>
              <div className="flex gap-3 text-[11px]">
                <button type="button" className="text-primary cursor-pointer hover:underline" onClick={() => setSelected(new Set(available.map((c) => c.id)))}>
                  Todos
                </button>
                <button type="button" className="text-primary cursor-pointer hover:underline" onClick={() => setSelected(new Set(byParagraph.map((c) => c.id)))}>
                  Solo por párrafo ({byParagraph.length})
                </button>
                <button type="button" className="text-primary cursor-pointer hover:underline" onClick={() => setSelected(new Set())}>
                  Ninguno
                </button>
              </div>
            </div>
            {candidates.length === 0 ? (
              <div className="text-muted-foreground rounded-md border p-3">El proyecto aún no tiene videos.</div>
            ) : (
              <div className="max-h-[50vh] overflow-y-auto rounded-md border">
                {candidates.map((c, i) => (
                  <label
                    key={c.id}
                    title={c.reason}
                    className={cn(
                      'flex items-center gap-2.5 border-b px-2.5 py-1.5 last:border-b-0',
                      c.available ? 'hover:bg-secondary/40 cursor-pointer' : 'cursor-not-allowed opacity-45',
                      c.available && !selected.has(c.id) && 'opacity-55',
                    )}
                  >
                    <input type="checkbox" checked={c.available && selected.has(c.id)} disabled={!c.available || busy} onChange={() => toggle(c.id)} />
                    <span className="text-muted-foreground w-6 shrink-0 text-right font-mono text-[10.5px]">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate" title={c.title}>
                      {c.title}
                    </span>
                    {!c.available ? (
                      <span className="text-muted-foreground shrink-0 text-[10.5px]">{c.reason}</span>
                    ) : (
                      <span className={cn('shrink-0 text-[10.5px]', c.voiceMode === 'paragraph' ? 'text-warning' : 'text-muted-foreground')}>
                        {c.voiceMode === 'paragraph' ? 'por párrafo' : 'un solo pedido'}
                      </span>
                    )}
                    {c.published && <Globe className="text-success size-3.5 shrink-0" aria-label="Publicado" />}
                    <span className="text-muted-foreground shrink-0 tabular-nums">{fmtDur(c.durationSec)}</span>
                    <span className="text-muted-foreground w-11 shrink-0 text-right tabular-nums">{fmtDate(c.createdAt)}</span>
                  </label>
                ))}
              </div>
            )}
          </section>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-muted-foreground">{chosen.length ? `${fmtNum(chars)} caracteres de voz` : 'Marca al menos un video.'}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
                Cancelar
              </Button>
              <Button size="sm" onClick={() => void start()} disabled={busy || !chosen.length}>
                {busy ? <Loader2 className="animate-spin" /> : <Mic />} Rehacer {chosen.length} {chosen.length === 1 ? 'locución' : 'locuciones'}
              </Button>
            </div>
          </div>
          {error && <p className="text-destructive">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
