import { Loader2, LogIn } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AuthUser } from '@wilox/shared';
import { BrandLockup } from '@/components/Header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { authApi } from '@/lib/api';
import { brand } from '@/lib/brand';

/** Inicio de sesión (hito 3). Sin registro público: los usuarios los crea el admin. */
export function LoginView({ onLogin }: { onLogin: (u: AuthUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onLogin(await authApi.login(email, password));
    } catch (err) {
      setError((err as Error).message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-3">
          <BrandLockup tagline={brand.loginTagline ?? brand.tagline} />
        </div>
        <Card>
          <CardContent>
            <form onSubmit={submit} className="grid gap-4">
              <label className="grid gap-1.5 text-xs font-medium">
                Email
                <input
                  type="email"
                  autoComplete="username"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="bg-background/60 border-input focus-visible:border-ring focus-visible:ring-ring/30 h-10 rounded-md border px-3 text-sm outline-none focus-visible:ring-2"
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium">
                Contraseña
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="bg-background/60 border-input focus-visible:border-ring focus-visible:ring-ring/30 h-10 rounded-md border px-3 text-sm outline-none focus-visible:ring-2"
                />
              </label>
              {error && <p className="text-destructive text-xs">{error}</p>}
              <Button type="submit" disabled={busy || !email || !password}>
                {busy ? <Loader2 className="animate-spin" /> : <LogIn />} Entrar
              </Button>
              <p className="text-muted-foreground text-center text-[11px]">¿Sin acceso u olvidaste la contraseña? Pídeselo al administrador.</p>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
