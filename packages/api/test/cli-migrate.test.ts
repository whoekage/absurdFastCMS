import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { loadConfigFromEnv, type ContiConfig } from '../src/compose/config.ts';
import { runMigrate, runMigrateLint } from '../src/compose/migrate.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { tableExists } from './helpers.ts';

/**
 * S4 CLI path (real Postgres) — `conti migrate` / `conti migrate lint` resolve to these compose wrappers.
 * Proves the full wiring end-to-end: load the committed `schema/*.ts` (the real demo `article.ts`), run the
 * base migrations, apply, and that a re-run is a no-op + lint sees nothing pending. The per-op destructive
 * gate is exercised on IR in schema-migrate.test.ts.
 */

const schemaDir = fileURLToPath(new URL('../schema', import.meta.url));

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let config: ContiConfig;

before(async () => {
  db = await createFileDatabase('climigrate');
  sql = db.sql;
  process.env.DATABASE_URL = db.url; // loadConfigFromEnv reads it; the per-file harness doesn't set it
  config = { ...loadConfigFromEnv(), database: { url: db.url }, schema: { dir: schemaDir } };
});
after(async () => {
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

test('runMigrate applies the committed schema/*.ts, is idempotent, and lint then sees no changes', async () => {
  const r1 = await runMigrate(config);
  assert.equal(r1.noop, false);
  assert.equal(await tableExists(sql, 'ct_article'), true); // article.ts -> ct_article created

  const r2 = await runMigrate(config);
  assert.equal(r2.noop, true); // idempotent

  const lint = await runMigrateLint(config);
  assert.equal(lint.changes.length, 0); // applied snapshot matches the source
});
