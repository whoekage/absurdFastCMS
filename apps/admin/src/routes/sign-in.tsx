import { useState, useEffect, type FormEvent } from 'react';
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, ShieldCheck, ShieldAlert } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSession, useNeedsSetup } from '@/lib/session';
import { signIn, signUpFirstAdmin, AuthError, SESSION_KEY, NEEDS_SETUP_KEY } from '@/lib/auth';
import { pwnedCount } from '@/lib/pwned';

export const Route = createFileRoute('/sign-in')({
  component: SignInPage,
});

type PwnedState = { status: 'idle' | 'checking' | 'safe' | 'breached' | 'error'; count: number };

/**
 * Standalone sign-in screen (rendered outside the app shell by __root). Two modes driven by /_setup:
 *  - first-admin: while the instance has no super-admin, this creates the owner account.
 *  - sign-in: thereafter. Errors are GENERIC (anti-enumeration). On success the session query is invalidated
 *    and the shell takes over (the index route lands on the dashboard). The first-admin password is checked
 *    live against Have I Been Pwned (k-anonymity — only a 5-char hash prefix leaves the browser).
 */
function SignInPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const session = useSession();
  const needsSetup = useNeedsSetup();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pwned, setPwned] = useState<PwnedState>({ status: 'idle', count: 0 });

  const firstAdmin = needsSetup.data === true;

  // Live, debounced breach check on the new owner password (advisory — never blocks sign-in, only setup).
  useEffect(() => {
    if (!firstAdmin || password.length < 8) {
      setPwned({ status: 'idle', count: 0 });
      return;
    }
    setPwned({ status: 'checking', count: 0 });
    let cancelled = false;
    const t = setTimeout(() => {
      pwnedCount(password)
        .then((count) => !cancelled && setPwned({ status: count > 0 ? 'breached' : 'safe', count }))
        .catch(() => !cancelled && setPwned({ status: 'error', count: 0 }));
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [password, firstAdmin]);

  // Already authenticated → leave the sign-in screen.
  if (session.data) return <Navigate to="/" />;

  const breached = firstAdmin && pwned.status === 'breached';

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (breached) {
      setError('That password appears in a known data breach — please choose a different one.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (firstAdmin) await signUpFirstAdmin(email.trim(), password, name.trim() || email.trim());
      else await signIn(email.trim(), password);
      await Promise.all([
        qc.invalidateQueries({ queryKey: SESSION_KEY }),
        qc.invalidateQueries({ queryKey: NEEDS_SETUP_KEY }),
      ]);
      await navigate({ to: '/' });
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display text-xl">{firstAdmin ? 'Create the owner account' : 'Sign in to conti'}</CardTitle>
          <CardDescription>
            {firstAdmin
              ? 'This first account becomes the super-admin of this workspace. Choose a strong password.'
              : 'Enter your credentials to access the admin.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {firstAdmin && (
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Your name" />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                placeholder="you@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={firstAdmin ? 'new-password' : 'current-password'}
                placeholder="••••••••"
              />
              {firstAdmin && pwned.status !== 'idle' && <BreachHint state={pwned} />}
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={busy || breached}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {firstAdmin ? 'Create owner account' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

/** The live HIBP indicator under the owner password — a real, free breach check (k-anonymity). */
function BreachHint({ state }: { state: PwnedState }) {
  if (state.status === 'checking') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Checking against known breaches…
      </p>
    );
  }
  if (state.status === 'safe') {
    return (
      <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <ShieldCheck className="h-3.5 w-3.5" /> Not found in any known breach
      </p>
    );
  }
  if (state.status === 'breached') {
    return (
      <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
        <ShieldAlert className="h-3.5 w-3.5" /> Found in {state.count.toLocaleString()} known breaches — choose another
      </p>
    );
  }
  return <p className="text-xs text-muted-foreground">Couldn’t reach the breach service — choose your password carefully.</p>;
}
