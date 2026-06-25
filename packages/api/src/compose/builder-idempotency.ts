import type { Sql, JSONValue } from 'postgres';

/**
 * S6 — persisted idempotency for Builder mutations. An `Idempotency-Key` header maps to a row holding the
 * request hash + the response envelope; a replay returns the STORED envelope verbatim (no re-apply, no swap).
 * Persisted (not in-memory) so it survives the crash/restart it exists to protect against. Single-instance,
 * so a plain table + opportunistic TTL prune (no background job) suffices.
 *
 * The success row is written from the ADAPTER, INSIDE the writer mutex, AFTER the post-apply version
 * recompute — NOT inside the migrate tx — because (a) `migrate()` returns before its tx on a no-op apply, so
 * an in-tx INSERT would never fire for a keyed no-op, and (b) the correct envelope `version` is only known
 * after the file rename + recompute. The accepted trade-off: a crash between the migrate commit and this
 * INSERT leaves no row, so a same-key replay re-applies → diffs to a no-op → byte-identical, benign.
 */

export interface IdempotencyRow {
  requestHash: string;
  status: number;
  response: Record<string, unknown>;
}

/** Create the on-demand bookkeeping table (mirror of `ensureAppliedTable`; no hand-written migration).
 *  Race-safe: a concurrent `CREATE TABLE IF NOT EXISTS` can collide on pg_type (23505) / report 42P07 — both
 *  mean another session just created it, so swallow. */
export async function ensureIdempotencyTable(sql: Sql): Promise<void> {
  try {
    await sql`CREATE TABLE IF NOT EXISTS _builder_idempotency (
      key text PRIMARY KEY,
      request_hash text NOT NULL,
      status int NOT NULL,
      response jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== '23505' && code !== '42P07') throw e;
  }
}

/** Look up a prior result for `key`, or undefined. */
export async function idempotencyLookup(sql: Sql, key: string): Promise<IdempotencyRow | undefined> {
  const rows = await sql<{ request_hash: string; status: number; response: Record<string, unknown> }[]>`
    SELECT request_hash, status, response FROM _builder_idempotency WHERE key = ${key}
  `;
  const r = rows[0];
  return r === undefined ? undefined : { requestHash: r.request_hash, status: r.status, response: r.response };
}

/** Record a terminal result (success or a TERMINAL 4xx) for `key`. First writer wins (ON CONFLICT DO NOTHING). */
export async function recordIdempotency(sql: Sql, key: string, requestHash: string, status: number, response: Record<string, unknown>): Promise<void> {
  await sql`
    INSERT INTO _builder_idempotency (key, request_hash, status, response)
    VALUES (${key}, ${requestHash}, ${status}, ${sql.json(response as unknown as JSONValue)})
    ON CONFLICT (key) DO NOTHING
  `;
}

/** Opportunistic TTL prune (24h). Runs OUTSIDE the apply tx; only on a keyed request — never a background job. */
export async function pruneIdempotency(sql: Sql): Promise<void> {
  await sql`DELETE FROM _builder_idempotency WHERE created_at < now() - interval '24 hours'`;
}
