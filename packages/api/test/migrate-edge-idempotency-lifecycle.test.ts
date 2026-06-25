import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { migrate, migrateLint, MigrationBlockedError } from '../src/db/schema/migrate.ts';
import type { Schema, FieldSchema, FieldType } from '../src/db/schema/model.ts';
import type { FieldOptions } from '../src/db/type.catalog.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, physicalColumns, tableExists } from './helpers.ts';

/**
 * S4 migrate engine — IDEMPOTENCY-LIFECYCLE edge dimension, against REAL Postgres (no mocks). Where
 * schema-migrate.test.ts proves each op once in isolation, this drives the HEADLINE end-to-end lifecycle:
 * create -> INSERT real rows -> rename -> add-with-default -> retype -> drop -> re-run as a NO-OP, and
 * asserts the ACTUAL ROW DATA survives every step (not just that columns exist). It also pins down the
 * idempotency invariants the design leans on: diff(x,x) is empty, a re-run of a destructive migration is a
 * no-op, migrating to the EXACT current state never touches the table, and the `_schema_applied` snapshot
 * stays consistent (a single row per type, tracking the latest catalog) across the whole sequence.
 */

const f = (id: string, name: string, type: FieldType, options?: FieldOptions): FieldSchema =>
  options ? { id, name, type, options } : { id, name, type };
const schema = (id: string, apiId: string, fields: FieldSchema[]): Schema => ({ id, apiId, fields });

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;

before(async () => {
  db = await createFileDatabase('edgeidempotency-lifecycle');
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

/** Read the applied-snapshot rows for a type id (the canonical-JSON bookkeeping the diff reads back). */
async function appliedRows(s: Sql): Promise<{ type_id: string; api_id: string; schema: Schema }[]> {
  return s<{ type_id: string; api_id: string; schema: Schema }[]>`
    SELECT type_id, api_id, schema FROM _schema_applied ORDER BY type_id
  `;
}

test('HEADLINE lifecycle: create -> rename -> add+default -> retype -> drop -> idempotent re-run, data intact throughout', async () => {
  // 1) CREATE the entity.
  const v1 = [
    schema('ct_a', 'article', [
      f('f_t', 'title', 'string', { nullable: true }),
      f('f_b', 'body', 'text', { nullable: true }),
      f('f_v', 'views', 'integer', { nullable: true }),
    ]),
  ];
  const r1 = await migrate(sql, v1);
  assert.equal(r1.noop, false);
  assert.equal(await tableExists(sql, 'ct_article'), true);

  // 2) INSERT several REAL rows.
  await sql.unsafe(`INSERT INTO ct_article (title, body, views) VALUES
    ('alpha', 'first body', 10),
    ('beta',  'second body', 20),
    ('gamma', 'third body', 30)`);

  // 3) MIGRATE: rename `title` -> `headline` (same field id f_t => RENAME COLUMN, lossless).
  const v2 = [
    schema('ct_a', 'article', [
      f('f_t', 'headline', 'string', { nullable: true }),
      f('f_b', 'body', 'text', { nullable: true }),
      f('f_v', 'views', 'integer', { nullable: true }),
    ]),
  ];
  const r2 = await migrate(sql, v2);
  assert.deepEqual(r2.applied.map((c) => c.kind), ['renameField']);
  let cols = (await physicalColumns(sql, 'ct_article')).map((c) => c.name);
  assert.ok(cols.includes('headline') && !cols.includes('title'), 'renamed, not dropped+added');
  // ALL THREE rows survive under the new name, in value-order.
  const afterRename = await sql<{ headline: string; body: string; views: number }[]>`
    SELECT headline, body, views FROM ct_article ORDER BY views`;
  assert.deepEqual(afterRename.map((r) => r.headline), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(afterRename.map((r) => r.body), ['first body', 'second body', 'third body']);

  // 4) MIGRATE: add `active boolean NOT NULL DEFAULT false` (safe — default backfills existing rows).
  const v3 = [
    schema('ct_a', 'article', [
      f('f_t', 'headline', 'string', { nullable: true }),
      f('f_b', 'body', 'text', { nullable: true }),
      f('f_v', 'views', 'integer', { nullable: true }),
      f('f_act', 'active', 'boolean', { nullable: false, default: false }),
    ]),
  ];
  const r3 = await migrate(sql, v3);
  assert.deepEqual(r3.applied.map((c) => c.kind), ['addField']);
  // every PRE-EXISTING row backfilled to the default; old columns untouched.
  const afterAdd = await sql<{ headline: string; active: boolean }[]>`
    SELECT headline, active FROM ct_article ORDER BY views`;
  assert.deepEqual(afterAdd.map((r) => r.active), [false, false, false]);
  assert.deepEqual(afterAdd.map((r) => r.headline), ['alpha', 'beta', 'gamma']);

  // 5) MIGRATE: retype `views` integer -> biginteger (rewrite = data-dependent => needs the ack).
  const v4 = [
    schema('ct_a', 'article', [
      f('f_t', 'headline', 'string', { nullable: true }),
      f('f_b', 'body', 'text', { nullable: true }),
      f('f_v', 'views', 'biginteger', { nullable: true }),
      f('f_act', 'active', 'boolean', { nullable: false, default: false }),
    ]),
  ];
  await assert.rejects(migrate(sql, v4), MigrationBlockedError); // gated without the ack
  // gate held — nothing changed: still int4.
  let viewsType = (await physicalColumns(sql, 'ct_article')).find((c) => c.name === 'views')!.type;
  assert.equal(viewsType, 'integer');

  const r4 = await migrate(sql, v4, { allowDestructive: true });
  assert.deepEqual(r4.applied.map((c) => c.kind), ['retypeField']);
  viewsType = (await physicalColumns(sql, 'ct_article')).find((c) => c.name === 'views')!.type;
  assert.equal(viewsType, 'bigint');
  // VALUES carried across the cast (read as string to dodge JS bigint precision).
  const afterRetype = await sql<{ headline: string; views: string }[]>`
    SELECT headline, views::text AS views FROM ct_article ORDER BY views`;
  assert.deepEqual(afterRetype.map((r) => r.views), ['10', '20', '30']);
  assert.deepEqual(afterRetype.map((r) => r.headline), ['alpha', 'beta', 'gamma']);

  // 6) MIGRATE: drop `body` (destructive => gated; allowed with the ack). The OTHER columns' data intact.
  const v5 = [
    schema('ct_a', 'article', [
      f('f_t', 'headline', 'string', { nullable: true }),
      f('f_v', 'views', 'biginteger', { nullable: true }),
      f('f_act', 'active', 'boolean', { nullable: false, default: false }),
    ]),
  ];
  await assert.rejects(migrate(sql, v5), MigrationBlockedError);
  assert.ok((await physicalColumns(sql, 'ct_article')).some((c) => c.name === 'body'), 'gate held: body still present');

  const r5 = await migrate(sql, v5, { allowDestructive: true });
  assert.deepEqual(r5.applied.map((c) => c.kind), ['dropField']);
  cols = (await physicalColumns(sql, 'ct_article')).map((c) => c.name);
  assert.ok(!cols.includes('body'), 'body dropped');
  // the surviving columns keep every row + value.
  const afterDrop = await sql<{ headline: string; views: string; active: boolean }[]>`
    SELECT headline, views::text AS views, active FROM ct_article ORDER BY views`;
  assert.deepEqual(afterDrop.map((r) => r.headline), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(afterDrop.map((r) => r.views), ['10', '20', '30']);
  assert.deepEqual(afterDrop.map((r) => r.active), [false, false, false]);

  // 7) RE-RUN the SAME migrate => NOOP (idempotent), applied = []; data still intact.
  const r6 = await migrate(sql, v5, { allowDestructive: true });
  assert.equal(r6.noop, true);
  assert.equal(r6.applied.length, 0);
  const finalRows = await sql<{ headline: string }[]>`SELECT headline FROM ct_article ORDER BY views`;
  assert.deepEqual(finalRows.map((r) => r.headline), ['alpha', 'beta', 'gamma']);

  // the applied snapshot tracks EXACTLY the final catalog: one row, latest apiId, headline+views+active.
  const applied = await appliedRows(sql);
  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.type_id, 'ct_a');
  assert.equal(applied[0]!.api_id, 'article');
  assert.deepEqual(applied[0]!.schema.fields.map((f) => f.name), ['headline', 'views', 'active']);
});

test('migrating to the EXACT current state is a no-op (diff(x,x) empty) — even with rows present', async () => {
  const v = [
    schema('ct_a', 'thing', [
      f('f_t', 'title', 'string', { nullable: true }),
      f('f_n', 'note', 'text', { nullable: true }),
    ]),
  ];
  await migrate(sql, v);
  await sql.unsafe(`INSERT INTO ct_thing (title, note) VALUES ('keep', 'me')`);

  // identical IR (fresh object graph, same ids/names/types) => empty change-set => no-op.
  const same = [
    schema('ct_a', 'thing', [
      f('f_t', 'title', 'string', { nullable: true }),
      f('f_n', 'note', 'text', { nullable: true }),
    ]),
  ];
  const r = await migrate(sql, same);
  assert.equal(r.noop, true);
  assert.equal(r.applied.length, 0);
  // the row is untouched.
  const [row] = await sql<{ title: string; note: string }[]>`SELECT title, note FROM ct_thing`;
  assert.equal(row?.title, 'keep');
  assert.equal(row?.note, 'me');
});

test('re-running a DESTRUCTIVE migration is itself a no-op (the drop is not re-attempted)', async () => {
  await migrate(sql, [
    schema('ct_a', 'thing', [
      f('f_t', 'title', 'string', { nullable: true }),
      f('f_n', 'note', 'text', { nullable: true }),
    ]),
  ]);
  await sql.unsafe(`INSERT INTO ct_thing (title, note) VALUES ('a', 'b')`);

  const dropped = [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])];
  const r1 = await migrate(sql, dropped, { allowDestructive: true });
  assert.deepEqual(r1.applied.map((c) => c.kind), ['dropField']);

  // second run sees `note` already gone in the snapshot => no diff => no-op, NOT a re-drop error.
  const r2 = await migrate(sql, dropped, { allowDestructive: true });
  assert.equal(r2.noop, true);
  assert.equal(r2.applied.length, 0);
  // and even WITHOUT the ack the now-equal state is a clean no-op (nothing destructive left to gate).
  const r3 = await migrate(sql, dropped);
  assert.equal(r3.noop, true);
  // the surviving row + column intact.
  const [row] = await sql<{ title: string }[]>`SELECT title FROM ct_thing`;
  assert.equal(row?.title, 'a');
});

test('a BLOCKED migration mutates NOTHING: not the table, not the applied snapshot (re-run still sees the gate)', async () => {
  const v1 = [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true }), f('f_n', 'note', 'text', { nullable: true })])];
  await migrate(sql, v1);
  await sql.unsafe(`INSERT INTO ct_thing (title, note) VALUES ('x', 'y')`);

  const snapBefore = await appliedRows(sql);

  const dropped = [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])];
  await assert.rejects(migrate(sql, dropped), MigrationBlockedError);

  // table unchanged.
  assert.ok((await physicalColumns(sql, 'ct_thing')).some((c) => c.name === 'note'));
  const [row] = await sql<{ title: string; note: string }[]>`SELECT title, note FROM ct_thing`;
  assert.equal(row?.note, 'y');
  // snapshot unchanged — the blocked path never reconciled `_schema_applied`.
  const snapAfter = await appliedRows(sql);
  assert.deepEqual(snapAfter.map((r) => r.schema.fields.map((f) => f.name)), snapBefore.map((r) => r.schema.fields.map((f) => f.name)));

  // because the snapshot was untouched, a re-run hits the SAME gate (not a silent no-op).
  await assert.rejects(migrate(sql, dropped), MigrationBlockedError);
  // lint confirms the same single blocked drop, still applying nothing.
  const { changes, blocked } = await migrateLint(sql, dropped);
  assert.deepEqual(changes.map((c) => c.kind), ['dropField']);
  assert.equal(blocked.length, 1);
});

test('ROLLBACK atomicity: a multi-op migration that fails its data-dependent op leaves NO partial apply', async () => {
  // start: title + a free-text `code` column carrying a non-numeric value.
  await migrate(sql, [
    schema('ct_a', 'thing', [
      f('f_t', 'title', 'string', { nullable: true }),
      f('f_c', 'code', 'string', { nullable: true }),
    ]),
  ]);
  await sql.unsafe(`INSERT INTO ct_thing (title, code) VALUES ('alpha', 'NOT-A-NUMBER'), ('beta', 'STILL-NOT')`);

  // one migration with TWO ops: a safe rename (title->headline) AND a rewrite-cast (code string->integer)
  // whose cast FAILS on the real rows. The cast aborts the tx => the rename must roll back too.
  const failing = [
    schema('ct_a', 'thing', [
      f('f_t', 'headline', 'string', { nullable: true }),
      f('f_c', 'code', 'integer', { nullable: true }),
    ]),
  ];
  await assert.rejects(migrate(sql, failing, { allowDestructive: true })); // PG cast error inside the tx

  // NO partial apply: the rename did NOT stick, the retype did NOT stick.
  const cols = (await physicalColumns(sql, 'ct_thing')).map((c) => c.name);
  assert.ok(cols.includes('title') && !cols.includes('headline'), 'rename rolled back');
  const codeType = (await physicalColumns(sql, 'ct_thing')).find((c) => c.name === 'code')!.type;
  assert.ok(codeType === 'character varying' || codeType === 'text', `code stayed a string type, got ${codeType}`);
  // data fully intact.
  const rows = await sql<{ title: string; code: string }[]>`SELECT title, code FROM ct_thing ORDER BY title`;
  assert.deepEqual(rows.map((r) => r.title), ['alpha', 'beta']);
  assert.deepEqual(rows.map((r) => r.code), ['NOT-A-NUMBER', 'STILL-NOT']);
  // snapshot still the ORIGINAL (rollback reverted reconcileApplied too) => a corrected re-migrate is offered the gate, not a phantom diff.
  const applied = await appliedRows(sql);
  assert.deepEqual(applied[0]!.schema.fields.map((f) => f.name), ['title', 'code']);
});

test('rename round-trip (A->B->A) preserves data and lands a self-consistent snapshot', async () => {
  await migrate(sql, [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('roundtrip')`);

  // A -> B
  const r1 = await migrate(sql, [schema('ct_a', 'thing', [f('f_t', 'headline', 'string', { nullable: true })])]);
  assert.deepEqual(r1.applied.map((c) => c.kind), ['renameField']);
  // B -> A (back to the original name)
  const r2 = await migrate(sql, [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  assert.deepEqual(r2.applied.map((c) => c.kind), ['renameField']);

  const cols = (await physicalColumns(sql, 'ct_thing')).map((c) => c.name);
  assert.ok(cols.includes('title') && !cols.includes('headline'), 'back under the original name');
  const [row] = await sql<{ title: string }[]>`SELECT title FROM ct_thing`;
  assert.equal(row?.title, 'roundtrip'); // never lost across two renames

  // re-running the final state is a clean no-op (snapshot agrees with the file).
  const r3 = await migrate(sql, [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  assert.equal(r3.noop, true);
  const applied = await appliedRows(sql);
  assert.equal(applied[0]!.schema.fields[0]!.name, 'title');
});

test('rename + add in ONE migration: both apply atomically, old rows survive under the new name, new column backfills', async () => {
  await migrate(sql, [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('one'), ('two')`);

  // one step: rename title->name AND add slug NOT NULL DEFAULT 'x'.
  const next = [
    schema('ct_a', 'thing', [
      f('f_t', 'name', 'string', { nullable: true }),
      f('f_s', 'slug', 'string', { nullable: false, default: 'x' }),
    ]),
  ];
  const r = await migrate(sql, next);
  assert.deepEqual(new Set(r.applied.map((c) => c.kind)), new Set(['renameField', 'addField']));

  const rows = await sql<{ name: string; slug: string }[]>`SELECT name, slug FROM ct_thing ORDER BY name`;
  assert.deepEqual(rows.map((r) => r.name), ['one', 'two']); // data survived rename
  assert.deepEqual(rows.map((r) => r.slug), ['x', 'x']); // new column backfilled to default

  // idempotent re-run.
  assert.equal((await migrate(sql, next)).noop, true);
});
