import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { migrate, MigrationBlockedError, MigrationDataLossError } from '../src/db/schema/migrate.ts';
import type { Schema, FieldSchema, FieldType } from '../src/db/schema/model.ts';
import type { FieldOptions } from '../src/db/type.catalog.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, physicalColumns, tableExists } from './helpers.ts';

/**
 * RETYPE edge-cases for the S4 migrate engine, against REAL Postgres (no mocks). Goes deeper than the
 * happy-path int->bigint in schema-migrate.test.ts: every casting transition is exercised with REAL ROWS
 * inserted first, then the data is SELECTed back and asserted to survive (safe casts) or the migration is
 * asserted to be GATED / ROLLED BACK with the data + schema intact (unsafe casts).
 *
 * The two casting seams under test:
 *   - diff.classifyTypeChange -> retypeRisk: metadata-only=safe, rewrite=data-dependent, forbidden.
 *   - ddl.compileAlterColumnType: `ALTER COLUMN TYPE <pg> USING <col>::<pg>` — note it NEVER touches an
 *     existing CHECK constraint, which is the source of the enum suspected-bugs below.
 */

const f = (id: string, name: string, type: FieldType, options?: FieldOptions): FieldSchema =>
  options ? { id, name, type, options } : { id, name, type };
const schema = (id: string, apiId: string, fields: FieldSchema[]): Schema => ({ id, apiId, fields });

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;

before(async () => {
  db = await createFileDatabase('edgeretype');
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

test('integer -> biginteger: gated as data-dependent; acked cast preserves the exact value', async () => {
  await migrate(sql, [schema('ct_a', 'thing', [f('f_v', 'views', 'integer', { nullable: true })])]);
  // A value safely inside int4 but we also push an int4-max boundary to prove it survives the widening.
  await sql.unsafe(`INSERT INTO ct_thing (views) VALUES (2147483647), (-2147483648), (0)`);

  const widened = [schema('ct_a', 'thing', [f('f_v', 'views', 'biginteger', { nullable: true })])];
  await assert.rejects(migrate(sql, widened), MigrationBlockedError);
  // The block changed nothing: still int4.
  assert.equal((await physicalColumns(sql, 'ct_thing')).find((c) => c.name === 'views')?.type, 'integer');

  const r = await migrate(sql, widened, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['retypeField']);
  assert.equal((await physicalColumns(sql, 'ct_thing')).find((c) => c.name === 'views')?.type, 'bigint');
  const rows = await sql<{ views: string }[]>`SELECT views FROM ct_thing ORDER BY views`;
  // bigint comes back as a STRING via postgres.js — compare as strings to avoid precision loss.
  assert.deepEqual(rows.map((x) => String(x.views)), ['-2147483648', '0', '2147483647']);
});

test('varchar GROW (512 -> 1024): metadata-only/safe, NO ack needed, data intact', async () => {
  await migrate(sql, [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { length: 512, nullable: true })])]);
  const long = 'x'.repeat(512); // exactly fills the old column
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('hello'), ('${long}')`);

  // Widening is metadata-only -> safe: NO allowDestructive required.
  const grown = [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { length: 1024, nullable: true })])];
  const r = await migrate(sql, grown);
  assert.deepEqual(r.applied.map((c) => c.kind), ['retypeField']);

  const col = (await physicalColumns(sql, 'ct_thing')).find((c) => c.name === 'title');
  assert.equal(col?.type, 'character varying');
  const rows = await sql<{ title: string }[]>`SELECT title FROM ct_thing ORDER BY length(title)`;
  assert.deepEqual(rows.map((x) => x.title), ['hello', long]); // every char survived
});

test('varchar SHRINK (1024 -> 256) with an OVER-LONG row: even acked, the pre-flight FAILS LOUD + rolls back (FIXED)', async () => {
  await migrate(sql, [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { length: 1024, nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('short one'), ('${'y'.repeat(1024)}')`);

  const shrunk = [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { length: 256, nullable: true })])];
  // Shrink truncates -> rewrite -> data-dependent -> blocked without ack.
  await assert.rejects(migrate(sql, shrunk), MigrationBlockedError);

  // ACKED no longer truncates silently: the pre-flight COUNT finds 1 over-long row and refuses, naming it.
  await assert.rejects(
    () => migrate(sql, shrunk, { allowDestructive: true }),
    (e: unknown) => e instanceof MigrationDataLossError && e.affected === 1 && e.column === 'title',
  );
  // Nothing changed: still varchar(1024) and BOTH values intact at full length (the over-long row not cut).
  assert.equal((await physicalColumns(sql, 'ct_thing')).find((c) => c.name === 'title')?.type, 'character varying');
  const rows = await sql<{ title: string }[]>`SELECT title FROM ct_thing ORDER BY length(title)`;
  assert.deepEqual([rows[0]?.title, rows[1]?.title?.length], ['short one', 1024], 'over-long value survives uncut');
});

test('varchar SHRINK (1024 -> 256) where ALL rows FIT: acked shrink applies cleanly, data byte-identical', async () => {
  await migrate(sql, [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { length: 1024, nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('short one'), (NULL), ('${'z'.repeat(200)}')`); // all <= 256

  const shrunk = [schema('ct_a', 'thing', [f('f_t', 'title', 'string', { length: 256, nullable: true })])];
  const r = await migrate(sql, shrunk, { allowDestructive: true }); // pre-flight finds 0 over-long -> proceeds
  assert.deepEqual(r.applied.map((c) => c.kind), ['retypeField']);
  const rows = await sql<{ title: string | null }[]>`SELECT title FROM ct_thing ORDER BY length(title) NULLS FIRST`;
  assert.deepEqual([rows[0]?.title, rows[1]?.title, rows[2]?.title?.length], [null, 'short one', 200], 'every value untouched');
  // The new ceiling is real: a 257-char insert is now rejected.
  await assert.rejects(sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('${'q'.repeat(257)}')`));
});

test('enumeration ADD a member: gated; acked rebuilds the CHECK so the NEW member is insertable (FIXED)', async () => {
  await migrate(sql, [schema('ct_a', 'thing', [f('f_s', 'state', 'enumeration', { values: ['draft', 'live'], nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (state) VALUES ('draft'), ('live')`);

  // Adding a member changes the value-set -> classifyTypeChange = rewrite -> data-dependent -> gated.
  const added = [schema('ct_a', 'thing', [f('f_s', 'state', 'enumeration', { values: ['draft', 'live', 'archived'], nullable: true })])];
  await assert.rejects(migrate(sql, added), MigrationBlockedError);

  const r = await migrate(sql, added, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['retypeField']);
  // Existing rows intact + the CHECK was rebuilt (and the varchar grown for 'archived') so the new member inserts.
  assert.deepEqual((await sql<{ state: string }[]>`SELECT state FROM ct_thing ORDER BY state`).map((x) => x.state), ['draft', 'live']);
  await sql.unsafe(`INSERT INTO ct_thing (state) VALUES ('archived')`);
  const [c1] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ct_thing WHERE state = 'archived'`;
  assert.equal(c1?.n, 1, 'the added enum member is now insertable (CHECK rebuilt)');
});

test('enumeration REMOVE an UNUSED member: acked rebuilds the CHECK; the removed member is now REJECTED (FIXED)', async () => {
  await migrate(sql, [schema('ct_a', 'thing', [f('f_s', 'state', 'enumeration', { values: ['draft', 'live', 'archived'], nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (state) VALUES ('draft'), ('live')`); // NO row uses 'archived'

  const removed = [schema('ct_a', 'thing', [f('f_s', 'state', 'enumeration', { values: ['draft', 'live'], nullable: true })])];
  const r = await migrate(sql, removed, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['retypeField']);
  assert.deepEqual((await sql<{ state: string }[]>`SELECT state FROM ct_thing ORDER BY state`).map((x) => x.state), ['draft', 'live']); // data intact
  // FIXED: the new CHECK enforces the removal — 'archived' is no longer accepted.
  await assert.rejects(() => sql.unsafe(`INSERT INTO ct_thing (state) VALUES ('archived')`), /violates check constraint/i);
});

test('enumeration REMOVE an IN-USE member: correctly REJECTED (cannot remove a member a row uses); rolls back', async () => {
  await migrate(sql, [schema('ct_a', 'thing', [f('f_s', 'state', 'enumeration', { values: ['draft', 'live', 'archived'], nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (state) VALUES ('draft'), ('archived')`); // a row USES 'archived'

  const removed = [schema('ct_a', 'thing', [f('f_s', 'state', 'enumeration', { values: ['draft', 'live'], nullable: true })])];
  await assert.rejects(migrate(sql, removed), MigrationBlockedError); // gated
  // Acked: the rebuilt CHECK (draft,live) is VALIDATED against the 'archived' row -> ADD CONSTRAINT fails ->
  // the WHOLE migration rolls back. Data intact + the original CHECK is restored (so 'archived' still valid,
  // 'bogus' still rejected) — proving no partial apply and no corruption.
  await assert.rejects(migrate(sql, removed, { allowDestructive: true }));
  assert.deepEqual((await sql<{ state: string }[]>`SELECT state FROM ct_thing ORDER BY state`).map((x) => x.state), ['archived', 'draft']);
  await sql.unsafe(`INSERT INTO ct_thing (state) VALUES ('archived')`); // old CHECK restored by the rollback
  await assert.rejects(() => sql.unsafe(`INSERT INTO ct_thing (state) VALUES ('bogus')`), /violates check constraint/i);
});

test('decimal precision/scale CHANGE (10,2 -> 12,4): gated; acked cast re-scales the stored value', async () => {
  await migrate(sql, [schema('ct_a', 'thing', [f('f_p', 'price', 'decimal', { precision: 10, scale: 2, nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (price) VALUES (123.45), (0.10)`);

  // Any numeric precision/scale change is a rewrite -> data-dependent -> gated.
  const rescaled = [schema('ct_a', 'thing', [f('f_p', 'price', 'decimal', { precision: 12, scale: 4, nullable: true })])];
  await assert.rejects(migrate(sql, rescaled), MigrationBlockedError);
  // Block changed nothing: still numeric(10,2).
  const before = (await physicalColumns(sql, 'ct_thing')).find((c) => c.name === 'price');
  assert.equal(before?.type, 'numeric');

  const r = await migrate(sql, rescaled, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['retypeField']);
  // Values preserved, re-scaled to scale 4 (numeric is returned as a STRING by postgres.js).
  const rows = await sql<{ price: string }[]>`SELECT price FROM ct_thing ORDER BY price`;
  assert.deepEqual(rows.map((x) => x.price), ['0.1000', '123.4500']);
});

test('decimal SCALE SHRINK (10,4 -> 10,2) with a ROUNDING row: even acked, the pre-flight FAILS LOUD + rolls back (FIXED)', async () => {
  await migrate(sql, [schema('ct_a', 'thing', [f('f_p', 'price', 'decimal', { precision: 10, scale: 4, nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (price) VALUES (1.2345), (9.9900)`); // 1.2345 would round, 9.9900 fits

  const narrowed = [schema('ct_a', 'thing', [f('f_p', 'price', 'decimal', { precision: 10, scale: 2, nullable: true })])];
  await assert.rejects(migrate(sql, narrowed), MigrationBlockedError);

  // ACKED no longer rounds silently: the pre-flight finds the 1 row that would lose fractional digits.
  await assert.rejects(
    () => migrate(sql, narrowed, { allowDestructive: true }),
    (e: unknown) => e instanceof MigrationDataLossError && e.affected === 1 && e.column === 'price',
  );
  // Untouched: still numeric(10,4), 1.2345 NOT rounded.
  const rows = await sql<{ price: string }[]>`SELECT price FROM ct_thing ORDER BY price`;
  assert.deepEqual(rows.map((x) => x.price), ['1.2345', '9.9900']);
});

test('decimal SCALE SHRINK (10,4 -> 10,2) where NO value rounds: acked shrink applies cleanly', async () => {
  await migrate(sql, [schema('ct_a', 'thing', [f('f_p', 'price', 'decimal', { precision: 10, scale: 4, nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (price) VALUES (1.2300), (0.5000), (NULL)`); // all exact at scale 2

  const narrowed = [schema('ct_a', 'thing', [f('f_p', 'price', 'decimal', { precision: 10, scale: 2, nullable: true })])];
  const r = await migrate(sql, narrowed, { allowDestructive: true }); // 0 rounding rows -> proceeds
  assert.deepEqual(r.applied.map((c) => c.kind), ['retypeField']);
  const rows = await sql<{ price: string | null }[]>`SELECT price FROM ct_thing ORDER BY price NULLS FIRST`;
  assert.deepEqual(rows.map((x) => x.price), [null, '0.50', '1.23'], 're-scaled to scale 2, no value changed');
});

test('UNCASTABLE string -> integer on NON-NUMERIC rows: gated, and on apply the WHOLE tx ROLLS BACK', async () => {
  await migrate(sql, [
    schema('ct_a', 'thing', [
      f('f_t', 'title', 'string', { length: 255, nullable: true }),
      f('f_n', 'note', 'string', { length: 255, nullable: true }),
    ]),
  ]);
  await sql.unsafe(`INSERT INTO ct_thing (title, note) VALUES ('hello world', 'keep me')`);

  // string -> integer: cms_type + pg_type + engine_type all change -> rewrite -> data-dependent -> gated.
  const retyped = [
    schema('ct_a', 'thing', [
      f('f_t', 'title', 'integer', { nullable: true }),
      f('f_n', 'note', 'string', { length: 255, nullable: true }),
    ]),
  ];
  await assert.rejects(migrate(sql, retyped), MigrationBlockedError);
  assert.equal((await physicalColumns(sql, 'ct_thing')).find((c) => c.name === 'title')?.type, 'character varying');

  // ACKED: `title::integer` on 'hello world' raises 22P02 (invalid_text_representation). The single
  // tx (sql.begin) must roll the ENTIRE migration back — column type unchanged, data intact, and
  // _schema_applied NOT advanced (a re-diff still produces the same retype).
  await assert.rejects(migrate(sql, retyped, { allowDestructive: true }), (err: unknown) => {
    // Not a MigrationBlockedError (it passed the gate); a raw PG cast error surfaces from the failed tx.
    assert.ok(!(err instanceof MigrationBlockedError));
    return true;
  });

  // No partial application: title is still varchar, note untouched, the row is exactly as inserted.
  const cols = await physicalColumns(sql, 'ct_thing');
  assert.equal(cols.find((c) => c.name === 'title')?.type, 'character varying');
  assert.equal(cols.find((c) => c.name === 'note')?.type, 'character varying');
  const [row] = await sql<{ title: string; note: string }[]>`SELECT title, note FROM ct_thing`;
  assert.equal(row?.title, 'hello world');
  assert.equal(row?.note, 'keep me');

  // _schema_applied was NOT advanced: the applied snapshot still describes `title` as a string, so a
  // dry re-run still finds the same blocked retype (proving the reconcile rolled back with the DDL).
  await assert.rejects(migrate(sql, retyped), MigrationBlockedError);
});

test('UNCASTABLE string -> integer SUCCEEDS when every row is numeric-looking (cast carries the value)', async () => {
  await migrate(sql, [schema('ct_a', 'thing', [f('f_t', 'code', 'string', { length: 255, nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (code) VALUES ('42'), ('-7'), (NULL)`);

  const retyped = [schema('ct_a', 'thing', [f('f_t', 'code', 'integer', { nullable: true })])];
  await assert.rejects(migrate(sql, retyped), MigrationBlockedError); // still data-dependent -> gated

  const r = await migrate(sql, retyped, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['retypeField']);
  assert.equal((await physicalColumns(sql, 'ct_thing')).find((c) => c.name === 'code')?.type, 'integer');
  const rows = await sql<{ code: number | null }[]>`SELECT code FROM ct_thing ORDER BY code NULLS LAST`;
  assert.deepEqual(rows.map((x) => x.code), [-7, 42, null]); // numeric strings cast cleanly; NULL stays NULL
});
