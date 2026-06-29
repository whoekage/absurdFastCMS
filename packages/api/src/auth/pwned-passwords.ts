import { createHash } from 'node:crypto';

/**
 * HIBP Pwned Passwords — a PLAIN, framework-agnostic module (NO better-auth dependency). It answers ONE
 * question: how many known breaches does this password appear in (or "couldn't reach HIBP")? The thin
 * better-auth wiring (a `hooks.before` middleware in {@link buildAuth}) decides what to DO with the answer.
 *
 * WHY a module, not the better-auth `haveIBeenPwned` PLUGIN: that plugin (a) FAILS CLOSED — a HIBP outage
 * throws INTERNAL_SERVER_ERROR inside `password.hash`, taking sign-up/change-password DOWN; (b) ignores the
 * per-row COUNT (no threshold; the `Add-Padding` decoys aren't filtered by intent); (c) sets no request
 * timeout. A breach check is DEFENCE-IN-DEPTH, not a hard gate, so this module returns a value and lets the
 * caller fail OPEN by default. (See docs / the [[trigram-index-wiring]]-style research note for the survey.)
 */

/** The HIBP k-anonymity range endpoint. The full hash / password NEVER leaves this process. */
const PWNED_RANGE_ENDPOINT = 'https://api.pwnedpasswords.com/range';
/** HIBP returns HTTP 403 for a missing/abusive User-Agent — identify THIS consumer (their explicit ask). */
const PWNED_USER_AGENT = 'conti-cms-pwned-check';
/** A HIBP call sits in the sign-up critical path; cap it so a slow HIBP can't hang auth (we fail open). */
const PWNED_TIMEOUT_MS = 2500;

export interface PwnedQueryOptions {
  /** Override the range endpoint (tests point this at an unreachable host to exercise the fail-open path). */
  endpoint?: string;
  userAgent?: string;
  timeoutMs?: number;
}

/**
 * Query HIBP by k-ANONYMITY: SHA-1 the password, send ONLY the 5-char hash prefix to `/range/{prefix}`,
 * match the suffix LOCALLY. Returns the breach COUNT (`>= 0`; `0` = the suffix is not in the corpus), or
 * `null` when HIBP could NOT be reached (timeout / network error / non-2xx) so the caller can fail OPEN.
 *
 * `Add-Padding: true` pads every response to 800-1000 rows to defeat response-size traffic analysis; we read
 * the per-row COUNT, so the count-0 padding decoys are inert — a genuinely-pwned suffix carries `count >= 1`,
 * and matching by count (not mere presence) is also what makes a `threshold` possible. NEVER logs the
 * password (only the 5-char prefix ever travels, and we log nothing here).
 */
export async function pwnedBreachCount(password: string, opts: PwnedQueryOptions = {}): Promise<number | null> {
  if (!password) return 0;
  const endpoint = opts.endpoint ?? PWNED_RANGE_ENDPOINT;
  const hash = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PWNED_TIMEOUT_MS);
  try {
    const res = await fetch(`${endpoint}/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': opts.userAgent ?? PWNED_USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) return null; // HIBP unhealthy → "no answer" (caller fails open)
    const body = await res.text();
    // Each line is `<SUFFIX>:<count>` (suffix UPPERCASE hex). Find OUR suffix; read its count.
    for (const line of body.split('\n')) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      if (line.slice(0, colon).trim().toUpperCase() === suffix) {
        const n = Number.parseInt(line.slice(colon + 1), 10);
        return Number.isFinite(n) ? n : 0;
      }
    }
    return 0; // suffix not present → not pwned
  } catch {
    return null; // abort (timeout) / network failure → "no answer" (caller fails open)
  } finally {
    clearTimeout(timer);
  }
}

export type PwnedVerdict = 'ok' | 'compromised' | 'unavailable';

/**
 * Turn a {@link pwnedBreachCount} result into a verdict. `null` → `'unavailable'` (the caller picks fail-open
 * vs fail-closed). `count >= threshold` → `'compromised'`. Otherwise `'ok'`. `threshold` defaults to 1 (NIST
 * 800-63B: reject a password that appears in the breach corpus AT ALL); raise it to tolerate low-frequency
 * appearances.
 */
export function pwnedVerdict(count: number | null, threshold = 1): PwnedVerdict {
  if (count === null) return 'unavailable';
  return count >= Math.max(1, threshold) ? 'compromised' : 'ok';
}
