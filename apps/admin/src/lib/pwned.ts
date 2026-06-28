/**
 * "Have I Been Pwned" — Pwned Passwords range API. FREE, no API key, no rate limit, privacy-preserving via
 * k-ANONYMITY: we SHA-1 the password and send ONLY the first 5 hex chars of the digest; the API returns every
 * breached-hash suffix under that prefix and we match the rest LOCALLY. The password — and its full hash —
 * NEVER leave the browser. (`Add-Padding` makes the response a fixed size so even the prefix's popularity
 * doesn't leak.) Returns how many breach corpora the password appears in: 0 = not found in any known breach.
 *
 * crypto.subtle needs a secure context — true for https AND http://localhost (dev), so this works everywhere
 * the admin runs. Used only as ADVISORY UX on the first-admin password field (the operator picking their own
 * password); it is not a server-side gate.
 */
export async function pwnedCount(password: string): Promise<number> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { 'Add-Padding': 'true' } });
  if (!res.ok) throw new Error(`pwned range ${res.status}`);
  for (const line of (await res.text()).split('\n')) {
    const [suf, count] = line.trim().split(':');
    if (suf === suffix) return Number.parseInt(count ?? '0', 10) || 0;
  }
  return 0;
}
