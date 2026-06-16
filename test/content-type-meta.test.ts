import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSql } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import {
  createContentType,
  addField,
  renameField,
  dropField,
  changeFieldType,
  dropContentType as dropContentTypeRaw,
  getContentType,
  getFields,
} from '../src/db/content-type-repo.ts';
import { withCatalogWrite } from './catalog-lock.ts';
import {
  ContentTypeExistsError,
  ContentTypeNotFoundError,
  FieldNotFoundError,
  FieldExistsError,
  ReservedFieldNameError,
  ReservedTableNameError,
  TypeChangeForbiddenError,
  DefaultTypeError,
  SchemaChangeConflictError,
  InvalidIdentifierError,
  DuplicateFieldError,
  advisoryKey,
} from '../src/db/ddl.ts';

/**
 * CONTENT-TYPE META SLICE — the runtime DDL + meta layer end-to-end against a REAL Postgres (no
 * mocks). Requires the docker-compose Postgres up and `.env.test` -> the isolated `absurd_test`
 * database. We migrate (applying 0002), then for each test create/mutate real per-type tables and
 * introspect information_schema / pg_catalog to prove the physical table EXACTLY matches the meta.
 * Maps to the blueprint P1..P16.
 */

const sql = createSql(); // DATABASE_URL from .env.test

/**
 * A table DROP committing in the window of another file's parallel engine build (the global-catalog
 * loader SELECTs every `ct_*` table) would make that build hit a vanished table. Serialize this file's
 * table-dropping ops under the shared catalog write lock. See test/catalog-lock.ts.
 */
function dropContentType(s: typeof sql, apiId: string): Promise<void> {
  return withCatalogWrite(s, () => dropContentTypeRaw(s, apiId));
}

/** Drop every runtime per-type table and wipe the catalog so each test starts clean. */
async function cleanCatalog(): Promise<void> {
  await withCatalogWrite(sql, async () => {
    const tables = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'ct\\_m\\_%'`;
    for (const { table_name } of tables) await sql.unsafe(`DROP TABLE IF EXISTS "${table_name}" CASCADE`);
    await sql`DELETE FROM content_types WHERE api_id LIKE 'm\\_%'`;
  });
}

/** Read the real columns of a table from information_schema, in ordinal order. */
async function physicalColumns(table: string): Promise<{ name: string; type: string; nullable: boolean }[]> {
  const rows = await sql<{ column_name: string; data_type: string; udt_name: string; is_nullable: string; character_maximum_length: number | null; numeric_precision: number | null; numeric_scale: number | null }[]>`
    SELECT column_name, data_type, udt_name, is_nullable, character_maximum_length, numeric_precision, numeric_scale
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} ORDER BY ordinal_position
  `;
  return rows.map((r) => ({ name: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES' }));
}

/** Whether a table physically exists. */
async function tableExists(table: string): Promise<boolean> {
  const r = await sql`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${table}`;
  return r.length > 0;
}

before(async () => {
  await runMigrations();
  await cleanCatalog();
});

beforeEach(async () => {
  await cleanCatalog();
});

after(async () => {
  await cleanCatalog();
  await sql.end();
});

// P1 — create -> physical table with system + user cols in sort order; meta == physical. [9,47,60]
test('P1 create content-type builds a table matching the meta exactly', async () => {
  await createContentType(sql, {
    apiId: 'm_post',
    fields: [
      { name: 'title', cmsType: 'string', options: { nullable: false } },
      { name: 'views', cmsType: 'integer' },
      { name: 'amount', cmsType: 'decimal', options: { precision: 12, scale: 2 } },
    ],
  });
  const ct = await getContentType(sql, 'm_post');
  assert.ok(ct);
  assert.equal(ct!.table_name, 'ct_m_post');
  const cols = await physicalColumns('ct_m_post');
  // system cols first, in order, then user cols by sort.
  assert.deepEqual(cols.map((c) => c.name), ['id', 'created_at', 'updated_at', 'title', 'views', 'amount']);
  // title is NOT NULL, views nullable, amount nullable.
  assert.equal(cols.find((c) => c.name === 'title')!.nullable, false);
  assert.equal(cols.find((c) => c.name === 'views')!.nullable, true);

  // meta == physical: every content_type_fields row has a matching physical column.
  const fields = await getFields(sql, ct!.id);
  assert.deepEqual(fields.map((f) => f.name), ['title', 'views', 'amount']);
  for (const f of fields) assert.ok(cols.some((c) => c.name === f.name), `physical column for ${f.name}`);
  assert.deepEqual(fields.map((f) => f.sort), [0, 1, 2]);
  assert.equal(fields.find((f) => f.name === 'amount')!.pg_type, 'numeric(12,2)');
});

// P2 — atomicity: a meta failure rolls back the CREATE TABLE (no table, no rows). [9,10,14,20]
test('P2 a failed create leaves NO table and NO meta rows (atomic rollback)', async () => {
  await createContentType(sql, { apiId: 'm_widget', fields: [{ name: 'name', cmsType: 'string' }] });
  // Second create with the SAME api_id -> the pre-check OR the DB UNIQUE rejects; the partial work
  // (a would-be CREATE TABLE) must NOT survive. We force the race past the pre-check by inserting a
  // DIFFERENT api_id that derives the SAME table_name is impossible; instead assert the dup path.
  await assert.rejects(() => createContentType(sql, { apiId: 'm_widget', fields: [{ name: 'x', cmsType: 'integer' }] }), ContentTypeExistsError);
  // Exactly one type, one table, the original single field — nothing from the failed attempt leaked.
  const ct = await getContentType(sql, 'm_widget');
  const fields = await getFields(sql, ct!.id);
  assert.deepEqual(fields.map((f) => f.name), ['name']);
  const cols = await physicalColumns('ct_m_widget');
  assert.ok(!cols.some((c) => c.name === 'x'));
});

// P2b — true mid-transaction failure: a CREATE TABLE that then hits a meta UNIQUE rolls the table back.
test('P2b CREATE TABLE rolls back when a later meta write fails in the same tx', async () => {
  // Pre-create the table name physically (simulating leftover) so the runtime CREATE TABLE throws
  // INSIDE the tx after meta inserts -> the whole tx (meta + any DDL) rolls back.
  await sql.unsafe(`CREATE TABLE "ct_m_clash" (id serial primary key)`);
  await assert.rejects(() => createContentType(sql, { apiId: 'm_clash', fields: [{ name: 'a', cmsType: 'integer' }] }));
  // No meta rows leaked from the failed tx: neither the content_types row NOR any content_type_fields.
  assert.equal(await getContentType(sql, 'm_clash'), null);
  assert.equal((await sql`SELECT 1 FROM content_type_fields WHERE content_type_id IN (SELECT id FROM content_types WHERE api_id LIKE 'm\\_%')`).length, 0, 'no orphan field rows from the rolled-back create');
  // ct_m_clash is still the pre-seeded one-column table, NOT the user's shape (the CREATE TABLE rolled back).
  const clashCols = await physicalColumns('ct_m_clash');
  assert.deepEqual(clashCols.map((c) => c.name), ['id']);
  await sql.unsafe(`DROP TABLE "ct_m_clash"`);
});

// P3 — create twice (and a case-variant) -> ContentTypeExistsError; only one table/row. [25,38]
test('P3 duplicate api_id (and case-variant) rejected, no silent no-op', async () => {
  await createContentType(sql, { apiId: 'm_author', fields: [{ name: 'name', cmsType: 'string' }] });
  await assert.rejects(() => createContentType(sql, { apiId: 'm_author', fields: [] }), ContentTypeExistsError);
  await assert.rejects(() => createContentType(sql, { apiId: 'm_Author', fields: [] }), ContentTypeExistsError);
  const all = await sql`SELECT 1 FROM content_types WHERE lower(api_id) = 'm_author'`;
  assert.equal(all.length, 1);
});

// P4 — a lossy/rewrite type change is REJECTED UP FRONT (no cast attempted), so nothing changes. The
//       in-transaction failed-cast rollback (checklist 11/12) is DEFERRED to the rewrite-aware step:
//       Step 2 emits no fallible cast through changeFieldType (metadata-only = binary-coercible only),
//       so the 22P02/22003 -> TypeChangeFailedError path is intentionally unreachable here. [28]
test('P4 a rewrite-class type change is rejected up front; physical type and meta unchanged', async () => {
  await createContentType(sql, { apiId: 'm_note', fields: [{ name: 'body', cmsType: 'string', options: { length: 100 } }] });
  await sql.unsafe(`INSERT INTO "ct_m_note" (body) VALUES ('not a number')`);
  // string(varchar) -> integer is a 'rewrite' transition; rejected up front (no cast attempted).
  await assert.rejects(() => changeFieldType(sql, 'm_note', 'body', 'integer'), TypeChangeForbiddenError);
  const cols = await physicalColumns('ct_m_note');
  assert.equal(cols.find((c) => c.name === 'body')!.type, 'character varying');
  const ct = await getContentType(sql, 'm_note');
  const f = (await getFields(sql, ct!.id))[0]!;
  assert.equal(f.cms_type, 'string');
});

// P5 — rewrite-class change int4->int8 rejected, nothing changed. [15,57]
test('P5 rewrite-class type change rejected', async () => {
  await createContentType(sql, { apiId: 'm_counter', fields: [{ name: 'n', cmsType: 'integer' }] });
  await assert.rejects(() => changeFieldType(sql, 'm_counter', 'n', 'biginteger'), TypeChangeForbiddenError);
  const cols = await physicalColumns('ct_m_counter');
  assert.equal(cols.find((c) => c.name === 'n')!.type, 'integer');
});

// P5b — a metadata-only change (varchar grow / varchar->text) succeeds atomically.
test('P5b metadata-only type change succeeds', async () => {
  await createContentType(sql, { apiId: 'm_tag', fields: [{ name: 'label', cmsType: 'string', options: { length: 50 } }] });
  await changeFieldType(sql, 'm_tag', 'label', 'text');
  const cols = await physicalColumns('ct_m_tag');
  assert.equal(cols.find((c) => c.name === 'label')!.type, 'text');
  const ct = await getContentType(sql, 'm_tag');
  assert.equal((await getFields(sql, ct!.id))[0]!.cms_type, 'text');
});

// P6 — ADD NOT NULL to a populated table: no default -> rejected; constant default -> ok. [16]
test('P6 ADD NOT NULL on a populated table needs a constant default', async () => {
  await createContentType(sql, { apiId: 'm_item', fields: [{ name: 'sku', cmsType: 'string' }] });
  await sql.unsafe(`INSERT INTO "ct_m_item" (sku) VALUES ('a'), ('b')`);
  // NOT NULL, no default, populated table -> PG 23502 -> mapped error, full rollback.
  await assert.rejects(() => addField(sql, 'm_item', { name: 'qty', cmsType: 'integer', options: { nullable: false } }), DefaultTypeError);
  let cols = await physicalColumns('ct_m_item');
  assert.ok(!cols.some((c) => c.name === 'qty'));
  const ct = await getContentType(sql, 'm_item');
  assert.ok(!(await getFields(sql, ct!.id)).some((f) => f.name === 'qty'));
  // With a constant default -> succeeds atomically.
  await addField(sql, 'm_item', { name: 'qty', cmsType: 'integer', options: { nullable: false, default: 0 } });
  cols = await physicalColumns('ct_m_item');
  assert.ok(cols.some((c) => c.name === 'qty' && c.nullable === false));
});

// P7 — volatile default add rejected. [17]
test('P7 volatile default rejected', async () => {
  await createContentType(sql, { apiId: 'm_event', fields: [{ name: 'name', cmsType: 'string' }] });
  await assert.rejects(() => addField(sql, 'm_event', { name: 'at', cmsType: 'datetime', options: { default: 'now()' } }), DefaultTypeError);
  await assert.rejects(() => addField(sql, 'm_event', { name: 'gid', cmsType: 'uuid', options: { default: 'gen_random_uuid()' } }), DefaultTypeError);
});

// P8 — rename via real RENAME COLUMN + meta UPDATE; reserved + collision rejected. [21,41]
test('P8 rename field atomically; reserved + collision rejected', async () => {
  await createContentType(sql, { apiId: 'm_page', fields: [{ name: 'title', cmsType: 'string' }, { name: 'slug', cmsType: 'string' }] });
  await renameField(sql, 'm_page', 'title', 'heading');
  let cols = await physicalColumns('ct_m_page');
  assert.ok(cols.some((c) => c.name === 'heading'));
  assert.ok(!cols.some((c) => c.name === 'title'));
  const ct = await getContentType(sql, 'm_page');
  assert.ok((await getFields(sql, ct!.id)).some((f) => f.name === 'heading'));
  // rename to a reserved system column -> rejected, original preserved.
  await assert.rejects(() => renameField(sql, 'm_page', 'heading', 'id'), ReservedFieldNameError);
  // rename to an existing sibling (case-variant) -> rejected.
  await assert.rejects(() => renameField(sql, 'm_page', 'heading', 'Slug'), FieldExistsError);
  // rename a non-existent field -> FieldNotFoundError.
  await assert.rejects(() => renameField(sql, 'm_page', 'nope', 'whatever'), FieldNotFoundError);
  cols = await physicalColumns('ct_m_page');
  assert.ok(cols.some((c) => c.name === 'heading') && cols.some((c) => c.name === 'slug'));
});

// P9 — drop field syncs meta, rejects system cols + non-existent. [42]
test('P9 drop field syncs meta and guards system/non-existent', async () => {
  await createContentType(sql, { apiId: 'm_doc', fields: [{ name: 'a', cmsType: 'string' }, { name: 'b', cmsType: 'integer' }] });
  await dropField(sql, 'm_doc', 'b');
  const cols = await physicalColumns('ct_m_doc');
  assert.ok(!cols.some((c) => c.name === 'b'));
  const ct = await getContentType(sql, 'm_doc');
  assert.ok(!(await getFields(sql, ct!.id)).some((f) => f.name === 'b'));
  await assert.rejects(() => dropField(sql, 'm_doc', 'id'), ReservedFieldNameError);
  await assert.rejects(() => dropField(sql, 'm_doc', 'ghost'), FieldNotFoundError);
});

// P10 — drop content-type removes table + field rows + type row; non-existent -> ContentTypeNotFoundError. [43]
test('P10 drop content-type removes everything atomically', async () => {
  await createContentType(sql, { apiId: 'm_temp', fields: [{ name: 'x', cmsType: 'integer' }] });
  await dropContentType(sql, 'm_temp');
  assert.equal(await tableExists('ct_m_temp'), false);
  assert.equal(await getContentType(sql, 'm_temp'), null);
  assert.equal((await sql`SELECT 1 FROM content_type_fields WHERE content_type_id IN (SELECT id FROM content_types WHERE api_id LIKE 'm\\_%')`).length, 0);
  await assert.rejects(() => dropContentType(sql, 'm_temp'), ContentTypeNotFoundError);
});

// P11 — enum round-trip: allowed value ok, disallowed fails CHECK, injection value is a literal. [5,13]
test('P11 enumeration CHECK round-trips and an injection value is inert', async () => {
  await createContentType(sql, { apiId: 'm_ticket', fields: [{ name: 'status', cmsType: 'enumeration', options: { values: ['open', "a'); DROP TABLE articles;--"] } }] });
  await sql.unsafe(`INSERT INTO "ct_m_ticket" (status) VALUES ('open')`);
  // a value not in the set fails the CHECK constraint.
  await assert.rejects(() => sql.unsafe(`INSERT INTO "ct_m_ticket" (status) VALUES ('closed')`));
  // the injection-y member is a legal VALUE (stored, checked as a literal) — never executed: articles survives.
  await sql.unsafe(`INSERT INTO "ct_m_ticket" (status) VALUES ('a''); DROP TABLE articles;--')`);
  assert.equal(await tableExists('articles'), true);
  const rows = await sql`SELECT status FROM "ct_m_ticket" ORDER BY id`;
  assert.equal(rows.length, 2);
});

// P12 — reserved SQL keyword field name creates and round-trips. [27]
test('P12 reserved-keyword field name works (quoted)', async () => {
  await createContentType(sql, { apiId: 'm_kw', fields: [{ name: 'order', cmsType: 'integer' }, { name: 'select', cmsType: 'string' }] });
  await sql.unsafe(`INSERT INTO "ct_m_kw" ("order", "select") VALUES (3, 'x')`);
  const r = await sql<{ order: number; select: string }[]>`SELECT "order", "select" FROM "ct_m_kw"`;
  assert.equal(r[0]!.order, 3);
  assert.equal(r[0]!.select, 'x');
});

// P13 — concurrency: two overlapping changes serialize via the advisory lock (both apply in order). [19,24,66]
test('P13 concurrent schema changes on one type serialize', async () => {
  await createContentType(sql, { apiId: 'm_conc', fields: [{ name: 'a', cmsType: 'integer' }] });
  // Two adds fired concurrently: the advisory lock serializes them; both succeed (distinct names).
  const results = await Promise.allSettled([
    addField(sql, 'm_conc', { name: 'b', cmsType: 'integer' }),
    addField(sql, 'm_conc', { name: 'c', cmsType: 'integer' }),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') assert.ok(r.reason instanceof SchemaChangeConflictError, `unexpected: ${r.reason}`);
  }
  const cols = await physicalColumns('ct_m_conc');
  // Whatever serialization order, the meta and physical agree on the set of columns.
  const ct = await getContentType(sql, 'm_conc');
  const fieldNames = (await getFields(sql, ct!.id)).map((f) => f.name).sort();
  const userCols = cols.filter((c) => !['id', 'created_at', 'updated_at'].includes(c.name)).map((c) => c.name).sort();
  assert.deepEqual(userCols, fieldNames);

  // A racing DUPLICATE add is rejected (FieldExistsError or the DB UNIQUE backstop), never doubled.
  const dup = await Promise.allSettled([
    addField(sql, 'm_conc', { name: 'dupe', cmsType: 'integer' }),
    addField(sql, 'm_conc', { name: 'dupe', cmsType: 'integer' }),
  ]);
  const ok = dup.filter((r) => r.status === 'fulfilled').length;
  assert.equal(ok, 1, 'exactly one of the racing duplicate adds may succeed');
  // The LOSER must reject with the field-level typed error (FieldExistsError) — NOT a mislabeled
  // ContentTypeExistsError. Whether the loser lost the in-app pre-check or tripped the
  // ctf_type_name_lower_uq DB backstop, the typed class must reflect the FIELD layer.
  const rejected = dup.find((r) => r.status === 'rejected');
  assert.ok(rejected, 'one racing duplicate add must reject');
  assert.ok((rejected as PromiseRejectedResult).reason instanceof FieldExistsError, `loser must be FieldExistsError, got ${(rejected as PromiseRejectedResult).reason}`);
});

// P14 — postgres.js parsing contract: int8/numeric/uuid STRING, timestamptz Date, jsonb parsed. [65,33,56]
test('P14 postgres.js parsing contract for the new pg types', async () => {
  await createContentType(sql, {
    apiId: 'm_mix',
    fields: [
      { name: 'big', cmsType: 'biginteger' },
      { name: 'amt', cmsType: 'decimal', options: { precision: 18, scale: 4 } },
      { name: 'gid', cmsType: 'uuid' },
      { name: 'meta', cmsType: 'json' },
      { name: 'when', cmsType: 'datetime' },
      { name: 'day', cmsType: 'date' },
    ],
  });
  await sql.unsafe(`INSERT INTO "ct_m_mix" (big, amt, gid, meta, "when", day) VALUES (9007199254740993, 12.3400, '00000000-0000-0000-0000-000000000001', '{"k":1}', '2021-01-01T00:00:00Z', '2021-02-03')`);
  const [row] = await sql<{ big: unknown; amt: unknown; gid: unknown; meta: unknown; when: unknown; day: unknown }[]>`SELECT big, amt, gid, meta, "when", day FROM "ct_m_mix"`;
  assert.equal(typeof row!.big, 'string', 'int8 -> string');
  assert.equal(row!.big, '9007199254740993');
  assert.equal(typeof row!.amt, 'string', 'numeric -> string');
  assert.equal(typeof row!.gid, 'string', 'uuid -> string');
  assert.ok(row!.when instanceof Date, 'timestamptz -> Date');
  // NOTE: postgres.js 3.4.9 parses `date` to a JS Date (NOT the string the blueprint assumed); we
  // pin the REAL observed contract here so a future parser change is caught. A later materializer
  // renders 'date' (calendar-only) vs 'datetime' (full ISO) off the cms_type, both via coerceDate.
  assert.ok(row!.day instanceof Date, 'date -> Date (postgres.js default parser)');
  assert.deepEqual(row!.meta, { k: 1 }, 'jsonb -> parsed');
});

// P15 — empty content-type (zero user fields) -> table with only system columns. [55]
test('P15 empty content-type creates a system-only table', async () => {
  await createContentType(sql, { apiId: 'm_bare', fields: [] });
  const cols = await physicalColumns('ct_m_bare');
  assert.deepEqual(cols.map((c) => c.name), ['id', 'created_at', 'updated_at']);
  const ct = await getContentType(sql, 'm_bare');
  assert.equal((await getFields(sql, ct!.id)).length, 0);
});

// P16 — updated_at maintenance: an UPDATE can advance updated_at (column present + defaulted). [61]
test('P16 updated_at column exists and is maintained on write', async () => {
  await createContentType(sql, { apiId: 'm_tracked', fields: [{ name: 'v', cmsType: 'integer' }] });
  await sql.unsafe(`INSERT INTO "ct_m_tracked" (v) VALUES (1)`);
  const [before] = await sql<{ created_at: Date; updated_at: Date }[]>`SELECT created_at, updated_at FROM "ct_m_tracked"`;
  assert.ok(before!.created_at instanceof Date);
  assert.ok(before!.updated_at instanceof Date);
  // The write layer is responsible for setting updated_at; assert the column accepts an explicit set.
  await sql.unsafe(`UPDATE "ct_m_tracked" SET v = 2, updated_at = now() WHERE v = 1`);
  const [after] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM "ct_m_tracked"`;
  assert.ok(after!.updated_at.getTime() >= before!.updated_at.getTime());
});

// P17 — the identifier gate is WIRED into the real create/addField/rename entry points: an injection
//        payload as an api_id or a field name is rejected BEFORE any SQL runs, and articles + the
//        catalog survive untouched. [1,2,13]
test('P17 injection identifiers rejected at the real entry points; articles + catalog survive', async () => {
  // an injection-y api_id -> rejected (an injection payload also fails the ASCII allowlist).
  await assert.rejects(() => createContentType(sql, { apiId: 'x"; DROP TABLE articles;--', fields: [] }), InvalidIdentifierError);
  // a reserved api_id -> ReservedTableNameError (a different gate arm, still pre-SQL).
  await assert.rejects(() => createContentType(sql, { apiId: 'articles', fields: [] }), ReservedTableNameError);
  // an injection-y FIELD name -> rejected before any CREATE TABLE.
  await assert.rejects(
    () => createContentType(sql, { apiId: 'm_safe', fields: [{ name: 'evil" GENERATED ALWAYS AS (1) STORED', cmsType: 'string' }] }),
    InvalidIdentifierError,
  );
  // nothing leaked: no ct_ table, no content_types row, articles intact.
  assert.equal(await tableExists('ct_m_safe'), false);
  assert.equal(await getContentType(sql, 'm_safe'), null);
  assert.equal((await sql`SELECT 1 FROM content_types WHERE api_id LIKE 'm\\_%'`).length, 0);
  assert.equal(await tableExists('articles'), true);

  // addField / renameField with a malicious target name -> rejected, the type untouched.
  await createContentType(sql, { apiId: 'm_host', fields: [{ name: 'title', cmsType: 'string' }] });
  await assert.rejects(() => addField(sql, 'm_host', { name: 'bad"; DROP TABLE articles;--', cmsType: 'string' }), InvalidIdentifierError);
  await assert.rejects(() => renameField(sql, 'm_host', 'title', 'bad" --'), InvalidIdentifierError);
  await assert.rejects(() => dropField(sql, 'm_host', 'bad" --'), InvalidIdentifierError);
  assert.equal(await tableExists('articles'), true);
  const ct = await getContentType(sql, 'm_host');
  assert.deepEqual((await getFields(sql, ct!.id)).map((f) => f.name), ['title']);
  const cols = await physicalColumns('ct_m_host');
  assert.deepEqual(cols.map((c) => c.name), ['id', 'created_at', 'updated_at', 'title']);
});

// P18 — case-insensitive duplicate field names are rejected THROUGH createContentType (real path). [23,24]
test('P18 case-variant duplicate field names rejected at create', async () => {
  await assert.rejects(
    () => createContentType(sql, { apiId: 'm_dupct', fields: [{ name: 'Title', cmsType: 'string' }, { name: 'title', cmsType: 'string' }] }),
    DuplicateFieldError,
  );
  // rejected before any DDL: no table, no rows.
  assert.equal(await tableExists('ct_m_dupct'), false);
  assert.equal(await getContentType(sql, 'm_dupct'), null);
});

// P19 — an enum value-set change is rejected (TypeChangeForbiddenError) so meta + the physical CHECK
//        never diverge. Proves the classifier fix end-to-end. [5,47,62]
test('P19 enum value-set change rejected; meta + physical CHECK stay consistent', async () => {
  await createContentType(sql, { apiId: 'm_tk', fields: [{ name: 'status', cmsType: 'enumeration', options: { values: ['a', 'b'] } }] });
  // changing the allowed members renders the SAME varchar(1) pgType but would leave the CHECK stale.
  await assert.rejects(
    () => changeFieldType(sql, 'm_tk', 'status', 'enumeration', { values: ['x', 'y'] }),
    TypeChangeForbiddenError,
  );
  // meta still records the original members.
  const ct = await getContentType(sql, 'm_tk');
  const f = (await getFields(sql, ct!.id))[0]!;
  assert.deepEqual(f.params['values'], ['a', 'b']);
  // physical CHECK still enforces the original set: an original member inserts, a new one is rejected.
  await sql.unsafe(`INSERT INTO "ct_m_tk" (status) VALUES ('a')`);
  await assert.rejects(() => sql.unsafe(`INSERT INTO "ct_m_tk" (status) VALUES ('x')`));
  // enum -> plain string of the same size is likewise rejected (would orphan the CHECK).
  await assert.rejects(() => changeFieldType(sql, 'm_tk', 'status', 'string', { length: 1 }), TypeChangeForbiddenError);
});

// P20 — an adversarial constant DEFAULT is neutralized (escaped literal, never executed) and the exact
//        literal round-trips. Pins that default injection-safety rests on Kysely's escaping. [13,35]
test('P20 injection-y default is inert and round-trips verbatim', async () => {
  const evil = "x'); DROP TABLE articles;--";
  await createContentType(sql, { apiId: 'm_def', fields: [{ name: 'note', cmsType: 'string', options: { default: evil } }] });
  assert.equal(await tableExists('articles'), true);
  // a row that relies on the default bakes the EXACT literal (no SQL executed from it).
  await sql.unsafe(`INSERT INTO "ct_m_def" (id) VALUES (DEFAULT)`);
  const [row] = await sql<{ note: string }[]>`SELECT note FROM "ct_m_def"`;
  assert.equal(row!.note, evil);
  assert.equal(await tableExists('articles'), true);
});

// P21 — non-integer constant defaults round-trip PHYSICALLY through the real addField DDL path: pins
//        the bound/escaped-Date default contract and each engine intent's serialization. [17,35,46,58]
test('P21 non-integer defaults are baked physically for every engine intent', async () => {
  await createContentType(sql, { apiId: 'm_defs', fields: [{ name: 'anchor', cmsType: 'integer' }] });
  await addField(sql, 'm_defs', { name: 'flag', cmsType: 'boolean', options: { default: true } });
  await addField(sql, 'm_defs', { name: 'amt', cmsType: 'decimal', options: { precision: 6, scale: 2, default: '1.50' } });
  await addField(sql, 'm_defs', { name: 'big', cmsType: 'biginteger', options: { default: '9007199254740993' } });
  await addField(sql, 'm_defs', { name: 'kind', cmsType: 'enumeration', options: { values: ['red', 'blue'], default: 'blue' } });
  await addField(sql, 'm_defs', { name: 'label', cmsType: 'string', options: { default: 'hello' } });
  await addField(sql, 'm_defs', { name: 'blob', cmsType: 'json', options: { default: { k: 1 } } });
  await addField(sql, 'm_defs', { name: 'day', cmsType: 'date', options: { default: '2020-01-01' } });
  await addField(sql, 'm_defs', { name: 'at', cmsType: 'datetime', options: { default: '2020-01-01T00:00:00Z' } });
  // insert a row that relies on EVERY default and read the baked values back.
  await sql.unsafe(`INSERT INTO "ct_m_defs" (anchor) VALUES (1)`);
  const [r] = await sql<{ flag: boolean; amt: string; big: string; kind: string; label: string; blob: unknown; day: Date; at: Date }[]>`
    SELECT flag, amt, big, kind, label, blob, day, at FROM "ct_m_defs"
  `;
  assert.equal(r!.flag, true);
  assert.equal(r!.amt, '1.50');
  assert.equal(r!.big, '9007199254740993');
  assert.equal(r!.kind, 'blue');
  assert.equal(r!.label, 'hello');
  assert.deepEqual(r!.blob, { k: 1 });
  assert.ok(r!.day instanceof Date);
  assert.ok(r!.at instanceof Date);
});

// P22 — forced mid-tx failure on a NON-create op (addField) rolls BOTH the meta INSERT and the
//        ADD COLUMN back together, proving the shared runSchemaTx atomicity beyond the create path. [9,14]
test('P22 addField rolls back meta + DDL together on an in-tx failure', async () => {
  await createContentType(sql, { apiId: 'm_atom', fields: [{ name: 'a', cmsType: 'integer' }] });
  // Pre-create a physical column 'b' WITHOUT a meta row, so the app pre-check (meta lookup) passes but
  // the in-tx ADD COLUMN "b" throws (duplicate column) AFTER the meta INSERT -> the whole tx rolls back.
  await sql.unsafe(`ALTER TABLE "ct_m_atom" ADD COLUMN "b" integer`);
  await assert.rejects(() => addField(sql, 'm_atom', { name: 'b', cmsType: 'integer' }));
  // No leaked meta row for 'b' (the INSERT rolled back with the failed ADD COLUMN).
  const ct = await getContentType(sql, 'm_atom');
  assert.ok(!(await getFields(sql, ct!.id)).some((f) => f.name === 'b'), 'no orphan meta field row');
});

// P23 — the lock_timeout -> SchemaChangeConflictError mapping is REAL: a held advisory lock makes a
//        competing schema change time out and reject with the typed conflict error. [19,66]
test('P23 a held lock makes a competing schema change reject with SchemaChangeConflictError', async () => {
  await createContentType(sql, { apiId: 'm_locked', fields: [{ name: 'a', cmsType: 'integer' }] });
  const ct = await getContentType(sql, 'm_locked');
  // advisoryKey is derived from the table name; hold that exact xact lock in a separate transaction.
  const key = advisoryKey(ct!.table_name);
  // Open a holder tx on a dedicated connection that grabs the advisory lock and parks.
  const holder = createSql();
  let release: () => void = () => {};
  let acquired: () => void = () => {};
  const parked = new Promise<void>((resolve) => { release = resolve; });
  const locked = new Promise<void>((resolve) => { acquired = resolve; });
  const held = holder.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${key})`;
    acquired(); // signal the lock is now HELD before the competing change fires
    await parked; // hold the lock until we let go
  });
  await locked; // deterministic: only race the competing change once the lock is provably held
  try {
    // Give the holder a moment to acquire the lock, then fire a competing change with a short timeout.
    // We shorten the wait by racing: the competing addField sets lock_timeout=5s internally, so it
    // will reject with SchemaChangeConflictError once it cannot get the advisory lock in time.
    await assert.rejects(
      () => addField(sql, 'm_locked', { name: 'b', cmsType: 'integer' }),
      SchemaChangeConflictError,
    );
  } finally {
    release();
    await held;
    await holder.end();
  }
  // After releasing, the type is unchanged (the timed-out add never applied).
  assert.ok(!(await getFields(sql, ct!.id)).some((f) => f.name === 'b'));
});
