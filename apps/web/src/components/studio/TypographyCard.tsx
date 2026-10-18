import { AlertTriangle, Loader2, RefreshCw, Trash2, Type, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { MAX_TYPEFACES, type ThemeDetail, type Typeface, type TypefaceRole } from '@wilox/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/textarea';
import { themesApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Field } from './NewThemeForm';

const ROLES: { value: TypefaceRole; label: string }[] = [
  { value: 'headings', label: 'Titulares' },
  { value: 'body', label: 'Texto' },
  { value: 'both', label: 'Todo' },
];
const WEIGHTS: [number, string][] = [
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'SemiBold'],
  [700, 'Bold'],
  [800, 'ExtraBold'],
  [900, 'Black'],
];

const sheetUrl = (themeId: string, f: Typeface) => `/api/themes/${themeId}/files/tipografias/${f.sheet}?v=${encodeURIComponent(f.updatedAt)}`;

/**
 * Tipografías del tema (hito 8, A2, ADR-094): las fuentes reales del texto de los fotogramas. Cada una genera
 * una lámina (alfabeto con Ñ, números, tildes y signos en sus pesos) que GPT Image recibe junto a las
 * referencias de estilo. No llama a Opus.
 */
export function TypographyCard({ theme, disabled }: { theme: ThemeDetail; disabled: boolean }) {
  const faces = theme.style.typefaces ?? [];
  const [names, setNames] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [upFamily, setUpFamily] = useState('');
  const [upWeight, setUpWeight] = useState(400);
  const fileInput = useRef<HTMLInputElement>(null);
  const full = faces.length >= MAX_TYPEFACES;
  const off = disabled || !!busy;

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

  const upload = (file: File) =>
    run('upload', async () => {
      const data = await new Promise<string>((ok, ko) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result));
        r.onerror = () => ko(new Error('No se pudo leer el archivo.'));
        r.readAsDataURL(file);
      });
      await themesApi.uploadTypeface(theme.id, { family: upFamily.trim() || file.name.replace(/\.(ttf|otf)$/i, '').replace(/[-_](regular|bold|light|medium|black|extrabold|semibold|thin).*/i, ''), weight: upWeight, fileName: file.name, data });
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Type className="text-primary size-4" /> Tipografías
        </CardTitle>
        <CardDescription>
          Las fuentes reales del texto de los fotogramas (hasta {MAX_TYPEFACES}). Cada una genera una lámina neutral con el alfabeto, la Ñ, los números,
          las tildes y los signos en sus pesos, que GPT Image recibe junto a las referencias de estilo para copiar la forma de cada letra. No llama a
          Opus: rige en las pruebas y en los videos nuevos.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field label="Fuentes de Google Fonts" hint="Separadas por comas o «y»">
          <div className="flex flex-wrap gap-2">
            <Input
              value={names}
              onChange={(e) => setNames(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && names.trim() && void run('add', async () => (await themesApi.addTypefaces(theme.id, names), setNames('')))}
              placeholder="Roboto, Oswald"
              className="h-9 min-w-48 flex-1 text-sm"
              disabled={off || full}
            />
            <Button size="sm" disabled={off || full || !names.trim()} onClick={() => void run('add', async () => (await themesApi.addTypefaces(theme.id, names), setNames('')))}>
              {busy === 'add' ? <Loader2 className="animate-spin" /> : <Type />} Generar muestras
            </Button>
          </div>
        </Field>

        {faces.map((f) => (
          <TypefaceRow key={f.family} theme={theme} f={f} off={off} run={run} />
        ))}

        <details className="text-muted-foreground text-[11px]">
          <summary className="cursor-pointer select-none">¿La fuente no está en Google Fonts? Sube su archivo .ttf u .otf (uno por peso)</summary>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Field label="Nombre de la fuente">
              <Input value={upFamily} onChange={(e) => setUpFamily(e.target.value)} placeholder="Mi Fuente" className="h-8 w-44 text-xs" disabled={off} />
            </Field>
            <Field label="Peso del archivo">
              <select
                value={upWeight}
                onChange={(e) => setUpWeight(Number(e.target.value))}
                disabled={off}
                className="border-input bg-background/60 h-8 cursor-pointer rounded-md border px-2 text-xs"
              >
                {WEIGHTS.map(([w, n]) => (
                  <option key={w} value={w}>
                    {n} ({w})
                  </option>
                ))}
              </select>
            </Field>
            <input ref={fileInput} type="file" accept=".ttf,.otf" className="hidden" onChange={(e) => (e.target.files?.[0] && void upload(e.target.files[0]), (e.target.value = ''))} />
            <Button size="sm" variant="outline" disabled={off} onClick={() => fileInput.current?.click()}>
              {busy === 'upload' ? <Loader2 className="animate-spin" /> : <Upload />} Subir .ttf / .otf
            </Button>
          </div>
        </details>
        {error && <div className="text-destructive text-xs">{error}</div>}
      </CardContent>
    </Card>
  );
}

function TypefaceRow({ theme, f, off, run }: { theme: ThemeDetail; f: Typeface; off: boolean; run: (label: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const working = f.status === 'generating';
  const lock = off || working;
  const toggleWeight = (w: number) => {
    const next = f.weights.includes(w) ? f.weights.filter((x) => x !== w) : [...f.weights, w];
    if (!next.length || next.length > 4) return;
    void run(`w-${f.family}`, () => themesApi.updateTypeface(theme.id, f.family, { weights: next }));
  };
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-background/40 p-3 sm:flex-row">
      <a
        href={f.sheet && f.status === 'ready' ? sheetUrl(theme.id, f) : undefined}
        target="_blank"
        rel="noreferrer"
        className={cn('relative grid aspect-[16/10] w-full shrink-0 place-items-center overflow-hidden rounded-md border bg-white sm:w-64', working && 'shimmer')}
        title="Ver la lámina"
      >
        {f.sheet && !working ? (
          <img src={sheetUrl(theme.id, f)} alt={`Lámina de ${f.family}`} className="absolute inset-0 size-full object-contain" />
        ) : working ? (
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        ) : (
          <AlertTriangle className="text-destructive size-5" />
        )}
      </a>
      <div className="flex min-w-0 flex-1 flex-col gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{f.family}</span>
          <Badge variant="secondary">{f.source === 'google' ? 'Google Fonts' : 'Subida'}</Badge>
          {working && <span className="text-muted-foreground">Generando la lámina…</span>}
          <Button size="sm" variant="ghost" className="ml-auto" disabled={off} onClick={() => window.confirm(`¿Quitar ${f.family} del tema?`) && void run(`rm-${f.family}`, () => themesApi.removeTypeface(theme.id, f.family))}>
            <Trash2 /> Quitar
          </Button>
        </div>
        {f.status === 'error' && (
          <div className="text-destructive flex flex-wrap items-center gap-2">
            {f.error}
            <Button size="sm" variant="outline" disabled={off} onClick={() => void run(`retry-${f.family}`, () => themesApi.updateTypeface(theme.id, f.family, { retry: true }))}>
              <RefreshCw /> Reintentar
            </Button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground w-12">Uso</span>
          {ROLES.map((r) => (
            <button
              key={r.value}
              type="button"
              disabled={lock}
              onClick={() => f.role !== r.value && void run(`role-${f.family}`, () => themesApi.updateTypeface(theme.id, f.family, { role: r.value }))}
              className={cn('cursor-pointer rounded-full border px-3 py-1 text-[11px] disabled:opacity-50', f.role === r.value ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground')}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground w-12">Pesos</span>
          {WEIGHTS.filter(([w]) => f.source === 'google' || f.files.some((x) => x.weight === w)).map(([w, n]) => (
            <button
              key={w}
              type="button"
              disabled={lock}
              onClick={() => toggleWeight(w)}
              title={`${n} ${w}`}
              className={cn('cursor-pointer rounded-full border px-2 py-0.5 text-[11px] disabled:opacity-50', f.weights.includes(w) ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground')}
            >
              {n}
            </button>
          ))}
        </div>
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          {f.role === 'headings'
            ? 'Para títulos y palabras clave, en su peso más grueso.'
            : f.role === 'body'
              ? 'Para el texto, las etiquetas y los subtítulos, en su peso más fino.'
              : 'Para todo el texto: el peso más grueso en los títulos y el más fino en el resto.'}{' '}
          Si la fuente no tiene un peso, se usa el más cercano.
        </p>
      </div>
    </div>
  );
}
