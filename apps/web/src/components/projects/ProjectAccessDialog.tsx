import { Check, Crown, Globe, Loader2, Lock, Search, UserRound, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AuthUser, ProjectAccessState, ProjectSummary, UserRef } from '@wilox/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { projectsApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { brand } from '@/lib/brand';

export const userLabel = (u: Pick<UserRef, 'name' | 'email'>) => u.name?.trim() || u.email;

const dateFmt = new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium' });

/**
 * «Acceso» del proyecto (hito 11, ADR-142): con qué usuarios de la app se comparte y si es público (todos los usuarios de
 * la app lo ven y lo gestionan; nadie de fuera: los links del cliente siguen en «Compartir»). Lo cambian el dueño y el
 * administrador; los demás ven quién tiene acceso. El administrador, además, cambia el dueño.
 */
export function ProjectAccessDialog({ project, me, onClose, onChanged }: { project: ProjectSummary; me: AuthUser; onClose: () => void; onChanged: () => void }) {
  const [s, setS] = useState<ProjectAccessState>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pub, setPub] = useState(false);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [newOwner, setNewOwner] = useState('');

  const apply = (r: ProjectAccessState) => {
    setS(r);
    setPicked(new Set(r.shares.map((x) => x.user.id)));
    setPub(r.public);
  };
  useEffect(() => {
    projectsApi.access(project.id).then(apply, (e: Error) => setError(e.message));
  }, [project.id]);

  const dirty = !!s && (pub !== s.public || picked.size !== s.shares.length || s.shares.some((x) => !picked.has(x.user.id)));
  const needle = q.trim().toLowerCase();
  const people = useMemo(() => {
    if (!s) return [];
    // Los activos y, aunque estén suspendidos, los que ya lo tienen compartido (para poder quitarlos).
    const byId = new Map<string, UserRef>(s.candidates.map((u) => [u.id, u]));
    for (const x of s.shares) byId.set(x.user.id, x.user);
    return [...byId.values()].filter((u) => !needle || `${u.name ?? ''} ${u.email}`.toLowerCase().includes(needle));
  }, [s, needle]);

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      apply(await projectsApi.saveAccess(project.id, { userIds: [...picked], public: pub }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changeOwner = async () => {
    if (!s || !newOwner) return;
    const to = s.candidates.find((u) => u.id === newOwner) ?? (newOwner === me.id ? { name: me.name, email: me.email } : undefined);
    if (!window.confirm(`¿Pasar «${project.name}» a ${to ? userLabel(to) : 'ese usuario'}? Será su dueño: podrá enviarlo a la papelera, archivarlo y compartirlo.`)) return;
    setBusy(true);
    setError(undefined);
    try {
      apply(await projectsApi.setOwner(project.id, newOwner));
      setNewOwner('');
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shareOf = (id: string) => s?.shares.find((x) => x.user.id === id);

  return (
    <Modal title={`Acceso a «${project.name}»`} onClose={onClose} className="max-w-xl">
      {!s ? (
        <div className="grid place-items-center p-8">{error ? <p className="text-destructive text-sm">{error}</p> : <Loader2 className="text-muted-foreground size-5 animate-spin" />}</div>
      ) : (
        <div className="grid gap-4 text-xs">
          <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
            <Crown className="text-warning size-4 shrink-0" />
            <span>
              Dueño: <b className="text-foreground">{userLabel(s.owner)}</b>
              {s.owner.id === me.id && ' (tú)'}
              {!s.owner.active && (
                <Badge variant="destructive" className="ml-1.5">
                  suspendido
                </Badge>
              )}
            </span>
          </div>
          <p className="text-muted-foreground leading-snug">
            Quien tiene acceso puede generar, corregir, regenerar, publicar, descargar y gestionar las observaciones de este proyecto. Enviarlo a la papelera, restaurarlo,
            archivarlo, eliminarlo y compartirlo es solo del dueño. Los links para el cliente siguen en «Compartir».
          </p>
          {s.unclassified ? (
            <p className="bg-secondary/40 flex items-center gap-2 rounded-lg border px-3 py-2">
              <Lock className="size-3.5" /> «Sin clasificar» es de cada usuario: no se comparte ni se hace público.
            </p>
          ) : (
            <>
              <label className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5', s.canShare && 'cursor-pointer', pub && 'border-primary/50 bg-primary/5')}>
                <input type="checkbox" checked={pub} disabled={!s.canShare || busy} onChange={(e) => setPub(e.target.checked)} className="accent-primary mt-0.5" />
                <span>
                  <span className="flex items-center gap-1.5 font-medium">
                    <Globe className="size-3.5" /> Público: todos los usuarios de la app
                  </span>
                  <span className="text-muted-foreground">Lo ven y lo gestionan todos los usuarios con cuenta en {brand.name} (también los que se creen después). Nadie de fuera.</span>
                </span>
              </label>
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 font-medium">
                    <Users className="size-3.5" /> Compartido con {picked.size ? `${picked.size} usuario${picked.size === 1 ? '' : 's'}` : 'nadie'}
                  </span>
                  {people.length > 6 && (
                    <label className="relative">
                      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
                      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar" className="bg-background/60 h-7 w-40 rounded-md border pr-2 pl-7 text-xs outline-none" />
                    </label>
                  )}
                </div>
                <div className="grid max-h-72 gap-1 overflow-y-auto rounded-lg border p-1">
                  {people.length === 0 && <p className="text-muted-foreground p-2">No hay otros usuarios en la app.</p>}
                  {people.map((u) => {
                    const sh = shareOf(u.id);
                    return (
                      <label key={u.id} className={cn('flex items-center gap-2 rounded-md px-2 py-1.5', s.canShare && 'hover:bg-secondary/60 cursor-pointer')}>
                        <input
                          type="checkbox"
                          checked={picked.has(u.id)}
                          disabled={!s.canShare || busy}
                          onChange={(e) =>
                            setPicked((cur) => {
                              const n = new Set(cur);
                              if (e.target.checked) n.add(u.id);
                              else n.delete(u.id);
                              return n;
                            })
                          }
                          className="accent-primary"
                        />
                        <UserRound className="text-muted-foreground size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">
                          <span className="text-foreground">{userLabel(u)}</span>
                          {u.name && <span className="text-muted-foreground"> · {u.email}</span>}
                          {u.id === me.id && <span className="text-muted-foreground"> (tú)</span>}
                        </span>
                        {!u.active && <Badge variant="destructive">suspendido</Badge>}
                        {sh && (
                          <span className="text-muted-foreground shrink-0 text-[11px]" title={`Lo compartió ${userLabel(sh.sharedBy)}`}>
                            desde {dateFmt.format(new Date(sh.createdAt))}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
              {s.canShare ? (
                <div className="flex items-center gap-2">
                  <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
                    {busy ? <Loader2 className="animate-spin" /> : <Check />} Guardar
                  </Button>
                  {saved && <span className="text-success">Guardado.</span>}
                </div>
              ) : (
                <p className="text-muted-foreground">Solo el dueño (o un administrador) cambia con quién se comparte.</p>
              )}
            </>
          )}
          {me.role === 'admin' && !s.unclassified && (
            <div className="grid gap-2 border-t pt-3">
              <span className="flex items-center gap-1.5 font-medium">
                <Crown className="size-3.5" /> Cambiar el dueño (administrador)
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <select value={newOwner} onChange={(e) => setNewOwner(e.target.value)} disabled={busy} className="bg-background/60 h-8 min-w-0 flex-1 cursor-pointer rounded-md border px-2 text-xs">
                  <option value="">Elegir el nuevo dueño…</option>
                  {s.owner.id !== me.id && <option value={me.id}>Yo ({userLabel(me)})</option>}
                  {s.candidates
                    .filter((u) => u.id !== me.id)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {userLabel(u)}
                      </option>
                    ))}
                </select>
                <Button size="sm" variant="outline" disabled={!newOwner || busy} onClick={() => void changeOwner()}>
                  Pasar el proyecto
                </Button>
              </div>
              <p className="text-muted-foreground">Sus videos, publicaciones y descargas van con el proyecto. Para pasar todos los de un usuario a la vez: «Usuarios» → «Pasar sus proyectos a…».</p>
            </div>
          )}
          {error && <p className="text-destructive">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
