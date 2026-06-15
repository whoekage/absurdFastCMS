import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createSql } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { PostgresStore } from '../src/db/postgres-store.ts';
import { seedArticleIfAbsent } from '../src/http/server.ts';
import { createContentType, getContentType, dropContentType } from '../src/db/content-type-repo.ts';
import { createServer, type ListenToken } from '../src/http/app.ts';

/**
 * WRITE-SECURITY SLICE — injection via field name, mass-assignment, jsonb byte-exact through load+
 * respond (the >2^53 guarantee the HTTP JSON.parse path cannot give), and unknown-type 404. Real
 * uWS + Postgres, no mocks. Every SQL identifier comes from the validated registry; a body key is
 * never an identifier; values are bound params.
 */

const sql = createSql();
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
      } else srv.close(() => reject(new Error('no port')));
    });
    srv.on('error', reject);
  });
}

async function tableExists(table: string): Promise<boolean> {
  const r = await sql`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${table}`;
  return r.length > 0;
}

before(async () => {
  await runMigrations();
  await seedArticleIfAbsent(sql);
  await sql`TRUNCATE ct_article RESTART IDENTITY CASCADE`;
  await sql`INSERT INTO ct_article (title, body, status, views, rating, active, "publishedAt")
            VALUES ('Seed', 'b1', 'published', 1, 1.0, true, '2021-01-01T00:00:00.000Z')`;
  if (await getContentType(sql, 'doc')) await dropContentType(sql, 'doc');
  await createContentType(sql, { apiId: 'doc', fields: [{ name: 'blob', cmsType: 'json', options: { nullable: false } }] });
  const store = new PostgresStore(sql);
  const { engine, registry } = await store.loadWithRegistry();
  const server = createServer(engine, store, registry);
  close = server.close;
  const port = await freePort();
  token = await server.listen(port);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (token) close(token);
  await sql`TRUNCATE ct_article RESTART IDENTITY CASCADE`;
  await dropContentType(sql, 'doc');
  await sql.end();
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
  assert.equal(await tableExists('ct_article'), true);
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
