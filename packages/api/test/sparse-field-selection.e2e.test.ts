import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { Registry } from '../src/db/registry.ts';
import { migrate } from '../src/db/schema/migrate.ts';
import type { Schema } from '../src/db/schema/model.ts';
import { buildEngine } from '../src/db/engine.loader.ts';
import { Engine } from '../src/store/engine.ts';
import { handleRequest } from '../src/http/read.router.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, schema } from './helpers.ts';

/**
 * be-02 — Strapi v5 sparse field selection (`fields`), END-TO-END over the REAL HTTP read router +
 * REAL Postgres (no mocks). Proves: the list route projects to (id + requested); the single route
 * (`/:type/:id`) now threads `fields` too; an unknown field 400s (the same gate filters use); `fields`
 * COMPOSES with populate (projected OWNER scalar body + FULL related rows — relations stay populate-
 * governed); and a request with NO `fields` is byte-identical to before this slice.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;

before(async () => {
  db = await createFileDatabase('sparsefields');
  sql = db.sql;
});

beforeEach(async () => {
  await cleanCatalog(sql);
});

after(async () => {
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

async function insertRow(table: string, cols: Record<string, string | number>): Promise<number> {
  const keys = Object.keys(cols);
  const ph = keys.map((_, i) => `$${i + 1}`).join(',');
  const [r] = await sql.unsafe<{ id: number }[]>(
    `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${ph}) RETURNING id`,
    keys.map((k) => cols[k]!),
  );
  return r!.id;
}

async function insertEdge(link: string, ownerPk: number, relatedPk: number): Promise<void> {
  await sql.unsafe(`INSERT INTO "${link}" (owner_id, related_id) VALUES ($1, $2)`, [ownerPk, relatedPk]);
}

async function setup(schemas: Schema[]): Promise<void> {
  await migrate(sql, schemas, { allowDestructive: true }); // CREATE TABLE ct_* (+ link tables), no meta
}

async function boot(schemas: Schema[]): Promise<Engine> {
  return buildEngine(sql, Registry.fromSchemas(schemas));
}

function get(engine: Engine, path: string, query = ''): { status: number; body: Buffer } {
  const res = handleRequest(engine, { method: 'GET', path, query });
  return { status: res.status, body: res.body };
}

function parse(body: Buffer): unknown {
  return JSON.parse(body.toString('utf8'));
}

test('LIST fields=: returns exactly id + requested columns (Strapi v5)', async () => {
  const schemas = [
    schema({
      name: 'article',
      fields: [
        { name: 'title', type: 'string' },
        { name: 'body', type: 'text' },
        { name: 'views', type: 'integer' },
      ],
    }),
  ];
  await setup(schemas);
  await insertRow('ct_article', { title: 'A', body: 'long body', views: 7 });
  const engine = await boot(schemas);

  const res = get(engine, '/article', 'fields=title,views');
  assert.equal(res.status, 200);
  const env = parse(res.body) as { data: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(env.data[0]!), ['id', 'title', 'views']); // id forced, body/created_at/updated_at dropped
  assert.equal(env.data[0]!.title, 'A');
  assert.equal(env.data[0]!.views, 7);
});

test('SINGLE /:type/:id now threads fields (was previously ignored)', async () => {
  const schemas = [
    schema({
      name: 'article',
      fields: [
        { name: 'title', type: 'string' },
        { name: 'body', type: 'text' },
      ],
    }),
  ];
  await setup(schemas);
  const id = await insertRow('ct_article', { title: 'A', body: 'B' });
  const engine = await boot(schemas);

  const res = get(engine, `/article/${id}`, 'fields=title');
  assert.equal(res.status, 200);
  const env = parse(res.body) as { data: Record<string, unknown>; meta: unknown };
  assert.deepEqual(Object.keys(env.data), ['id', 'title']);
  assert.equal(env.data.title, 'A');
  assert.deepEqual(env.meta, {});
});

test('fields with an UNKNOWN field 400s (same gate as filters)', async () => {
  const schemas = [schema({ name: 'article', fields: [{ name: 'title', type: 'string' }] })];
  await setup(schemas);
  const engine = await boot(schemas);
  assert.equal(get(engine, '/article', 'fields=nope').status, 400);
  assert.equal(get(engine, '/article', 'fields=title,nope').status, 400);
});

test('fields COMPOSES with populate: projected OWNER body + FULL related rows', async () => {
  const schemas = [
    schema({ name: 'author', fields: [{ name: 'name', type: 'string' }, { name: 'bio', type: 'text' }] }),
    schema({
      name: 'book',
      fields: [{ name: 'title', type: 'string' }, { name: 'isbn', type: 'string' }],
      relations: [{ field: 'author', kind: 'manyToOne', target: 'author' }],
    }),
  ];
  await setup(schemas);
  const a1 = await insertRow('ct_author', { name: 'Le Guin', bio: 'bio text' });
  const b1 = await insertRow('ct_book', { title: 'The Dispossessed', isbn: '111' });
  await insertEdge('book_author_lnk', b1, a1); // deterministic link name (was rel.link_table)
  const engine = await boot(schemas);

  // Project the OWNER to (id + title); populate author -> the author row is FULL (relations are not projected).
  const res = get(engine, '/book', 'fields=title&populate=author');
  assert.equal(res.status, 200);
  const env = parse(res.body) as { data: Record<string, unknown>[] };
  const row = env.data[0]!;
  // Owner: id + title + the populated relation key; NOT isbn/created_at/updated_at.
  assert.deepEqual(Object.keys(row).sort(), ['author', 'id', 'title']);
  assert.equal(row.title, 'The Dispossessed');
  // Related author row is FULL (carries name + bio + system fields), unaffected by the owner's fields.
  const author = row.author as Record<string, unknown>;
  assert.equal(author.name, 'Le Guin');
  assert.equal(author.bio, 'bio text');
  assert.ok('created_at' in author, 'related row keeps its full shape');
});

test('NO fields: the response is byte-identical to before (full-row path unchanged)', async () => {
  const schemas = [
    schema({
      name: 'article',
      fields: [{ name: 'title', type: 'string' }, { name: 'views', type: 'integer' }],
    }),
  ];
  await setup(schemas);
  await insertRow('ct_article', { title: 'A', views: 1 });
  await insertRow('ct_article', { title: 'B', views: 2 });
  const engine = await boot(schemas);

  const a = get(engine, '/article', 'sort=id:asc');
  const b = get(engine, '/article', 'sort=id:asc&fields='); // empty fields= is a no-op
  assert.equal(a.status, 200);
  // Empty fields= must NOT project: byte-identical to the no-fields request.
  assert.ok(a.body.equals(b.body), 'empty fields= is byte-identical to no fields');
  const env = parse(a.body) as { data: Record<string, unknown>[] };
  // Full row carries every column.
  assert.ok('views' in env.data[0]! && 'created_at' in env.data[0]! && 'updated_at' in env.data[0]!);
});
