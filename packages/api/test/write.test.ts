import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import type { ListenToken } from '../src/http/uws.adapter.ts';
import type { Engine } from '../src/store/engine.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { startTestServerFromSchemas, ARTICLE_SCHEMA } from './helpers.ts';

/**
 * WRITE-PATH SLICE — POST/PUT/DELETE end-to-end over a REAL uWS server backed by a REAL Postgres
 * (.env.test), no mocks, on the GENERIC module path. Each write commits to Postgres (source of
 * truth) and the server rebuilds ONLY that type's in-memory storage, so we prove read-after-write
 * through the wire. Plus strict-validation 400s, 404s, per-type cache isolation, and no corrupted state.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let token: ListenToken;
let base: string;
let close: (t: ListenToken) => void;
let engine: Engine; // held so the per-type-isolation test can OBSERVE the response cache directly.

async function seedRows(): Promise<void> {
  await sql`TRUNCATE ct_article RESTART IDENTITY CASCADE`;
  await sql`INSERT INTO ct_article (title, body, status, views, rating, active, "publishedAt")
            VALUES ('Seed one', 'b1', 'published', 10, 4.5, true, '2021-01-01T00:00:00.000Z')`;
  await sql`INSERT INTO ct_article (title, body, status, views, rating, active, "publishedAt")
            VALUES ('Seed two', 'b2', 'draft', 20, 2.0, false, '2021-02-01T00:00:00.000Z')`;
}

before(async () => {
  db = await createFileDatabase('wr');
  sql = db.sql;
  // A SECOND module (widget) to prove per-type cache isolation on an article write.
  const widget: import('../src/db/schema/model.ts').Schema = { id: 'ct_widget', apiId: 'widget', fields: [{ id: 'f_label', name: 'label', type: 'string', options: { nullable: false } }] };
  const blank: import('../src/db/schema/model.ts').Schema = { id: 'ct_blank', apiId: 'blank', fields: [] }; // system-fields-only
  const server = await startTestServerFromSchemas(sql, [ARTICLE_SCHEMA, widget, blank], {
    seed: async () => { await sql`INSERT INTO ct_widget (label) VALUES ('w1')`; await seedRows(); },
  });
  engine = server.engine;
  close = server.close;
  token = server.token;
  base = server.base;
});

after(async () => {
  if (token) close(token);
  // Guard so a failing before() (db/sql undefined) surfaces the real error, not a deref of undefined.
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

const j = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

test('POST creates a row, returns 201 + data, and GET sees it (read-after-write)', async () => {
  const payload = { title: 'Created \u{1F600}', body: 'fresh', status: 'published', views: 7, rating: 3.5, active: true, publishedAt: '2022-03-04T05:06:07.000Z' };
  const res = await fetch(`${base}/article`, j(payload));
  assert.equal(res.status, 201);
  const created = (await res.json()).data;
  assert.equal(created.id, 3); // RESTART IDENTITY + 2 seeds -> next serial is 3
  assert.equal(created.title, 'Created \u{1F600}');
  assert.equal(created.publishedAt, '2022-03-04T05:06:07.000Z');
  assert.equal(typeof created.created_at, 'string');
  assert.equal(typeof created.updated_at, 'string');

  // The new row is visible on the wire, byte-shaped exactly like a read.
  const got = await fetch(`${base}/article/3`);
  assert.equal(got.status, 200);
  assert.deepEqual((await got.json()).data, created);

  // List now has 3 rows.
  const list = await (await fetch(`${base}/article?pagination[pageSize]=100`)).json();
  assert.equal(list.data.length, 3);
});

test('PUT partially updates only the provided fields; GET reflects it', async () => {
  const res = await fetch(`${base}/article/1`, { method: 'PUT', body: JSON.stringify({ views: 999, status: 'archived' }) });
  assert.equal(res.status, 200);
  const updated = (await res.json()).data;
  assert.equal(updated.id, 1);
  assert.equal(updated.views, 999);
  assert.equal(updated.status, 'archived');
  assert.equal(updated.title, 'Seed one'); // untouched
  assert.equal(updated.body, 'b1'); // untouched

  const got = await (await fetch(`${base}/article/1`)).json();
  assert.deepEqual(got.data, updated);
});

test('PUT can set a nullable field to null', async () => {
  const res = await fetch(`${base}/article/2`, { method: 'PUT', body: JSON.stringify({ title: null }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.title, null);
  const got = await (await fetch(`${base}/article/2`)).json();
  assert.equal(got.data.title, null);
});

test('DELETE removes the row, returns it, and a later GET 404s', async () => {
  const res = await fetch(`${base}/article/2`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.id, 2);

  assert.equal((await fetch(`${base}/article/2`)).status, 404);
  const list = await (await fetch(`${base}/article?pagination[pageSize]=100`)).json();
  assert.deepEqual(list.data.map((d: { id: number }) => d.id).sort((a: number, b: number) => a - b), [1, 3]);
});

test('PUT / DELETE on a nonexistent id -> 404', async () => {
  assert.equal((await fetch(`${base}/article/9999`, { method: 'PUT', body: JSON.stringify({ views: 1 }) })).status, 404);
  assert.equal((await fetch(`${base}/article/9999`, { method: 'DELETE' })).status, 404);
});

test('create validation: unknown field, client id, missing required, wrong type, null on non-nullable -> 400', async () => {
  const ok = { body: 'x', status: 'draft', active: true, publishedAt: '2022-01-01T00:00:00.000Z' };
  const cases: Record<string, unknown> = {
    'unknown field': { ...ok, nope: 1 },
    'client-set id': { ...ok, id: 5 },
    'missing required (status)': { body: 'x', active: true, publishedAt: '2022-01-01T00:00:00.000Z' },
    'wrong type (views as string)': { ...ok, views: 'lots' },
    'null on non-nullable (body)': { ...ok, body: null },
    'bad date': { ...ok, publishedAt: 'not-a-date' },
  };
  for (const [label, payload] of Object.entries(cases)) {
    const res = await fetch(`${base}/article`, j(payload));
    assert.equal(res.status, 400, label);
    assert.equal(typeof (await res.json()).error, 'string', label);
  }
});

test('a valid create still works after the invalid ones (no corrupted state)', async () => {
  const res = await fetch(`${base}/article`, j({ body: 'again', status: 'draft', active: false, publishedAt: '2023-01-01T00:00:00.000Z' }));
  assert.equal(res.status, 201);
  assert.equal((await res.json()).data.title, null); // omitted nullable -> null
});

test('PUT with an empty / only-unknown body -> 400 (empty-update guard)', async () => {
  // A body that survives unknown-key checks but contributes NO writable field hits the empty-out guard.
  const empty = await fetch(`${base}/article/1`, { method: 'PUT', body: JSON.stringify({}) });
  assert.equal(empty.status, 400);
  assert.equal(typeof (await empty.json()).error, 'string');
});

test('POST with an over-length string -> a clean 400 (length guard, not a PG 22001 500)', async () => {
  const tooLong = 'x'.repeat(513); // title is varchar(512)
  const res = await fetch(`${base}/article`, j({ title: tooLong, body: 'b', status: 'draft', active: true, publishedAt: '2025-01-01T00:00:00.000Z' }));
  assert.equal(res.status, 400);
  const err = (await res.json()).error;
  assert.equal(typeof err, 'string');
  // No SQL / constraint / column-type detail leaked.
  assert.ok(!/22001|varchar|truncation|SQLSTATE/i.test(err));
});

test('system-fields-only module: POST {} -> 201 via DEFAULT VALUES, GET sees it, DELETE removes it', async () => {
  // `blank` (no user fields) is seeded in before(); use the running server.
  const res = await fetch(`${base}/blank`, j({}));
  const payload = await res.json();
  assert.equal(res.status, 201, JSON.stringify(payload));
  const created = payload.data;
  assert.deepEqual(Object.keys(created).sort(), ['created_at', 'id', 'updated_at']);
  assert.equal(typeof created.id, 'number');

  const got = await (await fetch(`${base}/blank/${created.id}`)).json();
  assert.deepEqual(got.data, created);

  const del = await fetch(`${base}/blank/${created.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await fetch(`${base}/blank/${created.id}`)).status, 404);
});

test('the rebuild path warms the type indexes (no dirty index after a write)', async () => {
  const res = await fetch(`${base}/article`, j({ body: 'warm', status: 'draft', active: true, publishedAt: '2026-01-01T00:00:00.000Z' }));
  assert.equal(res.status, 201);
  // After the per-write rebuild swaps in the fresh table, its indexes must be warmed (CL: warm-once).
  assert.equal(engine.table('article').hasDirtyIndex(), false);
});

test('a write to article does NOT invalidate a sibling type cache (per-type invalidation)', async () => {
  // Warm widget's list cache (first GET is a MISS that assembles + caches the response buffer).
  const w1 = await (await fetch(`${base}/widget`)).json();
  assert.equal(w1.data.length, 1);
  // OBSERVE the cache directly: snapshot the hit counter. (Total `size` would also be perturbed by the
  // article write dropping its OWN entries, which is correct per-type behavior — so we pin widget via
  // the hit counter instead, which is unambiguous: a re-assemble would NOT increment hits.)
  const hitsBefore = engine.cache.hits;

  // A write to article (a DIFFERENT type) must leave widget's cached response WARM. If the write wrongly
  // invalidated the whole engine (or all caches), the next widget GET would MISS + re-assemble — and a
  // deepEqual on the data alone could NOT tell the two apart, so we assert the cache stayed warm instead.
  const create = await fetch(`${base}/article`, j({ body: 'sib', status: 'draft', active: true, publishedAt: '2024-01-01T00:00:00.000Z' }));
  assert.equal(create.status, 201);

  // The second widget GET is therefore served from cache — a HIT (counter incremented), NOT a re-assemble.
  // This is what actually pins per-type invalidation: an article write left widget's cache entry alive.
  const w2 = await (await fetch(`${base}/widget`)).json();
  assert.equal(engine.cache.hits, hitsBefore + 1, 'sibling widget read after an article write must be a cache HIT');
  assert.deepEqual(w2.data, w1.data);
});
