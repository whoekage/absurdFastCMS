import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog, startTestServerFromFiles } from './helpers.ts';

/**
 * S4 — incremental IR-driven build-then-swap, over REAL Postgres (no mocks). Drives `applyEdit` against a
 * SAME-running uWS server and asserts a GET reflects the change WITHOUT a restart (the live swap): add a
 * type, add a field (a pre-existing row survives the re-stream), lossless field rename, a relation
 * registered live, a FAILED edit keeps last-good serving, a no-op skips the swap, hooks are swap-aware, and
 * the legacy /modules mutation path is 410 while the Builder is active. ALL assertions go via HTTP.
 *
 * (dropType / renameType are handled by swapFromIR but are not reachable through applyEdit's whole-type
 * upsert — they need the S5/S8 id-keyed routes — so they are covered by the migrate suite, not here.)
 */

const genDir = fileURLToPath(new URL(`./fixtures/.gen-${process.pid}-s4/`, import.meta.url));

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let srv: Awaited<ReturnType<typeof startTestServerFromFiles>>;

before(async () => {
  db = await createFileDatabase('engine-swap');
  sql = db.sql;
});
beforeEach(async () => {
  await cleanCatalog(sql);
  await sql`DROP TABLE IF EXISTS _schema_applied`;
  await rm(genDir, { recursive: true, force: true });
  if (srv) srv.close(srv.token);
  srv = await startTestServerFromFiles(sql, genDir); // empty entities dir → empty engine to start
});
after(async () => {
  if (srv) srv.close(srv.token);
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
  await rm(genDir, { recursive: true, force: true });
});

const get = (p: string): Promise<Response> => fetch(`${srv.base}${p}`);
const post = (p: string, body: unknown): Promise<Response> =>
  fetch(`${srv.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const dataOf = async (p: string): Promise<{ data: Record<string, unknown>[] }> => (await get(p)).json() as Promise<{ data: Record<string, unknown>[] }>;

test('1 — ADD a type goes LIVE: GET 404 → applyEdit → GET 200 + writable', async () => {
  assert.equal((await get('/gadget')).status, 404);
  const r = await srv.applyEdit({ apiId: 'gadget', fields: [{ name: 'title', type: 'string', options: { nullable: true } }] });
  assert.ok(r.ok && r.applied!.some((c) => c.kind === 'addType'));
  assert.equal((await get('/gadget')).status, 200); // live, no restart
  assert.equal((await post('/gadget', { title: 'x' })).status, 201);
  assert.equal((await dataOf('/gadget')).data[0]!.title, 'x');
});

test('2 — ADD a field goes LIVE; a pre-existing row survives the re-stream', async () => {
  const created = await srv.applyEdit({ apiId: 'gadget', fields: [{ name: 'title', type: 'string', options: { nullable: true } }] });
  await post('/gadget', { title: 'keep' });
  const id = (await dataOf('/gadget')).data[0]!.id;

  const edit = await srv.applyEdit({
    apiId: 'gadget', id: created.schema!.id,
    fields: [
      { id: created.schema!.fields[0]!.id, name: 'title', type: 'string', options: { nullable: true } },
      { name: 'subtitle', type: 'string', options: { nullable: true } },
    ],
  });
  assert.ok(edit.ok && edit.applied!.some((c) => c.kind === 'addField'));
  const row = (await dataOf('/gadget')).data.find((d) => d.id === id)!;
  assert.equal(row.title, 'keep'); // survived the live re-stream
  assert.equal(row.subtitle ?? null, null); // new nullable column present
});

test('3 — RENAME a field goes LIVE and LOSSLESS: data carries to the new wire key', async () => {
  const created = await srv.applyEdit({ apiId: 'gadget', fields: [{ name: 'title', type: 'string', options: { nullable: true } }] });
  await post('/gadget', { title: 'keep' });

  const edit = await srv.applyEdit({
    apiId: 'gadget', id: created.schema!.id,
    fields: [{ id: created.schema!.fields[0]!.id, name: 'headline', type: 'string', options: { nullable: true } }], // same id, new name
  });
  assert.ok(edit.ok && edit.applied!.some((c) => c.kind === 'renameField'));
  const row = (await dataOf('/gadget')).data[0]!;
  assert.equal(row.headline, 'keep'); // value carried across the rename, served under the new key
  assert.equal('title' in row, false); // old key gone from the live wire shape
});

test('4 — a RELATION is registered LIVE: populate (owner + inverse) resolves, not a 400', async () => {
  await srv.applyEdit({ apiId: 'writer', fields: [{ name: 'name', type: 'string', options: { nullable: true } }] });
  const r = await srv.applyEdit({
    apiId: 'post',
    fields: [{ name: 'title', type: 'string', options: { nullable: true } }],
    relations: [{ field: 'author', kind: 'manyToOne', target: 'writer', inverseField: 'posts' }],
  });
  assert.ok(r.ok && r.applied!.some((c) => c.kind === 'addRelation'));
  assert.equal((await get('/post?populate=author')).status, 200); // owner relation registered post-swap
  assert.equal((await get('/writer?populate=posts')).status, 200); // inverse registered on the target
});

test('6 — a FAILED edit (migrate throws) keeps last-good serving', async () => {
  const created = await srv.applyEdit({ apiId: 'gadget', fields: [{ name: 'title', type: 'string', options: { length: 1024, nullable: true } }] });
  await post('/gadget', { title: 'y'.repeat(1024) }); // over-long row

  // Shrink to 256 WITH allowDestructive: passes lint, but migrate's pre-flight throws MigrationDataLossError.
  await assert.rejects(() => srv.applyEdit({
    apiId: 'gadget', id: created.schema!.id,
    fields: [{ id: created.schema!.fields[0]!.id, name: 'title', type: 'string', options: { length: 256, nullable: true } }],
  }, { allowDestructive: true }));
  // Last-good untouched: still serves + still accepts a 1024-char value (column not shrunk).
  assert.equal((await get('/gadget')).status, 200);
  assert.equal((await post('/gadget', { title: 'z'.repeat(1024) })).status, 201);
});

test('7 — a NO-OP edit (identical IR) is ok with applied:[] and keeps serving', async () => {
  const created = await srv.applyEdit({ apiId: 'gadget', fields: [{ name: 'a', type: 'string', options: { nullable: true } }] });
  const again = await srv.applyEdit({
    apiId: 'gadget', id: created.schema!.id,
    fields: [{ id: created.schema!.fields[0]!.id, name: 'a', type: 'string', options: { nullable: true } }],
  });
  assert.ok(again.ok && again.applied!.length === 0); // no-op → no swap
  assert.equal((await get('/gadget')).status, 200);
});

test('8 — hooks are SWAP-AWARE: a hooks.ts added then picked up on the next edit runs on writes', async () => {
  const created = await srv.applyEdit({ apiId: 'gadget', fields: [{ name: 'title', type: 'string', options: { nullable: true } }] });
  // Drop a hooks.ts beside the (Builder-written) schema.ts: beforeCreate uppercases title.
  await mkdir(path.join(genDir, 'gadget'), { recursive: true });
  await writeFile(
    path.join(genDir, 'gadget', 'hooks.ts'),
    "import { defineHooks } from '@conti/core';\nexport default defineHooks({ beforeCreate(data) { return { ...data, title: String(data.title).toUpperCase() }; } });\n",
  );
  // A real change triggers the swap, which re-loads hooks (the new hooks.ts path is imported fresh).
  await srv.applyEdit({
    apiId: 'gadget', id: created.schema!.id,
    fields: [
      { id: created.schema!.fields[0]!.id, name: 'title', type: 'string', options: { nullable: true } },
      { name: 'note', type: 'string', options: { nullable: true } },
    ],
  });
  await post('/gadget', { title: 'hi', note: 'n' });
  assert.equal((await dataOf('/gadget')).data[0]!.title, 'HI'); // the swapped-in hook ran (live.hooks getter)
});

test('11 — the legacy /modules mutation route is GONE (404); the files-first Builder works', async () => {
  // Legacy-meta teardown: the meta controller is deleted, so POST /modules is no longer a registered
  // route — it falls through to the 404 fallback (was a 410 shim during the transition).
  const r = await fetch(`${srv.base}/modules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 404);
  const ok = await srv.applyEdit({ apiId: 'widget', fields: [{ name: 'a', type: 'string', options: { nullable: true } }] });
  assert.ok(ok.ok);
  assert.equal((await get('/widget')).status, 200);
});
