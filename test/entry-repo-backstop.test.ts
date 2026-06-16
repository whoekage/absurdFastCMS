import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { Registry } from '../src/store/registry.ts';
import { DetachedTable, Engine } from '../src/store/engine.ts';
import { insertEntry, EntryWriteError } from '../src/db/entry-repo.ts';
import { createContentType } from '../src/db/content-type-repo.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';

/**
 * Pins two backstops the validator normally front-runs, against REAL Postgres (no mocks):
 *  - {@link Engine.replaceType} throws when the type is NOT already defined (replace != define).
 *  - {@link insertEntry} maps a real PG SQLSTATE (23505 unique_violation) to a GENERIC
 *    {@link EntryWriteError} whose message leaks NO SQL / constraint / column detail.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;

before(async () => {
  db = await createFileDatabase('erb');
  sql = db.sql;
  await createContentType(sql, { apiId: 'gadget', fields: [{ name: 'code', cmsType: 'string', options: { nullable: false } }] });
  // A real UNIQUE constraint on a user column so a duplicate insert raises 23505 through the repo.
  await sql`ALTER TABLE ct_gadget ADD CONSTRAINT ct_gadget_code_uniq UNIQUE (code)`;
});

after(async () => {
  // Guard so a failing before() (db/sql undefined) surfaces the real error, not a deref of undefined.
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

test('Engine.replaceType throws on a type that is not defined', () => {
  const engine = new Engine();
  const detached = new DetachedTable([{ name: 'id', type: 'i32' }]);
  assert.throws(() => engine.replaceType('nope', detached), /not defined/);
});

test('a real 23505 unique violation maps to a generic EntryWriteError (no SQL/constraint leak)', async () => {
  const registry = await Registry.build(sql);
  const def = registry.get('gadget')!;
  await insertEntry(sql, def, { code: 'dup' });
  await assert.rejects(
    () => insertEntry(sql, def, { code: 'dup' }),
    (e: unknown) => {
      assert.ok(e instanceof EntryWriteError);
      // No constraint name, table name, column name, or SQLSTATE digits in the message.
      assert.ok(!/ct_gadget|code|uniq|23505|constraint|duplicate/i.test((e as Error).message));
      return true;
    },
  );
});
