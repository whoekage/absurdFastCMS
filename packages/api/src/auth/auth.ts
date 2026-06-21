import { betterAuth } from 'better-auth';
import { apiKey } from '@better-auth/api-key';
import { authDialect } from './auth.dialect.ts';
import { config } from '../config.ts';
import type { SessionCache } from './session.cache.ts';

/**
 * The single better-auth provider instance. This is BOTH the runtime auth handler (a WHATWG-Fetch
 * handler mounted under `/auth/*` via the uWS bridge) AND what the `@better-auth/cli generate` reads to
 * emit the schema we hand-fold into `migrations/0001_init.sql` — so the config here is the source of
 * truth for the auth tables.
 *
 * Choices (per the slice design):
 *  - emailAndPassword + DB-BACKED sessions are CORE (not plugins). We keep DB truth and DO NOT enable
 *    `cookieCache`: our own RAM {@link SessionCache} is the cache layer, and a signed cookie cache would
 *    make server-side revocation lag behind a logout/expiry. PG = durable truth, RAM = derived.
 *  - the `apiKey()` plugin is enabled so its table is folded into the migration NOW; its ROUTES are a
 *    later slice (this slice mounts the handler but gates nothing).
 *  - `advanced.database.generateId:false` lets Postgres column defaults own ids where applicable.
 *  - the `session.delete.after` DB hook evicts the RAM cache the instant a session row is deleted
 *    (logout / revoke) — wired through {@link buildAuth} so the cache and the auth instance close over
 *    each other without a module-level singleton cycle.
 *
 * The provider is BUILT (not a module singleton) so the auth handle, the secret, and the eviction hook
 * are wired at the composition root (server boot / a test's before()), never at import time — mirroring
 * how the store + registry are constructed, not imported.
 */

/** A thin port the session cache exposes to the auth instance so the delete hook can evict by token. */
export interface SessionEvictor {
  evict(token: string): void;
}

export interface BuildAuthOptions {
  /**
   * The session RAM cache to evict on a session-row delete. Optional so the CLI's `generate` (which
   * constructs the instance purely to read its schema) needs no cache. When present, the
   * `session.delete.after` hook calls `evict(session.token)`.
   */
  sessionEvictor?: SessionEvictor;
  /**
   * The public origin the auth handler runs under (cookie domain + redirect base). Defaults to the
   * configured PUBLIC_BASE_URL. The bridge mounts the handler at `/auth/*` so `basePath` is `/auth`.
   */
  baseURL?: string;
}

/** Build the better-auth provider, wiring the secret, the dedicated DB dialect, and the evict hook. */
export function buildAuth(opts: BuildAuthOptions = {}) {
  return betterAuth({
    secret: config.authSecret,
    baseURL: opts.baseURL ?? config.publicBaseUrl,
    basePath: '/auth',
    database: { dialect: authDialect(), type: 'postgres' },
    emailAndPassword: { enabled: true },
    session: { expiresIn: 604800, updateAge: 86400 }, // 7d expiry / 1d refresh; NO cookieCache (see above)
    plugins: [apiKey()],
    // better-auth GENERATES the text primary keys (`user.id`, `session.id`, ...): the folded schema's PKs
    // are `text ... primary key` with NO database default, so the app MUST supply the id. (An earlier
    // `generateId:false` here made better-auth defer to a non-existent DB default and every insert 422'd
    // "Failed to create user".) The RBAC `user_roles.user_id` FK points at this app-generated text id.
    databaseHooks: {
      session: {
        delete: {
          after: async (session: { token: string }) => {
            opts.sessionEvictor?.evict(session.token);
          },
        },
      },
    },
  });
}

/** The provider type (handler + typed `api.*` surface). */
export type Auth = ReturnType<typeof buildAuth>;

/** Re-export for callers that only need the cache port symbol. */
export type { SessionCache };
