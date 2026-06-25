import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';

import { runMigrations } from '../src/db/migration.runner.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { PostgresStore } from '../src/db/postgres.store.ts';
import { createServer } from '../src/http/uws.adapter.ts';
import { freePort } from './helpers.ts';
import { setAuthSql, closeAuth } from '../src/auth/auth.dialect.ts';
import { buildAuth } from '../src/auth/auth.ts';

/**
 * be-09a — the uWS ↔ Fetch BRIDGE E2E over a REAL uWS server + REAL better-auth + REAL Postgres (per-file
 * clone). NO MOCKS. Proves the bridge end-to-end: sign-up + sign-in through /auth/* return a session
 * cookie that is CORRECTLY SPLIT (one Set-Cookie header per cookie, never a comma-folded blob), the
 * inbound Cookie header is forwarded (an authenticated /auth/get-session round-trips the user), and a
 * non-/auth route is byte-untouched (the existing read path stays open — scope fence).
 */

let db: Awaited<ReturnType<typeof createFileDatabase>>;
let sql: Sql;
let store: PostgresStore;
let base: string;
let token: unknown;
let close: (t: unknown) => void;

before(async () => {
  db = await createFileDatabase('authbridge');
  sql = db.sql;
  await runMigrations(db.url);
  setAuthSql(sql);
  // baseURL == the actual serving origin so better-auth's same-origin CSRF check trusts requests whose
  // Origin matches (a browser sends Origin; the tests below set it explicitly).
  const port0 = await freePort();
  base = `http://127.0.0.1:${port0}`;
  const auth = buildAuth({ baseURL: base });

  store = new PostgresStore(sql);
  const { engine, registry } = await store.loadFromSchemas([]); // files-first empty catalog (no content types here)
  const server = createServer(engine, store, registry, undefined, auth);
  token = await server.listen(port0);
  close = server.close;
});

after(async () => {
  if (token !== undefined) close(token);
  await closeAuth(); // injected handle => no-op end.
  await store.close(); // no-op end (sql injected, store does not own it).
  await db.sql.end();
  await dropFileDatabase(db.name);
});

test('sign-up through the /auth bridge returns a correctly-split Set-Cookie session cookie', async () => {
  const res = await fetch(`${base}/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: 'bridge@example.com', password: 'correct-horse-battery-staple', name: 'Bridge' }),
  });
  assert.equal(res.status, 200, `sign-up failed: ${res.status} ${await res.clone().text()}`);

  // The fetch Headers exposes the split list via getSetCookie(); each entry is ONE cookie, so none of
  // them is a comma-folded blob carrying a second cookie's `name=`.
  const cookies = res.headers.getSetCookie();
  assert.ok(cookies.length >= 1, 'a session cookie must be set');
  const sessionCookie = cookies.find((c) => /session_token=/.test(c));
  assert.ok(sessionCookie !== undefined, 'a session_token cookie must be present');
  // Fold-corruption guard: a properly-split cookie never contains a second `; <name>=` outside attributes.
  // (A comma-folded "a=1, b=2" blob would instead appear as ONE entry with an embedded ", ".)
  assert.ok(!sessionCookie.includes(', '), 'the Set-Cookie must NOT be a comma-folded multi-cookie blob');
});

test('sign-in + get-session round-trips the user through the bridge (Cookie forwarded inbound)', async () => {
  // Sign in (the user exists from the previous test? per-file DB is shared across tests in THIS file).
  const signIn = await fetch(`${base}/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: 'bridge@example.com', password: 'correct-horse-battery-staple' }),
  });
  assert.equal(signIn.status, 200, `sign-in failed: ${signIn.status} ${await signIn.clone().text()}`);
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter((c): c is string => c !== undefined)
    .join('; ');
  assert.ok(/session_token=/.test(cookie), 'sign-in must set a session cookie');

  // get-session with the Cookie forwarded inbound → the bridge passes it through to better-auth.
  const session = await fetch(`${base}/auth/get-session`, { headers: { cookie } });
  assert.equal(session.status, 200);
  const body = (await session.json()) as { user?: { email?: string } } | null;
  assert.equal(body?.user?.email, 'bridge@example.com', 'the forwarded cookie must authenticate the user');
});

test('a non-/auth route is unaffected by the auth mount (existing read path stays open)', async () => {
  // /article is the seeded-or-empty read route; with no article type it 404s, but it must NOT be
  // swallowed by /auth/* — the literal `auth` segment never shadows a `:type`. Either a 200 list or a
  // 404 is acceptable; what matters is it is NOT an auth-handler response.
  const res = await fetch(`${base}/modules`);
  assert.ok(res.status === 200 || res.status === 404, `unexpected status ${res.status}`);
  // An auth response would carry better-auth's JSON error shape; a builder response is the content-type list.
  const text = await res.text();
  assert.ok(!/Better Auth|invalid_/i.test(text), 'a non-/auth route must not be handled by the auth provider');
});
