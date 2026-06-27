import type uWS from 'uWebSockets.js';

/**
 * CORS + cross-origin CSRF policy for the content API. ACTIVE ONLY when `cors.trustedOrigins` is configured
 * (the admin / a trusted frontend runs on a DIFFERENT origin than the API). Same-origin deploys build NO
 * policy (`null`) and every CORS code path is skipped — the hot read path stays byte-identical.
 *
 * Design (from an OWASP + Directus + Payload + better-auth audit): ONE exact-match allowlist drives both
 * CORS (which browser origins may READ our credentialed responses) and CSRF (which origins may WRITE) —
 * they are the same trust set. Invariants the vuln class taught us: NEVER `*` with credentials; the granted
 * `Access-Control-Allow-Origin` is ALWAYS the exact request origin (never reflect-arbitrary); `Vary: Origin`
 * on every response so a shared cache can't replay one origin's grant to another; and a state-changing WRITE
 * additionally requires an allowlisted Origin — the defense once SameSite=None cookies (needed cross-origin)
 * remove SameSite's built-in CSRF protection.
 */

const ALLOW_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization, Accept-Language, Idempotency-Key, If-Match, x-api-key';
const MAX_AGE = '600';

export interface CorsPolicy {
  /** Origins allowed to READ credentialed responses (CORS allowlist). */
  readonly read: ReadonlySet<string>;
  /** Origins allowed to make state-changing WRITES (CSRF) = read ∪ the API's own origin. */
  readonly write: ReadonlySet<string>;
}

/** Build the policy, or `null` when CORS is off (no trusted origins → all CORS logic is skipped). */
export function buildCorsPolicy(trustedOrigins: readonly string[], ownOrigin: string | undefined): CorsPolicy | null {
  if (trustedOrigins.length === 0) return null;
  const read = new Set(trustedOrigins);
  const write = new Set(read);
  if (ownOrigin) write.add(ownOrigin);
  return { read, write };
}

/** CORS response headers for a credentialed request: ACAO echo + credentials when trusted, always `Vary`. */
export function corsHeaders(policy: CorsPolicy, origin: string | null | undefined): Record<string, string> {
  if (origin && policy.read.has(origin)) {
    return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' };
  }
  return { Vary: 'Origin' }; // untrusted/no-origin → no grant, but still Vary so caches don't leak a grant
}

/** Headers for an OPTIONS preflight: the full allow-set when trusted, else just `Vary` (the browser blocks). */
export function preflightHeaders(policy: CorsPolicy, origin: string | null | undefined): Record<string, string> {
  const base = corsHeaders(policy, origin);
  if (!('Access-Control-Allow-Origin' in base)) return base;
  return { ...base, 'Access-Control-Allow-Methods': ALLOW_METHODS, 'Access-Control-Allow-Headers': ALLOW_HEADERS, 'Access-Control-Max-Age': MAX_AGE };
}

/** CSRF: may this state-changing request proceed? A missing Origin = non-browser (no ambient-cookie CSRF). */
export function isWriteOriginAllowed(policy: CorsPolicy, origin: string | null | undefined): boolean {
  return !origin || policy.write.has(origin);
}

// --- per-request plumbing -------------------------------------------------------------------------------
// uWS has no middleware and `req` is invalid after the first await, so we CAPTURE the headers synchronously
// in the handler (where the Origin is readable) and WRITE them later inside the response cork. A WeakMap
// keyed by `res` avoids mutating the uWS object and is GC'd with the request.
const pending = new WeakMap<uWS.HttpResponse, Record<string, string>>();

/** SYNC in the handler (req valid): stash this request's CORS headers. No-op when CORS is off. */
export function captureCors(res: uWS.HttpResponse, origin: string | null | undefined, policy: CorsPolicy | null): void {
  if (policy) pending.set(res, corsHeaders(policy, origin));
}

/** Inside the response cork (before `res.end`): emit any captured CORS headers. */
export function writeCapturedCors(res: uWS.HttpResponse): void {
  const h = pending.get(res);
  if (h) for (const [k, v] of Object.entries(h)) res.writeHeader(k, v);
}
