import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sql } from 'postgres';
import { loadConfigFromEnv, type ContiConfig } from '../src/compose/config.ts';
import { runMigrate, runMigrateLint } from '../src/compose/migrate.ts';
import { MigrationBlockedError } from '../src/db/schema/migrate.ts';
import { stringifySchema } from '../src/db/schema/serialize.ts';
import type { ContentTypeSchema } from '../src/db/schema/model.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, tableExists, physicalColumns } from './helpers.ts';

/**
 * S4 CLI path (real Postgres) — `conti migrate` / `conti migrate lint` resolve to these compose wrappers.
 * Proves the wrapper runs the base migrations + the files-first migrate against a config, is idempotent,
 * and surfaces the destructive gate (MigrationBlockedError) the CLI turns into a clean exit-1.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let dir: string;
let config: ContiConfig;

before(async () => {
  db = await createFileDatabase('climigrate');
  sql = db.sql;
  // loadConfigFromEnv() reads DATABASE_URL; the per-file harness doesn't set it (each test gets its own DB).
  process.env.DATABASE_URL = db.url;
});
beforeEach(async () => {
  await cleanCatalog(sql);
  await sql`DROP TABLE IF EXISTS _schema_applied`;
  dir = await mkdtemp(path.join(tmpdir(), 'conti-climigrate-'));
  config = { ...loadConfigFromEnv(), database: { url: db.url }, schema: { dir } };
});
after(async () => {
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

const write = (s: ContentTypeSchema): Promise<void> => writeFile(path.join(dir, `${s.apiId}.json`), stringifySchema(s));
const thing = (fields: ContentTypeSchema['fields']): ContentTypeSchema => ({ id: 'ct_a', apiId: 'thing', fields });

test('runMigrate applies the committed schema, then is idempotent', async () => {
  await write(thing([{ id: 'f_t', name: 'title', type: 'string', options: { nullable: true } }]));
  const r1 = await runMigrate(config);
  assert.equal(r1.noop, false);
  assert.equal(await tableExists(sql, 'ct_thing'), true);

  const r2 = await runMigrate(config);
  assert.equal(r2.noop, true);
});

test('runMigrateLint reports the blocked drop; runMigrate gates it then applies with allowDestructive', async () => {
  await write(thing([
    { id: 'f_t', name: 'title', type: 'string', options: { nullable: true } },
    { id: 'f_n', name: 'note', type: 'text', options: { nullable: true } },
  ]));
  await runMigrate(config);

  await write(thing([{ id: 'f_t', name: 'title', type: 'string', options: { nullable: true } }])); // drop note
  const lint = await runMigrateLint(config);
  assert.deepEqual(lint.changes.map((c) => c.kind), ['dropField']);
  assert.equal(lint.blocked.length, 1);
  // lint applied nothing
  assert.ok((await physicalColumns(sql, 'ct_thing')).some((c) => c.name === 'note'));

  await assert.rejects(runMigrate(config), MigrationBlockedError);
  const r = await runMigrate(config, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['dropField']);
  assert.ok(!(await physicalColumns(sql, 'ct_thing')).some((c) => c.name === 'note'));
});
