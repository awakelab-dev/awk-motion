import { AudioLines, Check, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { AuthUser, PronunciationRuleInfo } from '@wilox/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { authApi, pronunciationsApi } from '@/lib/api';

const field =
  'bg-background/60 border-input focus-visible:border-ring focus-visible:ring-ring/30 h-9 rounded-md border px-3 text-sm outline-none focus-visible:ring-2';

/** Mi cuenta: datos y cambio de la contraseña propia (no hay recuperación por email). */
export function AccountView({ me }: { me: AuthUser }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setDone(false);
    if (next !== repeat) return setError('La contraseña nueva no coincide al repetirla.');
    setBusy(true);
    try {
      await authApi.changePassword(current, next);
      setDone(true);
      setCurrent('');
      setNext('');
      setRepeat('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto grid max-w-xl gap-6 px-4 pb-16 sm:px-6">
      <Card>
        <CardHeader>
          <CardTitle>Mi cuenta</CardTitle>
          <CardDescription>
            {me.name ? `${me.name} · ` : ''}
            {me.email}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-3">
          <Badge variant={me.role === 'admin' ? 'default' : 'secondary'}>{me.role === 'admin' ? 'Administrador' : 'Usuario'}</Badge>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Cambiar la contraseña</CardTitle>
          <CardDescription>Mínimo 10 caracteres. Se cierran tus sesiones en otros navegadores.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-3">
            <label className="grid gap-1.5 text-xs font-medium">
              Contraseña actual
              <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} className={field} />
            </label>
            <label className="grid gap-1.5 text-xs font-medium">
              Contraseña nueva
              <input type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} className={field} />
            </label>
            <label className="grid gap-1.5 text-xs font-medium">
              Repite la contraseña nueva
              <input type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} className={field} />
            </label>
            {error && <p className="text-destructive text-xs">{error}</p>}
            {done && (
              <p className="text-success flex items-center gap-1.5 text-xs">
                <Check className="size-3.5" /> Contraseña cambiada.
              </p>
            )}
            <div>
              <Button type="submit" disabled={busy || !current || !next || !repeat}>
                {busy ? <Loader2 className="animate-spin" /> : <KeyRound />} Cambiar contraseña
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <PronunciationsCard />
    </main>
  );
}

/** Mis pronunciaciones (hito 5, ADR-048): lo que la voz recibe en lugar de cada palabra, en todos mis videos. */
function PronunciationsCard() {
  const [rules, setRules] = useState<PronunciationRuleInfo[]>();
  const [match, setMatch] = useState('');
  const [say, setSay] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = () => pronunciationsApi.list().then(setRules, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await pronunciationsApi.create(match, say);
      setMatch('');
      setSay('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setError(undefined);
    try {
      await pronunciationsApi.remove(id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AudioLines className="text-primary size-4" /> Pronunciaciones
        </CardTitle>
        <CardDescription>
          Cómo debe decir la voz una palabra o sigla en todos tus videos (el texto del video no cambia). Se crean también desde «Rehacer audio».
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {rules?.length ? (
          <div className="divide-y rounded-lg border">
            {rules.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="font-medium">{r.match}</span>
                <span className="text-muted-foreground">→</span>
                <span className="min-w-0 flex-1 truncate">{r.say}</span>
                <button type="button" onClick={() => void remove(r.id)} className="text-muted-foreground hover:text-destructive cursor-pointer" title="Eliminar">
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">{rules ? 'Todavía no hay reglas.' : 'Cargando…'}</p>
        )}
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <label className="grid flex-1 gap-1 text-xs font-medium">
            Palabra o sigla
            <input value={match} onChange={(e) => setMatch(e.target.value)} placeholder="IAAS" className={field} />
          </label>
          <label className="grid flex-[2] gap-1 text-xs font-medium">
            La voz dice
            <input value={say} onChange={(e) => setSay(e.target.value)} placeholder="I, A, A, S" className={field} />
          </label>
          <Button type="submit" disabled={busy || !match.trim() || !say.trim()}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />} Añadir
          </Button>
        </form>
        {error && <p className="text-destructive text-xs">{error}</p>}
      </CardContent>
    </Card>
  );
}
