import { AlertTriangle, BookmarkPlus, Check, FileText, FileUp, Loader2, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ImportMode, ImportResult, ScriptStyleInfo } from '@wilox/shared';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { confirmSpend } from '@/lib/spend';
import { cn } from '@/lib/utils';

const toBase64 = (f: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });

/**
 * Importar la locución desde un PDF o un Word (hito 5, ADR-049): como texto (literal, en párrafos) o como
 * guion, explicando cómo está armado; Opus lo convierte en filas (locución, escena, expresión, layout).
 */
export function ImportDialog({ projectId, onClose, onImported }: { projectId?: string; onClose: () => void; onImported: (r: ImportResult) => void }) {
  const [file, setFile] = useState<File>();
  const [mode, setMode] = useState<ImportMode>('text');
  const [structure, setStructure] = useState('');
  // Estilos de guion (ADR-072): se propone el último usado en este proyecto.
  const [styles, setStyles] = useState<ScriptStyleInfo[]>([]);
  const [styleId, setStyleId] = useState<string>();
  const [naming, setNaming] = useState<string>();
  const [styleBusy, setStyleBusy] = useState(false);
  const [styleErr, setStyleErr] = useState<string>();
  useEffect(() => {
    api.scriptStyles(projectId).then(
      (r) => {
        setStyles(r.styles);
        const last = r.styles.find((x) => x.id === r.lastUsedId);
        if (last) {
          setStyleId(last.id);
          setStructure(last.structure);
          setMode('script');
        }
      },
      () => undefined,
    );
  }, [projectId]);
  const style = styles.find((x) => x.id === styleId);
  const pickStyle = (id: string) => {
    const st = styles.find((x) => x.id === id);
    setStyleId(st?.id);
    setStructure(st?.structure ?? '');
    setNaming(undefined);
    setStyleErr(undefined);
  };
  const styleAct = async (fn: () => Promise<void>) => {
    setStyleBusy(true);
    setStyleErr(undefined);
    try {
      await fn();
    } catch (e) {
      setStyleErr((e as Error).message);
    } finally {
      setStyleBusy(false);
    }
  };
  const saveNew = (name: string) =>
    styleAct(async () => {
      const st = await api.createScriptStyle({ name: name.trim(), structure: structure.trim() });
      setStyles((l) => [...l, st].sort((a, b) => a.name.localeCompare(b.name)));
      setStyleId(st.id);
      setNaming(undefined);
    });
  const update = () =>
    styleAct(async () => {
      const st = await api.updateScriptStyle(style!.id, { name: style!.name, structure: structure.trim() });
      setStyles((l) => l.map((x) => (x.id === st.id ? st : x)));
    });
  const remove = () =>
    window.confirm(`¿Eliminar el estilo «${style!.name}»? Los guiones ya importados no cambian.`) &&
    styleAct(async () => {
      await api.deleteScriptStyle(style!.id);
      setStyles((l) => l.filter((x) => x.id !== style!.id));
      setStyleId(undefined);
    });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [result, setResult] = useState<ImportResult>();

  const run = async () => {
    if (!file) return;
    // Como guion lo lee Opus (ADR-069); como texto no gasta.
    if (
      mode === 'script' &&
      !(await confirmSpend({ title: 'Importar como guion', body: 'Opus lee el documento y arma las filas del guion.', work: { llm: 1 }, action: 'Importar' }))
    )
      return;
    setBusy(true);
    setErr(undefined);
    setResult(undefined);
    try {
      setResult(
        await api.importDocument({
          fileName: file.name,
          data: await toBase64(file),
          mode,
          structure: mode === 'script' ? structure.trim() || undefined : undefined,
          // El proyecto recuerda el estilo usado (o que no se usó ninguno) para la próxima importación.
          ...(mode === 'script' ? { styleId: style?.id, projectId } : {}),
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Importar desde un PDF o un Word" onClose={onClose} className="max-w-4xl">
      <div className="grid gap-4">
        <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed p-4 text-sm hover:border-white/30">
          <FileUp className="text-primary size-5" />
          <span className="min-w-0 flex-1 truncate">{file ? file.name : 'Elige un PDF o un Word (.docx), hasta 20 MB'}</span>
          <input
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={(e) => (setFile(e.target.files?.[0]), setResult(undefined))}
          />
        </label>

        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ['text', 'Es un texto', 'Se usa tal cual como locución, un párrafo por párrafo del documento. No pasa por Opus.'],
              ['script', 'Es un guion', 'Trae locución y además escena, expresión o layout. Explica cómo está armado y Opus lo convierte en filas.'],
            ] as const
          ).map(([m, title, desc]) => (
            <button
              key={m}
              type="button"
              onClick={() => (setMode(m), setResult(undefined))}
              className={cn('cursor-pointer rounded-lg border p-3 text-left', mode === m ? 'border-primary bg-primary/10' : 'hover:border-white/20')}
            >
              <div className="text-sm font-medium">{title}</div>
              <div className="text-muted-foreground mt-0.5 text-[11px]">{desc}</div>
            </button>
          ))}
        </div>

        {mode === 'script' && (
          <div className="grid gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs font-medium" htmlFor="import-style">
                Estilo de guion
              </label>
              <select
                id="import-style"
                value={styleId ?? ''}
                onChange={(e) => pickStyle(e.target.value)}
                className="border-input bg-background/60 h-8 min-w-48 cursor-pointer rounded-md border px-2 text-xs"
              >
                <option value="">Sin estilo (escribirlo)</option>
                {styles.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                    {x.ownerName ? ` · de ${x.ownerName}` : ''}
                  </option>
                ))}
              </select>
              {/* Los del dueño de un proyecto compartido (hito 11) se usan, no se editan. */}
              {style && !style.ownerName && (
                <Button size="sm" variant="ghost" onClick={() => void remove()} disabled={styleBusy} title="Eliminar este estilo">
                  <Trash2 /> Eliminar
                </Button>
              )}
            </div>
            <label className="text-xs font-medium" htmlFor="import-structure">
              ¿Cómo está armado el guion?
            </label>
            <Textarea
              id="import-structure"
              rows={3}
              value={structure}
              onChange={(e) => setStructure(e.target.value)}
              placeholder="Por ejemplo: «En la tabla, la columna 1 es la locución y la columna 2 la descripción gráfica de la escena; la columna 3 indica el tono. Los títulos en negrita no se narran.»"
            />
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {style && !style.ownerName && structure.trim() !== style.structure && (
                <Button size="sm" variant="outline" onClick={() => void update()} disabled={styleBusy || structure.trim().length < 10}>
                  <Save /> Actualizar «{style.name}»
                </Button>
              )}
              {naming === undefined ? (
                (!style || structure.trim() !== style.structure) &&
                structure.trim().length >= 10 && (
                  <Button size="sm" variant="outline" onClick={() => setNaming('')} disabled={styleBusy}>
                    <BookmarkPlus /> Guardar como estilo nuevo
                  </Button>
                )
              ) : (
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (naming.trim().length >= 2) void saveNew(naming);
                  }}
                >
                  <Input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} placeholder="Nombre del estilo (p. ej. Guion Aspasia 3 columnas)" className="h-8 w-72 text-xs" />
                  <Button size="sm" type="submit" disabled={styleBusy || naming.trim().length < 2}>
                    {styleBusy ? <Loader2 className="animate-spin" /> : <Save />} Guardar
                  </Button>
                  <Button size="sm" variant="ghost" type="button" onClick={() => setNaming(undefined)}>
                    Cancelar
                  </Button>
                </form>
              )}
              {style && structure.trim() === style.structure && <span className="text-muted-foreground text-[11px]">Con el estilo «{style.name}».</span>}
              {styleErr && <span className="text-destructive">{styleErr}</span>}
            </div>
            <p className="text-muted-foreground text-[11px]">
              Las escenas se crean desde la descripción del guion, pero con el formato del tema elegido (paleta, tipografía, estilo). La locución se copia
              literal y se coteja con el documento.
            </p>
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={run} disabled={!file || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <FileText />} {mode === 'script' ? 'Leer el guion' : 'Extraer el texto'}
          </Button>
        </div>
        {err && <p className="text-destructive text-xs">{err}</p>}

        {result && (
          <div className="grid gap-3 border-t pt-4">
            {result.warnings.map((w) => (
              <p key={w} className="text-warning flex items-start gap-1.5 text-xs">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {w}
              </p>
            ))}
            {result.script ? (
              <div className="max-h-80 overflow-auto rounded-lg border">
                <table className="w-full text-left text-xs">
                  <thead className="bg-secondary/60 sticky top-0">
                    <tr>
                      <th className="w-8 px-2 py-1.5">#</th>
                      <th className="px-2 py-1.5">Locución</th>
                      <th className="px-2 py-1.5">Escena</th>
                      <th className="px-2 py-1.5">Expresión</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.script.rows.map((r, i) => (
                      <tr key={i} className="border-t align-top">
                        <td className="px-2 py-1.5 tabular-nums">{i + 1}</td>
                        <td className={cn('px-2 py-1.5', !r.verified && 'text-warning')}>
                          {!r.verified && <AlertTriangle className="mr-1 inline size-3" />}
                          {r.voice}
                        </td>
                        <td className="text-muted-foreground px-2 py-1.5">
                          {r.scene ?? '—'}
                          {r.layout ? <div className="mt-1 italic">Layout: {r.layout}</div> : null}
                        </td>
                        <td className="text-muted-foreground px-2 py-1.5">
                          {r.expression ?? '—'}
                          {r.voiceTag ? <div className="mt-1 font-mono text-[10px]">[{r.voiceTag}]</div> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <pre className="bg-background/40 max-h-80 overflow-auto rounded-lg border p-3 text-xs whitespace-pre-wrap">{result.text}</pre>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="text-muted-foreground text-[11px]">
                {result.text.split(/\n\s*\n/).length} párrafo(s){result.pages ? ` · ${result.pages} página(s)` : ''}. Se puede editar en el formulario.
              </span>
              <Button onClick={() => (onImported(result), onClose())}>
                <Check /> Usar {result.script ? 'este guion' : 'este texto'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
