import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { migrate, MigrationBlockedError } from '../src/db/schema/migrate.ts';
import type { Schema, FieldSchema, FieldType } from '../src/db/schema/model.ts';
import type { FieldOptions } from '../src/db/type.catalog.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, physicalColumns, tableExists } from './helpers.ts';

/**
 * S4 migrate engine — RENAME dimension hardening against REAL Postgres (no mocks). The headline win of the
 * stable-id diff is that a rename is `ALTER ... RENAME COLUMN`/`RENAME TO` (lossless), never a drop+add. We
 * drive `migrate` with the IR directly, INSERT real rows, perform the migration, then SELECT and assert the
 * ACTUAL values survived — going deeper than the basic happy-path coverage in schema-migrate.test.ts:
 *   - rename a populated field (many rows / NULLs / NOT NULL) and assert every value survives,
 *   - rename + retype the SAME field in one migrate (both ops, ordered),
 *   - rename an enumeration/`status` field and prove the CHECK still gates after the rename,
 *   - swap two field names via ids (the no-temp-name-staging collision case),
 *   - rename a TYPE (name/table) with data; rename then rename-back; the round-trip identity,
 *   - contrast a STABLE-id rename (data kept) vs a NEW id on a "renamed" field (drop+add => data LOST).
 */

const f = (id: string, name: string, type: FieldType, options?: FieldOptions): FieldSchema =>
  options ? { id, name, type, options } : { id, name, type };
const schema = (id: string, name: string, fields: FieldSchema[]): Schema => ({ id, name, fields });

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;

before(async () => {
  db = await createFileDatabase('edgerename');
  sql = db.sql;
});
beforeEach(async () => {
  await cleanCatalog(sql); // drops ct_ tables (CASCADE also drops their link tables)
  await sql`DROP TABLE IF EXISTS _schema_applied`;
});
after(async () => {
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

test('rename a field holding MANY rows (incl NULLs) -> RENAME COLUMN, every value survives in order', async () => {
  await migrate(sql, [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('alpha'), ('beta'), (NULL), ('delta')`);

  const r = await migrate(sql, [schema('ct_a', 'thing', [f('f_t', 'headline', 'string', { nullable: true })])]); // same id f_t
  assert.deepEqual(r.applied.map((c) => c.kind), ['renameField']);

  const cols = (await physicalColumns(sql, 'ct_thing')).map((c) => c.name);
  assert.ok(cols.includes('headline') && !cols.includes('title'), 'renamed, not dropped+added');
  const rows = await sql<{ headline: string | null }[]>`SELECT headline FROM ct_thing ORDER BY id`;
  assert.deepEqual(rows.map((x) => x.headline), ['alpha', 'beta', null, 'delta']); // every value carried across
});

test('rename + RETYPE the SAME field in one migrate: both ops, rename first, data cast preserved', async () => {
  await migrate(sql, [schema('ct_a', 'thing', [f('f_v', 'views', 'integer', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (views) VALUES (5), (7)`);

  // same id f_v: name integer->biginteger AND views->view_count, in one step (impossible for a name-pairing differ).
  const next = [schema('ct_a', 'thing', [f('f_v', 'view_count', 'biginteger', { nullable: true })])];
  await assert.rejects(migrate(sql, next), MigrationBlockedError); // retype int4->int8 is data-dependent (gated)

  const r = await migrate(sql, next, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['renameField', 'retypeField'], 'rename emitted BEFORE retype');

  const cols = (await physicalColumns(sql, 'ct_thing'));
  const vc = cols.find((c) => c.name === 'view_count');
  assert.ok(vc && !cols.some((c) => c.name === 'views'), 'renamed to view_count, old name gone');
  assert.equal(vc?.type, 'bigint', 'retyped to int8');
  const rows = await sql<{ view_count: string }[]>`SELECT view_count FROM ct_thing ORDER BY id`;
  assert.deepEqual(rows.map((x) => String(x.view_count)), ['5', '7']); // values carried across rename+cast
});

test('rename an ENUMERATION (status) field: CHECK follows the rename and still gates inserts', async () => {
  const before = schema('ct_a', 'thing', [
    f('f_s', 'status', 'enumeration', { values: ['draft', 'published', 'archived'], nullable: false }),
  ]);
  await migrate(sql, [before]);
  await sql.unsafe(`INSERT INTO ct_thing (status) VALUES ('draft'), ('published')`);
  // the CHECK must reject a non-member BEFORE the rename.
  await assert.rejects(sql.unsafe(`INSERT INTO ct_thing (status) VALUES ('bogus')`));

  const r = await migrate(sql, [
    schema('ct_a', 'thing', [f('f_s', 'state', 'enumeration', { values: ['draft', 'published', 'archived'], nullable: false })]),
  ]); // same id f_s, rename status -> state (value-set unchanged => rename only, no retype)
  assert.deepEqual(r.applied.map((c) => c.kind), ['renameField']);

  const cols = (await physicalColumns(sql, 'ct_thing')).map((c) => c.name);
  assert.ok(cols.includes('state') && !cols.includes('status'));
  const rows = await sql<{ state: string }[]>`SELECT state FROM ct_thing ORDER BY id`;
  assert.deepEqual(rows.map((x) => x.state), ['draft', 'published']); // data survived
  // the CHECK rewrote its column reference on rename: a valid member still inserts, a non-member still rejects.
  await sql.unsafe(`INSERT INTO ct_thing (state) VALUES ('archived')`);
  await assert.rejects(sql.unsafe(`INSERT INTO ct_thing (state) VALUES ('bogus')`), 'CHECK still gates post-rename');
});

test('rename a NOT NULL field: stays NOT NULL, data intact, NULL insert still rejected', async () => {
  await migrate(sql, [schema('ct_a', 'thing', [f('f_n', 'name', 'string', { nullable: false })])]);
  await sql.unsafe(`INSERT INTO ct_thing (name) VALUES ('keep')`);

  const r = await migrate(sql, [schema('ct_a', 'thing', [f('f_n', 'label', 'string', { nullable: false })])]); // same id f_n
  assert.deepEqual(r.applied.map((c) => c.kind), ['renameField']);

  const cols = await physicalColumns(sql, 'ct_thing');
  const label = cols.find((c) => c.name === 'label');
  assert.ok(label && !label.nullable, 'NOT NULL preserved across rename');
  const [row] = await sql<{ label: string }[]>`SELECT label FROM ct_thing`;
  assert.equal(row?.label, 'keep');
  await assert.rejects(sql.unsafe(`INSERT INTO ct_thing (label) VALUES (NULL)`), 'NOT NULL still enforced');
});

test('SWAP two field names via ids in one migrate: temp-name staging makes it lossless (FIXED)', async () => {
  await migrate(sql, [
    schema('ct_a', 'thing', [
      f('f_a', 'alpha', 'string', { nullable: true }),
      f('f_b', 'beta', 'string', { nullable: true }),
    ]),
  ]);
  await sql.unsafe(`INSERT INTO ct_thing (alpha, beta) VALUES ('A', 'B')`);

  // swap: f_a -> beta, f_b -> alpha. The two renames form a 2-cycle; a direct apply would hit 42701
  // duplicate_column. applyChangeSet now stages one source through a temp name, so the swap completes — and
  // VALUES follow the column (f_a always holds 'A'), they are NOT copied across the swapped names.
  const swapped = [
    schema('ct_a', 'thing', [
      f('f_a', 'beta', 'string', { nullable: true }),
      f('f_b', 'alpha', 'string', { nullable: true }),
    ]),
  ];
  const r = await migrate(sql, swapped); // a pure rename SWAP is `safe` — no ack needed
  assert.deepEqual(r.applied.map((c) => c.kind), ['renameField', 'renameField'], 'two logical renames, temp DDL hidden');

  const cols = (await physicalColumns(sql, 'ct_thing')).map((c) => c.name).filter((n) => n === 'alpha' || n === 'beta');
  assert.deepEqual(cols.sort(), ['alpha', 'beta'], 'both names still present (swapped, no temp left behind)');
  const [row] = await sql<{ alpha: string; beta: string }[]>`SELECT alpha, beta FROM ct_thing`;
  // f_a held 'A' and is now named beta; f_b held 'B' and is now named alpha => alpha='B', beta='A'.
  assert.deepEqual({ a: row?.alpha, b: row?.beta }, { a: 'B', b: 'A' }, 'values rode their columns through the swap');
});

test('3-CYCLE rename (a->b->c->a) in one migrate: cycle broken via one temp, every value follows its column', async () => {
  await migrate(sql, [
    schema('ct_a', 'thing', [
      f('f_a', 'a', 'string', { nullable: true }),
      f('f_b', 'b', 'string', { nullable: true }),
      f('f_c', 'c', 'string', { nullable: true }),
    ]),
  ]);
  await sql.unsafe(`INSERT INTO ct_thing (a, b, c) VALUES ('VA', 'VB', 'VC')`);

  // f_a:a->b, f_b:b->c, f_c:c->a — a 3-cycle (no free target). One temp break, then it unwinds as a chain.
  const cycled = [
    schema('ct_a', 'thing', [
      f('f_a', 'b', 'string', { nullable: true }),
      f('f_b', 'c', 'string', { nullable: true }),
      f('f_c', 'a', 'string', { nullable: true }),
    ]),
  ];
  const r = await migrate(sql, cycled);
  assert.deepEqual(r.applied.map((c) => c.kind), ['renameField', 'renameField', 'renameField']);

  const cols = (await physicalColumns(sql, 'ct_thing')).map((c) => c.name).filter((n) => ['a', 'b', 'c'].includes(n)).sort();
  assert.deepEqual(cols, ['a', 'b', 'c'], 'exactly a,b,c remain — no temp column leaked');
  // value rides its column: f_a(VA)->b, f_b(VB)->c, f_c(VC)->a.
  const [row] = await sql<{ a: string; b: string; c: string }[]>`SELECT a, b, c FROM ct_thing`;
  assert.deepEqual(row, { a: 'VC', b: 'VA', c: 'VB' });
});

test('rename a field to the OLD name of a DROPPED field (id reuse-free): rename succeeds, data preserved', async () => {
  // f_old="legacy" gets dropped; f_keep is renamed INTO the freed name "legacy". Drop is destructive => acked.
  await migrate(sql, [
    schema('ct_a', 'thing', [
      f('f_old', 'legacy', 'string', { nullable: true }),
      f('f_keep', 'current', 'string', { nullable: true }),
    ]),
  ]);
  await sql.unsafe(`INSERT INTO ct_thing (legacy, current) VALUES ('OLD', 'KEEP')`);

  const next = [schema('ct_a', 'thing', [f('f_keep', 'legacy', 'string', { nullable: true })])]; // f_old dropped, f_keep -> legacy
  await assert.rejects(migrate(sql, next), MigrationBlockedError); // contains a destructive dropField

  const r = await migrate(sql, next, { allowDestructive: true });
  const kinds = r.applied.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['dropField', 'renameField']);
  const cols = (await physicalColumns(sql, 'ct_thing')).map((c) => c.name);
  assert.ok(cols.includes('legacy') && !cols.includes('current'), 'f_keep now lives under the freed name');
  const [row] = await sql<{ legacy: string }[]>`SELECT legacy FROM ct_thing`;
  assert.equal(row?.legacy, 'KEEP', 'the SURVIVING field f_keep kept its value (not the dropped OLD)');
});

test('RENAME TYPE (name -> table) with multi-row, multi-column data: RENAME TO, all rows intact', async () => {
  await migrate(sql, [
    schema('ct_a', 'thing', [
      f('f_t', 'title', 'string', { nullable: true }),
      f('f_v', 'views', 'integer', { nullable: true }),
    ]),
  ]);
  await sql.unsafe(`INSERT INTO ct_thing (title, views) VALUES ('one', 1), ('two', 2), ('three', 3)`);

  const r = await migrate(sql, [
    schema('ct_a', 'gadget', [
      f('f_t', 'title', 'string', { nullable: true }),
      f('f_v', 'views', 'integer', { nullable: true }),
    ]),
  ]); // same id ct_a, name thing -> gadget
  assert.deepEqual(r.applied.map((c) => c.kind), ['renameType']);
  assert.equal(await tableExists(sql, 'ct_gadget'), true);
  assert.equal(await tableExists(sql, 'ct_thing'), false);
  const rows = await sql<{ title: string; views: number }[]>`SELECT title, views FROM ct_gadget ORDER BY id`;
  assert.deepEqual(rows.map((x) => [x.title, x.views]), [['one', 1], ['two', 2], ['three', 3]]);
});

test('rename TYPE then rename it BACK: round-trips losslessly, the same rows survive both hops', async () => {
  await migrate(sql, [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('roundtrip')`);

  await migrate(sql, [schema('ct_a', 'gadget', [f('f_t', 'title', 'string', { nullable: true })])]); // thing -> gadget
  assert.equal(await tableExists(sql, 'ct_gadget'), true);

  const r = await migrate(sql, [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]); // gadget -> thing
  assert.deepEqual(r.applied.map((c) => c.kind), ['renameType']);
  assert.equal(await tableExists(sql, 'ct_thing'), true);
  assert.equal(await tableExists(sql, 'ct_gadget'), false);
  const [row] = await sql<{ title: string }[]>`SELECT title FROM ct_thing`;
  assert.equal(row?.title, 'roundtrip'); // survived BOTH renames
});

test('rename FIELD then rename it BACK: data survives the full round-trip', async () => {
  await migrate(sql, [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('there-and-back')`);

  await migrate(sql, [schema('ct_a', 'thing', [f('f_t', 'headline', 'string', { nullable: true })])]); // title -> headline
  const r = await migrate(sql, [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]); // headline -> title
  assert.deepEqual(r.applied.map((c) => c.kind), ['renameField']);

  const cols = (await physicalColumns(sql, 'ct_thing')).map((c) => c.name);
  assert.ok(cols.includes('title') && !cols.includes('headline'));
  const [row] = await sql<{ title: string }[]>`SELECT title FROM ct_thing`;
  assert.equal(row?.title, 'there-and-back');
});

test('STABLE-id rename KEEPS data; a NEW id on a "renamed" field is drop+add => data LOST', async () => {
  // Baseline: one field with a real value.
  await migrate(sql, [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('precious')`);

  // (1) STABLE id f_t with a new name => RENAME COLUMN, value kept.
  const renamed = await migrate(sql, [schema('ct_a', 'thing', [f('f_t', 'headline', 'string', { nullable: true })])]);
  assert.deepEqual(renamed.applied.map((c) => c.kind), ['renameField']);
  const [kept] = await sql<{ headline: string }[]>`SELECT headline FROM ct_thing`;
  assert.equal(kept?.headline, 'precious', 'stable-id rename preserved the value');

  // (2) A NEW id (f_x) for what looks like the same column => the differ sees a DROP (f_t) + ADD (f_x):
  // destructive, so gated. With the ack it drops the old column (value gone) and adds a fresh empty one.
  const reidentified = [schema('ct_a', 'thing', [f('f_x', 'headline', 'string', { nullable: true })])];
  await assert.rejects(migrate(sql, reidentified), MigrationBlockedError); // dropField is destructive

  const r = await migrate(sql, reidentified, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind).sort(), ['addField', 'dropField']);
  const [lost] = await sql<{ headline: string | null }[]>`SELECT headline FROM ct_thing`;
  assert.equal(lost?.headline, null, 'a new id = drop+add => the value is LOST (the class id-matching prevents)');
});
