import type { ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Mail, ShieldAlert, ArrowRight, ArrowLeft, Lock, Check, Clock, Monitor, Smartphone, X, MailCheck } from 'lucide-react';

/**
 * A static, pixel-for-pixel rendering of the Lua Auth Flow design screens that don't yet have a backend
 * (verify / forgot / reset / invite / lockout / session-expired / signed-out / account-security). It is a
 * VISUAL reference + ready-to-wire markup — not a live flow. Standalone (bypasses the shell + auth gate via
 * __root). The two screens that ARE live (create-owner + sign-in) render at /sign-in.
 */

const ACCENT = '#4f5bd5';
const ACCENT2 = '#10b5a3';
const GLYPH = `linear-gradient(145deg, ${ACCENT}, ${ACCENT2})`;
const SHADOW = '0 22px 60px -16px rgba(22,18,32,0.22), 0 2px 6px rgba(0,0,0,0.04)';
const SHADOW_RM = '0 22px 60px -16px rgba(22,18,32,0.16), 0 2px 6px rgba(0,0,0,0.03)';
const CARD = 'overflow-hidden rounded-[18px] border bg-white';

export const Route = createFileRoute('/auth-gallery')({ component: Gallery });

function Gallery() {
  return (
    <div className="min-h-screen bg-[#eceae4] px-10 py-12" style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif", color: '#18171a' }}>
      <div className="mx-auto max-w-[1120px] space-y-12">
        <h2 className="text-[15px] font-bold text-[#46464f]">Lua Auth Flow — roadmap screens (static UI 1:1)</h2>
        <Section n="1.3" title="Verify email" path="/admin/verify"><VerifyEmail /></Section>
        <Section n="2.2" title="Forgot password" path="/admin/forgot" roadmap><ForgotPassword /></Section>
        <Section n="2.3" title="Check your inbox" path="link sent" roadmap><CheckInbox /></Section>
        <Section n="2.4" title="Set a new password" path="/admin/reset?token=…" roadmap><ResetPassword /></Section>
        <Section n="3.1" title="Accept invitation" path="/invite/8fa3c1" roadmap><AcceptInvite /></Section>
        <Section n="3.2" title="Too many attempts" path="rate-limited"><Locked /></Section>
        <Section n="3.3" title="Session expired" path="re-auth"><SessionExpired /></Section>
        <Section n="3.4" title="Signed out" path="/admin/logout"><SignedOut /></Section>
        <Section n="4.2" title="Account & security" path="/admin/account/security" roadmap><AccountSecurity /></Section>
      </div>
    </div>
  );
}

function Section({ n, title, path, roadmap, children }: { n: string; title: string; path: string; roadmap?: boolean; children: ReactNode }) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2.5 text-[13.5px] font-semibold text-[#46464f]">
        <span className="inline-flex h-[21px] min-w-[34px] items-center justify-center rounded-md px-[7px] font-mono text-[11px] font-semibold text-white" style={{ background: roadmap ? '#b0b0bc' : ACCENT }}>
          {n}
        </span>
        {title}
        <span className="rounded-md border border-black/[0.07] bg-black/[0.04] px-2 py-0.5 font-mono text-[11px] font-medium text-[#8a8a96]">{path}</span>
        {roadmap && <span className="rounded-md border px-[7px] py-0.5 font-mono text-[10px] font-semibold" style={{ color: '#a86a18', background: 'rgba(202,138,58,0.12)', borderColor: 'rgba(202,138,58,0.3)' }}>roadmap</span>}
      </div>
      {children}
    </div>
  );
}

function Glyph({ size }: { size: number }) {
  const inner = Math.round(size * 0.345);
  return (
    <div className="relative flex shrink-0 items-center justify-center" style={{ width: size, height: size, borderRadius: size * 0.28, background: GLYPH, boxShadow: `0 4px 12px ${ACCENT}47` }}>
      <div style={{ width: inner, height: inner, background: '#fff', borderRadius: 3, transform: 'rotate(45deg)' }} />
    </div>
  );
}

function PrimaryBtn({ children }: { children: ReactNode }) {
  return (
    <button type="button" className="flex w-full items-center justify-center gap-2 rounded-[11px] py-3 text-[14px] font-semibold text-white" style={{ background: ACCENT, boxShadow: `0 8px 20px ${ACCENT}47` }}>
      {children}
    </button>
  );
}

const labelCls = 'mb-[7px] block text-[12.5px] font-semibold text-[#5a5a66]';
const inputBox = 'h-[44px] w-full rounded-[10px] border border-black/[0.12] bg-white px-[13px] text-[14px] text-[#18171a] placeholder:text-[#a8a8b2]';
const iconLeft = 'pointer-events-none absolute left-[13px] top-1/2 h-4 w-4 -translate-y-1/2 text-[#a8a8b2]';
const backRow = 'inline-flex items-center gap-1.5 text-[12.5px] font-semibold';

// ── 1.3 Verify email (OTP) ────────────────────────────────────────────────────
function VerifyEmail() {
  return (
    <CenteredCard bg="#f4f3ef">
      <IconCircle><Mail className="h-[26px] w-[26px]" strokeWidth={1.8} /></IconCircle>
      <h1 className="text-center text-[21px] font-bold tracking-[-0.02em] text-[#16141c]">Verify your email</h1>
      <p className="mt-2 text-center text-[13px] leading-[1.55] text-[#6a6a76]">
        We sent a 6-digit code to<br /><strong className="font-semibold text-[#3a3a44]">mara@acme.io</strong>. Enter it to finish setup.
      </p>
      <div className="my-[22px] flex justify-center gap-[9px]">
        {['2', '4', '8', '1'].map((d) => (
          <div key={d} className="flex h-14 w-[46px] items-center justify-center rounded-[11px] border border-black/[0.12] bg-[#fafafa] font-mono text-[24px] font-semibold text-[#18171a]">{d}</div>
        ))}
        <div className="flex h-14 w-[46px] items-center justify-center rounded-[11px] border bg-white" style={{ borderColor: ACCENT, boxShadow: `0 0 0 3px ${ACCENT}26` }}>
          <span className="inline-block h-6 w-0.5 animate-pulse" style={{ background: ACCENT }} />
        </div>
        <div className="h-14 w-[46px] rounded-[11px] border border-black/[0.12] bg-[#fafafa]" />
      </div>
      <PrimaryBtn>Verify &amp; continue</PrimaryBtn>
      <div className="mt-4 text-center text-[12.5px] text-[#8a8a96]">Didn't get it? <span className="text-[#b0b0bc]">Resend in</span> <span className="font-mono text-[#6a6a76]">0:42</span></div>
    </CenteredCard>
  );
}

// ── 2.2 Forgot password ────────────────────────────────────────────────────────
function ForgotPassword() {
  return (
    <CenteredCard bg="#f4f3ef" dashed>
      <IconCircle><Lock className="h-6 w-6" strokeWidth={1.8} /></IconCircle>
      <h1 className="text-[20px] font-bold tracking-[-0.02em] text-[#16141c]">Reset your password</h1>
      <p className="mb-[22px] mt-2 text-[13px] leading-[1.55] text-[#6a6a76]">Enter the email on your account and we'll send a secure, single-use reset link.</p>
      <label className={labelCls}>Email</label>
      <div className="relative mb-[18px]">
        <Mail className={iconLeft} strokeWidth={1.9} />
        <input placeholder="you@company.com" className={`${inputBox} pl-[38px]`} />
      </div>
      <PrimaryBtn>Send reset link</PrimaryBtn>
      <div className="mt-5 border-t border-black/[0.06] pt-4 text-center">
        <span className={backRow} style={{ color: ACCENT }}><ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.2} />Back to sign in</span>
      </div>
    </CenteredCard>
  );
}

// ── 2.3 Check your inbox ───────────────────────────────────────────────────────
function CheckInbox() {
  return (
    <CenteredCard bg="#f4f3ef" dashed>
      <IconCircle><MailCheck className="h-[26px] w-[26px]" strokeWidth={1.7} /></IconCircle>
      <h1 className="text-center text-[20px] font-bold tracking-[-0.02em] text-[#16141c]">Check your inbox</h1>
      <p className="mb-5 mt-2 text-center text-[13px] leading-[1.55] text-[#6a6a76]">
        We sent a reset link to <strong className="font-semibold text-[#3a3a44]">m•••@acme.io</strong>. The link expires in <span className="font-mono">30 min</span>.
      </p>
      <div className="mb-5 rounded-[13px] border border-black/[0.07] bg-[#faf9f6] px-[14px] py-[13px] text-left">
        <div className="mb-[9px] flex items-center gap-[9px]">
          <Glyph size={26} />
          <div className="leading-[1.3]"><div className="text-[12px] font-semibold text-[#2a2a33]">conti Security</div><div className="text-[10.5px] text-[#9a9aa6]">no-reply@conti.local</div></div>
        </div>
        <div className="mb-[3px] text-[12.5px] font-semibold text-[#2a2a33]">Reset your password</div>
        <div className="text-[11.5px] leading-[1.4] text-[#8a8a96]">Click the button below to choose a new password. If you didn't request this, ignore this email.</div>
      </div>
      <PrimaryBtn>Open email app</PrimaryBtn>
      <div className="mt-[14px] text-center text-[12.5px] text-[#8a8a96]">Didn't arrive? <span className="text-[#b0b0bc]">Resend in</span> <span className="font-mono text-[#6a6a76]">0:58</span></div>
    </CenteredCard>
  );
}

// ── 2.4 Set a new password (split, "how we store it") ──────────────────────────
const SECURITY_CHECKS = [
  'Passwords checked against Have I Been Pwned',
  'Server-side sessions you can revoke',
  'httpOnly session cookies — no tokens in the browser',
  'Role-based access control',
];
function ResetPassword() {
  return (
    <SplitCard dashed>
      <div className="flex flex-1 flex-col justify-center px-[50px] py-[44px]">
        <IconSquare><Lock className="h-[22px] w-[22px]" strokeWidth={1.9} /></IconSquare>
        <h1 className="mt-5 text-[27px] font-bold tracking-[-0.025em] text-[#16141c]">Set a new password</h1>
        <p className="mb-[26px] mt-2 max-w-[380px] text-[13.5px] leading-[1.55] text-[#6a6a76]">Choose a strong password you haven't used on conti before. You'll be signed in right after.</p>
        <label className={labelCls}>New password</label>
        <input type="password" defaultValue="v0lt-runner-9X" className="h-[42px] w-full rounded-[10px] border bg-white px-[13px] text-[14px] text-[#18171a]" style={{ borderColor: ACCENT, boxShadow: `0 0 0 3px ${ACCENT}26` }} />
        <StrengthRow />
        <label className={`${labelCls} mt-[15px]`}>Confirm new password</label>
        <div className="relative">
          <input type="password" defaultValue="v0lt-runner-9X" className="h-[42px] w-full rounded-[10px] border border-black/[0.12] bg-white px-[13px] pr-10 text-[14px] text-[#18171a]" />
          <Check className="absolute right-[13px] top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-[#15a86b]" strokeWidth={2.6} />
        </div>
        <div className="mt-6"><PrimaryBtn>Update password &amp; sign in <ArrowRight className="h-4 w-4" strokeWidth={2.4} /></PrimaryBtn></div>
      </div>
      <SecurityPanel />
    </SplitCard>
  );
}
function StrengthRow() {
  return (
    <>
      <div className="mt-[9px] flex gap-[5px]">{[0, 1, 2, 3].map((i) => <span key={i} className="h-1 flex-1 rounded-[3px]" style={{ background: '#15a86b' }} />)}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
        <span className="flex items-center gap-1.5 font-semibold text-[#15a86b]"><Check className="h-3 w-3" strokeWidth={2.6} />Strong</span>
        <span className="h-[11px] w-px bg-black/[0.12]" />
        <span className="text-[#6a8a76]">Not found in any known breach</span>
        <span className="font-mono text-[10px] text-[#b0b0bc]">HIBP ✓</span>
      </div>
    </>
  );
}
function SecurityPanel() {
  return (
    <div className="relative hidden w-[392px] shrink-0 flex-col justify-between px-[38px] py-10 lg:flex" style={{ background: '#efeee7' }}>
      <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-[#8a8576]">how we store it</div>
      <div>
        <h2 className="mb-[18px] text-[26px] font-bold leading-[1.12] tracking-[-0.026em] text-[#1a1812]">What's actually protecting this.</h2>
        <div className="flex flex-col gap-[11px]">
          {SECURITY_CHECKS.map((s) => (
            <div key={s} className="flex items-start gap-[11px]">
              <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] text-[#15a86b]" style={{ background: 'rgba(21,168,107,0.14)' }}><Check className="h-[13px] w-[13px]" strokeWidth={2.6} /></span>
              <span className="text-[13px] font-medium leading-[1.4] text-[#3a3830]">{s}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="font-mono text-[11px] tracking-[0.03em] text-[#9a9588]">self-hosted · open source</div>
    </div>
  );
}

// ── 3.1 Accept invitation (split) ──────────────────────────────────────────────
function AcceptInvite() {
  return (
    <SplitCard dashed>
      <div className="flex flex-1 flex-col justify-center px-[50px] py-[44px]">
        <div className="mb-[22px] flex items-center gap-[11px]">
          <div className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[11px] text-[14px] font-bold text-white" style={{ background: GLYPH }}>DP</div>
          <div className="leading-[1.35]"><div className="text-[13px] text-[#6a6a76]"><strong className="font-semibold text-[#2a2a33]">Devon Park</strong> invited you</div><div className="text-[11.5px] text-[#9a9aa6]">2 hours ago · expires in 7 days</div></div>
        </div>
        <h1 className="text-[27px] font-bold tracking-[-0.025em] text-[#16141c]">Join the conti workspace</h1>
        <p className="mb-6 mt-2 text-[13.5px] leading-[1.55] text-[#6a6a76]">
          You're joining as <span className="inline-flex items-center gap-1.5 rounded-[7px] px-2 py-0.5 align-middle text-[12.5px] font-semibold" style={{ background: `${ACCENT}1f`, color: ACCENT }}><span className="h-1.5 w-1.5 rounded-full" style={{ background: ACCENT }} />Editor</span>. Set your name and a password to accept.
        </p>
        <label className={labelCls}>Name</label>
        <input placeholder="Your name" className={`${inputBox} mb-[15px]`} />
        <label className={labelCls}>Email</label>
        <div className="mb-[15px] flex items-center gap-[9px] rounded-[10px] border border-black/[0.08] bg-[#f6f5f2] px-[13px] py-[11px]">
          <Mail className="h-[15px] w-[15px] text-[#a8a8b2]" strokeWidth={1.9} />
          <span className="flex-1 text-[14px] text-[#6a6a76]">luca@studio.io</span>
          <span className="rounded-[5px] border border-black/[0.08] bg-white px-1.5 py-px font-mono text-[10px] text-[#9a9aa6]">locked</span>
        </div>
        <label className={labelCls}>Create password</label>
        <input type="password" placeholder="••••••••••" className={inputBox} />
        <div className="mt-6"><PrimaryBtn>Accept &amp; join <ArrowRight className="h-4 w-4" strokeWidth={2.4} /></PrimaryBtn></div>
        <p className="mt-4 text-center text-[11.5px] text-[#a2a2ae]">Not <span className="font-mono text-[#6a6a76]">luca@studio.io</span>? <span className="font-semibold" style={{ color: ACCENT }}>Decline invite</span></p>
      </div>
      <div className="relative hidden w-[392px] shrink-0 flex-col justify-between px-[38px] py-10 lg:flex" style={{ background: '#efeee7' }}>
        <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-[#8a8576]">you've been invited</div>
        <div>
          <div className="mb-5 flex items-center gap-[13px]">
            <Glyph size={48} />
            <div className="leading-[1.3]"><div className="text-[18px] font-bold text-[#1a1812]">conti</div><div className="font-mono text-[11px] text-[#9a9588]">conti.local</div></div>
          </div>
          <p className="mb-[18px] text-[13.5px] leading-[1.55] text-[#5e5a4e]">Join <strong className="font-semibold text-[#1a1812]">8 teammates</strong> already managing content here.</p>
          <div className="flex items-center">
            {['DP', 'AT', 'PN', 'LR'].map((m, i) => (
              <div key={m} className="flex h-[34px] w-[34px] items-center justify-center rounded-full text-[11.5px] font-bold text-white" style={{ background: GLYPH, marginRight: -9, border: '2px solid #efeee7', zIndex: 4 - i }}>{m}</div>
            ))}
            <div className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-black/[0.06] text-[11.5px] font-bold text-[#6a6a76]" style={{ border: '2px solid #efeee7' }}>+4</div>
          </div>
        </div>
        <div className="font-mono text-[11px] tracking-[0.03em] text-[#9a9588]">self-hosted · open source</div>
      </div>
    </SplitCard>
  );
}

// ── 3.2 Too many attempts ──────────────────────────────────────────────────────
function Locked() {
  return (
    <CenteredCard bg="#f5f1ec">
      <div className="mx-auto mb-[18px] flex h-[54px] w-[54px] items-center justify-center rounded-[15px]" style={{ background: 'rgba(200,90,30,0.12)', color: '#c0561f' }}><ShieldAlert className="h-[26px] w-[26px]" strokeWidth={1.8} /></div>
      <h1 className="text-center text-[20px] font-bold tracking-[-0.02em] text-[#16141c]">Too many attempts</h1>
      <p className="mb-[18px] mt-2 text-center text-[13px] leading-[1.55] text-[#6a6a76]">For your security, sign-in is paused for this account. Try again in</p>
      <div className="text-center font-mono text-[40px] font-semibold tracking-[-0.02em]" style={{ color: '#c0561f' }}>04:58</div>
      <div className="mb-[22px] mt-1.5 flex justify-center gap-1.5">{[0, 1, 2, 3, 4].map((i) => <span key={i} className="h-[9px] w-[9px] rounded-full" style={{ background: '#c0561f' }} />)}</div>
      <button type="button" className="w-full rounded-[11px] border border-black/[0.12] bg-white py-[11px] text-[13px] font-semibold text-[#3a3a44]">Contact your workspace admin</button>
      <div className="mt-[18px] flex items-center justify-center gap-1.5 border-t border-black/[0.06] pt-4 font-mono text-[10.5px] text-[#a8a8b2]"><Clock className="h-3 w-3" />attempt logged · IP 81.224·xx · Stockholm</div>
    </CenteredCard>
  );
}

// ── 3.3 Session expired ────────────────────────────────────────────────────────
function SessionExpired() {
  return (
    <CenteredCard bg="#f4f3ef" align="left">
      <IconSquare round><Clock className="h-6 w-6" strokeWidth={1.8} /></IconSquare>
      <h1 className="mt-[18px] text-[20px] font-bold tracking-[-0.02em] text-[#16141c]">Your session expired</h1>
      <p className="mb-5 mt-2 text-[13px] leading-[1.55] text-[#6a6a76]">You were signed out after 30 days of inactivity. Confirm your password to pick up where you left off.</p>
      <div className="mb-4 flex items-center gap-[11px] rounded-[12px] border border-black/[0.07] bg-[#f6f5f2] px-[13px] py-[11px]">
        <div className="flex h-9 w-9 items-center justify-center rounded-[10px] text-[13px] font-bold text-white" style={{ background: GLYPH }}>ML</div>
        <div className="min-w-0 flex-1 leading-[1.3]"><div className="text-[13px] font-semibold text-[#2a2a33]">Mara Lindqvist</div><div className="text-[11.5px] text-[#9a9aa6]">mara@acme.io</div></div>
        <span className="text-[11.5px] font-semibold" style={{ color: ACCENT }}>Not you?</span>
      </div>
      <label className={labelCls}>Password</label>
      <div className="relative mb-[18px]">
        <Lock className={iconLeft} strokeWidth={1.9} />
        <input type="password" defaultValue="edge-runner-22" className="h-[44px] w-full rounded-[10px] border bg-white pl-[38px] pr-[13px] text-[14px] text-[#18171a]" style={{ borderColor: ACCENT, boxShadow: `0 0 0 3px ${ACCENT}26` }} />
      </div>
      <PrimaryBtn>Resume session <ArrowRight className="h-4 w-4" strokeWidth={2.4} /></PrimaryBtn>
    </CenteredCard>
  );
}

// ── 3.4 Signed out ─────────────────────────────────────────────────────────────
function SignedOut() {
  return (
    <CenteredCard bg="#f4f3ef">
      <div className="mx-auto mb-5 flex h-[58px] w-[58px] items-center justify-center rounded-full text-[#15a86b]" style={{ background: 'rgba(21,168,107,0.12)' }}><Check className="h-7 w-7" strokeWidth={2.2} /></div>
      <h1 className="text-center text-[21px] font-bold tracking-[-0.02em] text-[#16141c]">You're signed out</h1>
      <p className="mb-6 mt-2 text-center text-[13px] leading-[1.55] text-[#6a6a76]">Your session on this device has ended. Every change was saved before you left.</p>
      <PrimaryBtn>Sign back in <ArrowRight className="h-4 w-4" strokeWidth={2.4} /></PrimaryBtn>
      <div className="mt-4 flex items-center justify-center gap-1.5 border-t border-black/[0.06] pt-4 font-mono text-[10.5px] text-[#a8a8b2]"><Check className="h-3 w-3 text-[#15a86b]" strokeWidth={2.2} />session cleared · cookie removed</div>
    </CenteredCard>
  );
}

// ── 4.2 Account & security (wide) ──────────────────────────────────────────────
const SESSIONS = [
  { device: 'MacBook Pro · Chrome', meta: 'Stockholm, SE · right now', current: true, phone: false },
  { device: 'iPhone 15 · Safari', meta: 'Stockholm, SE · 3h ago', current: false, phone: true },
  { device: 'Linux · Firefox', meta: 'Frankfurt, DE · 2d ago', current: false, phone: false },
];
const AUDIT = [
  { ok: true, event: 'Signed in', where: 'Stockholm, SE', ip: '81.224·xx', time: 'now' },
  { ok: true, event: 'Session revoked', where: 'Stockholm, SE', ip: '81.224·xx', time: '2d' },
  { ok: false, event: 'Failed sign-in', where: 'Unknown · Tor', ip: '185.220·xx', time: '5d' },
  { ok: true, event: 'Password changed', where: 'Stockholm, SE', ip: '81.224·xx', time: '12d' },
  { ok: true, event: 'Signed in', where: 'Berlin, DE', ip: '94.16·xx', time: '14d' },
];
function AccountSecurity() {
  return (
    <div className={`${CARD} flex flex-col border-dashed border-black/[0.16]`} style={{ boxShadow: SHADOW_RM, minHeight: 620 }}>
      <div className="border-b border-black/[0.06] px-7 pb-[18px] pt-6">
        <h1 className="mb-1 text-[19px] font-bold tracking-[-0.02em] text-[#16141c]">Account &amp; security</h1>
        <p className="text-[12.5px] text-[#8a8a96]">Manage how you sign in, where you're logged in, and review recent activity.</p>
      </div>
      <div className="grid flex-1 grid-cols-2 gap-[26px] px-7 py-[22px]">
        {/* left */}
        <div className="flex min-w-0 flex-col gap-[22px]">
          <div>
            <SectionLabel>Password</SectionLabel>
            <div className="flex items-center gap-[11px] rounded-[12px] border border-black/[0.07] bg-[#faf9f6] px-[14px] py-[13px]">
              <IconSquare sm><Lock className="h-[17px] w-[17px]" strokeWidth={1.9} /></IconSquare>
              <div className="min-w-0 flex-1 leading-[1.35]"><div className="text-[13px] font-semibold text-[#2a2a33]">Password</div><div className="text-[11px] text-[#9a9aa6]">Last changed 12 days ago · checked against HIBP</div></div>
              <span className="text-[11.5px] font-semibold" style={{ color: ACCENT }}>Change</span>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-[11px] flex items-center justify-between">
              <SectionLabel>Active sessions</SectionLabel>
              <span className="cursor-pointer text-[11.5px] font-semibold" style={{ color: '#c0561f' }}>Revoke all others</span>
            </div>
            <div className="flex flex-col gap-2">
              {SESSIONS.map((s) => (
                <div key={s.device} className="flex items-center gap-[11px] rounded-[11px] border border-black/[0.07] bg-[#faf9f6] px-[13px] py-[11px]">
                  <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-black/[0.05] text-[#7a7a88]">{s.phone ? <Smartphone className="h-[15px] w-[15px]" strokeWidth={1.9} /> : <Monitor className="h-[15px] w-[15px]" strokeWidth={1.9} />}</div>
                  <div className="min-w-0 flex-1 leading-[1.35]">
                    <div className="flex items-center gap-[7px] text-[12.5px] font-semibold text-[#2a2a33]">{s.device}{s.current && <span className="rounded-[5px] px-1.5 py-px text-[10px] font-bold text-[#15a86b]" style={{ background: 'rgba(21,168,107,0.12)' }}>This device</span>}</div>
                    <div className="text-[11px] text-[#9a9aa6]">{s.meta}</div>
                  </div>
                  {!s.current && <span className="text-[11px] font-semibold" style={{ color: '#c0561f' }}>Revoke</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
        {/* right: login history */}
        <div className="flex min-w-0 flex-col">
          <div className="mb-[11px] flex items-center justify-between">
            <SectionLabel>Login history</SectionLabel>
            <span className="font-mono text-[10.5px] text-[#a8a8b2]">last 30d</span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[13px] border border-black/[0.07] bg-[#faf9f6]">
            {AUDIT.map((a) => (
              <div key={`${a.event}-${a.time}`} className="flex items-center gap-[11px] border-b border-black/[0.05] px-[15px] py-[13px]">
                <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px]" style={{ background: a.ok ? 'rgba(21,168,107,0.13)' : 'rgba(192,86,31,0.13)', color: a.ok ? '#15a86b' : '#c0561f' }}>{a.ok ? <Check className="h-[13px] w-[13px]" strokeWidth={2.6} /> : <X className="h-[13px] w-[13px]" strokeWidth={2.6} />}</span>
                <div className="min-w-0 flex-1 leading-[1.4]"><div className="text-[12.5px] font-semibold text-[#2a2a33]">{a.event}</div><div className="text-[11px] text-[#9a9aa6]">{a.where} · <span className="font-mono">{a.ip}</span></div></div>
                <span className="shrink-0 text-[11px] text-[#a8a8b2]">{a.time}</span>
              </div>
            ))}
            <div className="px-[15px] py-[11px] text-center"><span className="text-[11.5px] font-semibold" style={{ color: ACCENT }}>View full history →</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}
function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-[#9898a8]">{children}</div>;
}

// ── shared scaffolds ───────────────────────────────────────────────────────────
function CenteredCard({ bg, dashed, align = 'center', children }: { bg: string; dashed?: boolean; align?: 'center' | 'left'; children: ReactNode }) {
  return (
    <div className={`${CARD} ${dashed ? 'border-dashed border-black/[0.16]' : 'border-black/[0.05]'} flex items-center justify-center`} style={{ background: bg, height: 560, boxShadow: dashed ? SHADOW_RM : SHADOW }}>
      <div className={`w-[380px] rounded-[20px] border border-black/[0.06] bg-white px-[34px] py-[34px] ${align === 'center' ? 'text-center' : ''}`} style={{ boxShadow: '0 24px 60px -18px rgba(22,18,32,0.22)' }}>
        {children}
      </div>
    </div>
  );
}
function SplitCard({ dashed, children }: { dashed?: boolean; children: ReactNode }) {
  return <div className={`${CARD} ${dashed ? 'border-dashed border-black/[0.16]' : 'border-black/[0.05]'} flex`} style={{ height: 560, boxShadow: dashed ? SHADOW_RM : SHADOW }}>{children}</div>;
}
function IconCircle({ children }: { children: ReactNode }) {
  return <div className="mx-auto mb-[18px] flex h-[54px] w-[54px] items-center justify-center rounded-[15px]" style={{ background: `${ACCENT}1f`, color: ACCENT }}>{children}</div>;
}
function IconSquare({ children, round, sm }: { children: ReactNode; round?: boolean; sm?: boolean }) {
  const size = sm ? 34 : round ? 52 : 46;
  return <div className="flex shrink-0 items-center justify-center" style={{ width: size, height: size, borderRadius: round ? 14 : 13, background: `${ACCENT}1f`, color: ACCENT }}>{children}</div>;
}
