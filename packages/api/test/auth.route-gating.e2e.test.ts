import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
import { createContentType } from '../src/db/content-type.repository.ts';

/**
 * be-09b — ROUTE-GATING + FIRST-ADMIN BOOTSTRAP, E2E over a REAL uWS server + REAL better-auth + REAL
 * Postgres (per-file clone) + the REAL SessionCache/RbacRegistry. NO MOCKS. Proves the full preventive
 * checklist: the Builder + every write + media upload are gated (401 no session / 403 under-privileged /
 * 2xx with the permission); reads stay PUBLIC; the warm gated path is ZERO-PG; the first sign-up is
 * promoted to super-admin exactly once (idempotent + race-safe); no body-supplied role/userId escalates;
 * no path/method bypass; and drafts never leak on the public read path under gating.
 */

let db: Awaited<ReturnType<typeof createFileDatabase>>;
let sql: Sql; // the COUNTED handle (debug query counter) shared by better-auth + cache + rbac + store.
let queryCount = 0;
let store: PostgresStore;
let auth: ReturnType<typeof buildAuth>;
let sessionCache: SessionCache;
let rbac: RbacRegistry;
let base: string;
let token: unknown;
let close: (t: unknown) => void;

/** Sign up a fresh user through the REAL /auth bridge; returns the request Cookie header for the session. */
async function signUp(email: string): Promise<string> {
  const res = await fetch(`${base}/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email, password: 'correct-horse-battery-staple', name: 'U' }),
  });
  assert.equal(res.status, 200, `sign-up failed: ${res.status} ${await res.clone().text()}`);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter((c): c is string => c !== undefined && c.includes('='))
    .join('; ');
}

/** Resolve a signed-up user's id from its email (the better-auth `user` row). */
async function userIdOf(email: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`SELECT id FROM "user" WHERE email = ${email}`;
  assert.ok(row, `no user row for ${email}`);
  return row.id;
}

/** Grant a named role to a user (a REAL user_roles row) + rebuild the registry. */
async function grantRole(userId: string, roleName: string): Promise<void> {
  await sql`
    INSERT INTO user_roles (user_id, role_id)
    SELECT ${userId}, id FROM roles WHERE name = ${roleName}
    ON CONFLICT DO NOTHING
  `;
  await rbac.rebuild();
}

before(async () => {
  db = await createFileDatabase('routegating');
  await runMigrations(db.url);
  sql = postgres(db.url, { max: 8, prepare: true, debug: () => { queryCount++; } });
  setAuthSql(sql);

  const port0 = await freePort();
  base = `http://127.0.0.1:${port0}`;

  store = new PostgresStore(sql);
  sessionCache = new SessionCache(() => auth);
  rbac = new RbacRegistry(sql);
  auth = buildAuth({ baseURL: base, sessionEvictor: sessionCache, sql, rbacInvalidate: () => rbac.rebuild() });
  await rbac.rebuild();

  // Pre-create the D&P type BEFORE loadWithRegistry so the live engine/registry knows it (the draft-leak
  // test below writes rows through the gated API, which rebuilds a KNOWN type in place).
  await createContentType(sql, {
    apiId: 'dpgate',
    draftPublish: true,
    fields: [{ name: 'title', cmsType: 'string', options: { nullable: false } }],
  });

  const { engine, registry } = await store.loadWithRegistry();
  const server = createServer(engine, store, registry, undefined, auth, sessionCache, rbac);
  token = await server.listen(port0);
  close = server.close;
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
// FIRST-ADMIN BOOTSTRAP — the first sign-up is super-admin; subsequent sign-ups get NO role.
// ---------------------------------------------------------------------------------------------------

test('checklist#7/#8: the FIRST sign-up is promoted to super-admin; the second gets ZERO permissions', async () => {
  // The very first user signs up → the user.create.after hook promotes it under the advisory lock.
  await signUp('admin@example.com');
  const adminId = await userIdOf('admin@example.com');
  await rbac.rebuild();
  assert.equal(rbac.checkPermission({ userId: adminId, sessionToken: 't' }, 'builder.manage'), true,
    'the first user must hold super-admin (builder.manage)');
  assert.equal(rbac.checkPermission({ userId: adminId, sessionToken: 't' }, 'content.create'), true);

  // A SECOND sign-up after an admin exists → bootstrap is a no-op → ZERO permissions (deny-by-default).
  await signUp('nobody@example.com');
  const nobodyId = await userIdOf('nobody@example.com');
  await rbac.rebuild();
  assert.equal(rbac.permissionsOf(nobodyId).size, 0, 'a non-first sign-up must get NO role');
  assert.equal(rbac.checkPermission({ userId: nobodyId, sessionToken: 't' }, 'content.create'), false);
  assert.equal(rbac.checkPermission({ userId: nobodyId, sessionToken: 't' }, 'builder.manage'), false);

  // EXACTLY ONE super-admin grant exists.
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'super-admin'
  `;
  assert.equal(n, 1, 'exactly one super-admin after two sign-ups');
});

test('checklist#6: re-invoking the bootstrap after an admin exists is a NO-OP (refused)', async () => {
  // Directly drive the hook path semantics: a third user signs up; no second admin appears.
  await signUp('third@example.com');
  const thirdId = await userIdOf('third@example.com');
  await rbac.rebuild();
  assert.equal(rbac.permissionsOf(thirdId).size, 0);
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'super-admin'
  `;
  assert.equal(n, 1, 'bootstrap is idempotent — still exactly one super-admin');
});

// ---------------------------------------------------------------------------------------------------
// 401-vs-403 SPLIT + DENY-BY-DEFAULT on the Builder (checklist #1, #10).
// ---------------------------------------------------------------------------------------------------

test('checklist#1/#10: POST /content-types is 401 with no session, 403 as viewer, 2xx as super-admin', async () => {
  const body = JSON.stringify({ apiId: 'gatecheck', fields: [{ name: 'title', cmsType: 'string' }] });

  // NO session → 401 (unauthenticated). Assert NO content-type row was created.
  const noAuth = await fetch(`${base}/content-types`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  assert.equal(noAuth.status, 401, `expected 401, got ${noAuth.status}`);
  let exists = await sql`SELECT 1 FROM content_types WHERE api_id = 'gatecheck'`;
  assert.equal(exists.length, 0, 'an unauthenticated POST must NOT create a content-type');

  // VIEWER session (no builder.manage) → 403 (forbidden). Still no row.
  const viewerCookie = await signUp('viewer1@example.com');
  await grantRole(await userIdOf('viewer1@example.com'), 'viewer');
  const asViewer = await fetch(`${base}/content-types`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: viewerCookie }, body,
  });
  assert.equal(asViewer.status, 403, `expected 403, got ${asViewer.status}`);
  exists = await sql`SELECT 1 FROM content_types WHERE api_id = 'gatecheck'`;
  assert.equal(exists.length, 0, 'a viewer POST must NOT create a content-type');

  // SUPER-ADMIN session → 2xx, row created.
  const adminCookie = await signUp('builder@example.com');
  await grantRole(await userIdOf('builder@example.com'), 'super-admin');
  const asAdmin = await fetch(`${base}/content-types`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie }, body,
  });
  assert.ok(asAdmin.status === 200 || asAdmin.status === 201, `expected 2xx, got ${asAdmin.status} ${await asAdmin.clone().text()}`);
  exists = await sql`SELECT 1 FROM content_types WHERE api_id = 'gatecheck'`;
  assert.equal(exists.length, 1, 'a super-admin POST must create the content-type');
});

test('checklist#1: every Builder mutation route is gated (401 with no session)', async () => {
  const routes: [string, string][] = [
    ['DELETE', '/content-types/gatecheck'],
    ['POST', '/content-types/gatecheck/fields'],
    ['PUT', '/content-types/gatecheck/fields/title'],
    ['DELETE', '/content-types/gatecheck/fields/title'],
    ['POST', '/content-types/gatecheck/relations'],
    ['POST', '/component-types'],
    ['DELETE', '/component-types/seo'],
    ['POST', '/component-types/seo/fields'],
    ['DELETE', '/component-types/seo/fields/x'],
  ];
  for (const [method, path] of routes) {
    const res = await fetch(`${base}${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}',
    });
    assert.equal(res.status, 401, `${method} ${path} must be 401 with no session, got ${res.status}`);
  }
});

// ---------------------------------------------------------------------------------------------------
// READS STAY PUBLIC (checklist #9 — no draft leak; reads need no auth).
// ---------------------------------------------------------------------------------------------------

test('reads stay PUBLIC: GET /content-types + GET /:type need no session (200)', async () => {
  const list = await fetch(`${base}/content-types`);
  assert.equal(list.status, 200, 'GET /content-types must be public');
  // A seeded type read with no auth.
  const read = await fetch(`${base}/gatecheck`);
  assert.equal(read.status, 200, 'GET /:type must be public with no session');
});

test('checklist#9: a DRAFT is not leaked on the public read path under gating', async () => {
  // `dpgate` (a D&P type) was pre-created in before(). Insert a published row + a draft via the gated API
  // as super-admin (the engine rebuilds the type in place), then read with NO auth.
  const adminCookie = await signUp('dpadmin@example.com');
  await grantRole(await userIdOf('dpadmin@example.com'), 'super-admin');
  const pub = await fetch(`${base}/dpgate`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ title: 'published-one' }),
  });
  assert.ok(pub.status === 200 || pub.status === 201, `seed published failed: ${pub.status} ${await pub.clone().text()}`);
  const pubId = ((await pub.json()) as { data: { id: number } }).data.id;
  // Publish it so published_at IS NOT NULL.
  const doPub = await fetch(`${base}/dpgate/${pubId}/actions/publish`, {
    method: 'POST', headers: { cookie: adminCookie },
  });
  assert.equal(doPub.status, 200, `publish failed: ${doPub.status} ${await doPub.clone().text()}`);
  // Insert a draft (stays unpublished).
  const draft = await fetch(`${base}/dpgate`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ title: 'secret-draft' }),
  });
  assert.ok(draft.status === 200 || draft.status === 201, `seed draft failed: ${draft.status}`);

  // PUBLIC read (no auth) — only the published row must appear; the draft must be absent.
  const list = await fetch(`${base}/dpgate`);
  assert.equal(list.status, 200);
  const text = await list.text();
  assert.ok(text.includes('published-one'), 'the published row must be visible');
  assert.ok(!text.includes('secret-draft'), 'the DRAFT must NOT leak on the public read path');
});

// ---------------------------------------------------------------------------------------------------
// PER-VERB DATA WRITE GATING (checklist #5 — method consistency / IDOR).
// ---------------------------------------------------------------------------------------------------

test('checklist#5: create/update/delete each gate on their own permission (no method gets a weaker check)', async () => {
  // Set up a target type + one row as super-admin.
  const adminCookie = await signUp('crudadmin@example.com');
  await grantRole(await userIdOf('crudadmin@example.com'), 'super-admin');
  const mk = await fetch(`${base}/content-types`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ apiId: 'crudt', fields: [{ name: 'title', cmsType: 'string' }] }),
  });
  assert.ok(mk.status === 200 || mk.status === 201, `mk type: ${mk.status} ${await mk.clone().text()}`);
  const seed = await fetch(`${base}/crudt`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ title: 'a' }),
  });
  const rowId = ((await seed.json()) as { data: { id: number } }).data.id;

  // AUTHOR session: has content.create + content.update + read + media; NOT content.delete.
  const authorCookie = await signUp('author1@example.com');
  await grantRole(await userIdOf('author1@example.com'), 'author');

  // POST (create) → allowed.
  const create = await fetch(`${base}/crudt`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: authorCookie },
    body: JSON.stringify({ title: 'b' }),
  });
  assert.ok(create.status === 200 || create.status === 201, `author create must succeed, got ${create.status}`);

  // PUT (update) → allowed (author has content.update).
  const update = await fetch(`${base}/crudt/${rowId}`, {
    method: 'PUT', headers: { 'content-type': 'application/json', cookie: authorCookie },
    body: JSON.stringify({ title: 'c' }),
  });
  assert.ok(update.status === 200 || update.status === 201, `author update must succeed, got ${update.status}`);

  // DELETE → FORBIDDEN (author lacks content.delete) — a different verb does NOT get a weaker check.
  const del = await fetch(`${base}/crudt/${rowId}`, { method: 'DELETE', headers: { cookie: authorCookie } });
  assert.equal(del.status, 403, `author DELETE must be 403, got ${del.status}`);
  // The row must still exist.
  const still = await sql`SELECT 1 FROM ct_crudt WHERE id = ${rowId}`;
  assert.equal(still.length, 1, 'a forbidden DELETE must not remove the row');
});

// ---------------------------------------------------------------------------------------------------
// MASS-ASSIGNMENT (checklist #3, #4) — body role/userId/isAdmin never authorizes.
// ---------------------------------------------------------------------------------------------------

test('checklist#3/#4: a body-supplied role/userId/isAdmin NEVER escalates authz', async () => {
  // An author (no builder.manage) attempts a Builder write while stuffing privileged fields in the body.
  const authorCookie = await signUp('massassign@example.com');
  await grantRole(await userIdOf('massassign@example.com'), 'author');
  const adminId = await userIdOf('admin@example.com');

  const res = await fetch(`${base}/content-types`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: authorCookie },
    body: JSON.stringify({
      apiId: 'evil', fields: [{ name: 'x', cmsType: 'string' }],
      userId: adminId, role: 'super-admin', isAdmin: true, permission: 'builder.manage',
    }),
  });
  // Authorized against the SESSION principal only → author lacks builder.manage → 403.
  assert.equal(res.status, 403, `body-supplied role must be ignored; expected 403, got ${res.status}`);
  const exists = await sql`SELECT 1 FROM content_types WHERE api_id = 'evil'`;
  assert.equal(exists.length, 0, 'the privileged-body Builder write must not create a content-type');

  // user_roles for the author was NOT mutated by the body (no self-escalation surface this slice).
  const grants = await sql`SELECT 1 FROM user_roles WHERE user_id = ${await userIdOf('massassign@example.com')}`;
  assert.equal(grants.length, 1, 'only the explicitly-granted author role exists; the body added nothing');

  // A request with userId in the body but NO session → 401 (body userId ignored).
  const noSession = await fetch(`${base}/content-types`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiId: 'evil2', fields: [], userId: adminId, role: 'super-admin' }),
  });
  assert.equal(noSession.status, 401, 'a body userId with no session must be 401, not an escalation');
});

// ---------------------------------------------------------------------------------------------------
// PATH-NORMALIZATION BYPASS (checklist #2) + 404 fallthrough (checklist #10).
// ---------------------------------------------------------------------------------------------------

test('checklist#2: an odd-slash path never reaches a write (401/404, never 2xx, never a created row)', async () => {
  for (const path of ['//content-types', '///content-types']) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiId: 'slashbypass', fields: [] }),
    });
    assert.ok(res.status === 401 || res.status === 404,
      `${path} must be 401/404, never 2xx; got ${res.status}`);
    assert.ok(res.status < 200 || res.status >= 300, `${path} must NEVER 2xx`);
  }
  const created = await sql`SELECT 1 FROM content_types WHERE api_id = 'slashbypass'`;
  assert.equal(created.length, 0, 'no odd-slash spelling created a content-type');
});

test('checklist#10: an unknown path returns 404 from the fallback, not 200/500', async () => {
  const res = await fetch(`${base}/this/is/not/a/route/at/all`);
  assert.equal(res.status, 404, `unknown path must 404, got ${res.status}`);
});

// ---------------------------------------------------------------------------------------------------
// MEDIA UPLOAD GATING (checklist #11).
// ---------------------------------------------------------------------------------------------------

test('checklist#11: POST /_files/upload is 401 no session / 403 viewer; GET /_files stays public', async () => {
  const multipart = (): { body: string; ct: string } => {
    const boundary = '----absurdtest';
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="t.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\nhello-bytes\r\n--${boundary}--\r\n`;
    return { body, ct: `multipart/form-data; boundary=${boundary}` };
  };

  // NO session → 401. No file row persisted.
  const m1 = multipart();
  const noAuth = await fetch(`${base}/_files/upload`, { method: 'POST', headers: { 'content-type': m1.ct }, body: m1.body });
  assert.equal(noAuth.status, 401, `no-session upload must be 401, got ${noAuth.status}`);

  // VIEWER (no media.upload) → 403.
  const viewerCookie = await signUp('mediaviewer@example.com');
  await grantRole(await userIdOf('mediaviewer@example.com'), 'viewer');
  const m2 = multipart();
  const asViewer = await fetch(`${base}/_files/upload`, {
    method: 'POST', headers: { 'content-type': m2.ct, cookie: viewerCookie }, body: m2.body,
  });
  assert.equal(asViewer.status, 403, `viewer upload must be 403, got ${asViewer.status}`);
  const noFiles = await sql`SELECT 1 FROM files`;
  assert.equal(noFiles.length, 0, 'no file row persisted by an unauthorized upload');

  // EDITOR (has media.upload) → 2xx.
  const editorCookie = await signUp('mediaeditor@example.com');
  await grantRole(await userIdOf('mediaeditor@example.com'), 'editor');
  const m3 = multipart();
  const asEditor = await fetch(`${base}/_files/upload`, {
    method: 'POST', headers: { 'content-type': m3.ct, cookie: editorCookie }, body: m3.body,
  });
  assert.ok(asEditor.status === 200 || asEditor.status === 201, `editor upload must 2xx, got ${asEditor.status} ${await asEditor.clone().text()}`);

  // GET /_files stays public (read-public config).
  const list = await fetch(`${base}/_files`);
  assert.equal(list.status, 200, 'GET /_files must be public');
});

// ---------------------------------------------------------------------------------------------------
// MID-SESSION ROLE REVOCATION (checklist #1 edge) + ZERO-PG WARM GATED PATH.
// ---------------------------------------------------------------------------------------------------

test('a session whose role was revoked mid-session is re-evaluated against the live registry (403)', async () => {
  const cookie = await signUp('revoke@example.com');
  const uid = await userIdOf('revoke@example.com');
  await grantRole(uid, 'super-admin');

  // With the grant: a Builder write is allowed.
  const ok = await fetch(`${base}/content-types`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ apiId: 'revoketype', fields: [{ name: 't', cmsType: 'string' }] }),
  });
  assert.ok(ok.status === 200 || ok.status === 201, `granted write must 2xx, got ${ok.status}`);

  // Revoke the role + rebuild — the session stays warm (still authenticates) but loses the permission.
  await sql`DELETE FROM user_roles WHERE user_id = ${uid}`;
  await rbac.rebuild();
  const denied = await fetch(`${base}/content-types`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ apiId: 'revoketype2', fields: [] }),
  });
  assert.equal(denied.status, 403, `a revoked session must now be 403, got ${denied.status}`);
});

// ---------------------------------------------------------------------------------------------------
// EDGE: an EXPIRED/EVICTED session at a gated route → 401 (not 403, not 2xx). A real sign-out deletes
// the PG session row + the delete.after hook evicts the RAM cache; the next gated request re-misses the
// cache, re-reads PG, finds no live session → principal null → 401. (Same terminal state an expired
// session reaches: warm hit fails the TTL compare → local evict → PG miss → null.)
// ---------------------------------------------------------------------------------------------------

test('an EVICTED/expired session at a gated route is 401 (deny-by-default), not a stale 2xx', async () => {
  const cookie = await signUp('evictgate@example.com');
  await grantRole(await userIdOf('evictgate@example.com'), 'super-admin');

  // Warm + prove the grant works at the gated route.
  const ok = await fetch(`${base}/content-types`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ apiId: 'evictbefore', fields: [{ name: 't', cmsType: 'string' }] }),
  });
  assert.ok(ok.status === 200 || ok.status === 201, `granted write must 2xx, got ${ok.status}`);

  // Real sign-out → deletes the session row → session.delete.after evicts the RAM cache. (Origin matches
  // baseURL so better-auth's CSRF origin check passes on this state-changing route.)
  const out = await fetch(`${base}/auth/sign-out`, { method: 'POST', headers: { cookie, origin: base } });
  assert.equal(out.status, 200, `sign-out failed: ${out.status} ${await out.clone().text()}`);

  // The SAME cookie now resolves no live session: the gated route re-misses RAM, re-reads PG, finds none.
  const denied = await fetch(`${base}/content-types`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ apiId: 'evictafter', fields: [] }),
  });
  assert.equal(denied.status, 401, `an evicted/expired session must be 401, got ${denied.status}`);
  const created = await sql`SELECT 1 FROM content_types WHERE api_id = 'evictafter'`;
  assert.equal(created.length, 0, 'an evicted-session write must not create a content-type');
});

// ---------------------------------------------------------------------------------------------------
// EDGE: a WRITE by a principal with NO write perm seeded for the action → 403 (deny-by-default). A fresh
// (non-first) sign-up holds ZERO permissions; it authenticates fine (so NOT 401) but no write action is
// granted, so EVERY gated write route is 403 and nothing is persisted.
// ---------------------------------------------------------------------------------------------------

test('a ZERO-permission (no perms seeded) session is 403 on every gated write, persists nothing', async () => {
  // A fresh sign-up after the first admin exists → bootstrap no-op → no role → no perms (deny-by-default).
  const cookie = await signUp('noperm@example.com');
  const uid = await userIdOf('noperm@example.com');
  await rbac.rebuild();
  assert.equal(rbac.permissionsOf(uid).size, 0, 'a non-first sign-up must hold ZERO permissions');

  // Every gated write/builder/upload route → 403 (authenticated, but lacking the mapped perm).
  const gated: [string, string, string | undefined][] = [
    ['POST', '/content-types', JSON.stringify({ apiId: 'nopermct', fields: [] })],
    ['POST', '/gatecheck', JSON.stringify({ title: 'x' })],
    ['PUT', '/gatecheck/1', JSON.stringify({ title: 'x' })],
    ['DELETE', '/gatecheck/1', undefined],
    ['POST', '/gatecheck/1/actions/publish', undefined],
  ];
  for (const [method, path, body] of gated) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json', cookie } : { cookie },
      body,
    });
    assert.equal(res.status, 403, `${method} ${path} for a zero-perm session must be 403, got ${res.status}`);
  }
  const created = await sql`SELECT 1 FROM content_types WHERE api_id = 'nopermct'`;
  assert.equal(created.length, 0, 'a zero-perm Builder write must persist nothing');
});

test('the WARM gated path is ZERO-PG (validate + checkPermission are RAM)', async () => {
  const cookie = await signUp('zeropg@example.com');
  await grantRole(await userIdOf('zeropg@example.com'), 'editor');

  // Warm the session cache with one request (cold validate hits PG once).
  await fetch(`${base}/zeropg-warm-miss`, { headers: { cookie } }); // a GET is public; warms nothing gated
  // Drive a gated write to warm the session entry through validate.
  await fetch(`${base}/content-types`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ apiId: 'zeropgtype', fields: [] }),
  });

  // Now measure: a gated request that is DENIED at the perm check (editor lacks builder.manage) — the
  // only PG work would be the session validate, which is now WARM (off-heap). The 403 short-circuits
  // before any handler SQL. Count queries across the request window.
  queryCount = 0;
  const res = await fetch(`${base}/content-types`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ apiId: 'zeropgtype2', fields: [] }),
  });
  assert.equal(res.status, 403, 'editor lacks builder.manage');
  assert.equal(queryCount, 0,
    `a WARM gated request (warm validate + RAM checkPermission) must fire ZERO Postgres queries, saw ${queryCount}`);
});

// ---------------------------------------------------------------------------------------------------
// BOOTSTRAP RACE (checklist #6) — N concurrent first sign-ups yield EXACTLY ONE super-admin.
// ---------------------------------------------------------------------------------------------------

test('checklist#6: N concurrent first sign-ups against a FRESH db yield EXACTLY ONE super-admin', async () => {
  // A fresh, independent db so "no admin yet" is genuinely true for the race.
  const fresh = await createFileDatabase('rgrace');
  try {
    await runMigrations(fresh.url);
    const fsql = postgres(fresh.url, { max: 12, prepare: true });
    try {
      const frbac = new RbacRegistry(fsql);
      let fauth: ReturnType<typeof buildAuth>;
      const fcache = new SessionCache(() => fauth, undefined, 0);
      const fport = await freePort();
      const fbase = `http://127.0.0.1:${fport}`;
      // The auth instance for THIS db (its own sql for the bootstrap hook).
      setAuthSql(fsql);
      fauth = buildAuth({ baseURL: fbase, sessionEvictor: fcache, sql: fsql, rbacInvalidate: () => frbac.rebuild() });
      const fstore = new PostgresStore(fsql);
      const { engine, registry } = await fstore.loadWithRegistry();
      const fserver = createServer(engine, fstore, registry, undefined, fauth, fcache, frbac);
      const ftoken = await fserver.listen(fport);
      try {
        // Fire N concurrent real sign-ups.
        const N = 8;
        const results = await Promise.all(
          Array.from({ length: N }, (_, i) =>
            fetch(`${fbase}/auth/sign-up/email`, {
              method: 'POST', headers: { 'content-type': 'application/json', origin: fbase },
              body: JSON.stringify({ email: `race${i}@example.com`, password: 'correct-horse-battery-staple', name: 'R' }),
            }).then((r) => r.status),
          ),
        );
        assert.ok(results.every((s) => s === 200), `all sign-ups should succeed: ${results}`);
        const [{ n }] = await fsql<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'super-admin'
        `;
        assert.equal(n, 1, `exactly one super-admin after ${N} concurrent first sign-ups, saw ${n}`);
      } finally {
        fserver.close(ftoken);
        fcache.stop();
      }
    } finally {
      await fsql.end();
    }
  } finally {
    await fresh.sql.end();
    await dropFileDatabase(fresh.name);
    setAuthSql(sql); // restore the shared handle for any trailing teardown
  }
});
