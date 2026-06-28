import { resolveApiBase } from './runtime-config.ts';

/**
 * The admin auth client (better-auth over the content API). Hand-rolled fetch — no better-auth client dep —
 * because the surface is tiny (sign-in / first-admin sign-up / sign-out / get-session) and the session rides
 * an httpOnly cookie (`credentials: 'include'`), so there is no token for JS to hold (no localStorage =
 * no XSS-exfil class). Errors are GENERIC by design (anti-enumeration: never reveal whether an email exists).
 */

const base = resolveApiBase();

export const SESSION_KEY = ['auth', 'session'] as const;
export const NEEDS_SETUP_KEY = ['auth', 'needs-setup'] as const;

/** Broadcasts auth changes across tabs so a sign-out/expiry in one tab redirects the others. */
export const AUTH_CHANNEL = 'conti-auth';

export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
  role?: string | null;
  image?: string | null;
}

/** A failed auth action carrying an already-generic, user-facing message. */
export class AuthError extends Error {}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The current session user, or null when unauthenticated. NEVER throws — a dead/absent session is just null. */
export async function getSession(): Promise<SessionUser | null> {
  try {
    const res = await fetch(`${base}/auth/get-session`, { credentials: 'include' });
    if (!res.ok) return null;
    const data = (await res.json()) as { user?: SessionUser } | null;
    return data?.user ?? null;
  } catch {
    return null;
  }
}

/** Whether the instance still needs its first admin (zero super-admins) — drives sign-in vs create-first-admin. */
export async function getNeedsSetup(): Promise<boolean> {
  try {
    const res = await fetch(`${base}/_setup`, { credentials: 'include' });
    if (!res.ok) return false;
    return ((await res.json()) as { needsFirstAdmin?: boolean }).needsFirstAdmin === true;
  } catch {
    return false;
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  const res = await postJson('/auth/sign-in/email', { email, password });
  // ONE generic message regardless of which field was wrong (anti-enumeration).
  if (!res.ok) throw new AuthError('Invalid email or password.');
}

/** Create the FIRST admin (only succeeds while the instance has no super-admin — the server enforces it). */
export async function signUpFirstAdmin(email: string, password: string, name: string): Promise<void> {
  const res = await postJson('/auth/sign-up/email', { email, password, name });
  if (!res.ok) {
    throw new AuthError(
      res.status === 403
        ? 'Registration is closed — an administrator already exists.'
        : 'Could not create the account. Use a valid email and a password of at least 8 characters.',
    );
  }
}

export async function signOut(): Promise<void> {
  try {
    await postJson('/auth/sign-out', {});
  } catch {
    /* best-effort: even if the server call fails, the caller still purges local session state */
  }
}
