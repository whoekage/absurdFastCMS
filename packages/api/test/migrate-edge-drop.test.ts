import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { migrate, MigrationBlockedError } from '../src/db/schema/migrate.ts';
import type { Schema, FieldSchema, FieldType } from '../src/db/schema/model.ts';
import type { FieldOptions } from '../src/db/type.catalog.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, physicalColumns, tableExists } from './helpers.ts';

/**
 * S4 migrate engine — EDGE cases for the DROP dimension, against REAL Postgres (no mocks). Where the
 * template (schema-migrate.test.ts) proves only the basic DROP-field happy path (gated, then allowed),
 * this file goes DEEPER: it INSERTS REAL ROWS, runs the migration, then SELECTs and asserts the actual
 * data survived (or is gone, deliberately). It covers the data-loss semantics of dropping a field that
 * holds data, dropping a whole TYPE (table), dropping ONE of several fields while the others' data stays
 * intact, and re-adding a dropped field as a fresh empty column.
 *
 * Cardinal rule (per the dimension brief): never assert merely that a column exists — assert the bytes.
 * For gating: assert MigrationBlockedError AND that NOTHING changed (column + rows still there). For the
 * destructive apply: assert the column is gone but the SIBLING data is untouched.
 */

const f = (id: string, name: string, type: FieldType, options?: FieldOptions): FieldSchema =>
  options ? { id, name, type, options } : { id, name, type };
const ct = (id: string, apiId: string, fields: FieldSchema[]): Schema => ({ id, apiId, fields });

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;

before(async () => {
  db = await createFileDatabase('edgedrop');
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

test('DROP a field holding data is BLOCKED without ack — column AND rows survive untouched', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true }), f('f_n', 'note', 'text', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title, note) VALUES ('keep', 'secret')`);

  const dropped = [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])];
  await assert.rejects(migrate(sql, dropped), MigrationBlockedError);

  // The column must still be physically present AND still hold its bytes — gating means NOTHING changed.
  assert.ok((await physicalColumns(sql, 'ct_thing')).some((c) => c.name === 'note'), 'note column survives the block');
  const [row] = await sql<{ title: string; note: string }[]>`SELECT title, note FROM ct_thing`;
  assert.equal(row?.title, 'keep');
  assert.equal(row?.note, 'secret', 'the dropped-field data is intact after the block');
});

test('DROP a field holding data WITH allowDestructive — column gone, sibling rows preserved', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true }), f('f_n', 'note', 'text', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title, note) VALUES ('keep', 'goodbye')`);

  const dropped = [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])];
  const r = await migrate(sql, dropped, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['dropField']);

  const cols = (await physicalColumns(sql, 'ct_thing')).map((c) => c.name);
  assert.ok(!cols.includes('note'), 'note column is gone');
  assert.ok(cols.includes('title'), 'title column remains');
  const [row] = await sql<{ title: string }[]>`SELECT title FROM ct_thing`;
  assert.equal(row?.title, 'keep', 'the surviving column keeps its data across the drop');
});

test('DROP one of SEVERAL fields keeps every OTHER column data intact (multi-row)', async () => {
  await migrate(sql, [
    ct('ct_a', 'thing', [
      f('f_t', 'title', 'string', { nullable: true }),
      f('f_n', 'note', 'text', { nullable: true }),
      f('f_v', 'views', 'integer', { nullable: true }),
      f('f_b', 'active', 'boolean', { nullable: true }),
    ]),
  ]);
  await sql.unsafe(`INSERT INTO ct_thing (title, note, views, active) VALUES ('a', 'n1', 10, true)`);
  await sql.unsafe(`INSERT INTO ct_thing (title, note, views, active) VALUES ('b', 'n2', 20, false)`);

  // Drop only the middle field `note`; the surrounding columns + both rows must be untouched.
  const dropped = [
    ct('ct_a', 'thing', [
      f('f_t', 'title', 'string', { nullable: true }),
      f('f_v', 'views', 'integer', { nullable: true }),
      f('f_b', 'active', 'boolean', { nullable: true }),
    ]),
  ];
  const r = await migrate(sql, dropped, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['dropField']);

  const cols = (await physicalColumns(sql, 'ct_thing')).map((c) => c.name);
  assert.ok(!cols.includes('note'), 'note dropped');
  assert.ok(['title', 'views', 'active'].every((c) => cols.includes(c)), 'siblings remain');

  const rows = await sql<{ title: string; views: number; active: boolean }[]>`SELECT title, views, active FROM ct_thing ORDER BY title`;
  assert.equal(rows.length, 2, 'no rows lost');
  assert.deepEqual(rows[0], { title: 'a', views: 10, active: true });
  assert.deepEqual(rows[1], { title: 'b', views: 20, active: false });
});

test('DROP a whole TYPE is BLOCKED without ack — table + rows survive', async () => {
  await migrate(sql, [
    ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })]),
    ct('ct_b', 'gadget', [f('f_g', 'label', 'string', { nullable: true })]),
  ]);
  await sql.unsafe(`INSERT INTO ct_gadget (label) VALUES ('alive')`);

  // Removing ct_b from the catalog => dropType (destructive). Without ack it must block + leave the table.
  const onlyThing = [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])];
  await assert.rejects(migrate(sql, onlyThing), MigrationBlockedError);

  assert.equal(await tableExists(sql, 'ct_gadget'), true, 'table survives the block');
  const [row] = await sql<{ label: string }[]>`SELECT label FROM ct_gadget`;
  assert.equal(row?.label, 'alive', 'rows survive the block');
  // The kept type must be undisturbed too.
  assert.equal(await tableExists(sql, 'ct_thing'), true);
});

test('DROP a whole TYPE WITH allowDestructive — table gone, the OTHER type untouched', async () => {
  await migrate(sql, [
    ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })]),
    ct('ct_b', 'gadget', [f('f_g', 'label', 'string', { nullable: true })]),
  ]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('survivor')`);
  await sql.unsafe(`INSERT INTO ct_gadget (label) VALUES ('doomed')`);

  const onlyThing = [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])];
  const r = await migrate(sql, onlyThing, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['dropType']);

  assert.equal(await tableExists(sql, 'ct_gadget'), false, 'dropped type table is gone');
  assert.equal(await tableExists(sql, 'ct_thing'), true, 'kept type table remains');
  const [row] = await sql<{ title: string }[]>`SELECT title FROM ct_thing`;
  assert.equal(row?.title, 'survivor', 'the kept type keeps its data');
});

test('RE-ADD a dropped field comes back FRESH (empty) — no resurrection of old data', async () => {
  // 1) create with note, write data into it.
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true }), f('f_n', 'note', 'text', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title, note) VALUES ('row', 'old-note')`);

  // 2) drop note (destructive, acked).
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])], { allowDestructive: true });
  assert.ok(!(await physicalColumns(sql, 'ct_thing')).some((c) => c.name === 'note'), 'note dropped');

  // 3) re-add a NEW field by the same name but a fresh id — additive (safe), no ack needed.
  const r = await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true }), f('f_n2', 'note', 'text', { nullable: true })])]);
  assert.deepEqual(r.applied.map((c) => c.kind), ['addField'], 're-add is a plain ADD COLUMN');

  // The existing row's title is untouched; the re-added note is NULL (the old bytes are NOT resurrected).
  const [row] = await sql<{ title: string; note: string | null }[]>`SELECT title, note FROM ct_thing`;
  assert.equal(row?.title, 'row', 'untouched sibling data');
  assert.equal(row?.note, null, 're-added column is fresh/empty, not the dropped data');
});

test('DROP field + DROP type in ONE migration are BOTH gated; ack applies BOTH atomically', async () => {
  await migrate(sql, [
    ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true }), f('f_n', 'note', 'text', { nullable: true })]),
    ct('ct_b', 'gadget', [f('f_g', 'label', 'string', { nullable: true })]),
  ]);
  await sql.unsafe(`INSERT INTO ct_thing (title, note) VALUES ('t', 'n')`);
  await sql.unsafe(`INSERT INTO ct_gadget (label) VALUES ('g')`);

  // next: drop ct_thing.note AND drop the whole ct_gadget type.
  const next = [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])];

  // Without ack: blocked, and NEITHER destructive op applies (both column + table still present).
  await assert.rejects(migrate(sql, next), MigrationBlockedError);
  assert.ok((await physicalColumns(sql, 'ct_thing')).some((c) => c.name === 'note'), 'note survives the block');
  assert.equal(await tableExists(sql, 'ct_gadget'), true, 'gadget survives the block');

  // With ack: both apply in the one transaction; the surviving data is intact.
  const r = await migrate(sql, next, { allowDestructive: true });
  assert.deepEqual(new Set(r.applied.map((c) => c.kind)), new Set(['dropField', 'dropType']));
  assert.ok(!(await physicalColumns(sql, 'ct_thing')).some((c) => c.name === 'note'), 'note dropped');
  assert.equal(await tableExists(sql, 'ct_gadget'), false, 'gadget dropped');
  const [row] = await sql<{ title: string }[]>`SELECT title FROM ct_thing`;
  assert.equal(row?.title, 't', 'surviving column data intact after the combined destructive apply');
});

test('after a DROP is BLOCKED, the applied-schema snapshot is unchanged (retry still blocks the SAME way)', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true }), f('f_n', 'note', 'text', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title, note) VALUES ('a', 'b')`);

  const dropped = [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])];

  // First block.
  await assert.rejects(migrate(sql, dropped), MigrationBlockedError);
  // A second identical attempt must block IDENTICALLY (the _schema_applied snapshot was not advanced),
  // and the data is still there — proving the failed migration left no partial state.
  await assert.rejects(migrate(sql, dropped), MigrationBlockedError);
  assert.ok((await physicalColumns(sql, 'ct_thing')).some((c) => c.name === 'note'), 'still present after two blocks');
  const [row] = await sql<{ note: string }[]>`SELECT note FROM ct_thing`;
  assert.equal(row?.note, 'b', 'data intact after repeated blocked attempts');

  // And a re-run of the ORIGINAL (no-drop) schema is a clean no-op — the snapshot was never corrupted.
  const noop = await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true }), f('f_n', 'note', 'text', { nullable: true })])]);
  assert.equal(noop.noop, true, 'snapshot intact: original schema re-applies as a no-op');
});
