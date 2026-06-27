import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import type { ContiConfig } from '../src/compose/config.ts';
import { runDrop } from '../src/compose/migrate.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';

/**
 * `conti drop` — the dev clean-slate. Drops + recreates the `public` schema, wiping every table and
 * sequence (conti has no down-migrations; this is the drop & recreate workflow). REAL Postgres (a per-file
 * db cloned from the golden template, which already carries the conti tables + the document_id sequence),
 * no mocks: assert it starts populated and ends empty.
 */

let db: Awaited<ReturnType<typeof createFileDatabase>>;
let sql: Sql;

before(async () => {
  db = await createFileDatabase('drop');
  sql = db.sql;
});

after(async () => {
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

async function publicCounts(s: Sql): Promise<{ tables: number; sequences: number }> {
  const [t] = await s`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`;
  const [q] = await s`SELECT count(*)::int AS n FROM information_schema.sequences WHERE sequence_schema = 'public'`;
  return { tables: t!.n as number, sequences: q!.n as number };
}

test('conti drop wipes every table + sequence in the public schema', async () => {
  const start = await publicCounts(sql);
  assert.ok(start.tables > 0, 'the cloned db should start with conti tables');
  assert.ok(start.sequences > 0, 'the cloned db should start with the document_id sequence');

  await runDrop({ database: { url: db.url } } as unknown as ContiConfig);

  const end = await publicCounts(sql);
  assert.equal(end.tables, 0, 'no tables remain after drop');
  assert.equal(end.sequences, 0, 'no sequences remain after drop');
});
