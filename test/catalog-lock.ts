import type { Sql } from 'postgres';

/**
 * TEST-INFRA ONLY (not runtime): a cross-file critical section that makes the parallel suite
 * (`node --test` at default concurrency) deterministic against ONE shared Postgres database.
 *
 * WHY THIS EXISTS — `buildEngine` / `PostgresStore.load` / `loadWithRegistry` load the ENTIRE
 * content-type catalog: they `Registry.build()` (read all `content_types` rows) and then
 * `SELECT ... FROM ct_<apiId>` for EVERY type that exists at that instant — including types owned by
 * OTHER test files. If another file's `dropContentType` (an atomic DELETE row + DROP TABLE) commits in
 * the window between the registry read and the per-table SELECT, the build hits a vanished table and
 * throws `relation "ct_..." does not exist`. The per-file api_id PREFIX isolation cannot prevent this
 * because the loader is global by design (and src/ runtime must not change).
 *
 * THE FIX — a single advisory lock guards that window:
 *   - withCatalogRead(): SHARE lock held across the WHOLE engine build (registry read + every SELECT).
 *     Many builds may proceed concurrently.
 *   - withCatalogWrite(): EXCLUSIVE lock around create/drop of a content-type. A mutation waits until no
 *     build is mid-flight, and a build sees a catalog that cannot lose a table under it. Reads/HTTP/
 *     assertions outside these calls still run fully in parallel, so file-level parallelism is preserved.
 *
 * A session-scoped advisory lock needs a dedicated connection for its whole lifetime, so each call
 * RESERVES one connection from the pool and releases it in a finally.
 */

// Arbitrary fixed 64-bit key shared by every test file in this suite.
const CATALOG_LOCK_KEY = 0x6ca7a106 as const;

/** Run `fn` while holding a SHARE advisory lock on the catalog (use around an engine/registry build). */
export async function withCatalogRead<T>(sql: Sql, fn: () => Promise<T>): Promise<T> {
  const conn = await sql.reserve();
  try {
    await conn`SELECT pg_advisory_lock_shared(${CATALOG_LOCK_KEY})`;
    try {
      return await fn();
    } finally {
      await conn`SELECT pg_advisory_unlock_shared(${CATALOG_LOCK_KEY})`;
    }
  } finally {
    conn.release();
  }
}

/** Run `fn` while holding an EXCLUSIVE advisory lock on the catalog (use around create/drop). */
export async function withCatalogWrite<T>(sql: Sql, fn: () => Promise<T>): Promise<T> {
  const conn = await sql.reserve();
  try {
    await conn`SELECT pg_advisory_lock(${CATALOG_LOCK_KEY})`;
    try {
      return await fn();
    } finally {
      await conn`SELECT pg_advisory_unlock(${CATALOG_LOCK_KEY})`;
    }
  } finally {
    conn.release();
  }
}
