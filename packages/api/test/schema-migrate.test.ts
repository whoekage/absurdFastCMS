import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sql } from 'postgres';
import { migrate, migrateLint, MigrationBlockedError } from '../src/db/schema/migrate.ts';
import { stringifySchema } from '../src/db/schema/serialize.ts';
import type { ContentTypeSchema, FieldSchema, FieldType } from '../src/db/schema/model.ts';
import type { FieldOptions } from '../src/db/type.catalog.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, physicalColumns, tableExists } from './helpers.ts';

/**
 * S4 — the migrate engine against REAL Postgres (no mocks). The headline proofs: a stable-id RENAME
 * preserves data (the Strapi #12626/#19141 fix), DROP is gated behind an ack, the apply is transactional
 * and idempotent, and a type change carries data across. Files-first: migrate diffs the committed dir
 * against the stored `_schema_applied` snapshot — no meta tables involved.
 */

const f = (id: string, name: string, type: FieldType, options?: FieldOptions): FieldSchema =>
  options ? { id, name, type, options } : { id, name, type };
const ct = (id: string, apiId: string, fields: FieldSchema[]): ContentTypeSchema => ({ id, apiId, fields });

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let dir: string;

before(async () => {
  db = await createFileDatabase('migrate');
  sql = db.sql;
});
beforeEach(async () => {
  await cleanCatalog(sql); // drops any ct_ tables
  await sql`DROP TABLE IF EXISTS _schema_applied`;
  dir = await mkdtemp(path.join(tmpdir(), 'conti-migrate-'));
});
after(async () => {
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

const write = (s: ContentTypeSchema): Promise<void> => writeFile(path.join(dir, `${s.apiId}.json`), stringifySchema(s));
const unlink = (apiId: string): Promise<void> => rm(path.join(dir, `${apiId}.json`));

test('fresh migrate creates the table from files; a second run is a no-op (idempotent)', async () => {
  await write(ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })]));
  const r1 = await migrate(sql, dir);
  assert.equal(r1.noop, false);
  assert.equal(await tableExists(sql, 'ct_thing'), true);
  assert.ok((await physicalColumns(sql, 'ct_thing')).some((c) => c.name === 'title'));

  const r2 = await migrate(sql, dir);
  assert.equal(r2.noop, true); // diff(prev,next) empty — the anti-churn invariant
  assert.equal(r2.applied.length, 0);
});

test('RENAME preserves data: id-matched name change → RENAME COLUMN, rows intact', async () => {
  await write(ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })]));
  await migrate(sql, dir);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('hello')`);

  // same field id f_t, new name headline
  await write(ct('ct_a', 'thing', [f('f_t', 'headline', 'string', { nullable: true })]));
  const r = await migrate(sql, dir);
  assert.deepEqual(r.applied.map((c) => c.kind), ['renameField']);

  const cols = (await physicalColumns(sql, 'ct_thing')).map((c) => c.name);
  assert.ok(cols.includes('headline') && !cols.includes('title'), 'column was renamed, not dropped+added');
  const [row] = await sql<{ headline: string }[]>`SELECT headline FROM ct_thing`;
  assert.equal(row?.headline, 'hello'); // DATA SURVIVED the rename
});

test('RENAME TYPE preserves data: apiId change → RENAME TABLE, rows intact', async () => {
  await write(ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })]));
  await migrate(sql, dir);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('keep')`);

  await unlink('thing'); // same id ct_a, new apiId gadget (the file must be renamed too — stem===apiId)
  await write(ct('ct_a', 'gadget', [f('f_t', 'title', 'string', { nullable: true })]));
  const r = await migrate(sql, dir);
  assert.deepEqual(r.applied.map((c) => c.kind), ['renameType']);

  assert.equal(await tableExists(sql, 'ct_gadget'), true);
  assert.equal(await tableExists(sql, 'ct_thing'), false);
  const [row] = await sql<{ title: string }[]>`SELECT title FROM ct_gadget`;
  assert.equal(row?.title, 'keep');
});

test('DROP field is blocked without ack, allowed with allowDestructive', async () => {
  await write(ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true }), f('f_n', 'note', 'text', { nullable: true })]));
  await migrate(sql, dir);
  await sql.unsafe(`INSERT INTO ct_thing (title, note) VALUES ('a', 'b')`);

  await write(ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])); // note dropped
  await assert.rejects(migrate(sql, dir), MigrationBlockedError);
  // not applied: note column still present
  assert.ok((await physicalColumns(sql, 'ct_thing')).some((c) => c.name === 'note'), 'blocked migration did not apply');

  const r = await migrate(sql, dir, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['dropField']);
  assert.ok(!(await physicalColumns(sql, 'ct_thing')).some((c) => c.name === 'note'));
});

test('ADD NOT NULL with a default applies (safe); without a default is gated (data-dependent)', async () => {
  await write(ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })]));
  await migrate(sql, dir);
  await sql.unsafe(`INSERT INTO ct_thing (title) VALUES ('x')`);

  // NOT NULL + default => safe; the existing row backfills to the default.
  await write(ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true }), f('f_a', 'active', 'boolean', { nullable: false, default: false })]));
  const r = await migrate(sql, dir);
  assert.deepEqual(r.applied.map((c) => c.kind), ['addField']);
  const [row] = await sql<{ active: boolean }[]>`SELECT active FROM ct_thing`;
  assert.equal(row?.active, false);

  // NOT NULL + NO default => data-dependent => blocked without ack.
  await write(ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true }), f('f_a', 'active', 'boolean', { nullable: false, default: false }), f('f_r', 'rank', 'integer', { nullable: false })]));
  await assert.rejects(migrate(sql, dir), MigrationBlockedError);
});

test('RETYPE is gated as data-dependent and preserves data when acked', async () => {
  await write(ct('ct_a', 'thing', [f('f_v', 'views', 'integer', { nullable: true })]));
  await migrate(sql, dir);
  await sql.unsafe(`INSERT INTO ct_thing (views) VALUES (5)`);

  await write(ct('ct_a', 'thing', [f('f_v', 'views', 'biginteger', { nullable: true })])); // integer -> biginteger
  await assert.rejects(migrate(sql, dir), MigrationBlockedError); // rewrite => data-dependent => gated

  const r = await migrate(sql, dir, { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['retypeField']);
  const [row] = await sql<{ views: string }[]>`SELECT views FROM ct_thing`;
  assert.equal(String(row?.views), '5'); // value carried across the cast (int8 comes back as a string)
});

test('relation: migrate creates the link table after both ct_ tables; idempotent; drop removes it', async () => {
  await write({ id: 'ct_w', apiId: 'writer', fields: [f('f_nm', 'name', 'string', { nullable: true })] });
  await write({
    id: 'ct_p',
    apiId: 'post',
    fields: [f('f_ti', 'title', 'string', { nullable: true })],
    relations: [{ id: 'rel_au', field: 'author', kind: 'manyToOne', target: 'writer', inverseField: 'posts' }],
  } as ContentTypeSchema);

  const r = await migrate(sql, dir);
  assert.ok(r.applied.map((c) => c.kind).includes('addRelation'));
  assert.equal(await tableExists(sql, 'ct_writer'), true);
  assert.equal(await tableExists(sql, 'ct_post'), true);
  assert.equal(await tableExists(sql, 'post_author_lnk'), true); // link table created (after both ct_ tables)

  // the link-table FKs are real: insert both endpoints + an edge.
  const [w] = await sql<{ id: number }[]>`INSERT INTO ct_writer (name) VALUES ('w') RETURNING id`;
  const [p] = await sql<{ id: number }[]>`INSERT INTO ct_post (title) VALUES ('p') RETURNING id`;
  await sql.unsafe(`INSERT INTO post_author_lnk (owner_id, related_id) VALUES (${p!.id}, ${w!.id})`);
  assert.equal((await sql`SELECT 1 FROM post_author_lnk`).length, 1);

  assert.equal((await migrate(sql, dir)).noop, true); // idempotent

  // drop the relation: link table gone (destructive → ack required)
  await write({ id: 'ct_p', apiId: 'post', fields: [f('f_ti', 'title', 'string', { nullable: true })] });
  await assert.rejects(migrate(sql, dir), MigrationBlockedError);
  const r2 = await migrate(sql, dir, { allowDestructive: true });
  assert.deepEqual(r2.applied.map((c) => c.kind), ['dropRelation']);
  assert.equal(await tableExists(sql, 'post_author_lnk'), false);
});

test('migrateLint reports the blocked changes WITHOUT applying', async () => {
  await write(ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true }), f('f_n', 'note', 'text', { nullable: true })]));
  await migrate(sql, dir);

  await write(ct('ct_a', 'thing', [f('f_t', 'title', 'string', { nullable: true })])); // drop note
  const { changes, blocked } = await migrateLint(sql, dir);
  assert.deepEqual(changes.map((c) => c.kind), ['dropField']);
  assert.equal(blocked.length, 1);
  // lint did not apply: note still there
  assert.ok((await physicalColumns(sql, 'ct_thing')).some((c) => c.name === 'note'));
});
