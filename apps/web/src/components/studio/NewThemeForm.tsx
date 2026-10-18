import { ImagePlus, Loader2, Sparkles, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ThemeBrief, ThemeDetail } from '@wilox/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/textarea';
import { imageToDataUrl, themesApi } from '@/lib/api';
import { confirmSpend } from '@/lib/spend';
import { cn } from '@/lib/utils';

export const IMAGERY_OPTIONS: { value: ThemeBrief['imageryMode']; label: string; hint: string }[] = [
  { value: 'auto', label: 'Que lo decida Opus', hint: 'según la descripción y las referencias' },
  { value: 'photos', label: 'Fotos y video reales', hint: 'en marcos, con la alternancia video/foto' },
  { value: 'objects', label: 'Solo objetos o ilustración', hint: 'sin fotos realistas' },
];

export interface PickedFile {
  name: string;
  data: string;
}

/** Selector de imágenes de referencia (varias), reducidas en el navegador antes de subirlas. */
export function ReferencePicker({
  files,
  onChange,
  disabled,
  compact,
}: {
  files: PickedFile[];
  onChange: (f: PickedFile[]) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [reading, setReading] = useState(false);
  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    setReading(true);
    try {
      const picked = await Promise.all(
        [...list].filter((f) => f.type.startsWith('image/')).map(async (f) => ({ name: f.name, data: await imageToDataUrl(f) })),
      );
      onChange([...files, ...picked].slice(0, 12));
    } finally {
      setReading(false);
    }
  };
  return (
    <div className={cn('grid gap-2', compact ? 'grid-cols-4 sm:grid-cols-6' : 'grid-cols-3 sm:grid-cols-4')}>
      {files.map((f, i) => (
        <div key={i} className="group relative aspect-square overflow-hidden rounded-lg border">
          <img src={f.data} alt={f.name} className="size-full object-cover" />
          <button
            type="button"
            className="absolute top-1 right-1 grid size-6 cursor-pointer place-items-center rounded-full bg-black/70 opacity-0 group-hover:opacity-100"
            onClick={() => onChange(files.filter((_, k) => k !== i))}
            title="Quitar"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <label
        className={cn(
          'text-muted-foreground hover:text-foreground flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-[11px] transition-colors',
          disabled && 'pointer-events-none opacity-50',
        )}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => (e.preventDefault(), void add(e.dataTransfer.files))}
      >
        {reading ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
        Añadir
        <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => (void add(e.target.files), (e.target.value = ''))} />
      </label>
    </div>
  );
}

export function NewThemeForm({ onCreated }: { onCreated: (t: ThemeDetail) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [palette, setPalette] = useState('');
  const [typography, setTypography] = useState('');
  const [imageryMode, setImageryMode] = useState<ThemeBrief['imageryMode']>('auto');
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [step, setStep] = useState<string>();
  const [error, setError] = useState<string>();

  const valid = name.trim().length >= 2 && description.trim().length >= 20;

  const submit = async () => {
    const ok = await confirmSpend({
      title: 'Crear el tema',
      body: 'Opus escribe la propuesta del tema (style bible) con la descripción y las referencias.',
      work: { llm: 1 },
      action: 'Crear tema',
    });
    if (!ok) return;
    setError(undefined);
    try {
      setStep('Creando el tema…');
      let t = await themesApi.create({
        name: name.trim(),
        description: description.trim(),
        palette: palette.trim() || undefined,
        typography: typography.trim() || undefined,
        imageryMode,
      });
      if (files.length) {
        setStep(`Subiendo ${files.length} referencia${files.length > 1 ? 's' : ''}…`);
        t = await themesApi.addReferences(t.id, files);
      }
      setStep('Pidiendo la propuesta a Opus…');
      t = await themesApi.propose(t.id);
      onCreated(t);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStep(undefined);
    }
  };

  return (
    <Card className="self-start">
      <CardHeader>
        <CardTitle>Nuevo tema</CardTitle>
        <CardDescription>
          Describe el estilo con detalle y añade imágenes de referencia. Opus propone el tema completo; después lo pruebas con el contenido
          estándar y lo guardas en "Mis temas".
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field label="Nombre">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acuarela editorial" maxLength={60} className="h-9 text-sm" />
        </Field>
        <Field label="Descripción detallada del estilo" hint={`${description.trim().length} caracteres · mínimo 20`}>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-40"
            placeholder="Fondo de papel de acuarela con textura, manchas de color que se expanden al entrar cada elemento, tipografía sans geométrica limpia en azul tinta, ilustraciones a mano con contorno fino…"
          />
        </Field>
        <Field label="Imágenes de referencia" hint="Opcional · hasta 12 · Opus las usa para el estilo y GPT Image como referencia (máx. 4)">
          <ReferencePicker files={files} onChange={setFiles} disabled={!!step} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Paleta" hint="Opcional">
            <Input value={palette} onChange={(e) => setPalette(e.target.value)} placeholder="#0E2A47, #F4EDE1, coral #EE8C7A…" className="h-9 text-sm" />
          </Field>
          <Field label="Tipografía" hint="Opcional">
            <Input value={typography} onChange={(e) => setTypography(e.target.value)} placeholder="Sans geométrica bold, sin serif" className="h-9 text-sm" />
          </Field>
        </div>
        <Field label="Imágenes en los fotogramas">
          <div className="grid gap-2 sm:grid-cols-3">
            {IMAGERY_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => setImageryMode(o.value)}
                className={cn(
                  'cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors',
                  imageryMode === o.value ? 'border-primary bg-primary/5' : 'hover:bg-accent/60',
                )}
              >
                <div className="text-xs font-medium">{o.label}</div>
                <div className="text-muted-foreground text-[11px]">{o.hint}</div>
              </button>
            ))}
          </div>
        </Field>
        {error && <div className="text-destructive rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs">{error}</div>}
        <Button size="lg" onClick={submit} disabled={!valid || !!step}>
          {step ? <Loader2 className="animate-spin" /> : <Sparkles />} {step ?? 'Crear y pedir la propuesta a Opus'}
        </Button>
      </CardContent>
    </Card>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs font-medium">{label}</div>
        {hint && <div className="text-muted-foreground text-[11px]">{hint}</div>}
      </div>
      {children}
    </div>
  );
}
