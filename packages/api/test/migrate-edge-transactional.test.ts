import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { migrate, MigrationBlockedError } from '../src/db/schema/migrate.ts';
import type { Schema, FieldSchema, FieldType } from '../src/db/schema/model.ts';
import type { FieldOptions } from '../src/db/type.catalog.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, physicalColumns, tableExists } from './helpers.ts';

/**
 * S4 migrate engine — the TRANSACTIONAL / ATOMICITY edge dimension, against REAL Postgres (no mocks).
 * Goes deeper than schema-migrate.test.ts (basic happy path): every test INSERTS REAL ROWS, performs (or
 * attempts) the migration, then SELECTs + ASSERTS the actual data survived (or that NOTHING changed).
 *
 * Two failure shapes are proven all-or-nothing:
 *   1. GATING (lint-time): a change-set that contains a BLOCKED op throws MigrationBlockedError BEFORE any
 *      DDL runs — so a SAFE add bundled with a FORBIDDEN/DESTRUCTIVE drop applies NOTHING (the add too).
 *   2. ROLLBACK (apply-time): an acked op whose DDL FAILS on real rows (an uncastable retype `USING
 *      col::int`, a NOT NULL add over existing NULLs) rolls the WHOLE `sql.begin` tx back — the bundled
 *      safe op is gone, `_schema_applied` is byte-unchanged, the data is intact, and a CORRECTED migrate
 *      still succeeds (proving no poisoned bookkeeping / no partial application).
 */

const f = (id: string, name: string, type: FieldType, options?: FieldOptions): FieldSchema =>
  options ? { id, name, type, options } : { id, name, type };
const ct = (id: string, apiId: string, fields: FieldSchema[]): Schema => ({ id, apiId, fields });

/** The stored applied-snapshot for a type id, as canonical-ish JSON text (to prove it is byte-unchanged). */
async function appliedSnapshot(sql: Sql, typeId: string): Promise<string | null> {
  const rows = await sql<{ schema: unknown }[]>`SELECT schema FROM _schema_applied WHERE type_id = ${typeId}`;
  return rows.length === 0 ? null : JSON.stringify(rows[0]!.schema);
}

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;

before(async () => {
  db = await createFileDatabase('edgetransactional');
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

test('GATING: a safe ADD bundled with a destructive DROP applies NOTHING (the add is not applied either)', async () => {
  // Seed: two columns, one real row.
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true }), f('f_n', 'note', 'text', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title, note) VALUES ('keep-title', 'keep-note')`);
  const before = await appliedSnapshot(sql, 'ct_a');

  // Same call: ADD a new safe column `extra` AND DROP `note` (destructive). No allowDestructive.
  const mixed = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_x', 'extra', 'string', { nullable: true }), // safe add
    // f_n dropped -> destructive
  ])];
  await assert.rejects(migrate(sql, mixed), MigrationBlockedError);

  // NOTHING changed: the safe add did NOT land, the dropped column is still there, the row is intact.
  const cols = (await physicalColumns(sql, 'ct_thing')).map((c) => c.name);
  assert.ok(!cols.includes('extra'), 'the SAFE add must NOT have been applied when the call was blocked');
  assert.ok(cols.includes('note'), 'the destructive drop must NOT have been applied');
  const [row] = await sql<{ title: string; note: string }[]>`SELECT title, note FROM ct_thing`;
  assert.equal(row?.title, 'keep-title');
  assert.equal(row?.note, 'keep-note');
  assert.equal(await appliedSnapshot(sql, 'ct_a'), before, '_schema_applied snapshot must be byte-unchanged');
});

test('GATING: a FORBIDDEN retype bundled with a safe RENAME applies nothing, even WITH allowDestructive', async () => {
  // jsonb <-> integer is an impossible cast (classifyTypeChange -> forbidden). forbidden is NEVER allowed.
  await migrate(sql, [ct('ct_a', 'thing', [f('f_d', 'data', 'json', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (data) VALUES ('{"v":1}'::jsonb)`);
  const before = await appliedSnapshot(sql, 'ct_a');

  // Rename f_d data->payload (safe) AND retype json->integer (forbidden) in one call, fully acked.
  const next = [ct('ct_a', 'thing', [f('f_d', 'payload', 'integer', { nullable: true })])];
  await assert.rejects(migrate(sql, next, { allowDestructive: true }), MigrationBlockedError);

  const cols = (await physicalColumns(sql, 'ct_thing')).map((c) => c.name);
  assert.ok(cols.includes('data') && !cols.includes('payload'), 'forbidden block must prevent the safe rename too');
  const [row] = await sql<{ data: unknown }[]>`SELECT data FROM ct_thing`;
  assert.deepEqual(row?.data, { v: 1 });
  assert.equal(await appliedSnapshot(sql, 'ct_a'), before, '_schema_applied snapshot must be byte-unchanged');
});

test('ROLLBACK: an acked UNCASTABLE retype fails at apply -> whole tx rolls back; a corrected migrate then works', async () => {
  // `code` holds non-numeric strings. string->integer is classified `rewrite` (data-dependent) — ackable —
  // but the `USING code::integer` cast FAILS on real data ('ABC'), so the DDL errors mid-tx.
  await migrate(sql, [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_c', 'code', 'string', { nullable: true }),
  ])]);
  await sql.unsafe(`INSERT INTO ct_thing (title, code) VALUES ('row1', 'ABC'), ('row2', '42')`);
  const before = await appliedSnapshot(sql, 'ct_a');

  // Same call: a SAFE add (`tag`) bundled with the doomed retype. The cast throws -> EVERYTHING rolls back.
  const doomed = [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_c', 'code', 'integer', { nullable: true }), // uncastable on 'ABC'
    f('f_g', 'tag', 'string', { nullable: true }), // safe add in the SAME tx
  ])];
  await assert.rejects(migrate(sql, doomed, { allowDestructive: true }), (err: Error) => {
    // NOT a MigrationBlockedError (it passed the gate) — a raw Postgres cast error from the apply tx.
    assert.ok(!(err instanceof MigrationBlockedError), 'apply-time failure is a Postgres error, not a gate block');
    return true;
  });

  // No partial application: `code` is still varchar (not integer), the safe `tag` add never landed.
  const cols = await physicalColumns(sql, 'ct_thing');
  const code = cols.find((c) => c.name === 'code');
  assert.equal(code?.type, 'character varying', 'retype must have rolled back — code is still varchar');
  assert.ok(!cols.some((c) => c.name === 'tag'), 'the bundled safe add must have rolled back too');
  const rows = await sql<{ title: string; code: string }[]>`SELECT title, code FROM ct_thing ORDER BY title`;
  assert.deepEqual(rows.map((r) => [r.title, r.code]), [['row1', 'ABC'], ['row2', '42']], 'data intact');
  assert.equal(await appliedSnapshot(sql, 'ct_a'), before, '_schema_applied must NOT have advanced (no poisoned bookkeeping)');

  // The bad rows still diff as the SAME pending change-set (proof the applied snapshot was not mutated):
  // fix the data, retype the SAME field again, and it now succeeds carrying real data across the cast.
  await sql.unsafe(`UPDATE ct_thing SET code = '7' WHERE code = 'ABC'`);
  const corrected = await migrate(sql, [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_c', 'code', 'integer', { nullable: true }),
  ])], { allowDestructive: true });
  assert.deepEqual(corrected.applied.map((c) => c.kind), ['retypeField']);
  const fixed = await sql<{ title: string; code: number }[]>`SELECT title, code FROM ct_thing ORDER BY title`;
  assert.deepEqual(fixed.map((r) => [r.title, Number(r.code)]), [['row1', 7], ['row2', 42]]);
  assert.equal((await physicalColumns(sql, 'ct_thing')).find((c) => c.name === 'code')?.type, 'integer');
});

test('ROLLBACK: an acked NOT NULL add over EXISTING NULLs fails at apply -> whole tx rolls back, data intact', async () => {
  // Setting an EXISTING nullable column to NOT NULL while a row holds NULL is data-dependent: the
  // ALTER ... SET NOT NULL fails (23502). Bundle it with a safe rename to prove the rename rolls back too.
  await migrate(sql, [ct('ct_a', 'thing', [
    f('f_t', 'title', 'string', { nullable: true }),
    f('f_s', 'subtitle', 'string', { nullable: true }),
  ])]);
  await sql.unsafe(`INSERT INTO ct_thing (title, subtitle) VALUES ('has', 'sub'), ('null-sub', NULL)`);
  const before = await appliedSnapshot(sql, 'ct_a');

  const doomed = [ct('ct_a', 'thing', [
    f('f_t', 'headline', 'string', { nullable: true }), // safe RENAME bundled in
    f('f_s', 'subtitle', 'string', { nullable: false }), // NOT NULL over a NULL row -> fails at apply
  ])];
  await assert.rejects(migrate(sql, doomed, { allowDestructive: true }), (err: Error) => {
    assert.ok(!(err instanceof MigrationBlockedError), 'this is an apply-time 23502, not a gate block');
    return true;
  });

  const cols = await physicalColumns(sql, 'ct_thing');
  assert.ok(cols.some((c) => c.name === 'title') && !cols.some((c) => c.name === 'headline'), 'rename rolled back');
  assert.equal(cols.find((c) => c.name === 'subtitle')?.nullable, true, 'subtitle is still NULLable (SET NOT NULL rolled back)');
  const rows = await sql<{ title: string; subtitle: string | null }[]>`SELECT title, subtitle FROM ct_thing ORDER BY title`;
  assert.deepEqual(rows.map((r) => [r.title, r.subtitle]), [['has', 'sub'], ['null-sub', null]], 'rows + the NULL intact');
  assert.equal(await appliedSnapshot(sql, 'ct_a'), before, '_schema_applied unchanged after the rolled-back apply');
});

test('ROLLBACK across TWO types in one change-set: a failure on type B rolls back the safe work on type A', async () => {
  // Two types. The call ADDs a safe column to A AND retypes a doomed column on B. The whole multi-type
  // change-set runs in ONE tx, so B's apply-failure must un-apply A's already-issued ADD COLUMN.
  await migrate(sql, [
    ct('ct_a', 'alpha', [f('a_t', 'title', 'string', { nullable: true })]),
    ct('ct_b', 'beta', [f('b_c', 'code', 'string', { nullable: true })]),
  ]);
  await sql.unsafe(`INSERT INTO ct_alpha (title) VALUES ('a1')`);
  await sql.unsafe(`INSERT INTO ct_beta (code) VALUES ('not-a-number')`);
  const beforeA = await appliedSnapshot(sql, 'ct_a');
  const beforeB = await appliedSnapshot(sql, 'ct_b');

  const doomed = [
    ct('ct_a', 'alpha', [f('a_t', 'title', 'string', { nullable: true }), f('a_x', 'extra', 'integer', { nullable: true })]), // safe add on A
    ct('ct_b', 'beta', [f('b_c', 'code', 'integer', { nullable: true })]), // uncastable retype on B
  ];
  await assert.rejects(migrate(sql, doomed, { allowDestructive: true }), (err: Error) => {
    assert.ok(!(err instanceof MigrationBlockedError));
    return true;
  });

  assert.ok(!(await physicalColumns(sql, 'ct_alpha')).some((c) => c.name === 'extra'), "A's safe add rolled back when B failed");
  assert.equal((await physicalColumns(sql, 'ct_beta')).find((c) => c.name === 'code')?.type, 'character varying', "B's retype rolled back");
  assert.equal((await sql`SELECT 1 FROM ct_alpha WHERE title = 'a1'`).length, 1);
  assert.equal((await sql`SELECT 1 FROM ct_beta WHERE code = 'not-a-number'`).length, 1);
  assert.equal(await appliedSnapshot(sql, 'ct_a'), beforeA, "A's snapshot unchanged");
  assert.equal(await appliedSnapshot(sql, 'ct_b'), beforeB, "B's snapshot unchanged");
});

test('GATING: a DROP TYPE bundled with a brand-new ADD TYPE blocks; the new table is NOT created', async () => {
  // Drop an existing type (destructive) while creating a fresh one — no allowDestructive. The whole call
  // must be refused; the new table must not exist (the add must not slip through ahead of the block).
  await migrate(sql, [ct('ct_a', 'old', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_old (title) VALUES ('survivor')`);
  const before = await appliedSnapshot(sql, 'ct_a');

  // next: drop ct_a (absent), add ct_b ('fresh').
  const next = [ct('ct_b', 'fresh', [f('f_n', 'name', 'string', { nullable: true })])];
  await assert.rejects(migrate(sql, next), MigrationBlockedError);

  assert.equal(await tableExists(sql, 'ct_old'), true, 'the dropped type still exists');
  assert.equal(await tableExists(sql, 'ct_fresh'), false, 'the new type was NOT created by a blocked call');
  assert.equal((await sql`SELECT 1 FROM ct_old WHERE title = 'survivor'`).length, 1);
  assert.equal(await appliedSnapshot(sql, 'ct_a'), before);
  assert.equal(await appliedSnapshot(sql, 'ct_b'), null, 'no snapshot row for the un-created type');
});

test('ROLLBACK is RECOVERABLE: after a failed apply, an unrelated safe migrate still succeeds (advisory lock released)', async () => {
  // A failed migrate must RELEASE pg_advisory_xact_lock + leave no open tx, so the very next migrate works.
  await migrate(sql, [ct('ct_a', 'thing', [f('f_c', 'code', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (code) VALUES ('xyz')`);

  await assert.rejects(
    migrate(sql, [ct('ct_a', 'thing', [f('f_c', 'code', 'integer', { nullable: true })])], { allowDestructive: true }),
    (err: Error) => !(err instanceof MigrationBlockedError),
  );

  // A completely independent, safe migrate right after the rollback must proceed (lock not stuck).
  const r = await migrate(sql, [ct('ct_a', 'thing', [
    f('f_c', 'code', 'string', { nullable: true }),
    f('f_n', 'note', 'text', { nullable: true }), // safe add
  ])]);
  assert.deepEqual(r.applied.map((c) => c.kind), ['addField']);
  assert.ok((await physicalColumns(sql, 'ct_thing')).some((c) => c.name === 'note'));
  assert.equal((await sql<{ code: string }[]>`SELECT code FROM ct_thing`)[0]?.code, 'xyz', 'original data intact');
});
