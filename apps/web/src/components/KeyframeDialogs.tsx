import { AudioLines, Loader2, Pause, Play, Wand2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { KeyframeState, RunState, VoiceSegment } from '@wilox/shared';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { confirmSpend } from '@/lib/spend';
import { cn } from '@/lib/utils';

const kname = (k: KeyframeState) => `K${String(k.index).padStart(2, '0')}`;

/** "Regenerar" en un pop-up (hito 5): el fotograma en grande y un campo amplio para la indicación. */
export function RegenerateDialog({ run, k, onClose }: { run: RunState; k: KeyframeState; onClose: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const send = async (useSuggestion = false) => {
    const ok = await confirmSpend({
      title: `Regenerar ${kname(k)}`,
      body: useSuggestion
        ? 'Se genera una imagen nueva con el plano que sugirió Opus; Opus la revisa.'
        : 'Opus reescribe el plano con tu indicación, se genera una imagen nueva y Opus la revisa.',
      work: { images: 1, llm: useSuggestion ? 1 : 2 },
      action: 'Regenerar',
    });
    if (!ok) return;
    setBusy(true);
    setErr(undefined);
    try {
      await api.regenerate(run.id, k.index, useSuggestion ? { useSuggestion: true } : { note: note.trim() || undefined });
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Regenerar ${kname(k)} · ${k.label.replace(/^K\d+ · /, '')}`} onClose={onClose} className="max-w-4xl">
      <div className="grid gap-4">
        {k.url && <img src={k.url} alt={k.label} className="aspect-video w-full rounded-lg border object-cover" />}
        {k.texts.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {k.texts.map((t) => (
              <span key={t} className="bg-secondary rounded px-1.5 py-0.5 text-[11px]">
                {t}
              </span>
            ))}
          </div>
        )}
        {k.review?.verdict === 'improve' && (
          <div className="border-warning/30 bg-warning/10 rounded-md border p-2.5 text-xs">
            <span className="text-warning font-medium">Opus sugiere mejorar: </span>
            {k.review.issues}
          </div>
        )}
        <div className="grid gap-1.5">
          <label className="text-xs font-medium" htmlFor="regen-note">
            ¿Qué quieres cambiar?
          </label>
          <Textarea
            id="regen-note"
            autoFocus
            rows={6}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Escribe en lenguaje natural lo que debe cambiar: «una sola foto grande en vez de tres», «el título en dos líneas», «cambia la enfermera por un laboratorio»… Vacío = otra versión del mismo plano."
          />
          <p className="text-muted-foreground text-[11px]">Opus reescribe el plano completo con tu indicación y la imagen nueva entra en la cola con la prioridad de este video.</p>
        </div>
        {err && <p className="text-destructive text-xs">{err}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          {k.review?.revisedScene && (
            <Button variant="secondary" onClick={() => send(true)} disabled={busy}>
              <Wand2 /> Aplicar sugerencia de Opus
            </Button>
          )}
          <Button onClick={() => send()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Wand2 />} Regenerar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

/**
 * "Rehacer audio" (hito 5, ADR-048): escucha el tramo de locución del fotograma, corrige el texto del
 * párrafo o di qué sonó mal; se vuelve a locutar el párrafo completo.
 */
export function RevoiceDialog({ run, k, onClose }: { run: RunState; k: KeyframeState; onClose: () => void }) {
  const [seg, setSeg] = useState<VoiceSegment>();
  const [loadErr, setLoadErr] = useState<string>();
  const [pi, setPi] = useState<number>();
  const [text, setText] = useState('');
  const [instruction, setInstruction] = useState('');
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [playing, setPlaying] = useState<'segment' | 'paragraph'>();
  const audio = useRef<HTMLAudioElement>(null);
  const stopAt = useRef<number>(0);

  useEffect(() => {
    api.voiceSegment(run.id, k.index).then(
      (s) => {
        setSeg(s);
        // Por defecto, el párrafo con más palabras dentro del tramo.
        const best = [...s.paragraphs].sort((a, b) => b.words.filter((w) => w.inSegment).length - a.words.filter((w) => w.inSegment).length)[0];
        if (best) {
          setPi(best.index);
          setText(best.text);
        }
      },
      (e: Error) => setLoadErr(e.message),
    );
  }, [run.id, k.index]);

  const para = seg?.paragraphs.find((p) => p.index === pi);

  const play = (what: 'segment' | 'paragraph') => {
    const a = audio.current;
    if (!a || !seg) return;
    if (playing === what) {
      a.pause();
      setPlaying(undefined);
      return;
    }
    const [from, to] = what === 'segment' ? [seg.fromSec, seg.toSec] : [para!.startSec, para!.startSec + para!.durationSec];
    stopAt.current = to;
    a.currentTime = from;
    void a.play().then(() => setPlaying(what), () => setPlaying(undefined));
  };

  const send = async () => {
    if (pi === undefined || !para) return;
    // Locución en un solo pedido (ADR-133): se vuelve a pedir toda, para mantener el mismo tono en todos los párrafos.
    const whole = run.mode !== 'mcp';
    const allChars = run.paragraphs.reduce((n, p) => n + (p.index === pi ? text.trim().length : (p.spokenText ?? p.text).length), 0);
    const ok = await confirmSpend({
      title: 'Rehacer audio',
      body: whole
        ? 'Se vuelve a locutar toda la locución en un solo pedido (con tu corrección), para que el tono siga igual en todos los párrafos; después se rehacen el post y el render (sin clips nuevos).'
        : 'Se vuelve a locutar el párrafo completo y después se rehacen el post y el render (sin clips nuevos).',
      work: { ttsChars: whole ? allChars : text.trim().length, llm: instruction.trim() ? 1 : 0 },
      action: 'Rehacer audio',
    });
    if (!ok) return;
    setBusy(true);
    setErr(undefined);
    try {
      await api.revoice(run.id, pi, {
        text: text.trim() !== para.text ? text.trim() : undefined,
        instruction: instruction.trim() || undefined,
        saveRules: save,
      });
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const done = run.status === 'done';
  return (
    <Modal title={`Rehacer audio · ${kname(k)} · ${k.label.replace(/^K\d+ · /, '')}`} onClose={onClose}>
      {!seg ? (
        loadErr ? (
          <p className="text-destructive text-sm">{loadErr}</p>
        ) : (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> Cargando la locución…
          </p>
        )
      ) : (
        <div className="grid gap-4">
          <audio
            ref={audio}
            src={seg.voiceUrl}
            preload="auto"
            onTimeUpdate={(e) => {
              if (playing && e.currentTarget.currentTime >= stopAt.current) {
                e.currentTarget.pause();
                setPlaying(undefined);
              }
            }}
            onEnded={() => setPlaying(undefined)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => play('segment')}>
              {playing === 'segment' ? <Pause /> : <Play />} Escuchar este tramo · {fmt(seg.fromSec)}–{fmt(seg.toSec)}
            </Button>
            {para && (
              <Button variant="ghost" onClick={() => play('paragraph')}>
                {playing === 'paragraph' ? <Pause /> : <Play />} Párrafo {para.index + 1} completo
              </Button>
            )}
          </div>

          {seg.paragraphs.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {seg.paragraphs.map((p) => (
                <button
                  key={p.index}
                  type="button"
                  onClick={() => (setPi(p.index), setText(p.text))}
                  className={cn('cursor-pointer rounded-md border px-2.5 py-1 text-xs', p.index === pi ? 'border-primary bg-primary/10' : 'hover:border-white/20')}
                >
                  Párrafo {p.index + 1}
                </button>
              ))}
            </div>
          )}

          {para && (
            <div className="rounded-lg border bg-background/40 p-3 text-sm leading-relaxed">
              {para.words.map((w, i) => (
                <span key={i} className={cn(w.inSegment && 'bg-primary/20 text-foreground rounded px-0.5')}>
                  {w.word}{' '}
                </span>
              ))}
              <div className="text-muted-foreground mt-2 text-[11px]">
                Resaltado: lo que se escucha en este fotograma · locución v{para.version}
                {para.spokenText ? ` · la voz recibe: «${para.spokenText}»` : ''}
              </div>
            </div>
          )}

          <div className="grid gap-1.5">
            <label className="text-xs font-medium" htmlFor="revoice-text">
              Texto del párrafo <span className="text-muted-foreground font-normal">(si lo cambias, cambia también el texto del video)</span>
            </label>
            <Textarea id="revoice-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <label className="text-xs font-medium" htmlFor="revoice-instruction">
              ¿Qué sonó mal? <span className="text-muted-foreground font-normal">(opcional)</span>
            </label>
            <Textarea
              id="revoice-instruction"
              rows={3}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Por ejemplo: «pronunciaste mal IAAS, se dice letra por letra», «el número 2026 se lee dos mil veintiséis», «más pausa después de la coma»…"
            />
            <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs">
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} className="accent-primary" />
              Recordar las pronunciaciones corregidas para mis próximos videos (Mi cuenta → Pronunciaciones)
            </label>
          </div>
          {seg.rules.length > 0 && (
            <div className="text-muted-foreground text-[11px]">
              Reglas que ya se aplican: {seg.rules.map((r) => `«${r.match}» → «${r.say}»`).join(' · ')}
            </div>
          )}
          <p className="text-muted-foreground text-[11px]">
            {run.mode !== 'mcp'
              ? 'Se vuelve a locutar toda la locución en un solo pedido, con este párrafo corregido (la versión anterior se conserva).'
              : 'Se vuelve a locutar el párrafo completo (la versión anterior se conserva).'} Cambian los tiempos, pero no los fotogramas
            {done ? '; como el video está terminado, se rehacen el post y el render (final nuevo) sin regenerar clips' : ''}.
          </p>
          {err && <p className="text-destructive text-xs">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={send} disabled={busy || !para || text.trim().length < 2}>
              {busy ? <Loader2 className="animate-spin" /> : <AudioLines />} Rehacer audio
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
