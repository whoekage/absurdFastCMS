import { PostgresJSDialect } from 'kysely-postgres-js';
import type { Sql } from 'postgres';
import { createSql } from '../db/database.client.ts';

/**
 * The DB binding for better-auth: a Kysely-over-postgres.js dialect bound to a DEDICATED postgres.js
 * handle. We stay SINGLE-DRIVER (no `pg` Pool, no second TLS/keepalive config, no second audit surface)
 * — the same postgres.js driver, the same DATABASE_URL — but the auth handle has its OWN `max` budget so
 * auth traffic never starves the hot read/write pool. better-auth wraps this dialect in its own internal
 * `Kysely` instance; we hand it the dialect, it owns the queries.
 *
 * The handle is lazily created on first use and OWNED here: {@link closeAuth} ends it on shutdown
 * alongside the store. In tests we inject a per-file handle via {@link setAuthSql} so auth shares the
 * test's cloned-database connection (and the same query counter) instead of opening a second one — in
 * that case the test owns the handle and {@link closeAuth} must NOT end it.
 */

let _sql: Sql | undefined;
/** true => WE opened `_sql` (lazy) and own its lifecycle; false => a test injected it (test owns it). */
let _owned = false;

/** The dedicated postgres.js handle for auth traffic (lazily opened; reused thereafter). */
function authSql(): Sql {
  if (_sql === undefined) {
    _sql = createSql();
    _owned = true;
  }
  return _sql;
}

/**
 * Inject the postgres.js handle auth should use (tests bind it to the per-file cloned DB so auth + the
 * RBAC registry share one connection — and one observable query counter — with the rest of the suite).
 * Must be called BEFORE the first {@link authSql}/{@link authDialect}/{@link buildAuth} use.
 */
export function setAuthSql(sql: Sql): void {
  _sql = sql;
  _owned = false;
}

/** A fresh PostgresJSDialect over the dedicated auth handle (better-auth wraps it in its own Kysely). */
export function authDialect(): PostgresJSDialect {
  return new PostgresJSDialect({ postgres: authSql() });
}

/**
 * End the auth handle (shutdown). Ends it ONLY when we own it (lazily created); a test-injected handle
 * is owned + closed by the test. Always clears the module state so a fresh handle can be opened next.
 */
export async function closeAuth(): Promise<void> {
  const sql = _sql;
  const owned = _owned;
  _sql = undefined;
  _owned = false;
  if (owned && sql !== undefined) await sql.end();
}
