import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { migrate, migrateLint, MigrationBlockedError } from '../src/db/schema/migrate.ts';
import type { ContentTypeSchema, FieldSchema, FieldType } from '../src/db/schema/model.ts';
import type { FieldOptions } from '../src/db/type.catalog.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, physicalColumns, tableExists } from './helpers.ts';

/**
 * S4 migrate engine against REAL Postgres (no mocks). Drives `migrate` with the IR directly (the loader is
 * at the edge now). Headline proofs: stable-id RENAME preserves data (the Strapi #12626/#19141 fix), DROP
 * is gated behind an ack, the apply is transactional + idempotent, type changes carry data, and relations
 * create/drop their link tables.
 */

const f = (id: string, name: string, type: FieldType, options?: FieldOptions): FieldSchema =>
  options ? { id, name, type, options } : { id, name, type };
const ct = (id: string, apiId: string, fields: FieldSchema[]): ContentTypeSchema => ({ id, apiId, fields });

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;

before(async () => {
  db = await createFileDatabase('migrate');
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

test('fresh migrate creates the table; a second run is a no-op (idempotent)', async () => {
  const next = [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])];
  const r1 = await migrate(sql, next);
  assert.equal(r1.noop, false);
  assert.equal(await tableExists(sql, 'ct_thing'), true);

  const r2 = await migrate(sql, next);
  assert.equal(r2.noop, true);
  assert.equal(r2.applied.length, 0);
});

test('RENAME preserves data: id-matched name change → RENAME COLUMN, rows intact', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('hello')`);

  const r = await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'headline', 'string', { nullable: true })])]); // same id f_t
  assert.deepEqual(r.applied.map((c) => c.kind), ['renameField']);

  const cols = (await physicalColumns(sql, 'ct_thing')).map((c) => c.name);
  assert.ok(cols.includes('headline') && !cols.includes('title'), 'renamed, not dropped+added');
  const [row] = await sql<{ headline: string }[]>`SELECT headline FROM ct_thing`;
  assert.equal(row?.headline, 'hello'); // DATA SURVIVED the rename
});

test('RENAME TYPE preserves data: apiId change → RENAME TABLE, rows intact', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('keep')`);

  const r = await migrate(sql, [ct('ct_a', 'gadget', [f('f_t', 'title', 'string', { nullable: true })])]); // same id ct_a
  assert.deepEqual(r.applied.map((c) => c.kind), ['renameType']);
  assert.equal(await tableExists(sql, 'ct_gadget'), true);
  assert.equal(await tableExists(sql, 'ct_thing'), false);
  const [row] = await sql<{ title: string }[]>`SELECT title FROM ct_gadget`;
  assert.equal(row?.title, 'keep');
});

test('DROP field is blocked without ack, allowed with allowDestructive', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true }), f('f_n', 'note', 'text', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title, note) VALUES ('a', 'b')`);

  const dropped = [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])];
  await assert.rejects(migrate(sql, dropped), MigrationBlockedError);
  assert.ok((await physicalColumns(sql, 'ct_thing')).some((c) => c.name === 'note'), 'blocked migration did not apply');

  const r = await migrate(sql, dropped, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['dropField']);
  assert.ok(!(await physicalColumns(sql, 'ct_thing')).some((c) => c.name === 'note'));
});

test('ADD NOT NULL with a default applies (safe); without a default is gated (data-dependent)', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('x')`);

  const withDefault = [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true }), f('f_a', 'active', 'boolean', { nullable: false, default: false })])];
  const r = await migrate(sql, withDefault);
  assert.deepEqual(r.applied.map((c) => c.kind), ['addField']);
  const [row] = await sql<{ active: boolean }[]>`SELECT active FROM ct_thing`;
  assert.equal(row?.active, false); // existing row backfilled to the default

  const noDefault = [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true }), f('f_a', 'active', 'boolean', { nullable: false, default: false }), f('f_r', 'rank', 'integer', { nullable: false })])];
  await assert.rejects(migrate(sql, noDefault), MigrationBlockedError);
});

test('RETYPE is gated as data-dependent and preserves data when acked', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_v', 'views', 'integer', { nullable: true })])]);
  await sql.unsafe(`INSERT INTO ct_thing (views) VALUES (5)`);

  const widened = [ct('ct_a', 'thing', [f('f_v', 'views', 'biginteger', { nullable: true })])];
  await assert.rejects(migrate(sql, widened), MigrationBlockedError);

  const r = await migrate(sql, widened, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['retypeField']);
  const [row] = await sql<{ views: string }[]>`SELECT views FROM ct_thing`;
  assert.equal(String(row?.views), '5'); // value carried across the cast
});

test('relation: migrate creates the link table after both ct_ tables; idempotent; drop removes it', async () => {
  const writer: ContentTypeSchema = { id: 'ct_w', apiId: 'writer', fields: [f('f_nm', 'name', 'string', { nullable: true })] };
  const postWithRel: ContentTypeSchema = {
    id: 'ct_p',
    apiId: 'post',
    fields: [f('f_ti', 'title', 'string', { nullable: true })],
    relations: [{ id: 'rel_au', field: 'author', kind: 'manyToOne', target: 'writer', inverseField: 'posts' }],
  };
  const r = await migrate(sql, [writer, postWithRel]);
  assert.ok(r.applied.map((c) => c.kind).includes('addRelation'));
  assert.equal(await tableExists(sql, 'ct_writer'), true);
  assert.equal(await tableExists(sql, 'ct_post'), true);
  assert.equal(await tableExists(sql, 'post_author_lnk'), true);

  const [w] = await sql<{ id: number }[]>`INSERT INTO ct_writer (name) VALUES ('w') RETURNING id`;
  const [p] = await sql<{ id: number }[]>`INSERT INTO ct_post (title) VALUES ('p') RETURNING id`;
  await sql.unsafe(`INSERT INTO post_author_lnk (owner_id, related_id) VALUES (${p!.id}, ${w!.id})`);
  assert.equal((await sql`SELECT 1 FROM post_author_lnk`).length, 1);

  assert.equal((await migrate(sql, [writer, postWithRel])).noop, true); // idempotent

  const postNoRel: ContentTypeSchema = { id: 'ct_p', apiId: 'post', fields: [f('f_ti', 'title', 'string', { nullable: true })] };
  await assert.rejects(migrate(sql, [writer, postNoRel]), MigrationBlockedError);
  const r2 = await migrate(sql, [writer, postNoRel], { allowDestructive: true });
  assert.deepEqual(r2.applied.map((c) => c.kind), ['dropRelation']);
  assert.equal(await tableExists(sql, 'post_author_lnk'), false);
});

test('migrateLint reports the blocked changes WITHOUT applying', async () => {
  await migrate(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true }), f('f_n', 'note', 'text', { nullable: true })])]);

  const { changes, blocked } = await migrateLint(sql, [ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])]);
  assert.deepEqual(changes.map((c) => c.kind), ['dropField']);
  assert.equal(blocked.length, 1);
  assert.ok((await physicalColumns(sql, 'ct_thing')).some((c) => c.name === 'note')); // lint applied nothing
});
