import { ArrowRightLeft, KeyRound, Loader2, Power, RefreshCw, Shield, UserPlus, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AuthUser, UserRole, UserSummary } from '@wilox/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { usersApi } from '@/lib/api';
import { cn } from '@/lib/utils';

const field =
  'bg-background/60 border-input focus-visible:border-ring focus-visible:ring-ring/30 h-9 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2';

const dateFmt = new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium', timeStyle: 'short' });
const fmtDate = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : '—');
const fmtUsd = (n: number) => n.toLocaleString('es-CL', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

/** Crear usuario: email, nombre, rol y contraseña inicial (el admin se la comunica al usuario). */
function CreateUserForm({ onCreated }: { onCreated: (u: UserSummary) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onCreated(await usersApi.create({ email, name: name || undefined, role, password }));
      setEmail('');
      setName('');
      setRole('user');
      setPassword('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1.4fr_1fr_0.8fr_1.2fr_auto] sm:items-end">
      <label className="grid gap-1.5 text-xs font-medium">
        Email
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={field} autoComplete="off" />
      </label>
      <label className="grid gap-1.5 text-xs font-medium">
        Nombre (opcional)
        <input value={name} onChange={(e) => setName(e.target.value)} className={field} autoComplete="off" />
      </label>
      <label className="grid gap-1.5 text-xs font-medium">
        Rol
        <select value={role} onChange={(e) => setRole(e.target.value as UserRole)} className={cn(field, 'cursor-pointer')}>
          <option value="user">Usuario</option>
          <option value="admin">Administrador</option>
        </select>
      </label>
      <label className="grid gap-1.5 text-xs font-medium">
        Contraseña inicial
        <input type="text" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} className={field} autoComplete="off" placeholder="mín. 10 caracteres" />
      </label>
      <Button type="submit" disabled={busy || !email || password.length < 10}>
        {busy ? <Loader2 className="animate-spin" /> : <UserPlus />} Crear
      </Button>
      {error && <p className="text-destructive text-xs sm:col-span-5">{error}</p>}
    </form>
  );
}

function UserRow({ u, me, users, onChange, onReload }: { u: UserSummary; me: AuthUser; users: UserSummary[]; onChange: (u: UserSummary) => void; onReload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [to, setTo] = useState('');
  const [error, setError] = useState<string>();
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<string>();
  const self = u.id === me.id;

  const act = async (fn: () => Promise<UserSummary>, ok?: string) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      onChange(await fn());
      if (ok) setNotice(ok);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** «Pasar sus proyectos a…» (hito 11, ADR-142): todos sus proyectos (y su «Sin clasificar») a otro usuario o a mí. */
  const targets = users.filter((x) => x.id !== u.id && x.active);
  const label = (x: { name: string | null; email: string }) => x.name?.trim() || x.email;
  const transfer = async () => {
    const dest = targets.find((x) => x.id === to);
    if (!dest) return;
    if (
      !window.confirm(
        `¿Pasar todos los proyectos de ${label(u)} a ${dest.id === me.id ? 'ti' : label(dest)}? Pasa a ser su dueño (papelera, archivo y compartir). Los videos de su «Sin clasificar» van a un proyecto nuevo «Sin clasificar de ${label(u)}».`,
      )
    )
      return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const r = await usersApi.transfer(u.id, dest.id);
      setNotice(
        `${r.projects} proyecto${r.projects === 1 ? '' : 's'} pasado${r.projects === 1 ? '' : 's'} a ${dest.id === me.id ? 'ti' : label(dest)}${r.videos ? ` y ${r.videos} video${r.videos === 1 ? '' : 's'} sin clasificar en «Sin clasificar de ${label(u)}»` : ''}.`,
      );
      setTransferring(false);
      setTo('');
      onReload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn('grid gap-3 border-t px-5 py-4 first:border-t-0', !u.active && 'bg-destructive/5')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <span className="truncate">{u.email}</span>
            {u.role === 'admin' && <Badge>Admin</Badge>}
            {!u.active && <Badge variant="destructive">Suspendido</Badge>}
            {self && <Badge variant="secondary">Tú</Badge>}
          </div>
          <div className="text-muted-foreground mt-1 text-xs">
            {u.name ?? 'Sin nombre'} · alta {fmtDate(u.createdAt)} · último acceso {fmtDate(u.lastLoginAt)}
          </div>
          <div className="text-muted-foreground mt-1 text-xs">
            {u.projects} proyecto{u.projects === 1 ? '' : 's'} · {u.generations} videos · {u.themes} temas · {fmtUsd(u.costUsd)}
          </div>
        </div>
        {!self && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => usersApi.update(u.id, { role: u.role === 'admin' ? 'user' : 'admin' }))}>
              <Shield /> {u.role === 'admin' ? 'Quitar admin' : 'Hacer admin'}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => (setResetting((v) => !v), setPassword(''), setNotice(undefined))}>
              <KeyRound /> Nueva contraseña
            </Button>
            {(u.projects > 0 || u.generations > 0) && (
              <Button size="sm" variant="outline" disabled={busy || !targets.length} onClick={() => (setTransferring((v) => !v), setNotice(undefined))} title="Pasar todos sus proyectos a otro usuario o a ti (p. ej. si está suspendido)">
                <ArrowRightLeft /> Pasar sus proyectos a…
              </Button>
            )}
            <Button
              size="sm"
              variant={u.active ? 'destructive' : 'secondary'}
              disabled={busy}
              onClick={() =>
                (!u.active || window.confirm(`¿Suspender a ${label(u)}? No podrá entrar; sus proyectos compartidos siguen funcionando para los demás y puedes pasarle sus proyectos a otro usuario.`)) &&
                void act(() => usersApi.update(u.id, { active: !u.active }), u.active ? 'Suspendido: sus sesiones se cerraron.' : 'Reactivado.')
              }
            >
              <Power /> {u.active ? 'Suspender' : 'Reactivar'}
            </Button>
          </div>
        )}
      </div>
      {resetting && !self && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => usersApi.resetPassword(u.id, password), 'Contraseña cambiada; sus sesiones se cerraron.').then(() => setResetting(false));
          }}
        >
          <input
            type="text"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Contraseña nueva (mín. 10 caracteres)"
            className={cn(field, 'max-w-xs')}
            autoComplete="off"
          />
          <Button size="sm" type="submit" disabled={busy || password.length < 10}>
            {busy ? <Loader2 className="animate-spin" /> : <KeyRound />} Guardar
          </Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => setResetting(false)}>
            <X /> Cancelar
          </Button>
        </form>
      )}
      {transferring && !self && (
        <div className="bg-secondary/40 flex flex-wrap items-center gap-2 rounded-lg border p-2.5 text-xs">
          <span className="text-muted-foreground">Pasar sus {u.projects} proyecto{u.projects === 1 ? '' : 's'} (y su «Sin clasificar») a</span>
          <select value={to} onChange={(e) => setTo(e.target.value)} className={cn(field, 'h-8 w-auto min-w-48 cursor-pointer text-xs')}>
            <option value="">Elegir…</option>
            {targets.map((x) => (
              <option key={x.id} value={x.id}>
                {x.id === me.id ? `mí (${label(x)})` : label(x)}
              </option>
            ))}
          </select>
          <Button size="sm" disabled={busy || !to} onClick={() => void transfer()}>
            {busy ? <Loader2 className="animate-spin" /> : <ArrowRightLeft />} Pasar
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setTransferring(false)}>
            <X /> Cancelar
          </Button>
        </div>
      )}
      {error && <p className="text-destructive text-xs">{error}</p>}
      {notice && <p className="text-success text-xs">{notice}</p>}
    </div>
  );
}

/** Pantalla "Usuarios" (solo admin, hito 3): crear, suspender, cambiar rol y fijar contraseña; hito 11: pasar sus proyectos. */
export function UsersView({ me }: { me: AuthUser }) {
  const [users, setUsers] = useState<UserSummary[]>();
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    usersApi.list().then(
      (l) => (setUsers(l), setError(undefined)),
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(load, [load]);

  const upsert = (u: UserSummary) => setUsers((l) => (l?.some((x) => x.id === u.id) ? l.map((x) => (x.id === u.id ? u : x)) : [...(l ?? []), u]));

  return (
    <main className="mx-auto grid max-w-[1100px] gap-6 px-4 pb-16 sm:px-6">
      <Card>
        <CardHeader>
          <CardTitle>Nuevo usuario</CardTitle>
          <CardDescription>
            Sin registro público ni recuperación por email: comunica tú la contraseña inicial; el usuario puede cambiarla en "Mi cuenta".
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateUserForm onCreated={upsert} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Usuarios</CardTitle>
            <CardDescription>
              Cada usuario ve sus proyectos, los que otros le comparten y los públicos; sus temas son suyos. Suspender corta el acceso sin borrar nada: sus
              proyectos compartidos siguen funcionando y con «Pasar sus proyectos a…» les das otro dueño (también a ti). Todos usan las mismas claves de la API.
            </CardDescription>
          </div>
          <Button size="icon" variant="ghost" onClick={load} title="Actualizar">
            <RefreshCw />
          </Button>
        </CardHeader>
        <div className="mt-4">
          {error && <p className="text-destructive px-5 pb-4 text-xs">{error}</p>}
          {!users && !error && (
            <div className="text-muted-foreground flex items-center gap-2 px-5 pb-5 text-xs">
              <Loader2 className="size-3.5 animate-spin" /> Cargando…
            </div>
          )}
          {users?.map((u) => <UserRow key={u.id} u={u} me={me} users={users} onChange={upsert} onReload={load} />)}
        </div>
      </Card>
    </main>
  );
}
