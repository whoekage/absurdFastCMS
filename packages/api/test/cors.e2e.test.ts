import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Sql } from 'postgres';
import type { ListenToken } from '../src/http/server.ts';
import type { SessionCache } from '../src/auth/session.cache.ts';
import { buildCorsPolicy } from '../src/http/cors.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { startTestServer, ARTICLE_SCHEMA, closeAuth } from './helpers.ts';

/**
 * CORS + cross-origin CSRF over a REAL uWS server (no mocks). The server runs with a policy trusting ONE
 * admin origin; we drive it with raw http requests carrying chosen `Origin` headers (raw http, not fetch,
 * which silently drops the forbidden `Origin` header). Proves: trusted reads get an exact ACAO + credentials
 * + Vary; untrusted reads stay PUBLIC but get no grant; preflight answers the allow-set only when trusted;
 * and a cross-origin WRITE is CSRF-rejected (403) before auth unless its Origin is allowlisted (then 401 for
 * the missing session) — distinguishing the CSRF gate (403) from the auth gate (401).
 */

const ADMIN = 'https://admin.example.com';
const OWN = 'https://example.com';
const EVIL = 'https://evil.example.com';

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let token: ListenToken;
let base: string;
let close: (t: ListenToken) => void;
let sessionCache: SessionCache;

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
}
function request(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const u = new URL(`${base}${path}`);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const JSON_POST = { 'Content-Type': 'application/json' };

before(async () => {
  db = await createFileDatabase('cors');
  sql = db.sql;
  const server = await startTestServer(sql, [ARTICLE_SCHEMA], { basePath: '/api', cors: buildCorsPolicy([ADMIN], OWN) });
  token = server.token;
  base = server.base;
  close = server.close;
  sessionCache = server.sessionCache;
});

after(async () => {
  if (token) close(token);
  if (sessionCache) sessionCache.stop();
  closeAuth();
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

test('GET from a trusted origin → exact ACAO echo + credentials + Vary', async () => {
  const r = await request('GET', '/api/article', { Origin: ADMIN });
  assert.equal(r.status, 200);
  assert.equal(r.headers['access-control-allow-origin'], ADMIN);
  assert.equal(r.headers['access-control-allow-credentials'], 'true');
  assert.match(String(r.headers['vary'] ?? ''), /Origin/);
});

test('GET from an untrusted origin → still public (200), but NO grant — just Vary', async () => {
  const r = await request('GET', '/api/article', { Origin: EVIL });
  assert.equal(r.status, 200);
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  assert.match(String(r.headers['vary'] ?? ''), /Origin/);
});

test('OPTIONS preflight from a trusted origin → 204 + the allow-set', async () => {
  const r = await request('OPTIONS', '/api/article', { Origin: ADMIN, 'Access-Control-Request-Method': 'POST' });
  assert.equal(r.status, 204);
  assert.equal(r.headers['access-control-allow-origin'], ADMIN);
  assert.match(String(r.headers['access-control-allow-methods'] ?? ''), /POST/);
  assert.ok(r.headers['access-control-allow-headers']);
  assert.ok(r.headers['access-control-max-age']);
});

test('OPTIONS preflight from an untrusted origin → 204 but no grant', async () => {
  const r = await request('OPTIONS', '/api/article', { Origin: EVIL });
  assert.equal(r.status, 204);
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

test('cross-origin WRITE from an untrusted origin → 403 (CSRF), never reaches auth', async () => {
  const r = await request('POST', '/api/article', { Origin: EVIL, ...JSON_POST }, '{}');
  assert.equal(r.status, 403);
});

test('WRITE from the trusted origin passes CSRF → 401 (no session)', async () => {
  const r = await request('POST', '/api/article', { Origin: ADMIN, ...JSON_POST }, '{}');
  assert.equal(r.status, 401);
});

test('same-origin WRITE (the API own origin) passes CSRF → 401', async () => {
  const r = await request('POST', '/api/article', { Origin: OWN, ...JSON_POST }, '{}');
  assert.equal(r.status, 401);
});

test('WRITE with NO Origin (non-browser, no CSRF vector) passes CSRF → 401', async () => {
  const r = await request('POST', '/api/article', { ...JSON_POST }, '{}');
  assert.equal(r.status, 401);
});

test('the /auth bridge also emits CORS for a trusted origin (corkHook path)', async () => {
  const r = await request('GET', '/api/auth/get-session', { Origin: ADMIN });
  assert.notEqual(r.status, 404); // routes to better-auth (200 null-session)
  assert.equal(r.headers['access-control-allow-origin'], ADMIN);
  assert.equal(r.headers['access-control-allow-credentials'], 'true');
});
