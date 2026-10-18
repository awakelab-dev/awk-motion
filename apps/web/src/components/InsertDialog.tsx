import { AlertTriangle, Film, Loader2, Plus, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { InsertFit, InsertVoice, RunState } from '@wilox/shared';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { confirmSpend, useCostText } from '@/lib/spend';
import { cn } from '@/lib/utils';

const FPS = 24;
const MAX_BYTES = 60 * 1024 * 1024;
const nn = (i: number) => String(i).padStart(2, '0');
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const FITS: { id: InsertFit; title: string; hint: string }[] = [
  { id: 'contain', title: 'Con bandas', hint: 'Se ve entero, con franjas negras a los lados o arriba y abajo.' },
  { id: 'cover', title: 'Recortar', hint: 'Llena el cuadro 16:9; se pierde lo que sobra en los bordes.' },
  { id: 'stretch', title: 'Estirar', hint: 'Llena el cuadro deformando la imagen.' },
];

const toBase64 = (f: File) =>
  new Promise<string>((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => ko(r.error);
    r.readAsDataURL(f);
  });

interface Probe {
  url: string;
  width: number;
  height: number;
  duration: number;
  /** El navegador no lo pudo leer (p. ej. ProRes): se revisa en el servidor al subirlo. */
  unknown?: boolean;
}

/**
 * Insertar un clip (ADR-073): generado por MiniMax del fotograma Kn al mismo Kn (en cualquier posición) o un
 * video subido como portada o cierre (solo al principio o al final), con pausa en la voz o un texto locutado.
 * Muestra el efecto en el video y, en un video subido, avisa si su tamaño o proporción no son las del video.
 */
export function InsertDialog({ run, onClose }: { run: RunState; onClose: () => void }) {
  const n = run.clips.length;
  const clipCost = useCostText({ clips: 1 });
  const [kind, setKind] = useState<'generated' | 'upload'>('generated');
  const [after, setAfter] = useState(Math.min(1, n));
  const [note, setNote] = useState('');
  const [voice, setVoice] = useState<InsertVoice>('pause');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File>();
  const [probe, setProbe] = useState<Probe>();
  const [trim, setTrim] = useState<[number, number]>([0, 0]);
  const [fit, setFit] = useState<InsertFit>('contain');
  const [keepAudio, setKeepAudio] = useState(true);
  // Transición animada de 2 s con el clip vecino (ADR-074/075): marcada por defecto.
  const [transition, setTransition] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const preview = useRef<HTMLVideoElement>(null);

  // Un video subido solo va al principio o al final.
  useEffect(() => {
    if (kind === 'upload' && after !== 0 && after !== n) setAfter(0);
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => probe && URL.revokeObjectURL(probe.url), [probe]);

  const pick = (f: File | undefined) => {
    setError(undefined);
    setProbe(undefined);
    setFile(f);
    if (!f) return;
    if (f.size > MAX_BYTES) return setError(`El video pesa ${(f.size / 1048576).toFixed(0)} MB; el máximo es 60 MB. Recórtalo o comprímelo antes de subirlo.`);
    const url = URL.createObjectURL(f);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      setProbe({ url, width: v.videoWidth, height: v.videoHeight, duration: v.duration });
      setTrim([0, Math.round(v.duration * 100) / 100]);
    };
    // Sin vista previa (el navegador no lo decodifica): se sube igual y el servidor lo revisa con ffprobe.
    v.onerror = () => {
      setProbe({ url, width: 0, height: 0, duration: 0, unknown: true });
      setTrim([0, 0]);
    };
    v.src = url;
  };

  const k = run.keyframes.find((x) => x.index === after);
  const where = after === 0 ? 'al principio' : after === n ? 'al final' : `entre clip${nn(after)} y clip${nn(after + 1)}`;
  const ownSec = kind === 'generated' ? 124 / FPS : (probe?.unknown ? 0 : Math.max(0, trim[1] - trim[0])) + (transition ? 48 / FPS : 0); // la transición entra recortada a 2 s (ADR-075)
  // La locución dura ≈ 15 caracteres por segundo (se mide al locutarla); el inserto dura al menos eso.
  const voiceSec = voice === 'text' ? text.trim().length / 15 : 0;
  const addSec = Math.max(ownSec, voice === 'text' ? voiceSec + 0.7 : 0);
  const totalSec = (run.finalFrames ?? run.totalFrames ?? 0) / FPS;

  const warnings = useMemo(() => {
    if (!probe) return [];
    const w: string[] = [];
    const ratio = probe.width / probe.height;
    if (Math.abs(ratio - 16 / 9) > 0.01) w.push(`Su proporción es ${probe.width}×${probe.height} (${ratio.toFixed(2)}:1) y la del video es 16:9: elige cómo acomodarlo.`);
    if (probe.width < 2560 || probe.height < 1440) w.push(`Es más chico que el video (2560×1440): se amplía y puede verse menos nítido.`);
    w.push('Se convierte a 24 cuadros por segundo y se vuelve a codificar con la calidad del video.');
    return w;
  }, [probe]);
  const ratioOff = !!probe && Math.abs(probe.width / probe.height - 16 / 9) > 0.01;

  const submit = async () => {
    setError(undefined);
    if (voice === 'text' && !text.trim()) return setError('Escribe el texto que se locuta durante el inserto.');
    if (kind === 'upload' && (!file || !probe)) return setError('Elige el video que quieres subir.');
    if (kind === 'upload' && !probe?.unknown && trim[1] - trim[0] < 0.5) return setError('El tramo elegido dura menos de medio segundo.');
    const withTransition = kind === 'upload' && transition;
    const spends = kind === 'generated' || voice === 'text' || withTransition;
    if (spends) {
      const ok = await confirmSpend({
        title: kind === 'generated' ? 'Insertar un clip generado' : 'Subir el video con locución',
        body: `${kind === 'generated' ? `Se genera un clip ${where} que parte y termina en ${k ? `K${nn(k.index)}` : 'el fotograma'}` : `Se agrega el video ${where}`}${withTransition ? `, se genera una transición de 2 s ${after === 0 ? 'hacia el clip01' : 'desde el último clip'}` : ''}${voice === 'text' ? ', se locuta el texto' : ''} y se vuelve a unir el final.`,
        work: { clips: kind === 'generated' || withTransition ? 1 : 0, ttsChars: voice === 'text' ? text.trim().length : 0 },
        action: kind === 'generated' ? 'Insertar clip' : 'Subir',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.addInsert(run.id, {
        kind,
        after,
        voice,
        text: voice === 'text' ? text.trim() : undefined,
        note: kind === 'generated' ? note.trim() || undefined : undefined,
        ...(kind === 'upload'
          ? { fileName: file!.name, data: await toBase64(file!), trimStart: trim[0], trimEnd: probe?.unknown && !trim[1] ? undefined : trim[1], fit, keepAudio, transition }
          : {}),
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const opt = (active: boolean) => cn('cursor-pointer rounded-lg border p-3 text-left', active ? 'border-primary bg-primary/10' : 'hover:border-white/20');
  return (
    <Modal title="Insertar un clip o subir un video" onClose={onClose} className="max-w-5xl">
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="grid min-w-0 content-start gap-4 text-xs">
          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" className={opt(kind === 'generated')} onClick={() => setKind('generated')}>
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Film className="size-4" /> Generar un clip
              </div>
              <div className="text-muted-foreground mt-0.5 text-[11px]">En cualquier posición: parte y termina en el mismo fotograma (el final del clip anterior, que es el inicio del siguiente).</div>
            </button>
            <button type="button" className={opt(kind === 'upload')} onClick={() => setKind('upload')}>
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Upload className="size-4" /> Subir un video
              </div>
              <div className="text-muted-foreground mt-0.5 text-[11px]">Una portada o un cierre: solo al principio o al final. MP4, MOV o WebM, hasta 60 MB.</div>
            </button>
          </div>

          <label className="grid gap-1">
            <span className="font-medium">Dónde</span>
            <select value={after} onChange={(e) => setAfter(Number(e.target.value))} className="border-input bg-background/60 h-9 cursor-pointer rounded-md border px-2">
              {Array.from({ length: n + 1 }, (_, i) => i)
                .filter((i) => kind === 'generated' || i === 0 || i === n)
                .map((i) => (
                  <option key={i} value={i}>
                    {i === 0 ? `Al principio (antes de clip01)${kind === 'upload' ? ' · portada' : ''}` : i === n ? `Al final (después de clip${nn(n)})${kind === 'upload' ? ' · cierre' : ''}` : `Entre clip${nn(i)} y clip${nn(i + 1)}`}
                  </option>
                ))}
            </select>
          </label>

          {kind === 'generated' ? (
            <div className="grid gap-2 sm:grid-cols-[220px_1fr]">
              <div className="grid gap-1">
                {k?.url && <img src={k.url} alt="" className="aspect-video w-full rounded-md border object-cover" />}
                <span className="text-muted-foreground text-[11px]">Empieza y termina en K{nn(after)}{k ? ` · ${k.label.replace(/^K\d+ · /, '')}` : ''}.</span>
              </div>
              <label className="grid content-start gap-1">
                <span className="font-medium">Qué movimiento debe tener (opcional)</span>
                <Textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Por ejemplo: «un destello recorre el título y los íconos laten suavemente». Vacío = movimiento sutil sobre la misma composición." />
              </label>
            </div>
          ) : (
            <div className="grid gap-2">
              <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed p-3 hover:border-white/30">
                <Upload className="text-primary size-4" />
                <span className="min-w-0 flex-1 truncate">{file ? `${file.name} · ${(file.size / 1048576).toFixed(1)} MB` : 'Elige el video (MP4, MOV o WebM)'}</span>
                <input type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
              </label>
              {probe?.unknown && (
                <div className="border-warning/30 bg-warning/10 grid gap-2 rounded-md border p-2">
                  <div className="text-warning flex items-start gap-1.5">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> Este navegador no puede mostrar el video (¿ProRes u otro códec?). Se sube igual: el servidor revisa su
                    tamaño y proporción y lo convierte. Indica el tramo a mano (0 en «Hasta» = hasta el final) y cómo acomodarlo si no es 16:9.
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {(['Desde', 'Hasta'] as const).map((label, i) => (
                      <label key={label} className="grid gap-1">
                        <span className="text-muted-foreground">{label} (s)</span>
                        <input
                          type="number"
                          min={0}
                          step={0.1}
                          value={trim[i]}
                          onChange={(e) => {
                            const v = Math.max(0, Number(e.target.value) || 0);
                            setTrim((t) => (i === 0 ? [v, t[1]] : [t[0], v]));
                          }}
                          className="border-input bg-background/60 h-8 rounded-md border px-2"
                        />
                      </label>
                    ))}
                  </div>
                  <div className="grid gap-1.5 sm:grid-cols-3">
                    {FITS.map((f) => (
                      <button key={f.id} type="button" className={opt(fit === f.id)} onClick={() => setFit(f.id)}>
                        <div className="font-medium">{f.title}</div>
                        <div className="text-muted-foreground text-[11px]">{f.hint}</div>
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={keepAudio} onChange={(e) => setKeepAudio(e.target.checked)} /> Conservar su audio, si tiene
                  </label>
                </div>
              )}
              {probe && !probe.unknown && (
                <>
                  <video ref={preview} src={probe.url} controls playsInline className="aspect-video w-full rounded-md border bg-black object-contain" />
                  <div className="grid grid-cols-2 gap-2">
                    {(['Desde', 'Hasta'] as const).map((label, i) => (
                      <label key={label} className="grid gap-1">
                        <span className="text-muted-foreground">
                          {label} (s) · <button type="button" className="text-primary cursor-pointer hover:underline" onClick={() => preview.current && setTrim((t) => (i === 0 ? [Math.min(preview.current!.currentTime, t[1]), t[1]] : [t[0], Math.max(preview.current!.currentTime, t[0])]))}>usar la posición actual</button>
                        </span>
                        <input
                          type="number"
                          min={0}
                          max={probe.duration}
                          step={0.1}
                          value={trim[i]}
                          onChange={(e) => {
                            const v = Math.max(0, Math.min(probe.duration, Number(e.target.value) || 0));
                            setTrim((t) => (i === 0 ? [v, Math.max(v, t[1])] : [Math.min(t[0], v), v]));
                          }}
                          className="border-input bg-background/60 h-8 rounded-md border px-2"
                        />
                      </label>
                    ))}
                  </div>
                  <div className="text-muted-foreground text-[11px]">
                    {probe.width}×{probe.height} · {fmt(probe.duration)} · se usa de {fmt(trim[0])} a {fmt(trim[1])} ({(trim[1] - trim[0]).toFixed(1)} s)
                  </div>
                  {warnings.length > 0 && (
                    <div className="border-warning/30 bg-warning/10 grid gap-1 rounded-md border p-2">
                      {warnings.map((w) => (
                        <div key={w} className="text-warning flex items-start gap-1.5">
                          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {w}
                        </div>
                      ))}
                    </div>
                  )}
                  {ratioOff && (
                    <div className="grid gap-1.5 sm:grid-cols-3">
                      {FITS.map((f) => (
                        <button key={f.id} type="button" className={opt(fit === f.id)} onClick={() => setFit(f.id)}>
                          <div className="font-medium">{f.title}</div>
                          <div className="text-muted-foreground text-[11px]">{f.hint}</div>
                        </button>
                      ))}
                    </div>
                  )}
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={keepAudio} onChange={(e) => setKeepAudio(e.target.checked)} /> Conservar su audio (normalizado; la música de fondo sigue debajo)
                  </label>
                </>
              )}
            </div>
          )}
        </div>

        <div className="grid min-w-0 content-start gap-4 text-xs">
          <section className="grid gap-2">
            <div className="font-medium">Locución durante el inserto</div>
            <button type="button" className={opt(voice === 'pause')} onClick={() => setVoice('pause')}>
              <div className="font-medium">Pausa en la voz</div>
              <div className="text-muted-foreground text-[11px]">La voz se detiene y sigue después del inserto; la música continúa.</div>
            </button>
            <button type="button" className={opt(voice === 'text')} onClick={() => setVoice('text')}>
              <div className="font-medium">Texto nuevo locutado</div>
              <div className="text-muted-foreground text-[11px]">Con la misma voz; el inserto dura lo que dure la locución (si es más larga que el clip, se congela su último cuadro).</div>
            </button>
            {voice === 'text' && <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Lo que se dice durante el inserto." />}
          </section>

          {kind === 'upload' && (
            <label className={cn(opt(transition), 'flex gap-2')}>
              <input type="checkbox" checked={transition} onChange={(e) => setTransition(e.target.checked)} className="mt-0.5" />
              <span>
                <span className="font-medium">Transición animada de 2 s</span>
                <span className="text-muted-foreground block text-[11px]">
                  {after === 0
                    ? 'Después de la portada: los elementos de su último cuadro salen deslizándose mientras entran los del primer fotograma del clip01 (sin deformar logos). Se genera ya, en paralelo con los clips.'
                    : 'Antes del cierre: los elementos del último clip salen deslizándose mientras entran los del cierre (sin deformar logos). Empieza en cuanto esté el último clip.'}{' '}
                  Solo cambia este inserto{clipCost ? ` (${clipCost})` : ''}. Después se puede desactivar y volver a activar desde la tarjeta del inserto, sin gastar.
                </span>
              </span>
            </label>
          )}

          <section className="border-warning/30 bg-warning/10 grid gap-1 rounded-md border p-2.5">
            <div className="text-warning flex items-center gap-1.5 font-medium">
              <AlertTriangle className="size-3.5" /> Qué cambia en el video
            </div>
            <div>
              Se agrega {where}: el video pasa de {fmt(totalSec)} a ≈ {fmt(totalSec + addSec)}.
            </div>
            <div className="text-muted-foreground text-[11px]">
              {voice === 'pause' ? 'La voz se pausa en ese punto (en el silencio entre frases más cercano)' : 'La voz se pausa en ese punto y entra la locución del inserto'}; los subtítulos y todo lo que sigue se corren, la
              música sigue, y el logo y la portada siguen a su clip. Se vuelve a unir el final (el anterior se conserva). El inserto se puede quitar después.
            </div>
          </section>

          {error && <div className="text-destructive">{error}</div>}
          <Button onClick={() => void submit()} disabled={busy || (kind === 'upload' && !probe)}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />} {kind === 'generated' ? 'Insertar clip' : 'Subir y agregar'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
