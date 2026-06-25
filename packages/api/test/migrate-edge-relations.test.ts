import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { migrate, readAppliedSchemas, MigrationBlockedError } from '../src/db/schema/migrate.ts';
import type { Schema, FieldSchema, FieldType } from '../src/db/schema/model.ts';
import type { FieldOptions } from '../src/db/type.catalog.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, tableExists, physicalColumns } from './helpers.ts';

/**
 * S4 migrate engine — RELATIONS edge cases against REAL Postgres (no mocks). Goes deeper than the basic
 * happy path in schema-migrate.test.ts: it INSERTS REAL endpoint rows + edges into a link table, runs
 * UNRELATED migrations, and asserts the edges + endpoint data actually SURVIVE (not just that a table
 * exists). Covers two-way inverse metadata round-trip, owner-field rename under live edges, multi-relation
 * owners, manyToMany cardinality, and the destructive drop-relation gate (blocked vs acked).
 */

const f = (id: string, name: string, type: FieldType, options?: FieldOptions): FieldSchema =>
  options ? { id, name, type, options } : { id, name, type };
const schema = (id: string, apiId: string, fields: FieldSchema[]): Schema => ({ id, apiId, fields });

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;

before(async () => {
  db = await createFileDatabase('edgerelations');
  sql = db.sql;
});
beforeEach(async () => {
  await cleanCatalog(sql); // drops ct_ tables (CASCADE also drops their FK-dependent link tables)
  await sql`DROP TABLE IF EXISTS _schema_applied`;
});
after(async () => {
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

// Owner ct_post (manyToOne author -> writer, inverse "posts"). Target ct_writer.
const writer = (extra: FieldSchema[] = []): Schema => ({
  id: 'ct_w',
  apiId: 'writer',
  fields: [f('f_nm', 'name', 'string', { nullable: true }), ...extra],
});
const postWithRel = (extra: FieldSchema[] = []): Schema => ({
  id: 'ct_p',
  apiId: 'post',
  fields: [f('f_ti', 'title', 'string', { nullable: true }), ...extra],
  relations: [{ id: 'rel_au', field: 'author', kind: 'manyToOne', target: 'writer', inverseField: 'posts' }],
});

/** Create writer+post, insert one writer + two posts, link both posts to the writer. Returns the ids. */
async function seedAuthorGraph(): Promise<{ wId: number; p1Id: number; p2Id: number }> {
  await migrate(sql, [writer(), postWithRel()]);
  assert.equal(await tableExists(sql, 'post_author_lnk'), true);

  const [w] = await sql<{ id: number }[]>`INSERT INTO ct_writer (name) VALUES ('Ada') RETURNING id`;
  const [p1] = await sql<{ id: number }[]>`INSERT INTO ct_post (title) VALUES ('p1') RETURNING id`;
  const [p2] = await sql<{ id: number }[]>`INSERT INTO ct_post (title) VALUES ('p2') RETURNING id`;
  await sql.unsafe(`INSERT INTO post_author_lnk (owner_id, related_id) VALUES (${p1!.id}, ${w!.id})`);
  await sql.unsafe(`INSERT INTO post_author_lnk (owner_id, related_id) VALUES (${p2!.id}, ${w!.id})`);
  return { wId: w!.id, p1Id: p1!.id, p2Id: p2!.id };
}

test('UNRELATED scalar add on the owner preserves edges + endpoint rows', async () => {
  const { wId, p1Id, p2Id } = await seedAuthorGraph();

  // Add a scalar field to the OWNER (post) — touches no relation. The link table + edges must be untouched.
  const r = await migrate(sql, [writer(), postWithRel([f('f_bd', 'body', 'text', { nullable: true })])]);
  assert.deepEqual(r.applied.map((c) => c.kind), ['addField']);

  assert.ok((await physicalColumns(sql, 'ct_post')).some((c) => c.name === 'body'), 'new column added');
  assert.equal(await tableExists(sql, 'post_author_lnk'), true, 'link table untouched');

  const edges = await sql<{ owner_id: number; related_id: number }[]>`
    SELECT owner_id, related_id FROM post_author_lnk ORDER BY owner_id`;
  assert.deepEqual(
    edges.map((e) => [e.owner_id, e.related_id]),
    [[p1Id, wId], [p2Id, wId]],
    'edges survived the unrelated migration',
  );
  assert.equal((await sql`SELECT 1 FROM ct_writer WHERE id = ${wId}`).length, 1, 'writer row intact');
  assert.equal((await sql`SELECT 1 FROM ct_post`).length, 2, 'post rows intact');
});

test('UNRELATED scalar add on the TARGET preserves edges + endpoint rows', async () => {
  const { wId, p1Id } = await seedAuthorGraph();

  // Add a scalar field to the TARGET (writer). The owner relation + link edges must be untouched.
  const r = await migrate(sql, [writer([f('f_em', 'email', 'string', { nullable: true })]), postWithRel()]);
  assert.deepEqual(r.applied.map((c) => c.kind), ['addField']);

  assert.ok((await physicalColumns(sql, 'ct_writer')).some((c) => c.name === 'email'));
  const edges = await sql<{ owner_id: number; related_id: number }[]>`SELECT owner_id, related_id FROM post_author_lnk`;
  assert.ok(edges.some((e) => e.owner_id === p1Id && e.related_id === wId), 'edge survived target migration');
  assert.equal((await sql`SELECT 1 FROM ct_writer WHERE id = ${wId}`).length, 1);
});

test('two-way inverse relation metadata round-trips through _schema_applied; re-run is a no-op', async () => {
  await seedAuthorGraph();

  // The applied snapshot must preserve the inverseField verbatim (so a re-diff sees no relation change).
  const applied = await readAppliedSchemas(sql);
  const post = applied.find((s) => s.id === 'ct_p');
  assert.ok(post, 'owner persisted');
  assert.equal(post!.relations?.length, 1);
  const rel = post!.relations![0]!;
  assert.equal(rel.field, 'author');
  assert.equal(rel.kind, 'manyToOne');
  assert.equal(rel.target, 'writer');
  assert.equal(rel.inverseField, 'posts', 'inverseField metadata round-tripped');

  // Idempotent: re-applying the IDENTICAL catalog emits no change (the inverse-flip false-diff guard).
  const r = await migrate(sql, [writer(), postWithRel()]);
  assert.equal(r.noop, true);
  assert.equal(r.applied.length, 0);
});

test('renaming the OWNER scalar field (id-matched) keeps edges + endpoint data intact', async () => {
  const { wId, p1Id } = await seedAuthorGraph();

  // Rename ct_post.title -> headline (same field id f_ti) — a RENAME COLUMN, lossless, must not disturb edges.
  const renamed: Schema = {
    id: 'ct_p',
    apiId: 'post',
    fields: [f('f_ti', 'headline', 'string', { nullable: true })],
    relations: [{ id: 'rel_au', field: 'author', kind: 'manyToOne', target: 'writer', inverseField: 'posts' }],
  };
  const r = await migrate(sql, [writer(), renamed]);
  assert.deepEqual(r.applied.map((c) => c.kind), ['renameField']);

  const cols = (await physicalColumns(sql, 'ct_post')).map((c) => c.name);
  assert.ok(cols.includes('headline') && !cols.includes('title'));
  const [row] = await sql<{ headline: string }[]>`SELECT headline FROM ct_post WHERE id = ${p1Id}`;
  assert.equal(row?.headline, 'p1', 'owner data survived rename');
  assert.equal(
    (await sql`SELECT 1 FROM post_author_lnk WHERE owner_id = ${p1Id} AND related_id = ${wId}`).length,
    1,
    'edge survived the owner field rename',
  );
});

test('dropping a relation is BLOCKED without ack — link table + edges remain intact', async () => {
  const { wId, p1Id } = await seedAuthorGraph();

  const postNoRel: Schema = { id: 'ct_p', apiId: 'post', fields: [f('f_ti', 'title', 'string', { nullable: true })] };
  await assert.rejects(migrate(sql, [writer(), postNoRel]), MigrationBlockedError);

  // Nothing changed: link table still present, edges + endpoint rows untouched, applied snapshot unchanged.
  assert.equal(await tableExists(sql, 'post_author_lnk'), true, 'blocked drop did not remove the link table');
  assert.equal(
    (await sql`SELECT 1 FROM post_author_lnk WHERE owner_id = ${p1Id} AND related_id = ${wId}`).length,
    1,
    'edge intact after blocked drop',
  );
  const applied = await readAppliedSchemas(sql);
  assert.equal(applied.find((s) => s.id === 'ct_p')?.relations?.length, 1, 'applied snapshot still has the relation');
});

test('dropping a relation with allowDestructive removes the link table but keeps endpoint rows', async () => {
  const { wId, p1Id, p2Id } = await seedAuthorGraph();

  const postNoRel: Schema = { id: 'ct_p', apiId: 'post', fields: [f('f_ti', 'title', 'string', { nullable: true })] };
  const r = await migrate(sql, [writer(), postNoRel], { allowDestructive: true });
  assert.deepEqual(r.applied.map((c) => c.kind), ['dropRelation']);

  assert.equal(await tableExists(sql, 'post_author_lnk'), false, 'link table dropped (edges lost)');
  // Endpoint rows MUST survive — dropping the relation drops only the edges, never the content.
  assert.equal((await sql`SELECT 1 FROM ct_writer WHERE id = ${wId}`).length, 1, 'writer row intact');
  const posts = await sql<{ id: number }[]>`SELECT id FROM ct_post ORDER BY id`;
  assert.deepEqual(posts.map((p) => p.id), [p1Id, p2Id], 'both post rows intact');

  // The applied snapshot no longer carries the relation → idempotent re-run.
  const applied = await readAppliedSchemas(sql);
  assert.equal(applied.find((s) => s.id === 'ct_p')?.relations?.length ?? 0, 0);
  assert.equal((await migrate(sql, [writer(), postNoRel])).noop, true);
});

test('ADD a NEW relation to an existing owner creates a fresh link table; existing edges accept new rows', async () => {
  // Start with post -> writer (author). Then ADD a second relation post -> writer (editor, manyToOne).
  await migrate(sql, [writer(), postWithRel()]);
  const [w] = await sql<{ id: number }[]>`INSERT INTO ct_writer (name) VALUES ('Ada') RETURNING id`;
  const [p] = await sql<{ id: number }[]>`INSERT INTO ct_post (title) VALUES ('p1') RETURNING id`;
  await sql.unsafe(`INSERT INTO post_author_lnk (owner_id, related_id) VALUES (${p!.id}, ${w!.id})`);

  const postTwoRels: Schema = {
    id: 'ct_p',
    apiId: 'post',
    fields: [f('f_ti', 'title', 'string', { nullable: true })],
    relations: [
      { id: 'rel_au', field: 'author', kind: 'manyToOne', target: 'writer', inverseField: 'posts' },
      { id: 'rel_ed', field: 'editor', kind: 'manyToOne', target: 'writer' },
    ],
  };
  const r = await migrate(sql, [writer(), postTwoRels]);
  assert.deepEqual(r.applied.map((c) => c.kind), ['addRelation']);
  assert.equal(await tableExists(sql, 'post_editor_lnk'), true, 'new link table created');
  assert.equal(await tableExists(sql, 'post_author_lnk'), true, 'existing link table untouched');

  // Original edge survived; the new link table accepts an edge to the same endpoints.
  assert.equal((await sql`SELECT 1 FROM post_author_lnk WHERE owner_id = ${p!.id}`).length, 1);
  await sql.unsafe(`INSERT INTO post_editor_lnk (owner_id, related_id) VALUES (${p!.id}, ${w!.id})`);
  assert.equal((await sql`SELECT 1 FROM post_editor_lnk WHERE owner_id = ${p!.id} AND related_id = ${w!.id}`).length, 1);
});

test('manyToMany link table enforces UNIQUE(owner_id, related_id); ord + edges survive an unrelated add', async () => {
  // post <-> tag manyToMany. The cardinality contract is UNIQUE(owner_id, related_id).
  const tag: Schema = { id: 'ct_t', apiId: 'tag', fields: [f('f_lb', 'label', 'string', { nullable: true })] };
  const postM2M: Schema = {
    id: 'ct_p',
    apiId: 'post',
    fields: [f('f_ti', 'title', 'string', { nullable: true })],
    relations: [{ id: 'rel_tg', field: 'tags', kind: 'manyToMany', target: 'tag', inverseField: 'posts' }],
  };
  await migrate(sql, [tag, postM2M]);
  assert.equal(await tableExists(sql, 'post_tags_lnk'), true);

  const [t1] = await sql<{ id: number }[]>`INSERT INTO ct_tag (label) VALUES ('a') RETURNING id`;
  const [t2] = await sql<{ id: number }[]>`INSERT INTO ct_tag (label) VALUES ('b') RETURNING id`;
  const [p] = await sql<{ id: number }[]>`INSERT INTO ct_post (title) VALUES ('p1') RETURNING id`;
  await sql.unsafe(`INSERT INTO post_tags_lnk (owner_id, related_id, ord) VALUES (${p!.id}, ${t1!.id}, 1)`);
  await sql.unsafe(`INSERT INTO post_tags_lnk (owner_id, related_id, ord) VALUES (${p!.id}, ${t2!.id}, 2)`);

  // Duplicate (owner_id, related_id) must be rejected by the manyToMany UNIQUE constraint.
  await assert.rejects(
    sql.unsafe(`INSERT INTO post_tags_lnk (owner_id, related_id, ord) VALUES (${p!.id}, ${t1!.id}, 3)`),
    /duplicate key|unique/i,
  );

  // Unrelated scalar add on the owner — the ordered edges must survive byte-for-byte.
  const r = await migrate(sql, [
    tag,
    {
      id: 'ct_p',
      apiId: 'post',
      fields: [f('f_ti', 'title', 'string', { nullable: true }), f('f_bd', 'body', 'text', { nullable: true })],
      relations: [{ id: 'rel_tg', field: 'tags', kind: 'manyToMany', target: 'tag', inverseField: 'posts' }],
    },
  ]);
  assert.deepEqual(r.applied.map((c) => c.kind), ['addField']);
  const edges = await sql<{ related_id: number; ord: number }[]>`
    SELECT related_id, ord FROM post_tags_lnk WHERE owner_id = ${p!.id} ORDER BY ord`;
  assert.deepEqual(edges.map((e) => [e.related_id, Number(e.ord)]), [[t1!.id, 1], [t2!.id, 2]], 'ordered M2M edges survived');
});

test('deleting an endpoint row CASCADES its edges (FK ON DELETE CASCADE) without touching the other side', async () => {
  const { wId, p1Id, p2Id } = await seedAuthorGraph();

  // Delete the writer; ON DELETE CASCADE on related_id must remove both edges, leaving posts intact.
  await sql.unsafe(`DELETE FROM ct_writer WHERE id = ${wId}`);
  assert.equal((await sql`SELECT 1 FROM post_author_lnk`).length, 0, 'edges cascaded away with the writer');
  const posts = await sql<{ id: number }[]>`SELECT id FROM ct_post ORDER BY id`;
  assert.deepEqual(posts.map((p) => p.id), [p1Id, p2Id], 'posts untouched by the cascade');

  // A subsequent unrelated migration still applies cleanly over the now-empty link table.
  const r = await migrate(sql, [writer(), postWithRel([f('f_bd', 'body', 'text', { nullable: true })])]);
  assert.deepEqual(r.applied.map((c) => c.kind), ['addField']);
});
