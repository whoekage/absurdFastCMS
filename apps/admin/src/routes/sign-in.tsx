import { useState, type FormEvent } from 'react';
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSession, useNeedsSetup } from '@/lib/session';
import { signIn, signUpFirstAdmin, AuthError, SESSION_KEY, NEEDS_SETUP_KEY } from '@/lib/auth';

export const Route = createFileRoute('/sign-in')({
  component: SignInPage,
});

/**
 * Standalone sign-in screen (rendered outside the app shell by __root). Two modes driven by /_setup:
 *  - first-admin: while the instance has no super-admin, this creates it (and closes registration).
 *  - sign-in: thereafter. Errors are GENERIC (anti-enumeration). On success the session query is
 *    invalidated and the shell takes over (the index route lands on the dashboard).
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

  // Already authenticated → leave the sign-in screen.
  if (session.data) return <Navigate to="/" />;

  const firstAdmin = needsSetup.data === true;

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
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
          <CardTitle className="font-display text-xl">{firstAdmin ? 'Create the first admin' : 'Sign in to conti'}</CardTitle>
          <CardDescription>
            {firstAdmin
              ? 'This first account becomes the super-admin — registration closes afterwards.'
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
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {firstAdmin ? 'Create admin' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
