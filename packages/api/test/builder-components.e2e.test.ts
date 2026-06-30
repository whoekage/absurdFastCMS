import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, startTestServerFromFilesWithAuth, closeAuth } from './helpers.ts';

/**
 * The /builder/components route surface (GET list/one, preview, PUT, DELETE) over REAL Postgres (no mocks).
 * Components have NO table, so a write never migrates — it writes modules/components/<name>.ts + swaps the
 * registry. Proves: create/read round-trip; a module field referencing an unknown component is rejected (422)
 * while a defined one is accepted and its nested instance validates live; DELETE is blocked while referenced;
 * preview writes nothing; and a component write advances the shared catalog version.
 */

const genDir = fileURLToPath(new URL(`./fixtures/.gen-${process.pid}-components-route/`, import.meta.url));

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let srv: Awaited<ReturnType<typeof startTestServerFromFilesWithAuth>>;
let cookie: string;

before(async () => {
  db = await createFileDatabase('builder-components');
  sql = db.sql;
});
beforeEach(async () => {
  await cleanCatalog(sql);
  await sql`DROP TABLE IF EXISTS _schema_applied`;
  await rm(genDir, { recursive: true, force: true });
  if (srv) srv.close(srv.token);
  srv = await startTestServerFromFilesWithAuth(sql, genDir);
  const email = `cmp-route-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
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

// Components share the catalog ETag with modules (one version covers both resources).
const ver = async (): Promise<string> => (await fetch(`${srv.base}/builder/modules`)).headers.get('etag') ?? '';
const putc = async (name: string, body: unknown, ifMatch?: string): Promise<Response> =>
  fetch(`${srv.base}/builder/components/${name}`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'if-match': ifMatch ?? (await ver()) }, body: JSON.stringify(body) });
const delc = async (name: string, ifMatch?: string): Promise<Response> =>
  fetch(`${srv.base}/builder/components/${name}`, { method: 'DELETE', headers: { 'content-type': 'application/json', cookie, 'if-match': ifMatch ?? (await ver()) }, body: '{}' });
const previewc = (name: string, body: unknown): Promise<Response> =>
  fetch(`${srv.base}/builder/components/${name}/preview`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
const putModule = async (name: string, body: unknown): Promise<Response> =>
  fetch(`${srv.base}/builder/modules/${name}`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'if-match': await ver() }, body: JSON.stringify(body) });
const delModule = async (name: string): Promise<Response> =>
  fetch(`${srv.base}/builder/modules/${name}`, { method: 'DELETE', headers: { 'content-type': 'application/json', cookie, 'if-match': await ver() }, body: JSON.stringify({ allowDestructive: true }) });

test('PUT create a component → mints ids; GET list/one reflect it', async () => {
  const r = await putc('seo', { name: 'seo', fields: [{ name: 'meta_title', type: 'string', options: { nullable: false } }] });
  assert.equal(r.status, 200);
  const env = (await r.json()) as { ok: boolean; component: { id: string; fields: { id: string }[] } };
  assert.equal(env.ok, true);
  assert.ok(env.component.id.startsWith('cmp_') && env.component.fields[0]!.id.startsWith('f_'));

  const list = (await (await fetch(`${srv.base}/builder/components`)).json()) as { ok: boolean; components: { name: string }[] };
  assert.ok(list.ok && list.components.some((c) => c.name === 'seo'));
  assert.equal((await fetch(`${srv.base}/builder/components/seo`)).status, 200);
  assert.equal((await fetch(`${srv.base}/builder/components/nope`)).status, 404);
});

test('a module field referencing an UNKNOWN component is rejected (422); a defined one validates live', async () => {
  const bad = await putModule('page', { name: 'page', fields: [{ name: 'hero', type: 'component', options: { component: 'missing' } }] });
  assert.equal(bad.status, 422);
  assert.match(((await bad.json()) as { error: string }).error, /unknown component "missing"/);

  await putc('seo', { name: 'seo', fields: [{ name: 'meta_title', type: 'string', options: { nullable: false } }] });
  const mod = await putModule('page', {
    name: 'page',
    fields: [
      { name: 'title', type: 'string', options: { nullable: true } },
      { name: 'seo', type: 'component', options: { component: 'seo' } },
    ],
  });
  assert.equal(mod.status, 200);

  // The component is live after the PUT swap: a nested instance validates + stores.
  const created = await fetch(`${srv.base}/page`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ title: 'Home', seo: { meta_title: 'Welcome' } }) });
  assert.equal(created.status, 201);
  assert.equal(((await created.json()) as { data: { seo: { meta_title: string } } }).data.seo.meta_title, 'Welcome');
});

test('DELETE a component is blocked while a module references it, then succeeds once the reference is gone', async () => {
  await putc('seo', { name: 'seo', fields: [{ name: 'meta_title', type: 'string', options: { nullable: false } }] });
  await putModule('page', { name: 'page', fields: [{ name: 'seo', type: 'component', options: { component: 'seo' } }] });

  const blocked = await delc('seo');
  assert.equal(blocked.status, 422);
  assert.match(((await blocked.json()) as { error: string }).error, /page\.seo/);

  await delModule('page'); // remove the referencing module
  const ok = await delc('seo');
  assert.equal(ok.status, 200);
  assert.equal((await fetch(`${srv.base}/builder/components/seo`)).status, 404);
});

test('POST preview returns the generated source and writes nothing', async () => {
  const p = await previewc('hero', { name: 'hero', fields: [{ name: 'heading', type: 'string' }] });
  assert.equal(p.status, 200);
  assert.match(((await p.json()) as { generatedSource: string }).generatedSource, /defineComponent\(\{/);
  assert.equal((await fetch(`${srv.base}/builder/components/hero`)).status, 404); // dry-run wrote nothing
});

test('a component write advances the shared catalog version (ETag)', async () => {
  const before = await ver();
  await putc('tag', { name: 'tag', fields: [{ name: 'label', type: 'string' }] });
  const after = await ver();
  assert.notEqual(before, after);
});
