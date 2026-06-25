import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { migrate, MigrationBlockedError } from '../src/db/schema/migrate.ts';
import type { ContentTypeSchema, FieldSchema, FieldType } from '../src/db/schema/model.ts';
import type { FieldOptions } from '../src/db/type.catalog.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, physicalColumns, tableExists } from './helpers.ts';

/**
 * S4 migrate engine — NULLABILITY + DEFAULTS edge cases against REAL Postgres (no mocks). Goes deeper than
 * schema-migrate.test.ts's happy path: every test INSERTS REAL ROWS, performs the migration, then SELECTs
 * and asserts the DATA survived (backfill value / null intact), not merely that a column exists.
 *
 * The matrix covered:
 *   - add a NOT NULL field WITH a default to a populated table -> existing rows BACKFILL to the default
 *     (bool / int / biginteger / float / decimal / string / enum), risk=safe (not gated).
 *   - add a NOT NULL field WITHOUT a default to a populated table -> data-dependent: BLOCKED without ack;
 *     with `allowDestructive` PG raises 23502 inside the tx -> whole migration ROLLS BACK (nothing applied).
 *   - flip a nullable column -> NOT NULL when some rows are NULL -> data-dependent: BLOCKED without ack;
 *     with ack PG raises 23502 -> ROLLBACK (the NULL row + nullable column both intact).
 *   - flip nullable -> NOT NULL when EVERY row is non-NULL + ack -> succeeds, data intact, column now NOT NULL.
 *   - flip NOT NULL -> nullable (DROP NOT NULL) -> SAFE (no ack), data intact, a fresh NULL insert now allowed.
 *
 * For a BLOCKED migration we assert MigrationBlockedError AND that nothing changed (column shape + rows). For
 * a ROLLED-BACK apply we assert the apply left NO partial change: the physical column nullability is unchanged,
 * the existing rows are intact, and a follow-up safe migration still computes the SAME change-set (the applied
 * snapshot `_schema_applied` was not advanced).
 */

const f = (id: string, name: string, type: FieldType, options?: FieldOptions): FieldSchema =>
  options ? { id, name, type, options } : { id, name, type };
const ct = (id: string, apiId: string, fields: FieldSchema[]): ContentTypeSchema => ({ id, apiId, fields });

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;

before(async () => {
  db = await createFileDatabase('edgenullability-defaults');
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

/** Read whether one physical column is nullable (information_schema is_nullable). */
async function colNullable(table: string, name: string): Promise<boolean | undefined> {
  return (await physicalColumns(sql, table)).find((c) => c.name === name)?.nullable;
}

test('ADD NOT NULL boolean WITH default false -> existing rows backfill to false (safe, not gated)', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('a'), ('b')`);

  const next = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_act', 'active', 'boolean', { nullable: false, default: false }),
  ])];
  const r = await migrate(sql, next); // NO allowDestructive — a NOT NULL add WITH a default is safe
  assert.deepEqual(r.applied.map((c) => c.kind), ['addField']);

  assert.equal(await colNullable('ct_thing', 'active'), false, 'column is physically NOT NULL');
  const rows = await sql<{ active: boolean }[]>`SELECT active FROM ct_thing ORDER BY id`;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((x) => x.active), [false, false]); // BOTH existing rows backfilled
});

test('ADD NOT NULL boolean WITH default true -> backfill to true (default value carried, not just non-null)', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('only')`);

  const next = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_ok', 'ok', 'boolean', { nullable: false, default: true }),
  ])];
  await migrate(sql, next);
  const [row] = await sql<{ ok: boolean }[]>`SELECT ok FROM ct_thing`;
  assert.equal(row?.ok, true); // backfilled to the TRUE default, not a coerced false
});

test('ADD NOT NULL integer WITH default 7 -> existing rows backfill to the integer default', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('x'), ('y'), ('z')`);

  const next = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_rk', 'rank', 'integer', { nullable: false, default: 7 }),
  ])];
  const r = await migrate(sql, next);
  assert.deepEqual(r.applied.map((c) => c.kind), ['addField']);
  const rows = await sql<{ rank: number }[]>`SELECT rank FROM ct_thing ORDER BY id`;
  assert.deepEqual(rows.map((x) => x.rank), [7, 7, 7]);
});

test('ADD NOT NULL biginteger WITH default -> existing rows backfill (i64 default carried losslessly)', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('big')`);

  // a value beyond i32 to prove the i64 path; supplied as a decimal-digit string (validateDefault i64).
  const next = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_cnt', 'count', 'biginteger', { nullable: false, default: '9007199254740993' }),
  ])];
  await migrate(sql, next);
  const [row] = await sql<{ count: string }[]>`SELECT count FROM ct_thing`;
  assert.equal(String(row?.count), '9007199254740993'); // bigint carried, no float precision loss
});

test('ADD NOT NULL float WITH default -> existing rows backfill to the float default', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('p')`);

  const next = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_score', 'score', 'float', { nullable: false, default: 1.5 }),
  ])];
  await migrate(sql, next);
  const [row] = await sql<{ score: number }[]>`SELECT score FROM ct_thing`;
  assert.equal(Number(row?.score), 1.5);
});

test('ADD NOT NULL decimal WITH default -> existing rows backfill to the decimal default', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('m')`);

  const next = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_amt', 'amount', 'decimal', { nullable: false, default: '12.34', precision: 10, scale: 2 }),
  ])];
  await migrate(sql, next);
  const [row] = await sql<{ amount: string }[]>`SELECT amount FROM ct_thing`;
  assert.equal(String(row?.amount), '12.34');
});

test('ADD NOT NULL string WITH default -> existing rows backfill to the string default', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('one'), ('two')`);

  const next = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_slug', 'slug', 'string', { nullable: false, default: 'untitled' }),
  ])];
  await migrate(sql, next);
  const rows = await sql<{ slug: string }[]>`SELECT slug FROM ct_thing ORDER BY id`;
  assert.deepEqual(rows.map((x) => x.slug), ['untitled', 'untitled']);
});

test('ADD NOT NULL enumeration WITH default -> backfill to the enum member (CHECK still satisfied)', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('e1'), ('e2')`);

  const next = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_st', 'state', 'enumeration', { nullable: false, default: 'draft', values: ['draft', 'review', 'live'] }),
  ])];
  const r = await migrate(sql, next);
  assert.deepEqual(r.applied.map((c) => c.kind), ['addField']);
  const rows = await sql<{ state: string }[]>`SELECT state FROM ct_thing ORDER BY id`;
  assert.deepEqual(rows.map((x) => x.state), ['draft', 'draft']);
  // The backfilled value satisfies the enum CHECK; a non-member insert is still rejected (23514).
  await assert.rejects(sql.unsafe(`INSERT INTO ct_thing (title, state) VALUES ('bad', 'bogus')`));
});

test('ADD NOT NULL WITHOUT default on a POPULATED table is BLOCKED (data-dependent); nothing changes', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('row1')`);

  const next = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_rk', 'rank', 'integer', { nullable: false }), // NOT NULL, no default
  ])];
  await assert.rejects(migrate(sql, next), MigrationBlockedError);

  // Nothing applied: the column was never added; the row is intact.
  assert.ok(!(await physicalColumns(sql, 'ct_thing')).some((c) => c.name === 'rank'), 'rank column not added');
  const [row] = await sql<{ title: string }[]>`SELECT title FROM ct_thing`;
  assert.equal(row?.title, 'row1');
});

test('ADD NOT NULL WITHOUT default + allowDestructive on POPULATED table -> PG 23502 -> ROLLBACK (no partial apply)', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('keepme')`);

  const next = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_rk', 'rank', 'integer', { nullable: false }),
  ])];
  // lint lets it through (acked), but PG refuses to add a NOT NULL column with no default to a populated
  // table (23502) -> the begin() tx rolls the WHOLE migration back.
  await assert.rejects(migrate(sql, next, { allowDestructive: true }));

  // Rollback proof: column never materialized, row intact, applied snapshot NOT advanced.
  assert.ok(!(await physicalColumns(sql, 'ct_thing')).some((c) => c.name === 'rank'), 'no partial column add');
  const [row] = await sql<{ title: string }[]>`SELECT title FROM ct_thing`;
  assert.equal(row?.title, 'keepme');

  // Snapshot unchanged: re-running with a default now re-computes the addField (the failed apply was not
  // recorded). If it succeeds and backfills, the prior apply genuinely rolled back.
  const fixed = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_rk', 'rank', 'integer', { nullable: false, default: 0 }),
  ])];
  const r = await migrate(sql, fixed);
  assert.deepEqual(r.applied.map((c) => c.kind), ['addField']);
  const [fixedRow] = await sql<{ rank: number }[]>`SELECT rank FROM ct_thing`;
  assert.equal(fixedRow?.rank, 0);
});

test('ADD NOT NULL WITHOUT default on an EMPTY table -> applies (no rows to violate the constraint)', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  // intentionally NO rows inserted

  const next = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_rk', 'rank', 'integer', { nullable: false }),
  ])];
  // Still data-dependent -> still gated by lint (the engine cannot know the table is empty without a probe);
  // with ack it applies cleanly because there are zero rows.
  await assert.rejects(migrate(sql, next), MigrationBlockedError);
  const r = await migrate(sql, next, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['addField']);
  assert.equal(await colNullable('ct_thing', 'rank'), false);
  // The constraint is real: a NULL insert is now refused.
  await assert.rejects(sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('no-rank')`));
});

test('FLIP nullable -> NOT NULL with SOME NULL rows is BLOCKED (data-dependent); column + rows unchanged', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_n', 'note', 'text', { nullable: true }),
  ])]);
  await sql.unsafe(`INSERT INTO ct_thing (title, note) VALUES ('a', 'has-note'), ('b', NULL)`);

  const next = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_n', 'note', 'text', { nullable: false }), // flip to NOT NULL
  ])];
  await assert.rejects(migrate(sql, next), MigrationBlockedError);

  // Unchanged: still nullable, the NULL row survives.
  assert.equal(await colNullable('ct_thing', 'note'), true, 'note still nullable (blocked)');
  const rows = await sql<{ note: string | null }[]>`SELECT note FROM ct_thing ORDER BY id`;
  assert.deepEqual(rows.map((x) => x.note), ['has-note', null]);
});

test('FLIP nullable -> NOT NULL with a NULL row + allowDestructive -> PG 23502 -> ROLLBACK (data intact)', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_n', 'note', 'text', { nullable: true }),
  ])]);
  await sql.unsafe(`INSERT INTO ct_thing (title, note) VALUES ('a', 'kept'), ('b', NULL)`);

  const next = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_n', 'note', 'text', { nullable: false }),
  ])];
  // acked -> not blocked by lint, but SET NOT NULL fails (23502) on the NULL row -> whole tx rolls back.
  await assert.rejects(migrate(sql, next, { allowDestructive: true }));

  // Rollback proof: the column is STILL nullable and BOTH rows (incl the NULL) are intact.
  assert.equal(await colNullable('ct_thing', 'note'), true, 'no partial SET NOT NULL');
  const rows = await sql<{ note: string | null }[]>`SELECT note FROM ct_thing ORDER BY id`;
  assert.deepEqual(rows.map((x) => x.note), ['kept', null]);
});

test('FLIP nullable -> NOT NULL when EVERY row is non-NULL + ack -> succeeds, data intact, column NOT NULL', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_n', 'note', 'text', { nullable: true }),
  ])]);
  await sql.unsafe(`INSERT INTO ct_thing (title, note) VALUES ('a', 'x'), ('b', 'y')`);

  const next = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_n', 'note', 'text', { nullable: false }),
  ])];
  await assert.rejects(migrate(sql, next), MigrationBlockedError); // still gated (data-dependent)
  const r = await migrate(sql, next, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['setFieldNullable']);

  assert.equal(await colNullable('ct_thing', 'note'), false, 'note is now NOT NULL');
  const rows = await sql<{ note: string }[]>`SELECT note FROM ct_thing ORDER BY id`;
  assert.deepEqual(rows.map((x) => x.note), ['x', 'y']); // data survived the constraint tightening
  // The constraint is real: a NULL insert is now refused.
  await assert.rejects(sql.unsafe(`INSERT INTO ct_thing (title, note) VALUES ('c', NULL)`));
});

test('FLIP NOT NULL -> nullable is SAFE (no ack): DROP NOT NULL, data intact, NULL insert now allowed', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_n', 'note', 'text', { nullable: false }),
  ])]);
  await sql.unsafe(`INSERT INTO ct_thing (title, note) VALUES ('a', 'present')`);
  assert.equal(await colNullable('ct_thing', 'note'), false, 'precondition: note starts NOT NULL');

  const next = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_n', 'note', 'text', { nullable: true }), // loosen to nullable
  ])];
  const r = await migrate(sql, next); // NO allowDestructive — loosening is safe
  assert.deepEqual(r.applied.map((c) => c.kind), ['setFieldNullable']);

  assert.equal(await colNullable('ct_thing', 'note'), true, 'note is now nullable');
  const [row] = await sql<{ note: string }[]>`SELECT note FROM ct_thing`;
  assert.equal(row?.note, 'present'); // existing data untouched
  // The constraint is gone: a NULL insert now succeeds.
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('b')`);
  const after = await sql<{ note: string | null }[]>`SELECT note FROM ct_thing ORDER BY id`;
  assert.deepEqual(after.map((x) => x.note), ['present', null]);
});

test('default is NOT a runtime constraint: adding NOT NULL+default does not force later inserts to the default', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('old')`);

  const next = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_rk', 'rank', 'integer', { nullable: false, default: 100 }),
  ])];
  await migrate(sql, next);
  // existing row backfilled to 100...
  const [old] = await sql<{ rank: number }[]>`SELECT rank FROM ct_thing ORDER BY id`;
  assert.equal(old?.rank, 100);
  // ...but a NEW insert may still supply its own value (the DEFAULT only fills an omitted column).
  await sql.unsafe(`INSERT INTO ct_thing (title, rank) VALUES ('new', 42)`);
  const rows = await sql<{ rank: number }[]>`SELECT rank FROM ct_thing ORDER BY id`;
  assert.deepEqual(rows.map((x) => x.rank), [100, 42]);
});
