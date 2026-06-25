import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, tableExists, startTestServerFromFiles } from './helpers.ts';

/**
 * S5 — the Builder HTTP route surface (GET list/one, preview, PUT, DELETE), over REAL Postgres (no mocks),
 * asserted via HTTP. The test server wires NO auth, so the `builder.manage` gate is OPEN (the no-auth
 * pass-through) — this exercises the route logic + uniform envelope + error→status mapping. The 401/403
 * gating path (auth wired) is covered separately with the auth harness (S6 concurrency suite).
 */

const genDir = fileURLToPath(new URL(`./fixtures/.gen-${process.pid}-s5route/`, import.meta.url));

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let srv: Awaited<ReturnType<typeof startTestServerFromFiles>>;

before(async () => {
  db = await createFileDatabase('builder-route');
  sql = db.sql;
});
beforeEach(async () => {
  await cleanCatalog(sql);
  await sql`DROP TABLE IF EXISTS _schema_applied`;
  await rm(genDir, { recursive: true, force: true });
  if (srv) srv.close(srv.token);
  srv = await startTestServerFromFiles(sql, genDir);
});
after(async () => {
  if (srv) srv.close(srv.token);
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
  await rm(genDir, { recursive: true, force: true });
});

// S6 requires If-Match on PUT/DELETE. These helpers auto-attach the CURRENT on-disk version (the GET ETag)
// unless an explicit `ifMatch` override is passed — so the functional route tests exercise the happy path
// while the precondition is enforced. (412/428 are asserted in the concurrency suite.)
const ver = async (): Promise<string> => (await fetch(`${srv.base}/builder/content-types`)).headers.get('etag') ?? '';
const put = async (apiId: string, body: unknown, ifMatch?: string): Promise<Response> =>
  fetch(`${srv.base}/builder/content-types/${apiId}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': ifMatch ?? (await ver()) }, body: JSON.stringify(body) });
const del = async (apiId: string, body: unknown, ifMatch?: string): Promise<Response> =>
  fetch(`${srv.base}/builder/content-types/${apiId}`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'if-match': ifMatch ?? (await ver()) }, body: JSON.stringify(body) });
const preview = (apiId: string, body: unknown): Promise<Response> =>
  fetch(`${srv.base}/builder/content-types/${apiId}/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('PUT create → 200 uniform envelope; GET list/one reflect it; the type serves live', async () => {
  const r = await put('gadget', { apiId: 'gadget', fields: [{ name: 'title', type: 'string', options: { nullable: true } }] });
  assert.equal(r.status, 200);
  const env = await r.json();
  assert.deepEqual({ ok: env.ok, blocked: env.blocked, live: env.live }, { ok: true, blocked: [], live: true });
  assert.ok(env.applied.some((c: { kind: string }) => c.kind === 'addType'));
  assert.ok(env.schema.id.startsWith('ct_') && env.schema.fields[0].id.startsWith('f_'));
  // GET list + one
  const list = await (await fetch(`${srv.base}/builder/content-types`)).json();
  assert.ok(list.ok && list.schemas.some((s: { apiId: string }) => s.apiId === 'gadget'));
  assert.equal((await fetch(`${srv.base}/builder/content-types/gadget`)).status, 200);
  assert.equal((await fetch(`${srv.base}/builder/content-types/nope`)).status, 404);
  assert.equal((await fetch(`${srv.base}/gadget`)).status, 200); // live
});

test('PUT apiId-RENAME (same id at the new path) → 200; old 404, new 200', async () => {
  const created = await (await put('gadget', { apiId: 'gadget', fields: [{ name: 'title', type: 'string', options: { nullable: true } }] })).json();
  const r = await put('doohickey', { id: created.schema.id, apiId: 'doohickey', fields: [{ id: created.schema.fields[0].id, name: 'title', type: 'string', options: { nullable: true } }] });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).applied.some((c: { kind: string }) => c.kind === 'renameType'));
  assert.equal((await fetch(`${srv.base}/gadget`)).status, 404);
  assert.equal((await fetch(`${srv.base}/doohickey`)).status, 200);
});

test('DELETE → 200, type gone; without allowDestructive → 409', async () => {
  await put('gadget', { apiId: 'gadget', fields: [{ name: 'a', type: 'string', options: { nullable: true } }] });
  assert.equal((await del('gadget', {})).status, 409); // requires the ack
  assert.equal((await fetch(`${srv.base}/gadget`)).status, 200); // still there

  const r = await del('gadget', { allowDestructive: true });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).applied.some((c: { kind: string }) => c.kind === 'dropType'));
  assert.equal((await fetch(`${srv.base}/gadget`)).status, 404);
  assert.equal(await tableExists(sql, 'ct_gadget'), false);
});

test('POST preview → 200 with changes + generatedSource, but writes/migrates NOTHING', async () => {
  const r = await preview('widget', { apiId: 'widget', fields: [{ name: 'a', type: 'string', options: { nullable: true } }] });
  assert.equal(r.status, 200);
  const p = await r.json();
  assert.ok(p.ok && p.applied.some((c: { kind: string }) => c.kind === 'addType') && /defineType/.test(p.generatedSource));
  assert.equal(await tableExists(sql, 'ct_widget'), false); // dry run
  assert.equal((await fetch(`${srv.base}/widget`)).status, 404);
});

test('422s: body/path mismatch, reserved identifier, dangling relation target', async () => {
  assert.equal((await put('gadget', { apiId: 'other', fields: [] })).status, 422); // body.apiId != path
  assert.equal((await put('gadget', { apiId: 'gadget', fields: [{ name: 'created_at', type: 'string' }] })).status, 422); // reserved
  assert.equal((await put('post', { apiId: 'post', fields: [{ name: 'title', type: 'string' }], relations: [{ field: 'author', kind: 'manyToOne', target: 'nope' }] })).status, 422); // dangling target
});

test('422 ownership guard via HTTP: a foreign field id on another type rejects; legit rename ok', async () => {
  const alpha = await (await put('alpha', { apiId: 'alpha', fields: [{ name: 'x', type: 'string', options: { nullable: true } }] })).json();
  const beta = await (await put('beta', { apiId: 'beta', fields: [{ name: 'y', type: 'string', options: { nullable: true } }] })).json();

  const forged = await put('beta', { id: beta.schema.id, apiId: 'beta', fields: [{ id: alpha.schema.fields[0].id, name: 'y', type: 'string', options: { nullable: true } }] });
  assert.equal(forged.status, 422); // alpha's field id claimed on beta
  const renamed = await put('beta', { id: beta.schema.id, apiId: 'beta', fields: [{ id: beta.schema.fields[0].id, name: 'renamed', type: 'string', options: { nullable: true } }] });
  assert.equal(renamed.status, 200);
});

test('DELETE of a relation-TARGET type → 422 (inbound relation); GET still 200', async () => {
  await put('writer', { apiId: 'writer', fields: [{ name: 'name', type: 'string', options: { nullable: true } }] });
  await put('post', { apiId: 'post', fields: [{ name: 'title', type: 'string', options: { nullable: true } }], relations: [{ field: 'author', kind: 'manyToOne', target: 'writer' }] });

  const r = await del('writer', { allowDestructive: true });
  assert.equal(r.status, 422); // referenced by post.author
  assert.match((await r.json()).error, /post\.author/);
  assert.equal((await fetch(`${srv.base}/writer`)).status, 200); // still serving
});
