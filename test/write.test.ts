import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createSql } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { PostgresStore } from '../src/db/postgres-store.ts';
import { createServer, type ListenToken } from '../src/http/app.ts';

/**
 * WRITE-PATH SLICE — POST/PUT/DELETE end-to-end over a REAL uWS server backed by a REAL Postgres
 * (.env.test), no mocks. Each write commits to Postgres (source of truth) and the server rebuilds its
 * in-memory engine, so we prove READ-AFTER-WRITE through the wire: create -> GET sees it, update ->
 * GET reflects only the changed fields, delete -> GET 404s. Plus strict-validation 400s and 404s.
 */

const sql = createSql(); // DATABASE_URL from .env.test
let token: ListenToken;
let base: string;
let close: (t: ListenToken) => void;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('no port')));
      }
    });
    srv.on('error', reject);
  });
}

async function seedRows(): Promise<void> {
  await sql`TRUNCATE articles RESTART IDENTITY`;
  await sql`INSERT INTO articles (title, body, status, views, rating, active, published_at)
            VALUES ('Seed one', 'b1', 'published', 10, 4.5, true, '2021-01-01T00:00:00.000Z')`;
  await sql`INSERT INTO articles (title, body, status, views, rating, active, published_at)
            VALUES ('Seed two', 'b2', 'draft', 20, 2.0, false, '2021-02-01T00:00:00.000Z')`;
}

before(async () => {
  await runMigrations();
  await seedRows();
  const store = new PostgresStore(sql);
  const engine = await store.load();
  const server = createServer(engine, store);
  close = server.close;
  const port = await freePort();
  token = await server.listen(port);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (token) close(token);
  await sql`TRUNCATE articles RESTART IDENTITY`;
  await sql.end();
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

  // The new row is visible on the wire, byte-shaped exactly like a read.
  const got = await fetch(`${base}/article/3`);
  assert.equal(got.status, 200);
  assert.deepEqual((await got.json()).data, created);

  // List now has 3 rows.
  const list = await (await fetch(`${base}/article?pagination[pageSize]=100`)).json();
  assert.equal(list.data.length, 3);
});

test('PUT partially updates only the provided fields; GET reflects it', async () => {
  // Update only views + status of seed row 1; title/body/etc must stay.
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
  // count dropped by one (we created 3, deleted 1 -> 2 live ids: 1 and 3).
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
