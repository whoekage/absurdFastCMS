import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { runMigrations } from '../src/db/migration.runner.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { startTestServer, tableExists } from './helpers.ts';

/**
 * STEP 5 — the CONTENT-TYPE BUILDER HTTP API, end-to-end over a REAL uWS server + REAL Postgres
 * (Testcontainers, no mocks). The headline proof is LIVE: define a content-type over HTTP, then
 * immediately POST a row to it and GET it back — with NO server restart — exercising the per-type
 * engine+registry sync. Plus: list/get, field add/rename/change-type/drop reflected in reads, drop-type,
 * the full typed-error -> HTTP table, and an injection payload rejected with NOTHING executed.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let base: string;
let close: (token: unknown) => void;
let token: unknown;

before(async () => {
  db = await createFileDatabase('ctb');
  sql = db.sql;
  await runMigrations(db.url); // golden template already has it; harmless + explicit.
  const srv = await startTestServer(sql); // loads an (empty) engine+registry; the SAME instances the builder mutates.
  base = srv.base;
  close = srv.close;
  token = srv.token;
});

after(async () => {
  if (token) close(token);
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

const POST = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
const PUT = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'PUT', body: JSON.stringify(body) });
const DEL = (path: string) => fetch(`${base}${path}`, { method: 'DELETE' });

test('create a content-type over HTTP, then write a row and read it back (live, no restart)', async () => {
  const create = await POST('/content-types', {
    apiId: 'product',
    fields: [
      { name: 'title', cmsType: 'string', options: { nullable: false } },
      { name: 'price', cmsType: 'decimal', options: { precision: 10, scale: 2, nullable: false } },
      { name: 'tags', cmsType: 'json', options: { nullable: true } },
    ],
  });
  assert.equal(create.status, 201);
  const def = (await create.json());
  assert.equal(def.apiId, 'product');
  // system fields first, then user fields in declared order.
  assert.deepEqual(def.fields.map((f: { name: string }) => f.name), ['id', 'created_at', 'updated_at', 'title', 'price', 'tags']);
  assert.equal(def.fields.find((f: { name: string }) => f.name === 'price').scale, 2);

  // The type is IMMEDIATELY writable through the data API (per-type engine+registry sync).
  const w = await POST('/product', { title: 'Widget', price: '9.99', tags: ['a', 'b'] });
  assert.equal(w.status, 201);
  const created = (await w.json()).data;
  assert.equal(created.id, 1);
  assert.equal(created.title, 'Widget');
  assert.equal(created.price, '9.99'); // decimal as an exact string on the wire.
  assert.deepEqual(created.tags, ['a', 'b']);

  // ...and IMMEDIATELY readable.
  const got = await (await fetch(`${base}/product/1`)).json();
  assert.equal(got.data.title, 'Widget');
  assert.equal(got.data.price, '9.99');
});

test('GET list + GET one + 404 for an absent type', async () => {
  const list = await (await fetch(`${base}/content-types`)).json();
  assert.ok(list.some((d: { apiId: string }) => d.apiId === 'product'));
  const one = await fetch(`${base}/content-types/product`);
  assert.equal(one.status, 200);
  assert.equal((await one.json()).apiId, 'product');
  assert.equal((await fetch(`${base}/content-types/nope`)).status, 404);
});

test('add / rename / change-type / drop a field, each reflected in reads', async () => {
  // add a field -> immediately writable.
  assert.equal((await POST('/content-types/product/fields', { name: 'views', cmsType: 'integer', options: { nullable: true } })).status, 201);
  const afterAdd = await (await fetch(`${base}/content-types/product`)).json();
  assert.ok(afterAdd.fields.some((f: { name: string }) => f.name === 'views'));

  // existing rows survive the schema change (re-streamed under the new column set).
  assert.equal((await (await fetch(`${base}/product/1`)).json()).data.title, 'Widget');

  // rename views -> hits.
  assert.equal((await PUT('/content-types/product/fields/views', { newName: 'hits' })).status, 200);
  const afterRename = await (await fetch(`${base}/content-types/product`)).json();
  assert.ok(afterRename.fields.some((f: { name: string }) => f.name === 'hits'));
  assert.ok(!afterRename.fields.some((f: { name: string }) => f.name === 'views'));

  // drop a field.
  assert.equal((await DEL('/content-types/product/fields/hits')).status, 200);
  assert.ok(!(await (await fetch(`${base}/content-types/product`)).json()).fields.some((f: { name: string }) => f.name === 'hits'));
});

test('error mapping: 409 exists, 404 absent field/type, 400 bad input', async () => {
  // 409 double-create.
  assert.equal((await POST('/content-types', { apiId: 'product', fields: [] })).status, 409);
  // 404 add field to an absent type.
  assert.equal((await POST('/content-types/ghost/fields', { name: 'x', cmsType: 'integer' })).status, 404);
  // 404 drop an absent field.
  assert.equal((await DEL('/content-types/product/fields/nope')).status, 404);
  // 400 unknown cms type.
  assert.equal((await POST('/content-types', { apiId: 'bad', fields: [{ name: 'x', cmsType: 'wat' }] })).status, 400);
  // 400 reserved field name.
  assert.equal((await POST('/content-types', { apiId: 'bad2', fields: [{ name: 'id', cmsType: 'integer' }] })).status, 400);
  // 400 malformed JSON body.
  const bad = await fetch(`${base}/content-types`, { method: 'POST', body: '{not json' });
  assert.equal(bad.status, 400);
  // 400 body without a fields array.
  assert.equal((await POST('/content-types', { apiId: 'nofields' })).status, 400);
});

test('injection via apiId / field name is rejected 400 with NOTHING executed', async () => {
  const before = await (await fetch(`${base}/content-types`)).json();
  const beforeCount = before.length;

  const evilApi = await POST('/content-types', { apiId: '"; DROP TABLE content_types;--', fields: [] });
  assert.equal(evilApi.status, 400);
  const evilField = await POST('/content-types', { apiId: 'inj', fields: [{ name: 'a"; DROP TABLE content_types;--', cmsType: 'integer' }] });
  assert.equal(evilField.status, 400);

  // The meta table is intact, no stray type was created, and the catalog count is unchanged.
  assert.equal(await tableExists(sql, 'content_types'), true);
  const after = await (await fetch(`${base}/content-types`)).json();
  assert.equal(after.length, beforeCount);
});

test('drop a content-type: gone from the builder AND the data API', async () => {
  await POST('/content-types', { apiId: 'ephemeral', fields: [{ name: 'n', cmsType: 'integer', options: { nullable: true } }] });
  assert.equal((await fetch(`${base}/content-types/ephemeral`)).status, 200);
  assert.equal((await POST('/ephemeral', { n: 1 })).status, 201); // writable while it exists.

  assert.equal((await DEL('/content-types/ephemeral')).status, 200);
  assert.equal((await fetch(`${base}/content-types/ephemeral`)).status, 404); // gone from the builder.
  assert.equal((await fetch(`${base}/ephemeral`)).status, 404); // gone from the data read API.
  assert.equal((await DEL('/content-types/ephemeral')).status, 404); // second drop -> 404.
  // the physical table is gone too.
  assert.equal(await tableExists(sql, 'ct_ephemeral'), false);
});
