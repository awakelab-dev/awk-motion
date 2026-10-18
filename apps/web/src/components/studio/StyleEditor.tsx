import { Loader2, Save, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SFX_NAMES, type SfxName, type ThemeDetail, type ThemeStyle } from '@wilox/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/textarea';
import { themesApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Field } from './NewThemeForm';

const TEXT_FIELDS: { key: keyof ThemeStyle & string; label: string; hint: string; rows: number }[] = [
  { key: 'imageBible', label: 'Bible de imagen (GPT Image 2.5)', hint: 'Se antepone a cada fotograma', rows: 6 },
  { key: 'videoBible', label: 'Bible de video (MiniMax)', hint: 'Identidad + movimiento', rows: 6 },
  { key: 'clipBible', label: 'Bible corta de clip', hint: 'Va en cada prompt de clip', rows: 3 },
  { key: 'directorNotes', label: 'Notas del estilo (STYLE NOTES)', hint: 'Prevalecen sobre los principios generales', rows: 5 },
  { key: 'imagery', label: 'Vocabulario de imágenes (RICHNESS)', hint: 'Qué da riqueza a cada fotograma', rows: 3 },
  { key: 'avoid', label: 'AVOID', hint: 'Lo que el estilo prohíbe', rows: 2 },
  { key: 'soundHint', label: 'Pista de sonido', hint: 'Bloque SOUND del clip', rows: 2 },
];

/** Edición de los campos del ThemeStyle antes de probar (solo lectura en los temas base). */
export function StyleEditor({ theme, disabled }: { theme: ThemeDetail; disabled?: boolean }) {
  const [draft, setDraft] = useState<ThemeStyle>(theme.style);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const ro = theme.readOnly || disabled;

  // Si el tema cambia desde fuera (propuesta de Opus, sugerencias aplicadas) y no hay edición local, se actualiza.
  useEffect(() => {
    if (!dirty) setDraft(theme.style);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme.version, theme.style]);

  const set = <K extends keyof ThemeStyle>(k: K, v: ThemeStyle[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setDirty(true);
  };
  const setInfo = (k: 'name' | 'description', v: string) => {
    setDraft((d) => ({ ...d, info: { ...d.info, [k]: v } }));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await themesApi.update(theme.id, { style: draft });
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!theme.style.imageBible && theme.origin === 'custom')
    return (
      <Card>
        <CardContent className="text-muted-foreground text-xs">El tema aún no tiene estilo: Opus lo propone a partir de la descripción y las referencias.</CardContent>
      </Card>
    );

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>ThemeStyle {theme.origin === 'custom' && <Badge variant="secondary">v{theme.version}</Badge>}</CardTitle>
            <CardDescription>
              {ro ? 'Solo lectura. Duplica el tema para editarlo.' : 'Edita los campos y guarda antes de lanzar una prueba: cada cambio crea una versión nueva.'}
            </CardDescription>
          </div>
          {!ro && (
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => (setDraft(theme.style), setDirty(false))}>
                <Undo2 /> Descartar
              </Button>
              <Button size="sm" disabled={!dirty || saving} onClick={save}>
                {saving ? <Loader2 className="animate-spin" /> : <Save />} Guardar cambios
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <div className="text-destructive text-xs">{error}</div>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre">
            <Input value={draft.info.name} onChange={(e) => setInfo('name', e.target.value)} disabled={ro} className="h-9 text-sm" />
          </Field>
          <Field label="Descripción corta (selector)">
            <Input value={draft.info.description} onChange={(e) => setInfo('description', e.target.value)} disabled={ro} className="h-9 text-sm" />
          </Field>
        </div>
        <Field label="Paleta (swatches)" hint="Hex separados por comas: fondo primero, acento al final">
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              {draft.info.swatches.map((c, i) => (
                <span key={`${c}${i}`} className="size-6 rounded-md ring-1 ring-white/10" style={{ background: c }} title={c} />
              ))}
            </div>
            <Input
              value={draft.info.swatches.join(', ')}
              onChange={(e) => {
                setDraft((d) => ({ ...d, info: { ...d.info, swatches: e.target.value.split(/[,\s]+/).filter((x) => /^#[0-9a-f]{3,8}$/i.test(x)) } }));
                setDirty(true);
              }}
              disabled={ro}
              className="h-9 font-mono text-xs"
            />
          </div>
        </Field>
        <div className="flex flex-wrap gap-4">
          <label className={cn('flex items-center gap-2 text-xs', ro ? 'opacity-70' : 'cursor-pointer')}>
            <input type="checkbox" checked={draft.usesMediaFrames} disabled={ro} onChange={(e) => set('usesMediaFrames', e.target.checked)} />
            Usa fotos/video reales en marcos
          </label>
        </div>
        {TEXT_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <Textarea
              value={String(draft[f.key as keyof ThemeStyle] ?? '')}
              onChange={(e) => set(f.key as 'avoid', e.target.value)}
              disabled={ro}
              rows={f.rows}
              className="font-mono text-[11.5px] leading-relaxed"
            />
          </Field>
        ))}
        <Field label="Perfil de SFX" hint="Sintetizados; sin música ni voz">
          <div className="grid gap-2 sm:grid-cols-3">
            <SfxPick label="Arranque" value={draft.sfx.opener} disabled={ro} onChange={(v) => set('sfx', { ...draft.sfx, opener: v })} />
            <SfxPick label="Pico fuerte" value={draft.sfx.hit} disabled={ro} onChange={(v) => set('sfx', { ...draft.sfx, hit: v })} />
            <div className="flex flex-col gap-1">
              <div className="text-muted-foreground text-[11px]">Acentos</div>
              <div className="flex flex-wrap gap-1">
                {SFX_NAMES.map((n) => {
                  const on = draft.sfx.accents.includes(n);
                  return (
                    <button
                      key={n}
                      type="button"
                      disabled={ro}
                      onClick={() => set('sfx', { ...draft.sfx, accents: on ? draft.sfx.accents.filter((x) => x !== n) : [...draft.sfx.accents, n] })}
                      className={cn('rounded-full border px-2 py-0.5 text-[11px]', on ? 'border-primary/40 bg-primary/10 text-primary' : 'text-muted-foreground', !ro && 'cursor-pointer')}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </Field>
      </CardContent>
    </Card>
  );
}

function SfxPick({ label, value, onChange, disabled }: { label: string; value: SfxName; onChange: (v: SfxName) => void; disabled?: boolean }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground text-[11px]">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as SfxName)}
        className="bg-background/60 border-input h-8 rounded-md border px-2 text-xs"
      >
        {SFX_NAMES.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}
