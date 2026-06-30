import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, tableExists, startTestServerFromFilesWithAuth, closeAuth } from './helpers.ts';

/**
 * S5 — the Builder HTTP route surface (GET list/one, preview, PUT, DELETE), over REAL Postgres (no mocks),
 * asserted via HTTP. The server wires the FULL real auth stack, so the `builder.manage` gate is ENFORCED:
 * every builder WRITE (PUT/DELETE/preview) carries the bootstrapped super-admin cookie. Reads (GET list/one,
 * the live type, the catalog-version ETag) stay PUBLIC and go out anonymous. This exercises the route logic
 * + uniform envelope + error→status mapping; the 401/403 gating path is covered separately (S6 concurrency).
 */

const genDir = fileURLToPath(new URL(`./fixtures/.gen-${process.pid}-s5route/`, import.meta.url));

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let srv: Awaited<ReturnType<typeof startTestServerFromFilesWithAuth>>;
let cookie: string; // the super-admin session cookie injected into every builder WRITE

before(async () => {
  db = await createFileDatabase('builder-route');
  sql = db.sql;
});
beforeEach(async () => {
  await cleanCatalog(sql);
  await sql`DROP TABLE IF EXISTS _schema_applied`;
  await rm(genDir, { recursive: true, force: true });
  if (srv) srv.close(srv.token);
  srv = await startTestServerFromFilesWithAuth(sql, genDir);
  // Bootstrap a super-admin: unique email per boot (per-file DB persists auth tables across boots), sign up
  // (first-admin advisory-lock bootstrap fires for the first user) + explicit grantRole (idempotent) so the
  // captured cookie is authed regardless of bootstrap timing. `builder.manage` then authorizes the writes.
  const email = `route-admin-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  cookie = await srv.signUp(email);
  await srv.grantRole(await srv.userIdOf(email), 'super-admin');
});
after(async () => {
  if (srv) {
    srv.close(srv.token);
    srv.sessionCache.stop();
    await closeAuth();
  }
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
  await rm(genDir, { recursive: true, force: true });
});

// S6 requires If-Match on PUT/DELETE. These helpers auto-attach the CURRENT on-disk version (the GET ETag)
// unless an explicit `ifMatch` override is passed — so the functional route tests exercise the happy path
// while the precondition is enforced. (412/428 are asserted in the concurrency suite.)
// The catalog-version ETag is a PUBLIC read ⇒ stays anonymous. The WRITES (PUT/DELETE/preview) carry the
// super-admin `cookie` so the `builder.manage` gate authorizes them.
const ver = async (): Promise<string> => (await fetch(`${srv.base}/builder/modules`)).headers.get('etag') ?? '';
const put = async (name: string, body: unknown, ifMatch?: string): Promise<Response> =>
  fetch(`${srv.base}/builder/modules/${name}`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'if-match': ifMatch ?? (await ver()) }, body: JSON.stringify(body) });
const del = async (name: string, body: unknown, ifMatch?: string): Promise<Response> =>
  fetch(`${srv.base}/builder/modules/${name}`, { method: 'DELETE', headers: { 'content-type': 'application/json', cookie, 'if-match': ifMatch ?? (await ver()) }, body: JSON.stringify(body) });
const preview = (name: string, body: unknown): Promise<Response> =>
  fetch(`${srv.base}/builder/modules/${name}/preview`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });

test('PUT create → 200 uniform envelope; GET list/one reflect it; the type serves live', async () => {
  const r = await put('gadget', { name: 'gadget', fields: [{ name: 'title', type: 'string', options: { nullable: true } }] });
  assert.equal(r.status, 200);
  const env = await r.json();
  assert.deepEqual({ ok: env.ok, blocked: env.blocked, live: env.live }, { ok: true, blocked: [], live: true });
  assert.ok(env.applied.some((c: { kind: string }) => c.kind === 'addType'));
  assert.ok(env.schema.id.startsWith('ct_') && env.schema.fields[0].id.startsWith('f_'));
  // GET list + one
  const list = await (await fetch(`${srv.base}/builder/modules`)).json();
  assert.ok(list.ok && list.schemas.some((s: { name: string }) => s.name === 'gadget'));
  assert.equal((await fetch(`${srv.base}/builder/modules/gadget`)).status, 200);
  assert.equal((await fetch(`${srv.base}/builder/modules/nope`)).status, 404);
  assert.equal((await fetch(`${srv.base}/gadget`)).status, 200); // live
});

test('PUT name-RENAME (same id at the new path) → 200; old 404, new 200', async () => {
  const created = await (await put('gadget', { name: 'gadget', fields: [{ name: 'title', type: 'string', options: { nullable: true } }] })).json();
  const r = await put('doohickey', { id: created.schema.id, name: 'doohickey', fields: [{ id: created.schema.fields[0].id, name: 'title', type: 'string', options: { nullable: true } }] });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).applied.some((c: { kind: string }) => c.kind === 'renameType'));
  assert.equal((await fetch(`${srv.base}/gadget`)).status, 404);
  assert.equal((await fetch(`${srv.base}/doohickey`)).status, 200);
});

test('DELETE → 200, type gone; without allowDestructive → 409', async () => {
  await put('gadget', { name: 'gadget', fields: [{ name: 'a', type: 'string', options: { nullable: true } }] });
  assert.equal((await del('gadget', {})).status, 409); // requires the ack
  assert.equal((await fetch(`${srv.base}/gadget`)).status, 200); // still there

  const r = await del('gadget', { allowDestructive: true });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).applied.some((c: { kind: string }) => c.kind === 'dropType'));
  assert.equal((await fetch(`${srv.base}/gadget`)).status, 404);
  assert.equal(await tableExists(sql, 'ct_gadget'), false);
});

test('POST preview → 200 with changes + generatedSource, but writes/migrates NOTHING', async () => {
  const r = await preview('widget', { name: 'widget', fields: [{ name: 'a', type: 'string', options: { nullable: true } }] });
  assert.equal(r.status, 200);
  const p = await r.json();
  assert.ok(p.ok && p.applied.some((c: { kind: string }) => c.kind === 'addType') && /defineSchema/.test(p.generatedSource));
  assert.equal(await tableExists(sql, 'ct_widget'), false); // dry run
  assert.equal((await fetch(`${srv.base}/widget`)).status, 404);
});

test('422s: body/path mismatch, reserved identifier, dangling relation target', async () => {
  assert.equal((await put('gadget', { name: 'other', fields: [] })).status, 422); // body.name != path
  assert.equal((await put('gadget', { name: 'gadget', fields: [{ name: 'created_at', type: 'string' }] })).status, 422); // reserved
  assert.equal((await put('post', { name: 'post', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'author', kind: 'manyToOne', target: 'nope' }] })).status, 422); // dangling target
});

test('422 ownership guard via HTTP: a foreign field id on another type rejects; legit rename ok', async () => {
  const alpha = await (await put('alpha', { name: 'alpha', fields: [{ name: 'x', type: 'string', options: { nullable: true } }] })).json();
  const beta = await (await put('beta', { name: 'beta', fields: [{ name: 'y', type: 'string', options: { nullable: true } }] })).json();

  const forged = await put('beta', { id: beta.schema.id, name: 'beta', fields: [{ id: alpha.schema.fields[0].id, name: 'y', type: 'string', options: { nullable: true } }] });
  assert.equal(forged.status, 422); // alpha's field id claimed on beta
  const renamed = await put('beta', { id: beta.schema.id, name: 'beta', fields: [{ id: beta.schema.fields[0].id, name: 'renamed', type: 'string', options: { nullable: true } }] });
  assert.equal(renamed.status, 200);
});

test('DELETE of a relation-TARGET type → 422 (inbound relation); GET still 200', async () => {
  await put('writer', { name: 'writer', fields: [{ name: 'name', type: 'string', options: { nullable: true } }] });
  await put('post', { name: 'post', fields: [{ name: 'title', type: 'string', options: { nullable: true } }], relations: [{ field: 'author', kind: 'manyToOne', target: 'writer' }] });

  const r = await del('writer', { allowDestructive: true });
  assert.equal(r.status, 422); // referenced by post.author
  assert.match((await r.json()).error, /post\.author/);
  assert.equal((await fetch(`${srv.base}/writer`)).status, 200); // still serving
});

test('PUT create a SINGLE type → GET reflects options.single; live type enforces one entry (409)', async () => {
  const r = await put('homepage', { name: 'homepage', options: { single: true }, fields: [{ name: 'hero', type: 'string', options: { nullable: true } }] });
  assert.equal(r.status, 200);

  // The applied catalog round-trips the flag.
  const one = await (await fetch(`${srv.base}/builder/modules/homepage`)).json();
  assert.equal(one.schema.options.single, true);

  // The live engine swap applied it: the first content create succeeds, the second is rejected.
  const first = await fetch(`${srv.base}/homepage`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ hero: 'Welcome' }) });
  assert.equal(first.status, 201);
  const second = await fetch(`${srv.base}/homepage`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ hero: 'Second' }) });
  assert.equal(second.status, 409);
});

test('toggling collection → single with >1 rows is blocked (422)', async () => {
  const created = await (await put('note', { name: 'note', fields: [{ name: 'text', type: 'string', options: { nullable: true } }] })).json();
  for (const text of ['a', 'b']) {
    const c = await fetch(`${srv.base}/note`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ text }) });
    assert.equal(c.status, 201);
  }
  // Flip to single while 2 rows exist — ids preserved so the ONLY diff is the (safe) single toggle, which the
  // row-count preflight then rejects → 422 (and nothing applied).
  const flip = await put('note', {
    id: created.schema.id,
    name: 'note',
    options: { single: true },
    fields: [{ id: created.schema.fields[0].id, name: 'text', type: 'string', options: { nullable: true } }],
  });
  assert.equal(flip.status, 422);
  assert.match((await flip.json()).error, /single type/);
});
