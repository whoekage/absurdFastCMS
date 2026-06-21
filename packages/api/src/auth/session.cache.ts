import type { ChangeBus } from '../store/response.cache.ts';
import type { Auth } from './auth.ts';

/**
 * The SESSION RAM CACHE — Postgres is durable truth, this Map is derived state. A WARM validation is a
 * SINGLE `Map.get(token)` + a TTL compare → ZERO Postgres. PG is touched ONLY on a miss/expiry (one
 * `auth.api.getSession` read) or never (a cold instance just re-misses and repopulates). This is the
 * hot-path win the slice exists for, asserted by a query-counter test.
 *
 * Eviction is event-driven, not polled: a logout/revoke deletes the `session` row → better-auth's
 * `session.delete.after` DB hook calls {@link SessionCache.evict} → local `Map.delete` PLUS a
 * `ChangeBus.publish('session:evict:<token>')` so a future Redis bus fans the eviction to every
 * instance (mirroring the response-cache invalidation seam). Expiry is handled LAZILY on read (the TTL
 * check) — no timer. The cache reuses the SAME string-topic ChangeBus as the content registry, on a
 * `session:evict:` namespace, so no interface change is needed.
 */

const EVICT_PREFIX = 'session:evict:';

/**
 * The resolved caller identity our routes will later gate on (this slice attaches it nowhere — scope
 * fence). `userId` keys the RBAC registry; `sessionToken` keys this cache + the evict bus.
 */
export interface Principal {
  userId: string;
  sessionToken: string;
}

interface Entry {
  principal: Principal;
  /** epoch ms; the session row's expiresAt. A warm hit past this is evicted + treated as a miss. */
  expiresAt: number;
}

/**
 * Read the better-auth session token out of the request `Cookie` header WITHOUT a PG touch. better-auth
 * stores the token in a `<prefix>session_token` cookie; the value before the first `.` is the raw token
 * (the suffix is the cookie signature). We match any cookie whose name ends in `session_token` so a
 * configured cookie prefix (e.g. `__Secure-`) is tolerated. Returns null when no such cookie is present.
 */
export function readSessionToken(headers: Headers): string | null {
  const cookie = headers.get('cookie');
  if (cookie === null) return null;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name.endsWith('session_token')) continue;
    const raw = decodeURIComponent(part.slice(eq + 1).trim());
    // The signed cookie is `<token>.<sig>`; the token better-auth indexes on is the part before the dot.
    const dot = raw.indexOf('.');
    const token = dot === -1 ? raw : raw.slice(0, dot);
    return token.length > 0 ? token : null;
  }
  return null;
}

export class SessionCache {
  private readonly map = new Map<string, Entry>();
  private readonly auth: () => Auth;
  private readonly bus: ChangeBus;

  /**
   * `auth` is supplied as a THUNK to break the construction cycle: the auth instance's
   * `session.delete.after` hook evicts THIS cache, so the cache must exist before the auth instance, yet
   * the cache needs the auth instance to call `getSession` on a miss. The thunk lets the cache be built
   * first and the auth instance assigned immediately after (resolved lazily on the first miss, never at
   * construction).
   */
  constructor(auth: () => Auth, bus: ChangeBus) {
    this.auth = auth;
    this.bus = bus;
    // Cross-instance eviction: a `session:evict:<token>` message (local or, in future, from Redis) drops
    // the entry. The same publish is what THIS instance emits in evict(), so a local publish is a no-op
    // re-delete (idempotent). Non-matching topics (content-type names, rbac:*) are ignored.
    this.bus.subscribe((topic) => {
      if (topic.startsWith(EVICT_PREFIX)) this.map.delete(topic.slice(EVICT_PREFIX.length));
    });
  }

  /**
   * Resolve the {@link Principal} for a request, or null when unauthenticated. THE HOT PATH: a warm,
   * unexpired token returns from the Map with ZERO Postgres. A miss/expiry does the ONLY PG read
   * (`auth.api.getSession`) and repopulates. A token-less request short-circuits to a PG read only if
   * better-auth might authenticate by another means (it returns null fast otherwise).
   */
  async validate(headers: Headers): Promise<Principal | null> {
    const token = readSessionToken(headers);
    if (token !== null) {
      const hit = this.map.get(token);
      if (hit !== undefined) {
        if (hit.expiresAt > Date.now()) return hit.principal; // WARM HIT — zero PG
        this.map.delete(token); // expired → evict locally, fall through to a fresh PG read
      }
    }
    // MISS / expiry / no-token: the single Postgres touch.
    const s = await this.auth().api.getSession({ headers });
    if (s === null) return null;
    const principal: Principal = { userId: s.user.id, sessionToken: s.session.token };
    this.map.set(s.session.token, { principal, expiresAt: +new Date(s.session.expiresAt) });
    return principal;
  }

  /**
   * Evict one session from the cache (the logout/revoke hook). Drops the local entry AND publishes the
   * eviction on the ChangeBus so every instance (today: just this one) drops it too. Idempotent.
   */
  evict(token: string): void {
    this.map.delete(token);
    this.bus.publish(`${EVICT_PREFIX}${token}`);
  }

  /** Test/diagnostic: current cached entry count (NOT a public route surface). */
  size(): number {
    return this.map.size;
  }
}
