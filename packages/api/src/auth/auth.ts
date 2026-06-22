import { betterAuth } from 'better-auth';
import { apiKey } from '@better-auth/api-key';
import { admin } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements, adminAc } from 'better-auth/plugins/admin/access';

/**
 * be-09f — the admin plugin REQUIRES every `adminRoles` entry to exist in its `roles` access-control map. We
 * mint a single `super-admin` role from the plugin's DEFAULT statement set granting EVERY user/session
 * action (it mirrors better-auth's built-in `admin` role). This is ONLY for better-auth's own lifecycle
 * endpoint authz (ban/remove/revoke). It is NOT a CMS authz source — the RbacRegistry never consults
 * better-auth's `user.role` or this access-control map.
 */
const teamAccess = createAccessControl(defaultStatements);
const ADMIN_ROLES = { 'super-admin': teamAccess.newRole(adminAc.statements) };
import type { Sql } from 'postgres';
import { authDialect } from './auth.dialect.ts';
import { config } from '../config.ts';
import type { SessionCache } from './session.cache.ts';

/**
 * be-09b — the FIRST-ADMIN bootstrap advisory-lock key. A FIXED constant (well inside int8 + JS safe-integer
 * range, distinct from the test-harness golden/create/catalog keys) so every concurrent first sign-up
 * serializes on the SAME `pg_advisory_xact_lock`. xact-scoped → auto-releases on commit/rollback. Bound as a
 * number and CAST `::int8` in SQL so postgres.js never narrows it to int4.
 */
const FIRST_ADMIN_LOCK_KEY = 7_309_041_558_722_011; // a fixed, arbitrary int8 key (< 2^53), hashed nowhere else

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
  /**
   * be-09b — the Postgres handle the FIRST-ADMIN bootstrap runs on (the boot store's `sql`). When present
   * (with {@link rbacInvalidate}), the `user.create.after` hook promotes the FIRST-ever user to
   * `super-admin` under an advisory lock. Absent for the CLI `generate` / read-only servers → the hook is
   * a no-op (no bootstrap surface). The hook NEVER reads a role/userId/isAdmin from the request body — the
   * user is the better-auth-created row, the grant is derived from PG state under the lock.
   */
  sql?: Sql;
  /**
   * be-09b — invalidate the in-memory RBAC registry AFTER the first-admin grant lands (a thunk that calls
   * `rbac.rebuild()`, mirroring the {@link sessionEvictor} cycle-breaker — `auth` is built after `rbac`).
   * Called ONLY when the bootstrap actually inserted the grant (so a normal sign-up never rebuilds).
   */
  rbacInvalidate?: () => Promise<void>;
  /**
   * be-09f — reload the off-heap team_view AFTER an identity mutation (name/avatar change via the
   * better-auth API, first-admin bootstrap). A thunk calling `teamView.rebuild()` — same cycle-breaker
   * pattern as {@link rbacInvalidate} (teamView is built before auth). Absent for the CLI generate /
   * read-only servers (no-op). Fires ONLY on a better-auth adapter mutation — raw SQL on `user` is
   * forbidden by policy (it would bypass this and diverge the projection from PG).
   */
  teamViewReload?: () => Promise<void>;
}

/**
 * be-09b — promote the FIRST-ever user to `super-admin`, exactly once, under an advisory lock. Runs in
 * ONE transaction:
 *   1. `pg_advisory_xact_lock` — concurrent first sign-ups SERIALIZE here (single-winner; xact-scoped).
 *   2. `INSERT ... SELECT super-admin ... WHERE NOT EXISTS (any super-admin grant)` — idempotent +
 *      refuse-after-admin: promotes ONLY when NO super-admin grant exists yet. Re-running after an admin
 *      exists inserts ZERO rows.
 * Returns true iff a grant row was actually inserted (so the caller rebuilds RBAC only then). The user is
 * `newUserId` (the better-auth-created row's id) — NEVER a body-supplied role/userId/isAdmin.
 */
async function promoteFirstAdmin(sql: Sql, newUserId: string): Promise<boolean> {
  const inserted = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${FIRST_ADMIN_LOCK_KEY}::int8)`;
    const rows = await tx`
      INSERT INTO user_roles (user_id, role_id)
        SELECT ${newUserId}, r.id FROM roles r
        WHERE r.name = 'super-admin'
          AND NOT EXISTS (
            SELECT 1 FROM user_roles ur JOIN roles r2 ON r2.id = ur.role_id
            WHERE r2.name = 'super-admin'
          )
      RETURNING user_id
    `;
    if (rows.length > 0) {
      // be-09f — the first super-admin ALSO becomes the first team row, atomically under the SAME advisory
      // lock + the SAME "no super-admin yet" guard. ON CONFLICT DO NOTHING keeps it idempotent; only reached
      // when the grant landed, so exactly one guarded admin always exists in team_view.
      await tx`
        INSERT INTO team (user_id, status) VALUES (${newUserId}, 'active')
        ON CONFLICT (user_id) DO NOTHING
      `;
      // be-09f — mirror the CMS super-admin into better-auth's own `user.role` so the admin plugin's
      // lifecycle endpoints (adminRoles:['super-admin']) recognize this actor. This `role` column is NOT a
      // CMS authz source (RbacRegistry never reads it) and is a non-session field, so the write does not
      // bypass session coherence.
      await tx`UPDATE "user" SET "role" = 'super-admin', "updatedAt" = now() WHERE id = ${newUserId}`;
    }
    return rows.length;
  });
  return inserted > 0;
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
    // be-09f — the ADMIN plugin is enabled for LIFECYCLE ONLY (ban/unban/remove/revoke-sessions via
    // `auth.api.*`). It is used STRICTLY to satisfy better-auth's OWN lifecycle-endpoint authz; it is NEVER
    // a CMS authz source — our RBAC tables (`user_roles`/`role_permissions`) are the SOLE truth and the
    // RbacRegistry NEVER reads better-auth's `user.role` field. `adminRoles: ['super-admin']` lets a
    // super-admin (whose better-auth `user.role` we keep in lock-step with the CMS role) drive lifecycle;
    // `defaultRole: 'user'` keeps a created identity authority-free (its `user.role` is 'user', not in
    // adminRoles, so a body-supplied role confers ZERO lifecycle authority AND zero CMS authority). NO
    // impersonation surface is exposed (scope fence). The plugin's columns (role/banned/banReason/banExpires
    // on `user`, impersonatedBy on `session`) are folded into migrations/0001_init.sql.
    plugins: [apiKey(), admin({ adminRoles: ['super-admin'], defaultRole: 'user', roles: ADMIN_ROLES })],
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
      // be-09b — FIRST-ADMIN bootstrap. Fires as a side-effect of a real better-auth sign-up (NO request
      // surface, NO body-supplied role). The user is the just-created row; the promotion is advisory-locked,
      // idempotent, and refuses once any super-admin grant exists. No-op when sql/rbacInvalidate are absent
      // (CLI generate / read-only server) so those paths skip the bootstrap entirely.
      user: {
        create: {
          after: async (user: { id: string }) => {
            if (opts.sql === undefined || opts.rbacInvalidate === undefined) return;
            const promoted = await promoteFirstAdmin(opts.sql, user.id);
            if (promoted) {
              await opts.rbacInvalidate();
              await opts.teamViewReload?.(); // the first admin appears in team_view immediately
            }
          },
        },
        update: {
          // be-09f — an identity mutation (name/image via the better-auth API) reloads team_view so the
          // projected name/avatar can never go stale (the stale-profile class). The hook fires ONLY on a
          // better-auth adapter mutation; raw SQL on "user" is forbidden by policy (it would bypass this
          // and diverge the projection from PG).
          after: async () => {
            await opts.teamViewReload?.();
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
