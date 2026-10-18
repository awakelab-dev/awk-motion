import { Ban, Check, Copy, Link2, Loader2, PlayCircle, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { DownloadBatchInfo, DownloadLinkInfo, LinkDays } from '@wilox/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { batchesApi } from '@/lib/api';
import { cn } from '@/lib/utils';

const DAYS: { v: LinkDays; label: string }[] = [
  { v: 7, label: '7 días' },
  { v: 30, label: '30 días' },
  { v: null, label: 'Sin caducidad' },
];
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' });
const field = 'bg-background h-8 rounded-md border px-2 text-xs';

/**
 * Links de descarga de una fila de «Descargas» (hito 9, T5, ADR-111): para mandarle al cliente el archivo sin bajarlo
 * al computador. Cada link caduca (7 o 30 días) o no, se desactiva y cuenta sus descargas; el archivo se guarda mientras
 * haya un link vigente.
 */
export function LinksPanel({ b, onChanged }: { b: DownloadBatchInfo; onChanged: () => void }) {
  const [days, setDays] = useState<LinkDays>(30);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const [copied, setCopied] = useState<string>();

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(undefined);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const copy = async (l: DownloadLinkInfo) => {
    try {
      await navigator.clipboard.writeText(l.url);
      setCopied(l.id);
      setTimeout(() => setCopied(undefined), 2000);
    } catch {
      setErr('No se pudo copiar: selecciona el link y cópialo a mano.');
    }
  };

  return (
    <div className="bg-secondary/30 grid gap-2.5 rounded-lg border p-3 text-xs">
      <div className="flex items-center gap-1.5 font-medium">
        <Link2 className="size-3.5" /> Links para el cliente
      </div>
      <p className="text-muted-foreground text-[11px] leading-snug">
        Quien abra el link ve una página con el archivo y «Descargar», sin sesión. Mientras haya un link vigente, el archivo no se borra.
        {b.status !== 'ready' ? ' Si aún se está armando, la página lo dice y se actualiza sola.' : ''}
      </p>
      {b.links.length > 0 && (
        <div className="grid gap-1.5">
          {b.links.map((l) => {
            const off = l.disabled || l.expired;
            return (
              <div key={l.id} className={cn('grid gap-1.5 rounded-md border p-2', off && 'opacity-60')}>
                <div className="flex flex-wrap items-center gap-2">
                  {l.label && <span className="font-medium">{l.label}</span>}
                  {l.disabled ? <Badge variant="secondary">Desactivado</Badge> : l.expired ? <Badge variant="secondary">Caducado</Badge> : <Badge variant="success">Activo</Badge>}
                  <span className="text-muted-foreground text-[11px]">
                    {l.expiresAt ? `${l.expired ? 'Caducó' : 'Hasta'} el ${fmtDate(l.expiresAt)}` : 'Sin caducidad'} · {l.downloads} descarga{l.downloads === 1 ? '' : 's'}
                    {l.lastDownloadAt ? ` (la última el ${fmtDate(l.lastDownloadAt)})` : ''}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <input readOnly value={l.url} onFocus={(e) => e.currentTarget.select()} className={cn(field, 'min-w-0 flex-1 basis-56 font-mono text-[10.5px]')} />
                  <Button size="sm" variant="outline" onClick={() => void copy(l)} disabled={off}>
                    {copied === l.id ? <Check /> : <Copy />} {copied === l.id ? 'Copiado' : 'Copiar'}
                  </Button>
                  {l.expired ? (
                    <select
                      className={cn(field, 'cursor-pointer')}
                      value=""
                      disabled={!!busy}
                      onChange={(e) => void act(`days-${l.id}`, () => batchesApi.updateLink(l.id, { days: e.target.value === 'null' ? null : (Number(e.target.value) as LinkDays) }))}
                      title="Volver a activarlo, contando desde hoy"
                    >
                      <option value="" disabled>
                        Renovar…
                      </option>
                      {DAYS.map((d) => (
                        <option key={String(d.v)} value={String(d.v)}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void act(`dis-${l.id}`, () => batchesApi.updateLink(l.id, { disabled: !l.disabled }))}>
                      {busy === `dis-${l.id}` ? <Loader2 className="animate-spin" /> : l.disabled ? <PlayCircle /> : <Ban />} {l.disabled ? 'Activar' : 'Desactivar'}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="px-2"
                    disabled={!!busy}
                    title="Eliminar el link"
                    onClick={() => window.confirm('¿Eliminar este link? Quien lo tenga ya no podrá descargar.') && void act(`rm-${l.id}`, () => batchesApi.removeLink(l.id))}
                  >
                    {busy === `rm-${l.id}` ? <Loader2 className="animate-spin" /> : <Trash2 />}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Para quién (opcional)" maxLength={120} className={cn(field, 'min-w-0 flex-1 basis-40')} />
        <select value={String(days)} onChange={(e) => setDays(e.target.value === 'null' ? null : (Number(e.target.value) as LinkDays))} className={cn(field, 'cursor-pointer')}>
          {DAYS.map((d) => (
            <option key={String(d.v)} value={String(d.v)}>
              {d.label}
            </option>
          ))}
        </select>
        <Button size="sm" disabled={!!busy} onClick={() => void act('create', () => batchesApi.createLink(b.id, { days, label: label.trim() || undefined }).then(() => setLabel('')))}>
          {busy === 'create' ? <Loader2 className="animate-spin" /> : <Link2 />} Crear link
        </Button>
      </div>
      {err && <div className="text-destructive text-[11px]">{err}</div>}
    </div>
  );
}
