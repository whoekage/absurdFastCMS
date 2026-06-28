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

/** Sign-in was rate-limited (429). `retryAfterSeconds` drives the "too many attempts" cooldown. */
export class RateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super('Too many attempts.');
  }
}

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
  if (res.status === 429) {
    // Too many attempts from this source. X-Retry-After (seconds) drives the cooldown; default to 5 min when
    // it's unreadable (e.g. a cross-origin response that didn't expose the header).
    const hdr = res.headers.get('x-retry-after') ?? res.headers.get('retry-after');
    const secs = Number(hdr);
    throw new RateLimitError(Number.isFinite(secs) && secs > 0 ? Math.ceil(secs) : 300);
  }
  // ONE generic message regardless of which field was wrong (anti-enumeration).
  if (!res.ok) throw new AuthError('Invalid email or password.');
}

/** Create the FIRST admin. The server enforces the password policy + the HIBP breach check (hooks.before),
 *  so we surface ITS message (e.g. "This password has appeared in a known data breach…"); not an enumeration
 *  surface here — this is the operator creating their own account. */
export async function signUpFirstAdmin(email: string, password: string, name: string): Promise<void> {
  const res = await postJson('/auth/sign-up/email', { email, password, name });
  if (!res.ok) {
    const serverMessage = await errorMessageOf(res);
    throw new AuthError(serverMessage ?? 'Could not create the account. Use a valid email and a password of at least 8 characters.');
  }
}

/** Pull better-auth's `message` off an error response (its APIError serializes `{ message, code }`). */
async function errorMessageOf(res: Response): Promise<string | undefined> {
  try {
    const data = (await res.json()) as { message?: unknown };
    return typeof data.message === 'string' && data.message.length > 0 ? data.message : undefined;
  } catch {
    return undefined;
  }
}

export async function signOut(): Promise<void> {
  try {
    await postJson('/auth/sign-out', {});
  } catch {
    /* best-effort: even if the server call fails, the caller still purges local session state */
  }
}
