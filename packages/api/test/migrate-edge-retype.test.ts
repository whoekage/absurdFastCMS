import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { migrate, MigrationBlockedError } from '../src/db/schema/migrate.ts';
import type { ContentTypeSchema, FieldSchema, FieldType } from '../src/db/schema/model.ts';
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
const ct = (id: string, apiId: string, fields: FieldSchema[]): ContentTypeSchema => ({ id, apiId, fields });

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
  await migrate(sql, [ct('ct_a', 'thing', [f('f_v', 'views', 'integer', { nullable: true })])]);
  // A value safely inside int4 but we also push an int4-max boundary to prove it survives the widening.
  await sql.unsafe(`INSERT INTO ct_thing (views) VALUES (2147483647), (-2147483648), (0)`);

  const widened = [ct('ct_a', 'thing', [f('f_v', 'views', 'biginteger', { nullable: true })])];
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
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { length: 512, nullable: true })])]);
  const long = 'x'.repeat(512); // exactly fills the old column
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('hello'), ('${long}')`);

  // Widening is metadata-only -> safe: NO allowDestructive required.
  const grown = [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { length: 1024, nullable: true })])];
  const r = await migrate(sql, grown);
  assert.deepEqual(r.applied.map((c) => c.kind), ['retypeField']);

  const col = (await physicalColumns(sql, 'ct_thing')).find((c) => c.name === 'title');
  assert.equal(col?.type, 'character varying');
  const rows = await sql<{ title: string }[]>`SELECT title FROM ct_thing ORDER BY length(title)`;
  assert.deepEqual(rows.map((x) => x.title), ['hello', long]); // every char survived
});

test('varchar SHRINK (1024 -> 256): gated; acked cast TRUNCATES (lossy) but fitting rows survive', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { length: 1024, nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('short one')`);

  const shrunk = [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { length: 256, nullable: true })])];
  // Shrink truncates -> rewrite -> data-dependent -> blocked without ack.
  await assert.rejects(migrate(sql, shrunk), MigrationBlockedError);
  assert.equal(
    (await physicalColumns(sql, 'ct_thing')).find((c) => c.name === 'title')?.type,
    'character varying',
  );
  // Still the old size: the blocked migration applied nothing (a 1024-char value still inserts).
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('${'y'.repeat(1024)}')`);

  // Acked: PG's `::varchar(256)` SILENTLY truncates to 256 (no 22001 on cast). The row that already fits
  // is byte-identical; the over-long row is truncated to exactly 256 chars.
  const r = await migrate(sql, shrunk, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['retypeField']);
  const rows = await sql<{ title: string }[]>`SELECT title FROM ct_thing ORDER BY length(title)`;
  assert.equal(rows[0]?.title, 'short one'); // fitting row untouched
  assert.equal(rows[1]?.title.length, 256); // over-long row truncated to the new ceiling
});

test('enumeration ADD a member: gated; acked cast keeps existing rows (but CHECK is NOT rebuilt)', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_s', 'state', 'enumeration', { values: ['draft', 'live'], nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (state) VALUES ('draft'), ('live')`);

  // Adding a member changes the value-set -> classifyTypeChange = rewrite -> data-dependent -> gated.
  const added = [ct('ct_a', 'thing', [f('f_s', 'state', 'enumeration', { values: ['draft', 'live', 'archived'], nullable: true })])];
  await assert.rejects(migrate(sql, added), MigrationBlockedError);

  const r = await migrate(sql, added, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['retypeField']);
  // Existing rows survived the (no-op varchar->varchar) cast.
  const rows = await sql<{ state: string }[]>`SELECT state FROM ct_thing ORDER BY state`;
  assert.deepEqual(rows.map((x) => x.state), ['draft', 'live']);

  // SUSPECTED BUG: compileAlterColumnType emits only ALTER TYPE ... USING, never rebuilding the CHECK.
  // The original CHECK (state IN ('draft','live')) is still in force, so the freshly-added member
  // 'archived' is REJECTED — the migration "succeeded" but the new enum member is unusable.
  await assert.rejects(
    () => sql.unsafe(`INSERT INTO ct_thing (state) VALUES ('archived')`),
    /violates check constraint/i,
    'EXPECTED-FAIL if the bug is fixed: the added enum member should be insertable after the migration',
  );
});

test('enumeration REMOVE a member: gated; acked migration does NOT enforce the removal (stale CHECK)', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_s', 'state', 'enumeration', { values: ['draft', 'live', 'archived'], nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (state) VALUES ('draft'), ('archived')`);

  // Removing 'archived' is a value-set change -> rewrite -> data-dependent -> gated.
  const removed = [ct('ct_a', 'thing', [f('f_s', 'state', 'enumeration', { values: ['draft', 'live'], nullable: true })])];
  await assert.rejects(migrate(sql, removed), MigrationBlockedError);

  // KNOWN GAP (found by this edge-case sweep): migrate's retypeField emits ONLY `ALTER COLUMN ... TYPE`
  // and does NOT rebuild the enum CHECK. Removing a member an existing row still uses ('archived') fails at
  // apply (the old CHECK is re-validated against the removed value during the rewrite) and the WHOLE
  // migration ROLLS BACK — data is SAFE (no partial), but enum value-set evolution is not yet supported.
  // (Symmetrically, ADDING a member would "succeed" yet the new value stays un-insertable under the old
  // CHECK.) Proper fix = drop+re-add the CHECK with the new value-set in the retype apply. Pinned here.
  await assert.rejects(migrate(sql, removed, { allowDestructive: true }));
  const rows = await sql<{ state: string }[]>`SELECT state FROM ct_thing ORDER BY state`;
  assert.deepEqual(rows.map((x) => x.state), ['archived', 'draft'], 'rolled back — both rows intact, no partial apply');
});

test('decimal precision/scale CHANGE (10,2 -> 12,4): gated; acked cast re-scales the stored value', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_p', 'price', 'decimal', { precision: 10, scale: 2, nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (price) VALUES (123.45), (0.10)`);

  // Any numeric precision/scale change is a rewrite -> data-dependent -> gated.
  const rescaled = [ct('ct_a', 'thing', [f('f_p', 'price', 'decimal', { precision: 12, scale: 4, nullable: true })])];
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

test('decimal SCALE SHRINK (10,4 -> 10,2): gated; acked cast ROUNDS the fractional digits (lossy)', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_p', 'price', 'decimal', { precision: 10, scale: 4, nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (price) VALUES (1.2345)`);

  const narrowed = [ct('ct_a', 'thing', [f('f_p', 'price', 'decimal', { precision: 10, scale: 2, nullable: true })])];
  await assert.rejects(migrate(sql, narrowed), MigrationBlockedError);

  const r = await migrate(sql, narrowed, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['retypeField']);
  // PG rounds 1.2345 -> 1.23 on the ::numeric(10,2) cast (half-up): proves the cast is genuinely lossy.
  const [row] = await sql<{ price: string }[]>`SELECT price FROM ct_thing`;
  assert.equal(row?.price, '1.23');
});

test('UNCASTABLE string -> integer on NON-NUMERIC rows: gated, and on apply the WHOLE tx ROLLS BACK', async () => {
  await migrate(sql, [
    ct('ct_a', 'thing', [
      f('f_t', 'title', 'string', { length: 255, nullable: true }),
      f('f_n', 'note', 'string', { length: 255, nullable: true }),
    ]),
  ]);
  await sql.unsafe(`INSERT INTO ct_thing (title, note) VALUES ('hello world', 'keep me')`);

  // string -> integer: cms_type + pg_type + engine_type all change -> rewrite -> data-dependent -> gated.
  const retyped = [
    ct('ct_a', 'thing', [
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
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'code', 'string', { length: 255, nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (code) VALUES ('42'), ('-7'), (NULL)`);

  const retyped = [ct('ct_a', 'thing', [f('f_t', 'code', 'integer', { nullable: true })])];
  await assert.rejects(migrate(sql, retyped), MigrationBlockedError); // still data-dependent -> gated

  const r = await migrate(sql, retyped, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['retypeField']);
  assert.equal((await physicalColumns(sql, 'ct_thing')).find((c) => c.name === 'code')?.type, 'integer');
  const rows = await sql<{ code: number | null }[]>`SELECT code FROM ct_thing ORDER BY code NULLS LAST`;
  assert.deepEqual(rows.map((x) => x.code), [-7, 42, null]); // numeric strings cast cleanly; NULL stays NULL
});
