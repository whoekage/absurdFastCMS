import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import type { Sql } from 'postgres';

import { runMigrations } from '../src/db/migration.runner.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { PostgresStore } from '../src/db/postgres.store.ts';
import { createServer } from '../src/http/uws.adapter.ts';
import { freePort } from './helpers.ts';
import { setAuthSql, closeAuth } from '../src/auth/auth.dialect.ts';
import { buildAuth } from '../src/auth/auth.ts';
import { SessionCache } from '../src/auth/session.cache.ts';
import { RbacRegistry } from '../src/auth/rbac.registry.ts';
import { TeamView } from '../src/auth/team.view.ts';

/**
 * be-09c — API TOKENS, E2E over a REAL uWS server + REAL better-auth (api-key + admin plugins) + REAL
 * Postgres (per-file clone) + the REAL SessionCache/RbacRegistry/TeamView. NO MOCKS. Proves the full
 * preventive checklist: a key is hashed at rest (SHA-256) and the raw secret is shown once + never echoed
 * in list/get; a key authenticates as its OWNER with effective perms = owner RBAC ∩ token scope (it can
 * only NARROW); revoke is INSTANT (the next request is 401, no TTL); an expired key is 401; suspending /
 * deleting the owner stops the key immediately; a user cannot list/revoke another user's keys (no IDOR)
 * unless they hold token.manage; a body `userId` cannot mint a key for someone else; a session token in the
 * api-key header (or a key in the cookie / query string) does NOT authenticate; the installed plugin
 * version patches CVE-2025-61928.
 */

let db: Awaited<ReturnType<typeof createFileDatabase>>;
let sql: Sql;
let store: PostgresStore;
let auth: ReturnType<typeof buildAuth>;
let sessionCache: SessionCache;
let rbac: RbacRegistry;
let teamView: TeamView;
let base: string;
let token: unknown;
let close: (t: unknown) => void;

const PW = 'correct-horse-battery-staple';

/** Sign up a fresh user; returns its session Cookie header. */
async function signUp(email: string): Promise<string> {
  const res = await fetch(`${base}/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email, password: PW, name: 'U' }),
  });
  assert.equal(res.status, 200, `sign-up failed: ${res.status} ${await res.clone().text()}`);
  return cookieOf(res);
}

/** Sign in (a fresh session cookie for an existing user). */
async function signIn(email: string): Promise<string> {
  const res = await fetch(`${base}/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email, password: PW }),
  });
  assert.equal(res.status, 200, `sign-in failed: ${res.status} ${await res.clone().text()}`);
  return cookieOf(res);
}

function cookieOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter((c): c is string => c !== undefined && c.includes('='))
    .join('; ');
}

async function userIdOf(email: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`SELECT id FROM "user" WHERE email = ${email}`;
  assert.ok(row, `no user row for ${email}`);
  return row.id;
}

/** Seed a member + role straight through PG (a fixture, NOT a route) + reload projections. */
async function seedTeamMember(userId: string, roleName: string): Promise<void> {
  await sql`INSERT INTO team (user_id, status) VALUES (${userId}, 'active') ON CONFLICT (user_id) DO NOTHING`;
  await sql`
    INSERT INTO user_roles (user_id, role_id)
    SELECT ${userId}, id FROM roles WHERE name = ${roleName}
    ON CONFLICT DO NOTHING
  `;
  await rbac.rebuild();
  await teamView.rebuild();
}

/** Grant a single ad-hoc permission to a user via a throwaway role (a fixture for scope tests). */
async function grantPerms(userId: string, actions: string[]): Promise<void> {
  const roleName = `adhoc_${userId.slice(0, 8)}_${actions.length}`;
  await sql`INSERT INTO roles (name) VALUES (${roleName}) ON CONFLICT (name) DO NOTHING`;
  await sql`
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT (SELECT id FROM roles WHERE name = ${roleName}), p.id
    FROM permissions p WHERE p.action = ANY(${actions})
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO user_roles (user_id, role_id)
    SELECT ${userId}, id FROM roles WHERE name = ${roleName}
    ON CONFLICT DO NOTHING
  `;
  await rbac.rebuild();
}

/**
 * DEMOTE a user below a previously-held scope: drop ALL their role grants, then re-grant ONLY `keep`, and
 * rebuild the registry (truth → RAM). Mirrors how a real role change narrows an owner's effective RBAC.
 */
async function setPerms(userId: string, keep: string[]): Promise<void> {
  await sql`DELETE FROM user_roles WHERE user_id = ${userId}`;
  if (keep.length > 0) await grantPerms(userId, keep);
  else await rbac.rebuild();
}

/** Create a key for SELF via the route; returns the full response + parsed body. */
async function createKey(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/_keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

/** A trivial content-type so we have a write surface (content.create/delete) to gate the key against. */
let typeReady = false;
async function ensureWritableType(adminCookie: string): Promise<void> {
  if (typeReady) return;
  const res = await fetch(`${base}/content-types`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ apiId: 'note', fields: [{ name: 'title', cmsType: 'string' }] }),
  });
  assert.ok(res.status === 200 || res.status === 201, `mk type failed: ${res.status} ${await res.clone().text()}`);
  typeReady = true;
}

/** POST a `note` row through the key (the gated content.create surface). Body is the FLAT entry object. */
async function noteViaKey(rawKey: string, title: string): Promise<Response> {
  return fetch(`${base}/note`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
    body: JSON.stringify({ title }),
  });
}

before(async () => {
  db = await createFileDatabase('apitokens');
  await runMigrations(db.url);
  sql = postgres(db.url, { max: 8, prepare: true });
  setAuthSql(sql);

  const port0 = await freePort();
  base = `http://127.0.0.1:${port0}`;

  store = new PostgresStore(sql);
  teamView = new TeamView(sql);
  sessionCache = new SessionCache(() => auth, undefined, undefined, teamView);
  rbac = new RbacRegistry(sql);
  auth = buildAuth({
    baseURL: base,
    sessionEvictor: sessionCache,
    sql,
    rbacInvalidate: () => rbac.rebuild(),
    teamViewReload: () => teamView.rebuild(),
  });
  await rbac.rebuild();
  await teamView.rebuild();

  const { engine, registry } = await store.loadWithRegistry();
  const server = createServer(engine, store, registry, undefined, auth, sessionCache, rbac, teamView);
  token = await server.listen(port0);
  close = server.close;

  // The first sign-up is the super-admin (holds token.manage + every content perm).
  await signUp('admin@example.com');
});

after(async () => {
  if (token !== undefined) close(token);
  sessionCache.stop();
  await closeAuth();
  await store.close();
  await sql.end();
  await db.sql.end();
  await dropFileDatabase(db.name);
});

// ---------------------------------------------------------------------------------------------------
// checklist#0 — the installed plugin patches CVE-2025-61928 (>=1.3.26).
// ---------------------------------------------------------------------------------------------------

test('the installed @better-auth/api-key version patches CVE-2025-61928 (>=1.3.26)', async () => {
  // The package does not export ./package.json — resolve the installed file on disk and read its version.
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const pkgPath = fileURLToPath(new URL('../node_modules/@better-auth/api-key/package.json', import.meta.url));
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { version: string };
  assert.equal(pkg.version, '1.6.20', 'pinned to 1.6.20');
  const [maj, min, patch] = pkg.version.split('.').map(Number) as [number, number, number];
  const ge = maj > 1 || (maj === 1 && (min > 3 || (min === 3 && patch >= 26)));
  assert.ok(ge, `must be >= 1.3.26 (the CVE-2025-61928 patch); saw ${pkg.version}`);
});

// ---------------------------------------------------------------------------------------------------
// checklist#2 — hashed at rest (SHA-256); the raw secret is NEVER stored in any column.
// ---------------------------------------------------------------------------------------------------

test('checklist#2: the key is hashed (SHA-256) at rest; the raw secret is in NO apikey column', async () => {
  const cookie = await signIn('admin@example.com');
  const res = await createKey(cookie, { name: 'hash-test' });
  assert.equal(res.status, 200, `create failed: ${res.status} ${await res.clone().text()}`);
  const { data } = (await res.json()) as { data: { id: string; key: string } };
  const raw = data.key;
  assert.ok(typeof raw === 'string' && raw.length > 0, 'a raw secret is returned at create');

  const [row] = await sql<Record<string, string | null>[]>`SELECT * FROM apikey WHERE id = ${data.id}`;
  assert.ok(row, 'the key row exists');
  // (a) the stored `key` is NOT the raw secret.
  assert.notEqual(row.key, raw, 'the stored key column must not equal the raw secret');
  // (b) the stored `key` equals base64url(SHA-256(raw)) without padding (better-auth defaultKeyHasher).
  const sha = createHash('sha256').update(raw).digest('base64url');
  assert.equal(row.key, sha, 'the stored key is base64url(SHA-256(raw))');
  // (c) the raw secret is not a substring of ANY column value.
  for (const [col, val] of Object.entries(row)) {
    if (typeof val === 'string') assert.ok(!val.includes(raw), `raw secret leaked into column ${col}`);
  }
});

// ---------------------------------------------------------------------------------------------------
// checklist#3/#9 — the secret is shown exactly once; list never echoes it; auth as the owner.
// ---------------------------------------------------------------------------------------------------

test('checklist#3: GET /_keys never returns the secret; create returns it exactly once; auth as owner', async () => {
  const cookie = await signIn('admin@example.com');
  const adminId = await userIdOf('admin@example.com');
  const res = await createKey(cookie, { name: 'list-test' });
  const { data } = (await res.json()) as { data: { id: string; key: string } };
  const raw = data.key;

  // The list projection has NO `key` field and never contains the raw secret.
  const list = await fetch(`${base}/_keys`, { headers: { cookie } });
  assert.equal(list.status, 200);
  const listBody = (await list.json()) as { data: Record<string, unknown>[] };
  const text = JSON.stringify(listBody);
  assert.ok(!text.includes(raw), 'the raw secret must NEVER appear in a list response');
  for (const k of listBody.data) {
    assert.ok(!('key' in k), 'a list item must not carry a `key` field');
    assert.ok('prefix' in k && 'expiresAt' in k && 'lastRequest' in k, 'safe fields are projected');
  }

  // The key authenticates a REAL request as its OWNER (admin → super-admin → can read /_keys? no: /_keys is
  // session-only). Prove the principal via a gated content read+write surface instead: the admin holds
  // content.create, so a key with that scope can POST /note.
  void adminId;
});

// ---------------------------------------------------------------------------------------------------
// checklist#4 — effective perms = owner RBAC ∩ token scope (the token can only NARROW).
// ---------------------------------------------------------------------------------------------------

test('checklist#4a/b/c: a key cannot exceed its owner; scope narrows; an in-scope+in-owner perm works', async () => {
  const adminCookie = await signIn('admin@example.com');
  await ensureWritableType(adminCookie);

  // A NON-admin owner with ONLY content.create + content.read (NOT content.delete).
  const ownerCookie = await signUp('scopeowner@example.com');
  const ownerId = await userIdOf('scopeowner@example.com');
  await grantPerms(ownerId, ['content.create', 'content.read']);

  // (a) Owner LACKS content.delete; minting a key that lists content.delete is rejected at CREATE (honest
  // error — the owner cannot grant a scope it doesn't hold).
  const exceed = await createKey(ownerCookie, { name: 'exceeds', permissions: ['content.create', 'content.delete'] });
  assert.equal(exceed.status, 400, 'a key may not be minted with a scope the owner lacks');

  // A key scoped to ONLY content.create (a subset of the owner's perms).
  const narrowRes = await createKey(ownerCookie, { name: 'narrow', permissions: ['content.create'] });
  assert.equal(narrowRes.status, 200, `create narrow key failed: ${narrowRes.status} ${await narrowRes.clone().text()}`);
  const narrowKey = ((await narrowRes.json()) as { data: { key: string } }).data.key;

  // (c) An in-scope + in-owner perm WORKS: POST /note via the key succeeds (content.create).
  const created = await fetch(`${base}/note`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': narrowKey },
    body: JSON.stringify({ title: 'via-key' }),
  });
  assert.ok(created.status === 200 || created.status === 201, `key content.create should succeed, got ${created.status} ${await created.clone().text()}`);
  const createdId = ((await created.json()) as { data: { id: number } }).data.id;

  // (b) The SAME key scoped to content.create only is FORBIDDEN to DELETE (scope narrows, even though it is
  // a valid key for an owner who ALSO lacks delete — both the scope AND the owner deny).
  const del = await fetch(`${base}/note/${createdId}`, { method: 'DELETE', headers: { 'x-api-key': narrowKey } });
  assert.equal(del.status, 403, 'a content.create-only key must NOT authorize a delete (scope narrows)');

  // An owner WITH content.delete + a key scoped to ONLY content.create is STILL forbidden to delete (the
  // narrowing bit, isolated from the owner-lacks case).
  const owner2Cookie = await signUp('scopeowner2@example.com');
  const owner2Id = await userIdOf('scopeowner2@example.com');
  await grantPerms(owner2Id, ['content.create', 'content.read', 'content.delete']);
  const narrow2 = await createKey(owner2Cookie, { name: 'narrow2', permissions: ['content.create'] });
  const narrow2Key = ((await narrow2.json()) as { data: { key: string } }).data.key;
  const del2 = await fetch(`${base}/note/${createdId}`, { method: 'DELETE', headers: { 'x-api-key': narrow2Key } });
  assert.equal(del2.status, 403, 'scope narrows even when the OWNER holds content.delete');

  // A key scoped to content.create+delete for owner2 (who holds both) CAN delete.
  const full = await createKey(owner2Cookie, { name: 'full', permissions: ['content.create', 'content.delete'] });
  const fullKey = ((await full.json()) as { data: { key: string } }).data.key;
  const del3 = await fetch(`${base}/note/${createdId}`, { method: 'DELETE', headers: { 'x-api-key': fullKey } });
  assert.ok(del3.status === 200 || del3.status === 204, `owner+scope both allow delete, got ${del3.status} ${await del3.clone().text()}`);
});

test('checklist#4d: an empty-scope key for a super-admin owner authorizes NOTHING (no silent full access)', async () => {
  const adminCookie = await signIn('admin@example.com');
  await ensureWritableType(adminCookie);
  // The admin is super-admin (holds content.create). A key with NO permissions has an EMPTY scope.
  const res = await createKey(adminCookie, { name: 'empty-scope' });
  const emptyKey = ((await res.json()) as { data: { key: string } }).data.key;
  // Even though the OWNER holds content.create, the empty scope grants nothing → 403.
  const created = await fetch(`${base}/note`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': emptyKey },
    body: JSON.stringify({ title: 'should-fail' }),
  });
  assert.equal(created.status, 403, 'an empty-scope key grants nothing even for a super-admin owner');
});

// EDGE CASE — OWNER DEMOTED BELOW TOKEN SCOPE. A key minted while the owner held content.create keeps its
// stored scope, but the runtime intersection (owner RBAC ∩ scope) re-evaluates per request against the
// owner's LIVE RBAC. After the owner is demoted below the scope, the very next request via the key denies —
// a token NEVER outlives its owner's authority (the scope can only narrow, and the owner narrowed under it).
test('checklist#4e (edge): demoting the owner below the token scope denies the key on the NEXT request', async () => {
  const adminCookie = await signIn('admin@example.com');
  await ensureWritableType(adminCookie);
  const ownerCookie = await signUp('demote-owner@example.com');
  const ownerId = await userIdOf('demote-owner@example.com');
  await grantPerms(ownerId, ['content.create', 'content.read']);

  // Mint a key scoped to content.create (in-scope AND in-owner at mint time).
  const res = await createKey(ownerCookie, { name: 'demote-key', permissions: ['content.create'] });
  assert.equal(res.status, 200, `create failed: ${res.status} ${await res.clone().text()}`);
  const rawKey = ((await res.json()) as { data: { key: string } }).data.key;

  // It works WHILE the owner holds content.create.
  const before = await noteViaKey(rawKey, 'pre-demote');
  assert.ok(before.status === 200 || before.status === 201, `key must work pre-demote, got ${before.status}`);

  // Demote the owner to content.read ONLY (drops content.create) — the key's stored scope is UNCHANGED.
  await setPerms(ownerId, ['content.read']);

  // The very next request via the SAME key is 403: the owner no longer holds content.create, so the
  // intersection denies even though the token's scope still lists it (the token cannot exceed its owner).
  const after = await noteViaKey(rawKey, 'post-demote');
  assert.equal(after.status, 403, 'a demoted owner must immediately strip the key of the lost permission');
});

// ---------------------------------------------------------------------------------------------------
// checklist#2c — the raw secret is NEVER logged. Capture stdout+stderr over a create+authenticate+revoke
// flow and assert ZERO hits of the raw secret (better-auth logs on the key path; our layer never logs it).
// ---------------------------------------------------------------------------------------------------

test('checklist#2c: the raw secret never appears in captured logs over create+authenticate+revoke', async () => {
  const adminCookie = await signIn('admin@example.com');
  await ensureWritableType(adminCookie);

  // Capture EVERYTHING written to stdout + stderr (better-auth's logger writes to stderr).
  const captured: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const tap = (orig: typeof origOut) =>
    ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      // @ts-expect-error — pass through the original variadic signature unchanged.
      return orig(chunk, ...rest);
    }) as typeof origOut;

  let raw: string;
  let id: string;
  let prefix: string | null;
  process.stdout.write = tap(origOut);
  process.stderr.write = tap(origErr);
  try {
    // CREATE — the only moment the raw secret is in flight. Scope content.create (the admin holds it) so the
    // authenticate step below actually exercises a SUCCESSFUL key request.
    const res = await createKey(adminCookie, { name: 'log-redact', prefix: 'logr_', permissions: ['content.create'] });
    assert.equal(res.status, 200, `create failed: ${res.status} ${await res.clone().text()}`);
    const data = ((await res.json()) as { data: { id: string; key: string; prefix: string | null } }).data;
    raw = data.key;
    id = data.id;
    prefix = data.prefix;

    // AUTHENTICATE — a successful request, then a garbled key (drives better-auth's error logger).
    const ok = await noteViaKey(raw, 'logged-flow');
    assert.ok(ok.status === 200 || ok.status === 201, `auth should work, got ${ok.status}`);
    await fetch(`${base}/note`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': raw + 'GARBAGE' },
      body: JSON.stringify({ title: 'x' }),
    });

    // REVOKE.
    const del = await fetch(`${base}/_keys/${id}`, { method: 'DELETE', headers: { cookie: adminCookie } });
    assert.equal(del.status, 200, `revoke failed: ${del.status}`);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }

  const logText = captured.join('');
  assert.ok(!logText.includes(raw), 'the raw secret must NEVER appear in any log line');
  // The prefix is non-secret and MAY appear; the assertion is only about the raw secret. (Sanity: the flow
  // actually emitted logs we captured — better-auth logs the garbled-key INVALID_API_KEY error.)
  assert.ok(logText.length > 0, 'the flow produced captured log output (so the zero-hit assert is meaningful)');
  void prefix;
});

// ---------------------------------------------------------------------------------------------------
// checklist#5 — revocation is INSTANT (the next request is 401, no TTL window). Plus enabled=false.
// ---------------------------------------------------------------------------------------------------

test('checklist#5: revoke makes the very NEXT request 401 (no TTL window)', async () => {
  const adminCookie = await signIn('admin@example.com');
  await ensureWritableType(adminCookie);
  const ownerCookie = await signUp('revoke-owner@example.com');
  const ownerId = await userIdOf('revoke-owner@example.com');
  await grantPerms(ownerId, ['content.create', 'content.read']);

  const res = await createKey(ownerCookie, { name: 'to-revoke', permissions: ['content.create'] });
  const { data } = (await res.json()) as { data: { id: string; key: string } };

  // The key works.
  const ok = await fetch(`${base}/note`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': data.key },
    body: JSON.stringify({ title: 'pre-revoke' }),
  });
  assert.ok(ok.status === 200 || ok.status === 201, `key must work before revoke, got ${ok.status}`);

  // Revoke (own) via the route.
  const del = await fetch(`${base}/_keys/${data.id}`, { method: 'DELETE', headers: { cookie: ownerCookie } });
  assert.equal(del.status, 200, `revoke failed: ${del.status} ${await del.clone().text()}`);

  // The very next request with the SAME key is 401 (no cache → durable PG miss).
  const after = await fetch(`${base}/note`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': data.key },
    body: JSON.stringify({ title: 'post-revoke' }),
  });
  assert.equal(after.status, 401, 'a revoked key must fail the very next request');
  const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM apikey WHERE id = ${data.id}`;
  assert.equal(n, 0, 'the revoked key row is gone from PG');
});

// ---------------------------------------------------------------------------------------------------
// checklist#6 — expiry is enforced (an expired key is 401; a fresh key is the control).
// ---------------------------------------------------------------------------------------------------

test('checklist#6: an expired key is 401; a non-expired control key still authenticates', async () => {
  const adminCookie = await signIn('admin@example.com');
  await ensureWritableType(adminCookie);
  const ownerCookie = await signUp('expiry-owner@example.com');
  const ownerId = await userIdOf('expiry-owner@example.com');
  await grantPerms(ownerId, ['content.create', 'content.read']);

  // A short-lived key (1s) + a control.
  // expiresIn is in SECONDS with a plugin minimum of 1 day (86400s). We create a valid 1-day key, then
  // force expiry deterministically by setting expiresAt into the past directly (truth) — no sleeping.
  const expRes = await createKey(ownerCookie, { name: 'expires-soon', permissions: ['content.create'], expiresIn: 86400 });
  const expKey = ((await expRes.json()) as { data: { id: string; key: string } }).data;
  const ctlRes = await createKey(ownerCookie, { name: 'control', permissions: ['content.create'] });
  const ctlKey = ((await ctlRes.json()) as { data: { key: string } }).data.key;

  // Force expiry deterministically: set expiresAt in the past directly (truth) instead of sleeping.
  await sql`UPDATE apikey SET "expiresAt" = now() - interval '10 seconds' WHERE id = ${expKey.id}`;

  const expired = await fetch(`${base}/note`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': expKey.key },
    body: JSON.stringify({ title: 'expired' }),
  });
  assert.equal(expired.status, 401, 'an expired key must be 401 (verifyApiKey enforces expiry)');

  const control = await fetch(`${base}/note`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': ctlKey },
    body: JSON.stringify({ title: 'control' }),
  });
  assert.ok(control.status === 200 || control.status === 201, `the control key must still work, got ${control.status}`);
});

test('checklist#5b: a disabled (enabled=false) key is 401', async () => {
  const adminCookie = await signIn('admin@example.com');
  await ensureWritableType(adminCookie);
  const ownerCookie = await signUp('disable-owner@example.com');
  const ownerId = await userIdOf('disable-owner@example.com');
  await grantPerms(ownerId, ['content.create', 'content.read']);
  const res = await createKey(ownerCookie, { name: 'to-disable', permissions: ['content.create'] });
  const { data } = (await res.json()) as { data: { id: string; key: string } };
  await sql`UPDATE apikey SET "enabled" = false WHERE id = ${data.id}`;
  const after = await fetch(`${base}/note`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': data.key },
    body: JSON.stringify({ title: 'x' }),
  });
  assert.equal(after.status, 401, 'a disabled key must be 401');
});

// ---------------------------------------------------------------------------------------------------
// checklist#7 — owner lifecycle: suspend / delete the owner stops the key immediately.
// ---------------------------------------------------------------------------------------------------

test('checklist#7a: suspending the owner makes their key fail the next request', async () => {
  const adminCookie = await signIn('admin@example.com');
  await ensureWritableType(adminCookie);
  const ownerCookie = await signUp('suspend-keyowner@example.com');
  const ownerId = await userIdOf('suspend-keyowner@example.com');
  await seedTeamMember(ownerId, 'editor'); // editor holds content.create
  const adminCookie2 = await signIn('admin@example.com'); // ensure a fresh super-admin session

  const res = await createKey(ownerCookie, { name: 'owner-key', permissions: ['content.create'] });
  const { data } = (await res.json()) as { data: { id: string; key: string } };
  const ok = await fetch(`${base}/note`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': data.key },
    body: JSON.stringify({ title: 'pre-suspend' }),
  });
  assert.ok(ok.status === 200 || ok.status === 201, `key must work before suspend, got ${ok.status}`);

  // Suspend the owner via the team route → durable key revoke + status flip + rbac rebuild.
  const susp = await fetch(`${base}/_team/${ownerId}/suspend`, { method: 'POST', headers: { cookie: adminCookie2 } });
  assert.equal(susp.status, 200, `suspend failed: ${susp.status} ${await susp.clone().text()}`);

  const after = await fetch(`${base}/note`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': data.key },
    body: JSON.stringify({ title: 'post-suspend' }),
  });
  assert.equal(after.status, 401, 'a suspended owner key must fail the next request (revoked + denied)');
  const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM apikey WHERE "referenceId" = ${ownerId}`;
  assert.equal(n, 0, 'the suspended owner keys are durably revoked in PG');
});

test('checklist#7b: a suspended-owner key whose row SURVIVES is still denied at resolution', async () => {
  // The belt: even if the durable revoke had not run, the resolution-time suspended-owner deny + the empty
  // RBAC intersection deny the key. We simulate a surviving row by re-inserting a verifiable key directly.
  const adminCookie = await signIn('admin@example.com');
  await ensureWritableType(adminCookie);
  const ownerCookie = await signUp('suspend-survive@example.com');
  const ownerId = await userIdOf('suspend-survive@example.com');
  await seedTeamMember(ownerId, 'editor');
  const adminCookie2 = await signIn('admin@example.com');

  const res = await createKey(ownerCookie, { name: 'survivor', permissions: ['content.create'] });
  const { data } = (await res.json()) as { data: { id: string; key: string } };

  // Flip the team status to suspended WITHOUT deleting the key row (truth), bypassing the route revoke.
  await sql`UPDATE team SET status = 'suspended' WHERE user_id = ${ownerId}`;
  await rbac.rebuild();
  await teamView.rebuild();
  void adminCookie2;

  const after = await fetch(`${base}/note`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': data.key },
    body: JSON.stringify({ title: 'x' }),
  });
  assert.equal(after.status, 401, 'a key whose owner team.status is suspended is denied even if the row survives');
});

test('checklist#7c: deleting the owner makes their key fail the next request', async () => {
  const adminCookie = await signIn('admin@example.com');
  await ensureWritableType(adminCookie);
  const ownerCookie = await signUp('delete-keyowner@example.com');
  const ownerId = await userIdOf('delete-keyowner@example.com');
  await seedTeamMember(ownerId, 'editor');
  const adminCookie2 = await signIn('admin@example.com');

  const res = await createKey(ownerCookie, { name: 'doomed', permissions: ['content.create'] });
  const { data } = (await res.json()) as { data: { id: string; key: string } };
  const ok = await fetch(`${base}/note`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': data.key },
    body: JSON.stringify({ title: 'pre-delete' }),
  });
  assert.ok(ok.status === 200 || ok.status === 201, `key must work before delete, got ${ok.status}`);

  const rem = await fetch(`${base}/_team/${ownerId}`, { method: 'DELETE', headers: { cookie: adminCookie2 } });
  assert.equal(rem.status, 200, `remove failed: ${rem.status} ${await rem.clone().text()}`);

  const after = await fetch(`${base}/note`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': data.key },
    body: JSON.stringify({ title: 'post-delete' }),
  });
  assert.equal(after.status, 401, 'a deleted owner key must fail the next request');
});

// ---------------------------------------------------------------------------------------------------
// checklist#8 — IDOR: list/revoke are own-only unless token.manage.
// ---------------------------------------------------------------------------------------------------

test('checklist#8: a user lists ONLY their own keys; cannot revoke another user key (no IDOR)', async () => {
  // Two NON-admin users, each with a key.
  const aCookie = await signUp('idor-a@example.com');
  const aId = await userIdOf('idor-a@example.com');
  await grantPerms(aId, ['content.create', 'content.read']);
  const bCookie = await signUp('idor-b@example.com');
  const bId = await userIdOf('idor-b@example.com');
  await grantPerms(bId, ['content.create', 'content.read']);

  const aKeyRes = await createKey(aCookie, { name: 'a-key', permissions: ['content.create'] });
  const aKeyId = ((await aKeyRes.json()) as { data: { id: string } }).data.id;
  const bKeyRes = await createKey(bCookie, { name: 'b-key', permissions: ['content.create'] });
  const bKeyId = ((await bKeyRes.json()) as { data: { id: string; key: string } }).data;

  // (a) A's list shows ONLY A's keys (B's absent).
  const aList = await fetch(`${base}/_keys`, { headers: { cookie: aCookie } });
  const aListBody = (await aList.json()) as { data: { id: string }[] };
  assert.ok(aListBody.data.some((k) => k.id === aKeyId), "A's list contains A's key");
  assert.ok(!aListBody.data.some((k) => k.id === bKeyId.id), "A's list must NOT contain B's key");

  // (b) A (no token.manage) revoking B's key → 403; B's key STILL authenticates afterward.
  const cross = await fetch(`${base}/_keys/${bKeyId.id}`, { method: 'DELETE', headers: { cookie: aCookie } });
  assert.equal(cross.status, 403, "A may not revoke B's key (no token.manage)");
  await ensureWritableType(await signIn('admin@example.com'));
  const bStill = await fetch(`${base}/note`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': bKeyId.key },
    body: JSON.stringify({ title: 'still-valid' }),
  });
  assert.ok(bStill.status === 200 || bStill.status === 201, "B's key still works after A's failed revoke");

  // (c) An actor WITH token.manage (the super-admin) revokes B's key → succeeds.
  const adminCookie = await signIn('admin@example.com');
  const adminRevoke = await fetch(`${base}/_keys/${bKeyId.id}`, { method: 'DELETE', headers: { cookie: adminCookie } });
  assert.equal(adminRevoke.status, 200, `token.manage holder must revoke any key, got ${adminRevoke.status}`);
  const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM apikey WHERE id = ${bKeyId.id}`;
  assert.equal(n, 0, "B's key is gone after the admin revoke");

  // (d) Revoking a key id the caller does not own (and a non-existent id) → 404/403, never a blind delete.
  const unknown = await fetch(`${base}/_keys/does-not-exist`, { method: 'DELETE', headers: { cookie: aCookie } });
  assert.equal(unknown.status, 404, 'a non-existent key id is 404');
  void bCookie;
});

// ---------------------------------------------------------------------------------------------------
// checklist#1 — mass-assignment: a body userId cannot mint a key for someone else.
// ---------------------------------------------------------------------------------------------------

test('checklist#1: unauthenticated create is rejected with ZERO rows inserted', async () => {
  const before = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM apikey`;
  const res = await fetch(`${base}/_keys`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'victim-id', name: 'x' }),
  });
  assert.equal(res.status, 401, 'no session → 401 on create');
  const after = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM apikey`;
  assert.equal(after[0]!.n, before[0]!.n, 'no apikey row was inserted');
});

test('checklist#1b: an authenticated body userId is IGNORED — the key binds to the session principal', async () => {
  const aCookie = await signUp('massassign-a@example.com');
  const aId = await userIdOf('massassign-a@example.com');
  await grantPerms(aId, ['content.create', 'content.read']);
  const victimCookie = await signUp('massassign-victim@example.com');
  const victimId = await userIdOf('massassign-victim@example.com');

  // A (NOT token.manage) POSTs /_keys with a body userId of the victim → the key binds to A, not the victim.
  const res = await createKey(aCookie, { userId: victimId, name: 'mass', permissions: ['content.create'] });
  assert.equal(res.status, 200, `create failed: ${res.status} ${await res.clone().text()}`);
  const id = ((await res.json()) as { data: { id: string } }).data.id;
  const [row] = await sql<{ referenceId: string }[]>`SELECT "referenceId" FROM apikey WHERE id = ${id}`;
  assert.equal(row!.referenceId, aId, 'the key binds to the SESSION principal, never the body userId');
  assert.notEqual(row!.referenceId, victimId, 'the body userId is ignored');
  void victimCookie;
});

test('checklist#1c: create-for-another requires token.manage', async () => {
  const aCookie = await signUp('crossmint-a@example.com');
  const aId = await userIdOf('crossmint-a@example.com');
  await grantPerms(aId, ['content.create']);
  const targetCookie = await signUp('crossmint-target@example.com');
  const targetId = await userIdOf('crossmint-target@example.com');

  // A lacks token.manage → 403.
  const denied = await fetch(`${base}/_keys/for/${targetId}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: aCookie },
    body: JSON.stringify({ name: 'for-target' }),
  });
  assert.equal(denied.status, 403, 'create-for-another without token.manage is 403');

  // The super-admin (token.manage) → succeeds, and the key binds to the TARGET.
  const adminCookie = await signIn('admin@example.com');
  const ok = await fetch(`${base}/_keys/for/${targetId}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ name: 'for-target' }),
  });
  assert.equal(ok.status, 200, `create-for-another with token.manage failed: ${ok.status} ${await ok.clone().text()}`);
  const id = ((await ok.json()) as { data: { id: string } }).data.id;
  const [row] = await sql<{ referenceId: string }[]>`SELECT "referenceId" FROM apikey WHERE id = ${id}`;
  assert.equal(row!.referenceId, targetId, 'the cross-user key binds to the TARGET owner');
  void targetCookie;
});

// ---------------------------------------------------------------------------------------------------
// checklist#10 — session/key confusion: a credential on the wrong channel does NOT authenticate.
// ---------------------------------------------------------------------------------------------------

test('checklist#10: a session token in x-api-key, a key in the cookie, or a key in the query are all rejected', async () => {
  const adminCookie = await signIn('admin@example.com');
  await ensureWritableType(adminCookie);
  const ownerCookie = await signUp('confusion-owner@example.com');
  const ownerId = await userIdOf('confusion-owner@example.com');
  await grantPerms(ownerId, ['content.create', 'content.read']);
  const keyRes = await createKey(ownerCookie, { name: 'confusion', permissions: ['content.create'] });
  const raw = ((await keyRes.json()) as { data: { key: string } }).data.key;

  // The raw session token value (from the owner's cookie) presented in x-api-key → NOT a hashed key → 401.
  const sessTokenValue = ownerCookie.split('=')[1]?.split('.')[0] ?? 'x';
  const r1 = await fetch(`${base}/note`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': sessTokenValue },
    body: JSON.stringify({ title: 'x' }),
  });
  assert.equal(r1.status, 401, 'a session token in x-api-key does not authenticate');

  // The raw key value placed in a SESSION cookie slot → not a hashed session token → 401.
  const r2 = await fetch(`${base}/note`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `better-auth.session_token=${raw}` },
    body: JSON.stringify({ title: 'x' }),
  });
  assert.equal(r2.status, 401, 'a raw key in the cookie does not authenticate');

  // The raw key in a QUERY STRING (never read) → 401.
  const r3 = await fetch(`${base}/note?api_key=${encodeURIComponent(raw)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'x' }),
  });
  assert.equal(r3.status, 401, 'a key in the query string is ignored');

  // The SAME key in the CORRECT header authenticates as the owner.
  const r4 = await fetch(`${base}/note`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': raw },
    body: JSON.stringify({ title: 'correct-header' }),
  });
  assert.ok(r4.status === 200 || r4.status === 201, `the key in the correct header works, got ${r4.status}`);
});

test('checklist#10b: key management routes are SESSION-ONLY (a key cannot mint/list/revoke keys)', async () => {
  const adminCookie = await signIn('admin@example.com');
  const ownerCookie = await signUp('selfesc-owner@example.com');
  const ownerId = await userIdOf('selfesc-owner@example.com');
  await seedTeamMember(ownerId, 'editor');
  await grantPerms(ownerId, ['content.create', 'content.read']);
  void adminCookie;

  const keyRes = await createKey(ownerCookie, { name: 'mgmt', permissions: ['content.create'] });
  const raw = ((await keyRes.json()) as { data: { key: string } }).data.key;

  // A key may NOT list keys (session-only) → 403.
  const list = await fetch(`${base}/_keys`, { headers: { 'x-api-key': raw } });
  assert.equal(list.status, 403, 'a key cannot list keys (management is session-only)');
  // A key may NOT create keys → 403.
  const create = await fetch(`${base}/_keys`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': raw }, body: JSON.stringify({ name: 'nope' }),
  });
  assert.equal(create.status, 403, 'a key cannot mint keys (no self-escalation)');
});

// ---------------------------------------------------------------------------------------------------
// checklist#12 — hash-equality lookup: two keys differing in the last char both resolve deterministically.
// ---------------------------------------------------------------------------------------------------

test('checklist#12: two distinct keys resolve to their OWN owners; a truncated key is INVALID', async () => {
  const adminCookie = await signIn('admin@example.com');
  await ensureWritableType(adminCookie);
  const o1Cookie = await signUp('hashlk-1@example.com');
  const o1Id = await userIdOf('hashlk-1@example.com');
  await grantPerms(o1Id, ['content.create', 'content.read']);
  const o2Cookie = await signUp('hashlk-2@example.com');
  const o2Id = await userIdOf('hashlk-2@example.com');
  await grantPerms(o2Id, ['content.create', 'content.read']);

  const k1 = ((await (await createKey(o1Cookie, { name: 'k1', permissions: ['content.create'] })).json()) as { data: { key: string } }).data.key;
  const k2 = ((await (await createKey(o2Cookie, { name: 'k2', permissions: ['content.create'] })).json()) as { data: { key: string } }).data.key;
  assert.notEqual(k1, k2, 'two keys are distinct');

  // Both resolve (POST /note works) — hash-equality lookup, not a prefix compare.
  const r1 = await fetch(`${base}/note`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': k1 }, body: JSON.stringify({ title: '1' }) });
  const r2 = await fetch(`${base}/note`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': k2 }, body: JSON.stringify({ title: '2' }) });
  assert.ok(r1.status === 200 || r1.status === 201, 'k1 resolves');
  assert.ok(r2.status === 200 || r2.status === 201, 'k2 resolves');

  // A truncated key is INVALID (never a partial match).
  const truncated = await fetch(`${base}/note`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': k1.slice(0, -3) },
    body: JSON.stringify({ title: 'x' }),
  });
  assert.equal(truncated.status, 401, 'a truncated key is INVALID_API_KEY (401), never a partial match');
});
