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

function schemaDirOf(config: ContiConfig): string {
  return config.schema?.dir ?? path.join(process.cwd(), 'schema');
}

/**
 * Apply the committed `schema/` to the database. Runs the base migrations first (the `0001_init` static
 * tables + `document_id_seq` a `ct_` table depends on), then the files-first migrate. Owns + closes its
 * own connection.
 */
export async function runMigrate(config: ContiConfig, opts: { allowDestructive?: boolean } = {}): Promise<MigrateResult> {
  await runMigrations(config.database.url);
  const { schemas } = await loadTypes(schemaDirOf(config));
  const sql = createSql(config.database.url);
  try {
    return await migrate(sql, schemas, opts);
  } finally {
    await sql.end();
  }
}

/** Compute the pending change-set + the blocked subset WITHOUT applying (the `migrate lint` command). */
export async function runMigrateLint(config: ContiConfig): Promise<{ changes: readonly Change[]; blocked: readonly Change[] }> {
  const { schemas } = await loadTypes(schemaDirOf(config));
  const sql = createSql(config.database.url);
  try {
    return await migrateLint(sql, schemas);
  } finally {
    await sql.end();
  }
}
