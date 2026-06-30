import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { schema, ARTICLE_SCHEMA, startTestServer, closeAuth, type TestServer } from './helpers.ts';

/**
 * SINGLE TYPE — a per-type opt-in that holds exactly ONE entry, end-to-end over a REAL uWS server + REAL
 * Postgres (.env.test), no mocks. Proves: a single type accepts the first create (201) and rejects a second
 * (409), while reads still work; and that a NON-single (collection) type is unaffected (many creates ok).
 * `single` is column-free metadata, so the type is otherwise byte-identical to a collection.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let srv: TestServer;

before(async () => {
  db = await createFileDatabase('single');
  sql = db.sql;
  // A SINGLE `homepage` (one entry) + the seed collection `article` (many entries) to prove non-interference.
  const homepage = schema({
    name: 'homepage',
    fields: [{ name: 'hero_title', type: 'string', options: { nullable: false } }],
    single: true,
  });
  srv = await startTestServer(sql, [ARTICLE_SCHEMA, homepage]);
});

after(async () => {
  if (srv) {
    srv.close(srv.token);
    srv.sessionCache.stop();
    await closeAuth();
  }
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

test('single type: first create 201, second create 409, the one entry reads back', async () => {
  const first = await srv.fetch('/homepage', { method: 'POST', body: JSON.stringify({ hero_title: 'Welcome' }) });
  assert.equal(first.status, 201);

  const second = await srv.fetch('/homepage', { method: 'POST', body: JSON.stringify({ hero_title: 'Second' }) });
  assert.equal(second.status, 409);

  // The single entry is still readable (the list holds exactly one row).
  const list = await (await srv.anonFetch('/homepage')).json();
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].hero_title, 'Welcome');
});

test('collection type is unaffected: many creates allowed', async () => {
  const entry = (title: string) => ({
    title,
    body: 'b',
    status: 'draft',
    active: true,
    publishedAt: '2026-01-01T00:00:00.000Z',
  });
  const a = await srv.fetch('/article', { method: 'POST', body: JSON.stringify(entry('One')) });
  assert.equal(a.status, 201);
  const b = await srv.fetch('/article', { method: 'POST', body: JSON.stringify(entry('Two')) });
  assert.equal(b.status, 201);
});
