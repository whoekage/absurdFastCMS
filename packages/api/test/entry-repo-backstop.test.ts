import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { Registry } from '../src/db/registry.ts';
import { DetachedTable, Engine } from '../src/store/engine.ts';
import { insertEntry, EntryWriteError } from '../src/db/entry.repository.ts';
import { migrate } from '../src/db/schema/migrate.ts';
import type { Schema } from '../src/db/schema/model.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { schema } from './helpers.ts';

/**
 * Pins two backstops the validator normally front-runs, against REAL Postgres (no mocks):
 *  - {@link Engine.replaceType} throws when the type is NOT already defined (replace != define).
 *  - {@link insertEntry} maps a real PG SQLSTATE (23505 unique_violation) to a GENERIC
 *    {@link EntryWriteError} whose message leaks NO SQL / constraint / column detail.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let gadgetSchema: Schema;

before(async () => {
  db = await createFileDatabase('erb');
  sql = db.sql;
  gadgetSchema = schema({ name: 'gadget', fields: [{ name: 'code', cmsType: 'string', options: { nullable: false } }] });
  await migrate(sql, [gadgetSchema], { allowDestructive: true });
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
  const registry = Registry.fromSchemas([gadgetSchema]);
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

// be-02b: document_id is a PHYSICAL system column only. The loader projects strictly from def.fields
// (SYSTEM_FIELDS stays 3 wide), so insertEntry's returned shape NEVER contains it. These pin the
// physical behaviour via a DIRECT PG SELECT of the column — NOT via the wire.
test('a fresh create auto-allocates a unique document_id via the sequence DEFAULT (direct PG)', async () => {
  const registry = Registry.fromSchemas([gadgetSchema]);
  const def = registry.get('gadget')!;
  // Plain creates: no opts -> column DEFAULTs to nextval('document_id_seq').
  const a = (await insertEntry(sql, def, { code: 'doc-a' })) as { id: number };
  const b = (await insertEntry(sql, def, { code: 'doc-b' })) as { id: number };
  // Returned shape carries NO document_id key (byte-identical reads / loader-skip).
  assert.ok(!('document_id' in a));
  assert.ok(!('document_id' in b));
  // But the physical column is populated and the two rows got DISTINCT ids.
  const rows = await sql<{ id: number; document_id: number }[]>`
    SELECT id, document_id FROM ct_gadget WHERE id IN (${a.id}, ${b.id}) ORDER BY id`;
  assert.equal(rows.length, 2);
  assert.equal(typeof rows[0].document_id, 'number');
  assert.notEqual(rows[0].document_id, rows[1].document_id);
});

test('the internal reuse seam attaches a second row to the SAME document_id (direct PG)', async () => {
  const registry = Registry.fromSchemas([gadgetSchema]);
  const def = registry.get('gadget')!;
  // Parent draws a fresh document_id from the sequence.
  const parent = (await insertEntry(sql, def, { code: 'variant-parent' })) as { id: number };
  const [{ document_id: parentDoc }] = await sql<{ document_id: number }[]>`
    SELECT document_id FROM ct_gadget WHERE id = ${parent.id}`;
  // The guarded seam: a variant REUSES the parent's document_id (be-03 / be-06 path).
  const variant = (await insertEntry(sql, def, { code: 'variant-child' }, { documentId: parentDoc })) as { id: number };
  assert.notEqual(variant.id, parent.id); // distinct PK rows
  const [{ document_id: variantDoc }] = await sql<{ document_id: number }[]>`
    SELECT document_id FROM ct_gadget WHERE id = ${variant.id}`;
  assert.equal(variantDoc, parentDoc); // SAME document
});
