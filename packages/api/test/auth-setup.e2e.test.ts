import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import type { ListenToken } from '../src/http/server.ts';
import type { SessionCache } from '../src/auth/session.cache.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { startTestServer, ARTICLE_SCHEMA, closeAuth } from './helpers.ts';

/**
 * FIRST-ADMIN BOOTSTRAP signal over a REAL server (no mocks). `/_setup` reports whether the instance still
 * needs its first admin; the FIRST sign-up becomes the super-admin (advisory-lock serialized) which flips
 * the signal. Registration STAYS OPEN by design — a second sign-up succeeds but is AUTHORITY-FREE (RBAC, not
 * the sign-up endpoint, is conti's access gate; new accounts have zero CMS power). The admin UI simply shows
 * the create-first-admin form only while `needsFirstAdmin`, the sign-in form thereafter.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let token: ListenToken;
let base: string;
let close: (t: ListenToken) => void;
let sessionCache: SessionCache;

before(async () => {
  db = await createFileDatabase('authsetup');
  sql = db.sql;
  const server = await startTestServer(sql, [ARTICLE_SCHEMA]);
  token = server.token;
  base = server.base;
  close = server.close;
  sessionCache = server.sessionCache;
  // This test asserts the FRESH-INSTANCE behavior; startTestServer (and a reused golden template) may seed
  // auth rows, so reset to a genuine zero-user state here (a real `conti migrate` seeds no users either).
  await sql`TRUNCATE "user", "session", "account", "user_roles", "team" RESTART IDENTITY CASCADE`;
});

after(async () => {
  if (token) close(token);
  if (sessionCache) sessionCache.stop();
  closeAuth();
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

const signUp = (email: string): Promise<Response> =>
  fetch(`${base}/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email, password: 'correct-horse-battery-staple', name: 'U' }),
  });
const needsFirstAdmin = async (): Promise<boolean> =>
  ((await (await fetch(`${base}/_setup`)).json()) as { needsFirstAdmin: boolean }).needsFirstAdmin;

test('GET /_setup reports needsFirstAdmin=true on a fresh instance', async () => {
  assert.equal(await needsFirstAdmin(), true);
});

test('the FIRST sign-up succeeds (becomes the admin) and closes setup', async () => {
  const r = await signUp('admin@example.com');
  assert.equal(r.status, 200);
  assert.equal(await needsFirstAdmin(), false, 'setup closes once a super-admin exists');
});

test('a SECOND sign-up still succeeds (open registration; the account is authority-free)', async () => {
  const r = await signUp('member@example.com');
  assert.equal(r.status, 200); // registration stays open by design — RBAC gates power, not the endpoint
  assert.equal(await needsFirstAdmin(), false); // but the instance is past first-admin bootstrap
});
