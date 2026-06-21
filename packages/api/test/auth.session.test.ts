import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import type { Sql } from 'postgres';

import { runMigrations } from '../src/db/migration.runner.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { setAuthSql, closeAuth } from '../src/auth/auth.dialect.ts';
import { buildAuth } from '../src/auth/auth.ts';
import { SessionCache, readSessionToken } from '../src/auth/session.cache.ts';

/**
 * be-09a — the SESSION provider + RAM cache over a REAL uWS-less better-auth instance + REAL Postgres
 * (per-file clone). NO MOCKS: a real sign-up writes a real `session` row; the cache validates it; a
 * SECOND validate is served from RAM with ZERO Postgres queries — asserted by a postgres.js `debug`
 * query counter on the SHARED auth handle (not a spy/mock). Sign-out deletes the row → the delete hook
 * evicts → the next validate misses and is unauthenticated.
 */

let db: Awaited<ReturnType<typeof createFileDatabase>>;
let sql: Sql; // the COUNTED handle better-auth + the cache both use (injected via setAuthSql).
let queryCount = 0;
let auth: ReturnType<typeof buildAuth>;
let cache: SessionCache;

before(async () => {
  db = await createFileDatabase('authsession');
  await runMigrations(db.url);
  // A dedicated postgres.js handle with a `debug` hook that increments on EVERY query — this is the
  // zero-PG proof instrument (real driver telemetry, not a mock). better-auth wraps this exact handle via
  // the injected dialect, and the cache's miss-path getSession runs through it too.
  sql = postgres(db.url, { max: 4, prepare: true, debug: () => { queryCount++; } });
  setAuthSql(sql);
  // Build the cache first (thunk to auth), then the auth instance wired to evict it (mirrors server.ts).
  cache = new SessionCache(() => auth);
  auth = buildAuth({ sessionEvictor: cache, baseURL: 'http://localhost' });
});

after(async () => {
  cache.stop(); // clear the background expiry-sweep timer so the test process tears down clean
  await closeAuth(); // no-op end: the handle is test-injected, the test owns it.
  await sql.end();
  await db.sql.end();
  await dropFileDatabase(db.name);
});

beforeEach(() => {
  queryCount = 0;
});

/** Sign up a user through the real handler and return the Set-Cookie header the response issued. */
async function signUp(email: string): Promise<string> {
  const res = await auth.handler(
    new Request('http://localhost/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct-horse-battery-staple', name: 'Test User' }),
    }),
  );
  assert.equal(res.status, 200, `sign-up failed: ${res.status} ${await res.clone().text()}`);
  const setCookie = res.headers.getSetCookie?.() ?? [];
  assert.ok(setCookie.length > 0, 'sign-up must issue a Set-Cookie (session)');
  return setCookie.join('; ');
}

/** Turn a Set-Cookie list into a request Cookie header (name=value pairs only). */
function cookieHeader(setCookie: string): string {
  return setCookie
    .split('; ')
    .map((c) => c.split(';')[0])
    .filter((c): c is string => c !== undefined && c.includes('='))
    .join('; ');
}

test('sign-up issues a session cookie carrying a parseable session token', async () => {
  const setCookie = await signUp('cookie@example.com');
  const headers = new Headers({ cookie: cookieHeader(setCookie) });
  const token = readSessionToken(headers);
  assert.ok(token !== null && token.length > 0, 'a session_token cookie must be present + parseable');
});

test('warm session validation is served from RAM with ZERO Postgres queries', async () => {
  const setCookie = await signUp('warm@example.com');
  const headers = new Headers({ cookie: cookieHeader(setCookie) });

  // First validate: a cache MISS → exactly one getSession PG read populates the entry.
  queryCount = 0;
  const first = await cache.validate(headers);
  assert.ok(first !== null, 'first validate must resolve the principal');
  assert.ok(queryCount > 0, 'the first (miss) validate MUST hit Postgres');
  assert.match(first.userId, /.+/);

  // Second validate of the SAME token: a warm hit → ZERO Postgres.
  queryCount = 0;
  const second = await cache.validate(headers);
  assert.ok(second !== null, 'second validate must resolve the principal');
  assert.equal(second.userId, first.userId);
  assert.equal(second.sessionToken, first.sessionToken);
  assert.equal(queryCount, 0, 'a WARM session validation MUST fire ZERO Postgres queries');
});

test('sign-out deletes the session, the delete hook evicts, and the next validate is unauthenticated', async () => {
  const setCookie = await signUp('logout@example.com');
  const cookie = cookieHeader(setCookie);
  const headers = new Headers({ cookie });

  // Warm the cache.
  const before = await cache.validate(headers);
  assert.ok(before !== null);
  assert.equal(cache.size() >= 1, true);

  // Real sign-out: deletes the session row → session.delete.after hook → cache.evict(token). The Origin
  // header matches the baseURL so better-auth's CSRF origin check on this state-changing route passes.
  const out = await auth.handler(
    new Request('http://localhost/auth/sign-out', {
      method: 'POST',
      headers: { cookie, origin: 'http://localhost' },
    }),
  );
  assert.equal(out.status, 200, `sign-out failed: ${out.status}`);

  // The token is evicted from RAM; revalidating now MISSES the cache and re-reads PG, which finds no
  // (live) session → unauthenticated.
  const after = await cache.validate(headers);
  assert.equal(after, null, 'after sign-out the session must no longer authenticate');
});
