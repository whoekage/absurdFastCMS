import path from 'node:path';
import { runMigrations } from '../db/migration.runner.ts';
import { createSql } from '../db/database.client.ts';
import { migrate, migrateLint, type MigrateResult } from '../db/schema/migrate.ts';
import { loadTypes } from '../db/schema/load.ts';
import type { Change } from '../db/schema/diff.ts';
import type { ContiConfig } from './config.ts';

/**
 * Composition wrapper for the `conti migrate` / `conti migrate lint` CLI commands: resolve the schema dir
 * + db from a {@link ContiConfig}, open a short-lived owned handle, and drive the S4 migrate engine. The
 * CLI stays thin — all the db/schema wiring lives here (compose -> db), and the engine itself is reused
 * unchanged. NOT yet wired into boot (that is S6's lifecycle slice).
 */

function modulesDirOf(config: ContiConfig): string {
  return config.modules?.dir ?? path.join(process.cwd(), 'modules');
}

/**
 * Apply the committed `schema/` to the database. Runs the base migrations first (the `0001_init` static
 * tables + `document_id_seq` a `ct_` table depends on), then the files-first migrate. Owns + closes its
 * own connection.
 */
export async function runMigrate(config: ContiConfig, opts: { allowDestructive?: boolean } = {}): Promise<MigrateResult> {
  await runMigrations(config.database.url);
  const { schemas } = await loadTypes(modulesDirOf(config));
  const sql = createSql(config.database.url);
  try {
    return await migrate(sql, schemas, opts);
  } finally {
    await sql.end();
  }
}

/**
 * DROP everything in the database — every table, sequence, type, etc. — by dropping and recreating the
 * `public` schema, leaving an empty database. The dev "clean slate" for the drop & recreate workflow (conti
 * has no down-migrations): after this, `conti migrate` rebuilds from scratch. Owns + closes its own
 * connection. DESTRUCTIVE — wipes all data in the configured database.
 */
export async function runDrop(config: ContiConfig): Promise<void> {
  const sql = createSql(config.database.url);
  try {
    await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await sql.unsafe('CREATE SCHEMA public');
  } finally {
    await sql.end();
  }
}

/** Compute the pending change-set + the blocked subset WITHOUT applying (the `migrate lint` command). */
export async function runMigrateLint(config: ContiConfig): Promise<{ changes: readonly Change[]; blocked: readonly Change[] }> {
  const { schemas } = await loadTypes(modulesDirOf(config));
  const sql = createSql(config.database.url);
  try {
    return await migrateLint(sql, schemas);
  } finally {
    await sql.end();
  }
}
