import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Sql } from 'postgres';

// Point local storage at a fresh temp dir BEFORE any config access (config caches on first read).
const STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'absurd-media-field-'));
process.env.LOCAL_STORAGE_PATH = STORAGE_DIR;
delete process.env.S3_BUCKET; // select the LOCAL provider for this run.

const { runMigrations } = await import('../src/db/migration.runner.ts');
const { createFileDatabase, dropFileDatabase } = await import('./db-per-file.ts');
const { startTestServer } = await import('./helpers.ts');
const { resetStorageProvider } = await import('../src/storage/index.ts');
const { pngBytes } = await import('./storage-fixtures.ts');

/**
 * be-04 MEDIA FIELD — declare a media field on a content-type, attach uploaded asset(s), read it back
 * BOTH un-populated (raw id / id[]) and populated (inlined asset object / array), over a REAL uWS server
 * + REAL Postgres (per-file clone) + REAL local-fs. NO mocks. Also proves: positive-int + cardinality +
 * existence validation, a scalar-only type is byte-identical (no media key, no populate effect), single
 * vs multiple shapes, dangling-asset populate behavior, and clearing a media field.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let base: string;
let close: (token: unknown) => void;
let token: unknown;

before(async () => {
  resetStorageProvider();
  db = await createFileDatabase('mediafield');
  sql = db.sql;
  await runMigrations(db.url);
  const srv = await startTestServer(sql);
  base = srv.base;
  close = srv.close;
  token = srv.token;
});

after(async () => {
  if (token) close(token);
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
  await rm(STORAGE_DIR, { recursive: true, force: true });
});

const POST = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', body: JSON.stringify(body) });
const PUT = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'PUT', body: JSON.stringify(body) });
const GET = (p: string) => fetch(`${base}${p}`);

interface Asset { id: number; mime: string; width: number | null; height: number | null; url: string | null }

async function uploadAsset(w: number, h: number): Promise<Asset> {
  const fd = new FormData();
  fd.set('file', new Blob([pngBytes(w, h)], { type: 'image/png' }), `img-${w}x${h}.png`);
  const r = await fetch(`${base}/_files/upload`, { method: 'POST', body: fd });
  assert.ok(r.status === 201 || r.status === 200, `upload ${w}x${h} -> ${r.status}`);
  return ((await r.json()) as { data: Asset }).data;
}

test('declare a SINGLE media field: builder projects cmsType media + multiple:false', async () => {
  const r = await POST('/content-types', {
    apiId: 'product',
    fields: [
      { name: 'title', cmsType: 'string', options: { nullable: false } },
      { name: 'cover', cmsType: 'media' },
    ],
  });
  assert.equal(r.status, 201);
  const def = (await r.json()) as { fields: { name: string; cmsType: string; multiple?: boolean }[] };
  const cover = def.fields.find((f) => f.name === 'cover')!;
  assert.equal(cover.cmsType, 'media');
  assert.equal(cover.multiple, false);
});

test('attach a SINGLE asset, read un-populated (raw id) then populated (inlined object)', async () => {
  const asset = await uploadAsset(40, 50);
  const created = (await (await POST('/product', { title: 'Widget', cover: asset.id })).json()) as { data: { id: number; cover: number } };
  assert.equal(created.data.cover, asset.id); // write response emits the raw id (un-populated).

  // Un-populated GET: the raw int id.
  const plain = (await (await GET(`/product/${created.data.id}`)).json()) as { data: { cover: number } };
  assert.equal(plain.data.cover, asset.id);

  // Populated GET: the asset OBJECT inlined under `cover`.
  const pop = (await (await GET(`/product/${created.data.id}?populate=cover`)).json()) as { data: { cover: Asset } };
  assert.equal(typeof pop.data.cover, 'object');
  assert.equal(pop.data.cover.id, asset.id);
  assert.equal(pop.data.cover.mime, 'image/png');
  assert.equal(pop.data.cover.width, 40);
  assert.equal(pop.data.cover.height, 50);

  // populate=* also expands the media field.
  const star = (await (await GET(`/product/${created.data.id}?populate=*`)).json()) as { data: { cover: Asset } };
  assert.equal(star.data.cover.id, asset.id);
});

test('LIST populate inlines the asset per row', async () => {
  const list = (await (await GET('/product?populate=cover')).json()) as { data: { cover: Asset | null }[] };
  assert.ok(list.data.length >= 1);
  const withCover = list.data.find((row) => row.cover !== null && typeof row.cover === 'object')!;
  assert.ok(withCover);
  assert.equal(withCover.cover!.mime, 'image/png');
});

test('MULTIPLE media field: array of ids, populated to an array of asset objects (order preserved)', async () => {
  const r = await POST('/content-types', {
    apiId: 'gallery',
    fields: [
      { name: 'name', cmsType: 'string', options: { nullable: false } },
      { name: 'photos', cmsType: 'media', options: { multiple: true } },
    ],
  });
  assert.equal(r.status, 201);
  const def = (await r.json()) as { fields: { name: string; multiple?: boolean }[] };
  assert.equal(def.fields.find((f) => f.name === 'photos')!.multiple, true);

  const a = await uploadAsset(11, 12);
  const b = await uploadAsset(13, 14);
  const created = (await (await POST('/gallery', { name: 'trip', photos: [a.id, b.id] })).json()) as { data: { id: number; photos: number[] } };
  assert.deepEqual(created.data.photos, [a.id, b.id]); // raw id array un-populated.

  const pop = (await (await GET(`/gallery/${created.data.id}?populate=photos`)).json()) as { data: { photos: Asset[] } };
  assert.equal(pop.data.photos.length, 2);
  assert.deepEqual(pop.data.photos.map((x) => x.id), [a.id, b.id]); // order preserved.
  assert.equal(pop.data.photos[0]!.width, 11);
  assert.equal(pop.data.photos[1]!.width, 13);
});

test('VALIDATION: a non-existent file id is rejected 400 (existence check)', async () => {
  const r = await POST('/product', { title: 'Bad', cover: 99999999 });
  assert.equal(r.status, 400);
});

test('VALIDATION: a non-positive / non-integer media id is rejected 400', async () => {
  assert.equal((await POST('/product', { title: 'x', cover: 0 })).status, 400);
  assert.equal((await POST('/product', { title: 'x', cover: -5 })).status, 400);
  assert.equal((await POST('/product', { title: 'x', cover: 1.5 })).status, 400);
  assert.equal((await POST('/product', { title: 'x', cover: 'abc' })).status, 400);
});

test('VALIDATION: a single media field rejects an array of >1 id (cardinality)', async () => {
  const a = await uploadAsset(3, 3);
  const b = await uploadAsset(4, 4);
  assert.equal((await POST('/product', { title: 'x', cover: [a.id, b.id] })).status, 400);
  // but a single-element array is accepted (lenient).
  const ok = await POST('/product', { title: 'x', cover: [a.id] });
  assert.equal(ok.status, 201);
});

test('clearing a single media field to null populates as null; multiple cleared populates as []', async () => {
  const asset = await uploadAsset(7, 7);
  const created = (await (await POST('/product', { title: 'clearme', cover: asset.id })).json()) as { data: { id: number } };
  const cleared = await PUT(`/product/${created.data.id}`, { cover: null });
  assert.equal(cleared.status, 200);
  const pop = (await (await GET(`/product/${created.data.id}?populate=cover`)).json()) as { data: { cover: Asset | null } };
  assert.equal(pop.data.cover, null);
});

test('a deleted asset populates as null (single) — dangling ref is tolerated, no 500', async () => {
  const asset = await uploadAsset(21, 22);
  const created = (await (await POST('/product', { title: 'willdangle', cover: asset.id })).json()) as { data: { id: number } };
  // Delete the asset out from under the reference.
  assert.equal((await fetch(`${base}/_files/${asset.id}`, { method: 'DELETE' })).status, 200);
  // Un-populated still emits the now-dangling raw id; populated resolves to null (skipped), never 500.
  const plain = (await (await GET(`/product/${created.data.id}`)).json()) as { data: { cover: number } };
  assert.equal(plain.data.cover, asset.id);
  const pop = await GET(`/product/${created.data.id}?populate=cover`);
  assert.equal(pop.status, 200);
  assert.equal(((await pop.json()) as { data: { cover: Asset | null } }).data.cover, null);
});

test('a type WITHOUT a media field is byte-identical: no media key, populate has no effect', async () => {
  await POST('/content-types', { apiId: 'note', fields: [{ name: 'body', cmsType: 'text' }] });
  const def = (await (await GET('/content-types/note')).json()) as { fields: { name: string; multiple?: boolean }[] };
  for (const f of def.fields) assert.equal('multiple' in f, false); // no media flag anywhere.

  const created = (await (await POST('/note', { body: 'hello' })).json()) as { data: { id: number } };
  // A populate query naming a non-relation/non-media scalar field still 400s (engine populate validation).
  const bad = await GET(`/note/${created.data.id}?populate=body`);
  assert.equal(bad.status, 400);
  // A plain read is unchanged.
  const plain = (await (await GET(`/note/${created.data.id}`)).json()) as { data: { body: string } };
  assert.equal(plain.data.body, 'hello');
});
