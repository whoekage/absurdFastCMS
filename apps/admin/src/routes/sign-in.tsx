import { useState, useEffect, type FormEvent, type ReactNode } from 'react';
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, ShieldCheck, ShieldAlert, ArrowRight, Mail, Lock, AlertCircle, Eye, EyeOff, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useSession, useNeedsSetup } from '@/lib/session';
import { signIn, signUpFirstAdmin, AuthError, SESSION_KEY, NEEDS_SETUP_KEY } from '@/lib/auth';
import { pwnedCount } from '@/lib/pwned';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/sign-in')({
  component: SignInPage,
});

type PwnedState = { status: 'idle' | 'checking' | 'safe' | 'breached' | 'error'; count: number };

const GLYPH_GRADIENT = 'linear-gradient(145deg, hsl(var(--primary)), #10b5a3)';

/**
 * Standalone auth screen (rendered outside the app shell by __root) in the Lua split layout: a form column
 * on the left, a brand/setup panel on the right. Two modes driven by /_setup — create-the-owner (first run,
 * with a live HIBP breach check on the password) and sign-in. Errors are GENERIC (anti-enumeration).
 */
function SignInPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const session = useSession();
  const needsSetup = useNeedsSetup();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pwned, setPwned] = useState<PwnedState>({ status: 'idle', count: 0 });

  const firstAdmin = needsSetup.data === true;

  // Live, debounced breach check on the new owner password (advisory — only gates setup, never sign-in).
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
    <div className="flex min-h-screen bg-background">
      {/* ── Form column ───────────────────────────────────────────────────────── */}
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-[380px]">
          <div className="mb-6 flex items-center gap-2.5">
            <Glyph />
            <span className="font-display text-[15px] font-bold tracking-tight">conti</span>
            <span className="rounded-[5px] border border-border px-1.5 py-px font-mono text-[10px] text-muted-foreground">
              {firstAdmin ? 'first run' : 'admin'}
            </span>
          </div>

          <h1 className="font-display text-[27px] font-bold leading-tight tracking-[-0.025em] text-foreground">
            {firstAdmin ? 'Create your owner account' : 'Sign in'}
          </h1>
          <p className="mt-2 max-w-[360px] text-[13.5px] leading-relaxed text-muted-foreground">
            {firstAdmin ? (
              <>
                You're the first one here. This account becomes the workspace{' '}
                <strong className="font-semibold text-foreground/80">owner</strong> — it controls every role and invite after it.
              </>
            ) : (
              'Welcome back.'
            )}
          </p>

          {error && (
            <div className="mt-5 flex items-center gap-2.5 rounded-[10px] border border-destructive/25 bg-destructive/[0.08] px-3 py-2.5">
              <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
              <span className="text-[12.5px] font-medium text-destructive">{error}</span>
            </div>
          )}

          <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
            {firstAdmin && (
              <Field label="Name" htmlFor="name">
                <input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  placeholder="Your name"
                  className={inputCls}
                />
              </Field>
            )}
            <Field label="Email" htmlFor="email">
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/70" />
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  placeholder="you@company.com"
                  className={cn(inputCls, 'pl-10')}
                />
              </div>
            </Field>
            <Field label="Password" htmlFor="password">
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/70" />
                <input
                  id="password"
                  type={show ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={firstAdmin ? 'new-password' : 'current-password'}
                  placeholder="••••••••"
                  className={cn(inputCls, 'pl-10 pr-10')}
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/70 hover:text-foreground"
                  aria-label={show ? 'Hide password' : 'Show password'}
                >
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {firstAdmin && pwned.status !== 'idle' && <BreachHint state={pwned} />}
            </Field>

            <Button type="submit" className="!mt-6 w-full gap-2" disabled={busy || breached}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {firstAdmin ? 'Create owner account' : 'Sign in'}
              {!busy && <ArrowRight className="h-4 w-4" />}
            </Button>
          </form>

          <p className="mt-4 flex items-center gap-1.5 text-[11.5px] text-muted-foreground/80">
            <ShieldCheck className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
            {firstAdmin ? 'Created locally on your conti instance — no data leaves the server.' : 'Signing in to your conti instance.'}
          </p>
        </div>
      </div>

      {/* ── Brand / setup panel (desktop only) ────────────────────────────────── */}
      {firstAdmin ? <OwnerSetupPanel /> : <SignInBrandPanel />}
    </div>
  );
}

const inputCls =
  'h-11 w-full rounded-[10px] border border-input bg-background px-3.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/15';

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-[12.5px] font-semibold text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** The brand glyph — a gradient square with an inset rotated diamond (matches the Lua mark). */
function Glyph({ size = 32 }: { size?: number }) {
  const inner = Math.round(size * 0.34);
  return (
    <div
      className="relative flex shrink-0 items-center justify-center rounded-[28%]"
      style={{ width: size, height: size, background: GLYPH_GRADIENT, boxShadow: '0 4px 14px hsl(var(--primary) / 0.3)' }}
    >
      <div style={{ width: inner, height: inner, background: '#fff', borderRadius: 3, transform: 'rotate(45deg)' }} />
    </div>
  );
}

/** Dark, calm setup panel for the first-run owner screen — the three TRUE security marks. */
function OwnerSetupPanel() {
  return (
    <div className="relative hidden w-[42%] max-w-[560px] shrink-0 flex-col justify-between overflow-hidden bg-[#15131b] p-12 lg:flex">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-[18%] -top-[20%] h-[55%] w-[72%] rounded-full blur-[70px]"
        style={{ background: 'radial-gradient(circle, hsl(var(--primary) / 0.6), transparent 64%)', opacity: 0.6 }}
      />
      <div className="relative z-10 flex items-center gap-3">
        <Glyph size={40} />
        <div className="leading-tight">
          <div className="font-display text-[17px] font-bold tracking-tight text-white">conti</div>
          <div className="font-mono text-[10.5px] text-white/50">first run · setup</div>
        </div>
      </div>

      <div className="relative z-10">
        <div className="mb-5 flex flex-wrap gap-2">
          <Chip icon={<ShieldCheck className="h-3 w-3 text-emerald-400" />}>Checked against Have I Been Pwned</Chip>
          <Chip icon={<Lock className="h-3 w-3 text-[#10b5a3]" />}>httpOnly, revocable sessions</Chip>
          <Chip icon={<Users className="h-3 w-3 text-white/60" />}>Role-based access</Chip>
        </div>
        <p className="m-0 text-[18px] font-medium leading-snug tracking-[-0.01em] text-white/90">
          You're setting up <strong className="font-bold text-white">conti</strong> — this first account owns the workspace.
        </p>
      </div>

      <div className="relative z-10 font-mono text-[11px] tracking-wide text-white/40">self-hosted · open source</div>
    </div>
  );
}

/** Minimal light brand panel for the returning sign-in screen. */
function SignInBrandPanel() {
  return (
    <div className="relative hidden w-[42%] max-w-[560px] shrink-0 items-center justify-center overflow-hidden bg-[#efeee7] p-12 dark:bg-muted lg:flex">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-[18%] -top-[24%] h-[50%] w-[70%] rounded-full blur-[60px]"
        style={{ background: 'radial-gradient(circle, hsl(var(--primary) / 0.2), transparent 66%)' }}
      />
      <div className="relative z-10 text-center">
        <div className="mx-auto mb-4">
          <Glyph size={52} />
        </div>
        <div className="font-display text-[22px] font-bold tracking-[-0.02em] text-[#1a1812] dark:text-foreground">conti</div>
        <div className="mt-1.5 font-mono text-[11px] text-muted-foreground">files-first headless CMS</div>
      </div>
    </div>
  );
}

function Chip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.07] px-2.5 py-1.5 text-[11.5px] font-semibold text-white/75">
      {icon}
      {children}
    </span>
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
        <span className="font-mono text-[10px] text-muted-foreground/70">HIBP ✓</span>
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
