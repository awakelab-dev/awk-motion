import { AlertTriangle, Bookmark, Copy, FlaskConical, Image as ImageIcon, Loader2, MessageSquareText, Power, PowerOff, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { themeOutOfSync, type AppInfo, type ThemeBrief, type ThemeCorrection, type ThemeDetail, type ThemeStyle } from '@wilox/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/textarea';
import { subscribeTheme, themesApi } from '@/lib/api';
import { confirmSpend } from '@/lib/spend';
import { cn } from '@/lib/utils';
import { Field, IMAGERY_OPTIONS, ReferencePicker, type PickedFile } from './NewThemeForm';
import { StyleEditor } from './StyleEditor';
import { TestCard } from './TestCard';
import { TypographyCard } from './TypographyCard';
import { Thumb } from './StudioView';

/** Costos orientativos (MCP, 2K high): imagen 2,75 · clip 10. */

export function ThemeWorkspace({
  id,
  info,
  onChanged,
  onDuplicate,
  onGone,
}: {
  id: string;
  info?: AppInfo;
  onChanged: () => void;
  onDuplicate: () => void;
  onGone: () => void;
}) {
  const [theme, setTheme] = useState<ThemeDetail>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let stop: (() => void) | undefined;
    themesApi.get(id).then(
      (t) => {
        setTheme(t);
        if (t.origin === 'custom') stop = subscribeTheme(id, setTheme, onGone);
      },
      (e: Error) => setError(e.message),
    );
    return () => stop?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // La lista de la izquierda refleja estado, versión y miniatura.
  useEffect(() => {
    if (theme) onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme?.status, theme?.version, theme?.thumbnailUrl, theme?.style.info.name]);

  if (error) return <Card className="self-start p-5 text-destructive text-xs">{error}</Card>;
  if (!theme) return <Loader2 className="text-muted-foreground m-10 size-5 animate-spin" />;

  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const opusBusy = !!theme.activity;
  const hasStyle = !!theme.style.imageBible;
  const tests = [...theme.tests].reverse();
  const mcp = info?.mode === 'mcp';
  // La descripción y las correcciones van siempre arriba (ADR-042). Los campos del estilo: sin pruebas,
  // antes de ellas; con pruebas, después.
  const editors = <StyleEditor theme={theme} disabled={opusBusy} />;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <Thumb t={theme} className="w-28" />
              <div className="min-w-0">
                <div className="truncate text-base font-semibold tracking-tight">{theme.style.info.name}</div>
                <div className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{theme.style.info.description}</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {theme.origin === 'base' ? (
                    <Badge variant="secondary">Tema base · solo lectura</Badge>
                  ) : theme.status === 'saved' ? (
                    <Badge variant="success">En "Mis temas"</Badge>
                  ) : (
                    <Badge variant="warning">Borrador</Badge>
                  )}
                  {theme.origin === 'custom' && <Badge variant="secondary">v{theme.version}</Badge>}
                  <Badge variant="secondary">{theme.style.usesMediaFrames ? 'Fotos/video reales' : 'Objetos / ilustración'}</Badge>
                  {theme.style.usesMediaFrames && theme.style.mediaFrameRule === 'byCount' && <Badge variant="secondary">Imágenes animadas según cuántas haya</Badge>}
                  {theme.style.flatColors && <Badge variant="secondary">Colores planos</Badge>}
                  {theme.basedOn && <Badge variant="secondary">Duplicado de {theme.basedOn}</Badge>}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={onDuplicate}>
                <Copy /> Duplicar
              </Button>
              {theme.origin === 'custom' && (
                <>
                  <Button size="sm" disabled={!hasStyle || opusBusy} onClick={() =>
                      void confirmSpend({
                        title: 'Probar el tema',
                        body: 'Se generan los 2 fotogramas de prueba (portada y enumeración) con el estilo del tema y el clip entre ellos; Opus revisa el resultado.',
                        work: { images: 2, clips: 1, llm: 1 },
                        action: 'Probar',
                      }).then((ok) => (ok ? act(() => themesApi.startTest(id, true)) : undefined))
                    }>
                    <FlaskConical /> Probar
                  </Button>
                  <Button size="sm" variant="outline" disabled={!hasStyle || opusBusy} onClick={() =>
                      void confirmSpend({
                        title: 'Probar el tema (solo frames)',
                        body: 'Se generan los 2 fotogramas de prueba (portada y enumeración) con el estilo del tema, sin clip; Opus los revisa.',
                        work: { images: 2, llm: 1 },
                        action: 'Probar',
                      }).then((ok) => (ok ? act(() => themesApi.startTest(id, false)) : undefined))
                    }>
                    <ImageIcon /> Solo frames
                  </Button>
                </>
              )}
            </div>
          </div>
          {opusBusy && (
            <div className="text-primary flex items-center gap-2 text-xs">
              <Loader2 className="size-3.5 animate-spin" /> {theme.activity}
            </div>
          )}
          {theme.proposalNotes && !opusBusy && (
            <div className={cn('rounded-lg border bg-background/40 p-3 text-xs leading-relaxed', theme.proposalNotes.startsWith('Error') && 'text-destructive')}>
              <span className="text-primary font-medium">Opus · </span>
              {theme.proposalNotes}
            </div>
          )}
          {error && <div className="text-destructive text-xs">{error}</div>}
          {theme.origin === 'custom' && <SavePanel theme={theme} />}
        </CardContent>
      </Card>

      {theme.origin === 'custom' && <BriefCard theme={theme} disabled={opusBusy} />}
      {theme.origin === 'custom' && <TypographyCard theme={theme} disabled={opusBusy} />}
      {!tests.length && editors}

      {theme.origin === 'custom' && (
        <div className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between">
            <div className="text-sm font-semibold tracking-tight">Pruebas</div>
            <div className="text-muted-foreground text-[11px]">Contenido estándar, igual para todos los temas · 2K · 24 fps</div>
          </div>
          {!tests.length && (
            <Card className="border-dashed bg-card/40">
              <CardContent className="text-muted-foreground text-xs">
                {hasStyle
                  ? 'Aún no hay pruebas. "Probar" genera el frame A (portada), el frame B (tres elementos) y la transición A→B con SFX.'
                  : 'Cuando Opus proponga el estilo podrás probarlo.'}
              </CardContent>
            </Card>
          )}
          {tests.map((t, i) => (
            <TestCard key={t.n} theme={theme} test={t} latest={i === 0} />
          ))}
        </div>
      )}
      {tests.length > 0 && editors}
      {theme.origin === 'base' && (
        <Card className="border-dashed bg-card/40">
          <CardContent className="text-muted-foreground text-xs">
            Los temas base no se prueban ni se editan aquí. Duplícalo para crear una variante y probarla.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Guardar en "Mis temas": nombre, descripción breve y miniatura (frame A de una prueba). */
function SavePanel({ theme }: { theme: ThemeDetail }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(theme.style.info.name);
  const [description, setDescription] = useState(theme.style.info.description);
  const withA = [...theme.tests].reverse().filter((t) => t.frames.find((f) => f.key === 'A')?.status === 'ready');
  const [thumb, setThumb] = useState<number | undefined>(theme.thumbnailTest ?? withA[0]?.n);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await themesApi.save(theme.id, { name: name.trim(), description: description.trim(), thumbnailTest: thumb });
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!open)
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant={theme.status === 'saved' ? 'secondary' : 'default'}
          disabled={!withA.length}
          onClick={() => {
            setName(theme.style.info.name);
            setDescription(theme.style.info.description);
            setThumb(theme.thumbnailTest ?? withA[0]?.n);
            setOpen(true);
          }}
        >
          <Bookmark /> {theme.status === 'saved' ? 'Actualizar en Mis temas' : 'Guardar en Mis temas'}
        </Button>
        {!withA.length && <span className="text-muted-foreground text-[11px]">Haz al menos una prueba para poder guardarlo.</span>}
        {theme.status === 'saved' && <span className="text-muted-foreground text-[11px]">Ya aparece en el selector de temas de Generar.</span>}
      </div>
    );

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-background/40 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nombre">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="h-9 text-sm" />
        </Field>
        <Field label="Descripción breve">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={160} className="h-9 text-sm" />
        </Field>
      </div>
      <Field label="Miniatura (frame A)">
        <div className="flex flex-wrap gap-2">
          {withA.map((t) => {
            const a = t.frames.find((f) => f.key === 'A')!;
            return (
              <button
                key={t.n}
                type="button"
                onClick={() => setThumb(t.n)}
                className={cn('aspect-video w-32 cursor-pointer overflow-hidden rounded-md border', thumb === t.n && 'ring-primary ring-2')}
                title={`Prueba ${t.n}`}
              >
                <img src={a.url} alt={`Prueba ${t.n}`} className="size-full object-cover" />
              </button>
            );
          })}
        </div>
      </Field>
      {error && <div className="text-destructive text-xs">{error}</div>}
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={saving || name.trim().length < 2 || description.trim().length < 3}>
          {saving ? <Loader2 className="animate-spin" /> : <Bookmark />} Guardar
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

/**
 * Descripción, referencias y correcciones del tema (ADR-042). Las correcciones quedan en un historial:
 * mandan sobre la descripción cuando se contradicen y se pueden desactivar o eliminar. Si la descripción,
 * las correcciones o las referencias cambian, el tema queda pendiente de regenerar.
 */
/** Animación de las imágenes (ADR-080): ajuste del tema que elige el usuario; Opus no lo propone. */
const FLAT_OPTIONS: { value: boolean; label: string }[] = [
  { value: false, label: 'Tal como salen' },
  { value: true, label: 'Aplanar colores' },
];
const MEDIA_RULE_OPTIONS: { value: NonNullable<ThemeStyle['mediaFrameRule']>; label: string }[] = [
  { value: 'opus', label: 'La decide Opus' },
  { value: 'byCount', label: 'Según cuántas haya' },
];

function BriefCard({ theme, disabled }: { theme: ThemeDetail; disabled: boolean }) {
  const brief = theme.brief!;
  const [draft, setDraft] = useState<ThemeBrief>(brief);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!dirty) setDraft(theme.brief!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme.brief]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const set = <K extends keyof ThemeBrief>(k: K, v: ThemeBrief[K]) => (setDraft((d) => ({ ...d, [k]: v })), setDirty(true));
  const saveBrief = async () => {
    await themesApi.update(theme.id, { brief: draft });
    setDirty(false);
  };
  const hasStyle = !!theme.style.imageBible;
  const off = disabled || !!busy;
  const corrections = brief.corrections ?? [];
  const pending = hasStyle && themeOutOfSync(brief, theme.references.map((r) => r.file));
  const regenerate = () =>
    void confirmSpend({
      title: 'Regenerar el tema',
      body: 'Opus vuelve a escribir la propuesta del tema con la descripción, las referencias y las correcciones.',
      work: { llm: 1 },
      action: 'Regenerar',
    }).then((ok) => (ok ? run('propose', async () => (dirty && (await saveBrief()), await themesApi.propose(theme.id))) : undefined));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Descripción, referencias y correcciones</CardTitle>
        <CardDescription>
          Lo que Opus usa para proponer el tema. Las correcciones mandan sobre la descripción cuando se contradicen, y la más reciente manda sobre las
          anteriores. Las referencias también van a GPT Image (máx. 4) en las pruebas y en los videos.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {pending && (
          <div className="border-warning/40 bg-warning/10 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-xs">
            <div className="text-warning flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                La descripción, las correcciones o las referencias cambiaron después de la v{brief.applied!.version}: el tema aún no
                refleja esos cambios. Regenéralo antes de la próxima prueba.
              </span>
            </div>
            <Button size="sm" disabled={off} onClick={regenerate}>
              {busy === 'propose' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Regenerar tema (v{theme.version + 1})
            </Button>
          </div>
        )}

        <Field label="Descripción detallada del estilo">
          <Textarea value={draft.description} onChange={(e) => set('description', e.target.value)} className="min-h-28" disabled={off} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Paleta" hint="Opcional">
            <Input value={draft.palette ?? ''} onChange={(e) => set('palette', e.target.value || undefined)} className="h-9 text-sm" disabled={off} />
          </Field>
          <Field label="Tipografía" hint="Opcional">
            <Input value={draft.typography ?? ''} onChange={(e) => set('typography', e.target.value || undefined)} className="h-9 text-sm" disabled={off} />
          </Field>
        </div>
        <Field label="Imágenes en los fotogramas" hint="Interruptor fijo: las correcciones no lo cambian">
          <div className="flex flex-wrap gap-2">
            {IMAGERY_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                disabled={off}
                onClick={() => set('imageryMode', o.value)}
                className={cn('cursor-pointer rounded-full border px-3 py-1 text-[11px]', draft.imageryMode === o.value ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground')}
              >
                {o.label}
              </button>
            ))}
          </div>
        </Field>
        {theme.style.usesMediaFrames && (
          <Field label="Animación de las imágenes" hint="Se guarda al elegir; no regenera el tema">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                {MEDIA_RULE_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    disabled={off || busy === 'rule'}
                    onClick={() =>
                      (theme.style.mediaFrameRule ?? 'opus') !== o.value &&
                      void run('rule', () => themesApi.update(theme.id, { style: { ...theme.style, mediaFrameRule: o.value } }))
                    }
                    className={cn(
                      'cursor-pointer rounded-full border px-3 py-1 text-[11px]',
                      (theme.style.mediaFrameRule ?? 'opus') === o.value ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {o.label}
                  </button>
                ))}
                {busy === 'rule' && <Loader2 className="size-3.5 animate-spin self-center" />}
              </div>
              <p className="text-muted-foreground text-[11px] leading-relaxed">
                {(theme.style.mediaFrameRule ?? 'opus') === 'byCount'
                  ? 'De izquierda a derecha (o de arriba abajo): 1 imagen → video · 2 → video + foto · 3 → video + foto + video · 4 → todas fotos. La app lo fija en cada fotograma. Rige en los videos nuevos.'
                  : 'Opus decide en cada fotograma qué imágenes son video y cuáles foto, según las notas del estilo.'}
              </p>
            </div>
          </Field>
        )}
        {hasStyle && (
          <Field label="Colores planos" hint="Se guarda al elegir; no regenera el tema">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                {FLAT_OPTIONS.map((o) => (
                  <button
                    key={String(o.value)}
                    type="button"
                    disabled={off || busy === 'flat'}
                    onClick={() =>
                      !!theme.style.flatColors !== o.value &&
                      void run('flat', () => themesApi.update(theme.id, { style: { ...theme.style, flatColors: o.value || undefined } }))
                    }
                    className={cn(
                      'cursor-pointer rounded-full border px-3 py-1 text-[11px]',
                      !!theme.style.flatColors === o.value ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {o.label}
                  </button>
                ))}
                {busy === 'flat' && <Loader2 className="size-3.5 animate-spin self-center" />}
              </div>
              <p className="text-muted-foreground text-[11px] leading-relaxed">
                {theme.style.flatColors
                  ? 'Cada fotograma nuevo o regenerado (también en los videos ya hechos con este tema y en las pruebas) se alisa al generarse: las letras gruesas, los fondos y las bandas de un solo color quedan sin el moteado que deja el generador de imágenes. Las fotos y los bordes no cambian. Sin costo.'
                  : 'Los fotogramas quedan tal como los entrega el generador de imágenes. Actívalo si las letras grandes o los fondos de un solo color salen con manchas o textura.'}
              </p>
            </div>
          </Field>
        )}
        {dirty && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" disabled={off} onClick={() => void run('brief', saveBrief)}>
              Guardar descripción
            </Button>
            {hasStyle && (
              <Button size="sm" disabled={off} onClick={regenerate}>
                <RefreshCw /> Guardar y regenerar tema
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => (setDraft(brief), setDirty(false))}>
              Descartar
            </Button>
          </div>
        )}

        <div className="flex flex-col gap-3 rounded-lg border bg-background/40 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-xs font-medium">Correcciones ({corrections.length})</div>
            <div className="text-muted-foreground text-[11px]">Mandan sobre la descripción · la más reciente manda</div>
          </div>
          {corrections.length === 0 && <div className="text-muted-foreground text-[11px]">Aún no hay correcciones.</div>}
          <ol className="flex flex-col gap-2">
            {corrections.map((c) => (
              <CorrectionItem
                key={c.id}
                c={c}
                n={corrections.filter((x) => x.active).findIndex((x) => x.id === c.id) + 1}
                disabled={off}
                onToggle={() => void run('toggle', () => themesApi.setCorrectionActive(theme.id, c.id, !c.active))}
                onRemove={() => confirm('¿Eliminar esta corrección del historial? El tema quedará pendiente de regenerar.') && void run('remove', () => themesApi.removeCorrection(theme.id, c.id))}
              />
            ))}
          </ol>
          <Field label="Nueva corrección" hint={hasStyle ? 'Opus la aplica sobre el tema actual (versión nueva)' : 'Se aplicará al diseñar el tema'}>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Más contraste en los títulos, fondo menos saturado, acento en coral…"
              disabled={off}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={off || note.trim().length < 3}
              onClick={() =>
                // Opus aplica la corrección (ADR-069: aviso de gasto, como «Regenerar»).
                void confirmSpend({
                  title: 'Añadir y aplicar la corrección',
                  body: pending
                    ? 'El tema tiene cambios sin regenerar: Opus lo rehace desde la descripción y todas las correcciones activas, incluida esta (versión nueva).'
                    : 'Opus aplica esta corrección sobre el tema actual y conserva el resto (versión nueva).',
                  work: { llm: 1 },
                  action: 'Añadir y aplicar',
                }).then((ok) => (ok ? run('note', async () => (dirty && (await saveBrief()), await themesApi.addCorrection(theme.id, note.trim()), setNote(''))) : undefined))
              }
            >
              {busy === 'note' ? <Loader2 className="animate-spin" /> : <MessageSquareText />} Añadir y aplicar
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={off}
              onClick={() =>
                (!hasStyle || confirm('Opus rehará el tema desde la descripción y todas las correcciones activas (versión nueva; las anteriores quedan en las pruebas). ¿Continuar?')) &&
                regenerate()
              }
            >
              <RefreshCw /> {hasStyle ? 'Regenerar desde la descripción y las correcciones' : 'Pedir propuesta a Opus'}
            </Button>
          </div>
        </div>
        <Field label={`Referencias (${theme.references.length})`}>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
            {theme.references.map((r, i) => (
              <div key={r.file} className="group relative aspect-square overflow-hidden rounded-lg border" title={r.originalName}>
                <img src={r.url} alt={r.originalName} className="size-full object-cover" />
                {i < 4 && <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[9px]">GPT</span>}
                <button
                  type="button"
                  disabled={off}
                  className="absolute top-1 right-1 grid size-6 cursor-pointer place-items-center rounded-full bg-black/70 opacity-0 group-hover:opacity-100"
                  onClick={() => void run('ref', () => themesApi.removeReference(theme.id, r.file))}
                  title="Quitar"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            ))}
          </div>
        </Field>
        <ReferencePicker files={files} onChange={setFiles} disabled={off} compact />
        {files.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            className="self-start"
            disabled={off}
            onClick={() => void run('upload', async () => (await themesApi.addReferences(theme.id, files), setFiles([])))}
          >
            {busy === 'upload' ? <Loader2 className="animate-spin" /> : <Upload />} Subir {files.length} referencia{files.length > 1 ? 's' : ''}
          </Button>
        )}

        {error && <div className="text-destructive text-xs">{error}</div>}
      </CardContent>
    </Card>
  );
}

/** Una corrección del historial: estado, cómo la aplicó Opus, activar/desactivar y eliminar. */
function CorrectionItem({
  c,
  n,
  disabled,
  onToggle,
  onRemove,
}: {
  c: ThemeCorrection;
  n: number;
  disabled: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const date = new Date(c.createdAt).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return (
    <li className={cn('flex flex-col gap-1.5 rounded-md border p-2.5', !c.active && 'opacity-60')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-xs leading-relaxed">
          {c.active && <span className="text-muted-foreground mr-1.5 font-mono">#{n}</span>}
          <span className={cn(!c.active && 'line-through')}>{c.text}</span>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2" disabled={disabled} onClick={onToggle} title={c.active ? 'Desactivar' : 'Activar'}>
            {c.active ? <PowerOff /> : <Power />}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" disabled={disabled} onClick={onRemove} title="Eliminar">
            <Trash2 />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground text-[10px]">{date}</span>
        {!c.active ? (
          <Badge variant="secondary">Desactivada</Badge>
        ) : c.appliedInVersion ? (
          <Badge variant="success">Aplicada en v{c.appliedInVersion}</Badge>
        ) : (
          <Badge variant="warning">Pendiente</Badge>
        )}
      </div>
      {c.how && c.active && (
        <div className="text-muted-foreground text-[11px] leading-relaxed">
          <span className="text-primary font-medium">Opus · </span>
          {c.how}
        </div>
      )}
    </li>
  );
}
