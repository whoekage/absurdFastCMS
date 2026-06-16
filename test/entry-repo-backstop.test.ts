import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSql } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { Registry } from '../src/store/registry.ts';
import { DetachedTable, Engine } from '../src/store/engine.ts';
import { insertEntry, EntryWriteError } from '../src/db/entry-repo.ts';
import { createContentType, getContentType, dropContentType } from '../src/db/content-type-repo.ts';
import { withCatalogWrite } from './catalog-lock.ts';

/**
 * Pins two backstops the validator normally front-runs, against REAL Postgres (no mocks):
 *  - {@link Engine.replaceType} throws when the type is NOT already defined (replace != define).
 *  - {@link insertEntry} maps a real PG SQLSTATE (23505 unique_violation) to a GENERIC
 *    {@link EntryWriteError} whose message leaks NO SQL / constraint / column detail.
 */

const sql = createSql();

before(async () => {
  await runMigrations();
  await withCatalogWrite(sql, async () => {
    if (await getContentType(sql, 'erb_gadget')) await dropContentType(sql, 'erb_gadget');
    await createContentType(sql, { apiId: 'erb_gadget', fields: [{ name: 'code', cmsType: 'string', options: { nullable: false } }] });
    // A real UNIQUE constraint on a user column so a duplicate insert raises 23505 through the repo.
    await sql`ALTER TABLE ct_erb_gadget ADD CONSTRAINT ct_erb_gadget_code_uniq UNIQUE (code)`;
  });
});

after(async () => {
  await withCatalogWrite(sql, () => dropContentType(sql, 'erb_gadget'));
  await sql.end();
});

test('Engine.replaceType throws on a type that is not defined', () => {
  const engine = new Engine();
  const detached = new DetachedTable([{ name: 'id', type: 'i32' }]);
  assert.throws(() => engine.replaceType('nope', detached), /not defined/);
});

test('a real 23505 unique violation maps to a generic EntryWriteError (no SQL/constraint leak)', async () => {
  const registry = await Registry.build(sql);
  const def = registry.get('erb_gadget')!;
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
