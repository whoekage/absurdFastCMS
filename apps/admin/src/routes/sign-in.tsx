import { useState, useEffect, type FormEvent, type ReactNode } from 'react';
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, ShieldCheck, ShieldAlert, ArrowRight, Mail, Lock, AlertCircle, Eye, Check, Users, Shield } from 'lucide-react';
import { useSession, useNeedsSetup } from '@/lib/session';
import { signIn, signUpFirstAdmin, AuthError, SESSION_KEY, NEEDS_SETUP_KEY } from '@/lib/auth';
import { pwnedCount } from '@/lib/pwned';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/sign-in')({
  component: SignInPage,
});

// Pixel-for-pixel with the Lua Auth Flow design (variant A). The screen is always LIGHT regardless of the
// app theme — it renders outside the shell — so colors are the design's exact values, not theme tokens.
const ACCENT = '#4f5bd5';
const ACCENT2 = '#10b5a3';
const GLYPH = `linear-gradient(145deg, ${ACCENT}, ${ACCENT2})`;
const CARD_SHADOW = '0 22px 60px -16px rgba(22,18,32,0.22), 0 2px 6px rgba(0,0,0,0.04)';

type PwnedState = { status: 'idle' | 'checking' | 'safe' | 'breached' | 'error'; count: number };

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
  const str = strength(password);

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

  const form = (
    <div className="flex flex-1 flex-col justify-center px-[50px] py-[42px]">
      {/* brand row */}
      <div className="mb-6 flex items-center gap-2.5">
        <Glyph size={32} />
        <span className="text-[15px] font-bold tracking-[-0.01em] text-[#18171a]">conti</span>
        <span className="rounded-[5px] border border-black/[0.08] px-1.5 py-px font-mono text-[10.5px] text-[#a0a0ac]">
          {firstAdmin ? 'first run' : 'admin'}
        </span>
      </div>

      <h1 className="text-[27px] font-bold leading-[1.1] tracking-[-0.025em] text-[#16141c]">
        {firstAdmin ? 'Create your owner account' : 'Sign in'}
      </h1>
      <p className="mt-2 max-w-[400px] text-[13.5px] leading-[1.55] text-[#6a6a76]">
        {firstAdmin ? (
          <>
            You're the first one here. This account becomes the workspace{' '}
            <strong className="font-semibold text-[#3a3a44]">owner</strong> — it controls every role and invite after it.
          </>
        ) : (
          'Welcome back.'
        )}
      </p>

      {error && (
        <div
          className="mt-[18px] flex items-center gap-2.5 rounded-[10px] px-[13px] py-2.5"
          style={{ background: 'rgba(192,86,31,0.08)', border: '1px solid rgba(192,86,31,0.22)' }}
        >
          <AlertCircle className="h-4 w-4 shrink-0" style={{ color: '#c0561f' }} />
          <span className="text-[12.5px] font-medium" style={{ color: '#a8481f' }}>
            {error}
          </span>
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-7 flex flex-col gap-[17px]" noValidate>
        {firstAdmin && (
          <Field label="Name" htmlFor="name">
            <input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Your name" className={inputCls()} />
          </Field>
        )}
        <Field label="Email" htmlFor="email">
          <div className="relative">
            <Mail className="pointer-events-none absolute left-[13px] top-1/2 h-4 w-4 -translate-y-1/2 text-[#a8a8b2]" />
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              placeholder="you@company.com"
              className={inputCls('pl-[38px]')}
            />
          </div>
        </Field>
        <Field
          label="Password"
          htmlFor="password"
          aside={
            <button type="button" onClick={() => setShow((s) => !s)} className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[#9a9aa6] hover:text-[#5a5a66]">
              <Eye className="h-3.5 w-3.5" />
              {show ? 'Hide' : 'Show'}
            </button>
          }
        >
          <input
            id="password"
            type={show ? 'text' : 'password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={firstAdmin ? 'new-password' : 'current-password'}
            placeholder="••••••••"
            className={inputCls()}
          />
          {firstAdmin && password.length > 0 && (
            <>
              <div className="mt-[9px] flex gap-[5px]">
                {[0, 1, 2, 3].map((i) => (
                  <span key={i} className="h-1 flex-1 rounded-[3px]" style={{ background: i < str.score ? str.color : 'rgba(0,0,0,0.09)' }} />
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
                {str.label && (
                  <span className="flex items-center gap-1.5 font-semibold" style={{ color: str.color }}>
                    {str.score >= 4 && <Check className="h-3 w-3" strokeWidth={2.6} />}
                    {str.label}
                  </span>
                )}
                {pwned.status !== 'idle' && <span className="h-[11px] w-px bg-black/[0.12]" />}
                <BreachHint state={pwned} />
              </div>
            </>
          )}
        </Field>

        <button
          type="submit"
          disabled={busy || breached}
          className="mt-[9px] flex w-full items-center justify-center gap-2 rounded-[11px] py-[13px] text-[14.5px] font-semibold text-white transition hover:brightness-105 disabled:opacity-60"
          style={{ background: ACCENT, boxShadow: '0 8px 20px rgba(79,91,213,0.3)' }}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {firstAdmin ? 'Create owner account' : 'Sign in'}
          {!busy && <ArrowRight className="h-4 w-4" strokeWidth={2.4} />}
        </button>
      </form>

      <p className="mt-4 text-[11.5px] leading-[1.5] text-[#a2a2ae]">
        {firstAdmin ? 'This account is created locally on your conti instance. No data leaves the server.' : 'Signing in to your conti instance.'}
      </p>
    </div>
  );

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f1f0ec] p-6">
      <div
        className="flex w-full max-w-[1000px] overflow-hidden rounded-[18px] border border-black/[0.05] bg-white"
        style={{ boxShadow: CARD_SHADOW }}
      >
        {form}
        {firstAdmin ? <OwnerPanel /> : <SignInPanel />}
      </div>
    </div>
  );
}

function inputCls(extra?: string): string {
  return cn(
    'h-[42px] w-full rounded-[10px] border border-black/[0.12] bg-white px-[13px] text-[14px] text-[#18171a] outline-none transition placeholder:text-[#a8a8b2]',
    'focus:border-[#4f5bd5] focus:ring-[3px] focus:ring-[#4f5bd5]/[0.15]',
    extra,
  );
}

function Field({ label, htmlFor, aside, children }: { label: string; htmlFor: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-[7px] flex items-center justify-between">
        <label htmlFor={htmlFor} className="text-[12.5px] font-semibold text-[#5a5a66]">
          {label}
        </label>
        {aside}
      </div>
      {children}
    </div>
  );
}

/** The Lua brand glyph — gradient square with an inset white diamond. */
function Glyph({ size }: { size: number }) {
  const inner = Math.round(size * 0.345);
  return (
    <div
      className="relative flex shrink-0 items-center justify-center"
      style={{ width: size, height: size, borderRadius: size * 0.28, background: GLYPH, boxShadow: `0 4px 12px ${ACCENT}47` }}
    >
      <div style={{ width: inner, height: inner, background: '#fff', borderRadius: 3, transform: 'rotate(45deg)' }} />
    </div>
  );
}

/** Light setup panel (owner first-run) — the three TRUE security marks. */
function OwnerPanel() {
  return (
    <div className="relative hidden w-[392px] shrink-0 flex-col justify-between overflow-hidden px-[38px] py-[44px] lg:flex" style={{ background: '#efeee7' }}>
      <div
        aria-hidden
        className="pointer-events-none absolute -right-[20%] -top-[30%] h-[55%] w-[70%] rounded-full"
        style={{ background: `radial-gradient(circle, ${ACCENT}38, transparent 66%)`, filter: 'blur(64px)', mixBlendMode: 'multiply' }}
      />
      <div className="relative z-10 flex items-center gap-[11px]">
        <Glyph size={40} />
        <div className="leading-[1.15]">
          <div className="text-[17px] font-bold tracking-[-0.01em] text-[#1a1812]">conti</div>
          <div className="font-mono text-[10.5px] text-[#9a9588]">first run · setup</div>
        </div>
      </div>

      <div className="relative z-10">
        <div className="mb-5 flex flex-wrap gap-[7px]">
          <PanelChip icon={<Shield className="h-3 w-3" style={{ color: '#15a86b' }} />}>HIBP breach check</PanelChip>
          <PanelChip icon={<Lock className="h-3 w-3" style={{ color: ACCENT }} />}>httpOnly sessions</PanelChip>
          <PanelChip icon={<Users className="h-3 w-3" style={{ color: '#8a8576' }} />}>Role-based access</PanelChip>
        </div>
        <p className="text-[18px] font-medium leading-[1.45] tracking-[-0.01em] text-[#2a281f]">
          You're setting up <strong className="font-bold">conti</strong> — this first account owns the workspace.
        </p>
      </div>

      <div className="relative z-10 font-mono text-[11px] tracking-[0.03em] text-[#9a9588]">self-hosted · open source</div>
    </div>
  );
}

/** Minimal light brand panel (returning sign-in). */
function SignInPanel() {
  return (
    <div className="relative hidden w-[360px] shrink-0 items-center justify-center overflow-hidden p-10 lg:flex" style={{ background: '#efeee7' }}>
      <div
        aria-hidden
        className="pointer-events-none absolute -right-[18%] -top-[24%] h-[50%] w-[70%] rounded-full"
        style={{ background: `radial-gradient(circle, ${ACCENT}33, transparent 66%)`, filter: 'blur(60px)', mixBlendMode: 'multiply' }}
      />
      <div className="relative z-10 text-center">
        <div className="mx-auto mb-4 w-fit">
          <Glyph size={52} />
        </div>
        <div className="text-[22px] font-bold tracking-[-0.02em] text-[#1a1812]">conti</div>
        <div className="mt-1.5 font-mono text-[11px] text-[#9a9588]">self-hosted CMS</div>
      </div>
    </div>
  );
}

function PanelChip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-[5px] text-[11.5px] font-semibold text-[#5e5a4e]"
      style={{ background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(0,0,0,0.07)' }}
    >
      {icon}
      {children}
    </span>
  );
}

/** Live HIBP indicator (real, free, k-anonymity). Renders inline next to the strength label. */
function BreachHint({ state }: { state: PwnedState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'checking') {
    return (
      <span className="flex items-center gap-1.5 text-[#9a9aa6]">
        <Loader2 className="h-3 w-3 animate-spin" /> Checking…
      </span>
    );
  }
  if (state.status === 'safe') {
    return (
      <span className="flex items-center gap-1.5" style={{ color: '#6a8a76' }}>
        <ShieldCheck className="h-3 w-3" style={{ color: '#15a86b' }} /> Not found in any known breach
        <span className="font-mono text-[10px] text-[#b0b0bc]">HIBP ✓</span>
      </span>
    );
  }
  if (state.status === 'breached') {
    return (
      <span className="flex items-center gap-1.5 font-medium" style={{ color: '#c0561f' }}>
        <ShieldAlert className="h-3 w-3" /> Found in {state.count.toLocaleString()} breaches
      </span>
    );
  }
  return <span className="text-[#9a9aa6]">Breach service unreachable</span>;
}

/** A small password-strength heuristic for the meter (length + character variety). */
function strength(pw: string): { score: number; label: string; color: string } {
  if (!pw) return { score: 0, label: '', color: '#e0683b' };
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^a-zA-Z0-9]/.test(pw)) s++;
  const label = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][s] ?? 'Strong';
  const color = s >= 4 ? '#15a86b' : s === 3 ? '#7ba83b' : s === 2 ? '#d98b2b' : '#e0683b';
  return { score: s, label, color };
}
