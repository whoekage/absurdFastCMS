import type { Auth } from './auth.ts';
import type { TeamView } from './team.view.ts';
import { OffHeapSessionStore } from './session.store.ts';

/**
 * The SESSION cache — Postgres is durable truth, this is derived state. A WARM validation is a single
 * off-heap probe + a TTL compare → ZERO Postgres. PG is touched ONLY on a miss/expiry (one
 * `auth.api.getSession` read) or never (a cold instance just re-misses and repopulates). This is the
 * hot-path win the slice exists for, asserted by a query-counter test.
 *
 * Storage is an {@link OffHeapSessionStore}, NOT a JS `Map`: all session state lives in ArrayBuffer-backed
 * typed arrays + byte arenas (the same off-heap discipline as the engine's columns), so the GC never
 * traces it entry-by-entry and there is no 2^24 Map ceiling. Millions of live sessions cost a handful of
 * large buffers, not millions of long-lived heap objects.
 *
 * SINGLE-INSTANCE: eviction is a LOCAL `store.delete(token)` driven by better-auth's `session.delete.after`
 * DB hook (logout/revoke) and lazily on read for expiry — a plain local delete. Single instance: one process
 * owns the cache and the durable session row, so a local delete is sufficient and correct. (A multi-instance
 * deployment would reintroduce a cross-instance evict mechanism + an L2/Redis tier later.)
 */

/**
 * The resolved caller identity our routes will later gate on (this slice attaches it nowhere — scope
 * fence). `userId` keys the RBAC registry; `sessionToken` keys this cache.
 */
export interface Principal {
  userId: string;
  sessionToken: string;
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

/** Default cadence of the background expiry sweep (ms). */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
/** A full sweep pass completes over roughly this many ticks (scan budget = recordCount / this). */
const SWEEP_PASSES = 20;
/** Floor on the per-tick scan budget so a small store still sweeps promptly. */
const MIN_SWEEP_BUDGET = 4096;

/**
 * be-09f — privileged/team sessions are CACHED for at most ~8h (end-users keep PG's 7d). better-auth's
 * `expiresIn` is GLOBAL, so the per-principal short TTL is enforced HERE — at the {@link SessionCache}
 * `store.set` — by capping the cached horizon when the validated user is in `team_view`. This is the
 * BACKSTOP that bounds how long a stale WARM entry can survive a missed revocation: suspend itself is the
 * PUSH path (banUser + revokeUserSessions → session.delete.after → evict). It is a CACHE horizon only — it
 * never shortens the PG row; on a re-validate after 8h the cache misses, re-reads PG (still valid up to 7d),
 * and re-caps.
 */
const TEAM_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export class SessionCache {
  private readonly store: OffHeapSessionStore;
  private readonly auth: () => Auth;
  private readonly teamView: TeamView | undefined;
  private readonly sweepTimer: ReturnType<typeof setInterval> | null;

  /**
   * `auth` is supplied as a THUNK to break the construction cycle: the auth instance's
   * `session.delete.after` hook evicts THIS cache, so the cache must exist before the auth instance, yet
   * the cache needs the auth instance to call `getSession` on a miss. The thunk lets the cache be built
   * first and the auth instance assigned immediately after (resolved lazily on the first miss, never at
   * construction).
   *
   * `initialSlots` only sizes the off-heap table's first allocation; it grows by doubling, so this is a
   * starting hint, not a cap. `sweepIntervalMs` is the cadence of the background ACTIVE-EXPIRY sweep that
   * evicts sessions which expired without ever being re-validated (0 disables it — used by tests that
   * drive `pruneExpired` directly). The timer is `unref`'d, so it NEVER keeps the process alive.
   *
   * be-09f — `teamView` is OPTIONAL (absent for read-only / legacy servers). When present, a validated
   * team member's cached horizon is capped to {@link TEAM_SESSION_TTL_MS}. It is threaded in as a trailing
   * arg AFTER the auth thunk so existing positional call sites are unaffected.
   */
  constructor(
    auth: () => Auth,
    initialSlots?: number,
    sweepIntervalMs: number = DEFAULT_SWEEP_INTERVAL_MS,
    teamView?: TeamView,
  ) {
    this.auth = auth;
    this.teamView = teamView;
    this.store = new OffHeapSessionStore(initialSlots);
    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        const total = this.store.recordCount();
        if (total === 0) return;
        this.store.pruneExpired(Date.now(), Math.max(MIN_SWEEP_BUDGET, Math.ceil(total / SWEEP_PASSES)));
      }, sweepIntervalMs);
      this.sweepTimer.unref?.(); // a background sweep must not hold the event loop open
    } else {
      this.sweepTimer = null;
    }
  }

  /** Stop the background expiry sweep (clean test teardown; the process exit handles it in prod). */
  stop(): void {
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
  }

  /**
   * Resolve the {@link Principal} for a request, or null when unauthenticated. THE HOT PATH: a warm,
   * unexpired token returns from the off-heap store with ZERO Postgres. A miss/expiry does the ONLY PG
   * read (`auth.api.getSession`) and repopulates. A token-less request short-circuits to a PG read only
   * if better-auth might authenticate by another means (it returns null fast otherwise).
   */
  async validate(headers: Headers): Promise<Principal | null> {
    const token = readSessionToken(headers);
    if (token !== null) {
      const hit = this.store.get(token);
      if (hit !== null) {
        if (hit.expiresAt > Date.now()) return { userId: hit.userId, sessionToken: token }; // WARM HIT — zero PG
        this.store.delete(token); // expired → evict locally, fall through to a fresh PG read
      }
    }
    // MISS / expiry / no-token: the single Postgres touch.
    const s = await this.auth().api.getSession({ headers });
    if (s === null) return null;
    const pgExpiry = +new Date(s.session.expiresAt);
    // be-09f — PUSH-not-pull suspend bound: a team member's WARM zero-PG validate cannot re-read a status
    // flag, so we CAP the cached horizon to TEAM_SESSION_TTL_MS. The active expiry sweep is the backstop
    // that evicts any session missed by a revocation. Non-team consumers (team_view miss) keep PG's 7d.
    const isTeam = this.teamView !== undefined && this.teamView.get(s.user.id) !== null;
    const expiresAt = isTeam ? Math.min(pgExpiry, Date.now() + TEAM_SESSION_TTL_MS) : pgExpiry;
    this.store.set(s.session.token, s.user.id, expiresAt);
    return { userId: s.user.id, sessionToken: s.session.token };
  }

  /**
   * Evict one session from the cache (the logout/revoke hook). A local off-heap delete, single instance.
   * Idempotent (deleting an absent token is a no-op).
   */
  evict(token: string): void {
    this.store.delete(token);
  }

  /** Test/diagnostic: current live cached entry count (NOT a public route surface). */
  size(): number {
    return this.store.size();
  }

  /**
   * Test/diagnostic: the cached expiry (epoch ms) for a token, or null if absent. Exposes the per-principal
   * horizon the cache actually committed — used to prove the be-09f short-TTL CAP (a team member is capped
   * to ~8h while a non-team consumer keeps PG's 7d). NOT a public route surface.
   */
  peekExpiry(token: string): number | null {
    return this.store.get(token)?.expiresAt ?? null;
  }
}
