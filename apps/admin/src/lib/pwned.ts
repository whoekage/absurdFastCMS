/**
 * Client mirror of the server's HIBP module (packages/api/src/auth/pwned-passwords.ts) so the live form
 * indicator and the server's enforcing `hooks.before` agree on the same verdict + threshold. "Have I Been
 * Pwned" Pwned-Passwords range API — FREE, no key, k-ANONYMITY: SHA-1 the password and send ONLY the first
 * 5 hex chars; match the suffix locally. The password and its full hash NEVER leave the browser. `null` =
 * HIBP unreachable → the caller fails OPEN (the breach check is defence-in-depth, never a hard gate). The
 * browser sends its own User-Agent (HIBP needs one) and crypto.subtle works on https + http://localhost.
 */

const PWNED_RANGE_ENDPOINT = 'https://api.pwnedpasswords.com/range';
const PWNED_TIMEOUT_MS = 2500;

export type PwnedVerdict = 'ok' | 'compromised' | 'unavailable';

/** Breach COUNT (`>= 0`; `0` = not in the corpus), or `null` when HIBP couldn't be reached (→ fail open). */
export async function pwnedBreachCount(password: string): Promise<number | null> {
  if (!password) return 0;
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PWNED_TIMEOUT_MS);
  try {
    const res = await fetch(`${PWNED_RANGE_ENDPOINT}/${prefix}`, { headers: { 'Add-Padding': 'true' }, signal: controller.signal });
    if (!res.ok) return null;
    for (const line of (await res.text()).split('\n')) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      if (line.slice(0, colon).trim().toUpperCase() === suffix) {
        const n = Number.parseInt(line.slice(colon + 1), 10);
        return Number.isFinite(n) ? n : 0;
      }
    }
    return 0;
  } catch {
    return null; // timeout / network / CORS failure → "no answer"
  } finally {
    clearTimeout(timer);
  }
}

/** `null` → 'unavailable'; `count >= threshold` → 'compromised'; else 'ok'. threshold 1 = NIST 800-63B. */
export function pwnedVerdict(count: number | null, threshold = 1): PwnedVerdict {
  if (count === null) return 'unavailable';
  return count >= Math.max(1, threshold) ? 'compromised' : 'ok';
}
