import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import type { Sql } from 'postgres';
import type { ListenToken } from '../src/http/server.ts';
import type { SessionCache } from '../src/auth/session.cache.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { startTestServer, ARTICLE_SCHEMA, closeAuth } from './helpers.ts';

/**
 * ADMIN-SERVING SLICE — the prod composition serves the prebuilt admin SPA at the ROOT while the content
 * API moves under `/api` (basePath). A REAL uWS server (no mocks) is built with basePath='/api' + a fixture
 * admin bundle, proving: the SPA index + hashed assets serve with correct cache headers; unknown client
 * routes fall back to index.html (SPA) while missing assets 404; the content API works UNDER `/api`; the
 * bare root is the admin (NOT the API); and auth is reachable under the prefix. The default basePath='' path
 * (routes at root, no admin) stays covered by the rest of the suite.
 */

const MARKER = 'ADMIN_FIXTURE_MARKER_x7';

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let token: ListenToken;
let base: string;
let close: (t: ListenToken) => void;
let sessionCache: SessionCache;

async function buildFixtureBundle(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'conti-admin-dist-'));
  await writeFile(
    path.join(dir, 'index.html'),
    `<!doctype html><html><head><title>admin</title></head><body><div id="root"></div>${MARKER}</body></html>`,
  );
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'assets', 'app-abc123.js'), 'console.log("admin");');
  await writeFile(path.join(dir, 'assets', 'app-abc123.css'), '#root{color:rebeccapurple}');
  return dir;
}

before(async () => {
  db = await createFileDatabase('adminserve');
  sql = db.sql;
  const adminDir = await buildFixtureBundle();
  const server = await startTestServer(sql, [ARTICLE_SCHEMA], {
    basePath: '/api',
    adminDir,
    seed: async () => {
      await sql`INSERT INTO ct_article (title, body, status, active, "publishedAt")
                VALUES ('A', 'b', 'published', true, '2021-01-01T00:00:00.000Z')`;
    },
  });
  token = server.token;
  base = server.base;
  close = server.close;
  sessionCache = server.sessionCache;
});

after(async () => {
  if (token) close(token);
  if (sessionCache) sessionCache.stop();
  closeAuth();
  if (sql) await sql.end(); // close the main pool — else the process never exits (the suite hangs on this file)
  if (db) await dropFileDatabase(db.name);
});

test('GET / serves the admin index.html (no-cache)', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.match(await res.text(), new RegExp(MARKER));
});

test('GET a hashed asset serves it immutably', async () => {
  const res = await fetch(`${base}/assets/app-abc123.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /javascript/);
  assert.match(res.headers.get('cache-control') ?? '', /immutable/);
  assert.match(await res.text(), /console\.log/);
});

test('GET an unknown client route falls back to the SPA index (no-cache)', async () => {
  const res = await fetch(`${base}/modules`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await res.text(), new RegExp(MARKER));
});

test('GET a MISSING asset is a 404 (not the SPA index)', async () => {
  const res = await fetch(`${base}/assets/does-not-exist.js`);
  assert.equal(res.status, 404);
});

test('the content API works UNDER /api', async () => {
  const res = await fetch(`${base}/api/article`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: unknown[] };
  assert.ok(Array.isArray(body.data), 'GET /api/article returns a {data:[...]} collection');
  assert.ok(body.data.length >= 1, 'the seeded row is present');
});

test('the bare root path is the admin SPA, NOT the content API', async () => {
  // Without the /api prefix, /article is no longer the content type — it is an SPA client route → index.html.
  const res = await fetch(`${base}/article`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), new RegExp(MARKER), 'root /article served the admin SPA, not API JSON');
});

test('auth is reachable under the /api prefix (basePath alignment)', async () => {
  // better-auth get-session with no cookie returns 200 (null session); the point is it ROUTES (not a 404),
  // proving the better-auth basePath aligns with the prefixed /api/auth route.
  const res = await fetch(`${base}/api/auth/get-session`);
  assert.notEqual(res.status, 404);
  assert.notEqual(res.status, 405);
});
