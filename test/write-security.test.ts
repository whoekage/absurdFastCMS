import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { PostgresStore } from '../src/db/postgres.store.ts';
import { createContentType } from '../src/db/content-type.repository.ts';
import type { ListenToken } from '../src/http/uws.adapter.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { tableExists, startTestServer } from './helpers.ts';

/**
 * WRITE-SECURITY SLICE — injection via field name, mass-assignment, jsonb byte-exact through load+
 * respond (the >2^53 guarantee the HTTP JSON.parse path cannot give), and unknown-type 404. Real
 * uWS + Postgres, no mocks. Every SQL identifier comes from the validated registry; a body key is
 * never an identifier; values are bound params.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let token: ListenToken;
let base: string;
let close: (t: ListenToken) => void;

before(async () => {
  db = await createFileDatabase('sec');
  sql = db.sql;
  await createContentType(sql, {
    apiId: 'article',
    fields: [
      { name: 'title', cmsType: 'string', options: { length: 512, nullable: true } },
      { name: 'body', cmsType: 'text', options: { nullable: false } },
      { name: 'status', cmsType: 'string', options: { nullable: false } },
      { name: 'views', cmsType: 'integer', options: { nullable: true } },
      { name: 'rating', cmsType: 'decimal', options: { precision: 10, scale: 2, nullable: true } },
      { name: 'active', cmsType: 'boolean', options: { nullable: false } },
      { name: 'publishedAt', cmsType: 'datetime', options: { nullable: false } },
    ],
  });
  await createContentType(sql, { apiId: 'doc', fields: [{ name: 'blob', cmsType: 'json', options: { nullable: false } }] });
  await sql`INSERT INTO ct_article (title, body, status, views, rating, active, "publishedAt")
            VALUES ('Seed', 'b1', 'published', 1, 1.0, true, '2021-01-01T00:00:00.000Z')`;
  const server = await startTestServer(sql);
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

test('injection via field name -> 400 unknown field, before any SQL; ct_article survives', async () => {
  const body = {
    '"; DROP TABLE ct_article;--': 1,
    body: 'x',
    status: 'draft',
    active: true,
    publishedAt: '2022-01-01T00:00:00.000Z',
  };
  const res = await fetch(`${base}/article`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown field/);
  assert.equal(await tableExists(sql, 'ct_article'), true);
});

test('mass-assignment: id / created_at / updated_at are rejected (400)', async () => {
  const ok = { body: 'x', status: 'draft', active: true, publishedAt: '2022-01-01T00:00:00.000Z' };
  for (const key of ['id', 'created_at', 'updated_at']) {
    const res = await fetch(`${base}/article`, { method: 'POST', body: JSON.stringify({ ...ok, [key]: key === 'id' ? 99 : '2000-01-01T00:00:00.000Z' }) });
    assert.equal(res.status, 400, key);
  }
});

test('jsonb nested big int + key order survive load+respond byte-exact (the ::text path)', async () => {
  // Insert jsonb DIRECTLY (bypassing the HTTP JSON.parse edge) with a nested int > 2^53 and out-of-order keys.
  const bigInt = 9007199254740993n; // 2^53 + 1
  await sql.unsafe(`INSERT INTO ct_doc (blob) VALUES ('{"big": ${bigInt}, "z": 1, "a": 2}'::jsonb)`);
  // Reload the engine so the directly-inserted row is visible.
  const store = new PostgresStore(sql);
  const { engine } = await store.loadWithRegistry();
  const buf = engine.respondById('doc', 1)!.toString('utf8');
  // The verbatim jsonb text is spliced (jsonb canonicalizes key order); the nested integer > 2^53
  // SURVIVES exact via the `::text` path — postgres.js's JS parse would have corrupted it to a double.
  assert.ok(buf.includes(String(bigInt)), buf);
  assert.ok(buf.includes(`{"a": 2, "z": 1, "big": ${bigInt}}`), buf);
});

test('write to unknown type -> 404 (no 500 / table-name leak)', async () => {
  const res = await fetch(`${base}/nope`, { method: 'POST', body: JSON.stringify({ x: 1 }) });
  assert.equal(res.status, 404);
});
