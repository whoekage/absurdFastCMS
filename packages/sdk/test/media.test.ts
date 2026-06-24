// be-04 — media library + media fields, end-to-end through the SDK against a REAL @conti/api server.
//
// NO MOCKS: a real uWS server over a fresh per-file Postgres + a real local-fs storage temp dir. Drives
// client.upload (multipart), client.assets.{list,get,delete}, and media-field read/write/populate via the
// SDK's own create/findOne/list. Proves the wire surface the admin dogfoods.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Point the local storage provider at a fresh temp dir BEFORE the server (and its memoized provider) boot.
const STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'absurd-sdk-media-'));
process.env.LOCAL_STORAGE_PATH = STORAGE_DIR;
delete process.env.S3_BUCKET;

const { startTestServer, withType } = await import('./server.ts');
const { createClient, BadRequestError, NotFoundError } = await import('../src/index.ts');
const { pngBytes } = await import('../../api/test/storage-fixtures.ts');

let server: Awaited<ReturnType<typeof startTestServer>>;

before(async () => {
  const { resetStorageProvider } = await import('../../api/src/storage/index.ts');
  resetStorageProvider();
  server = await startTestServer('sdk-media');
});

after(async () => {
  if (server) await server.close();
  await rm(STORAGE_DIR, { recursive: true, force: true });
});

test('upload() returns a FileAsset; assets.list/get/delete round-trip', async () => {
  const client = createClient({ baseUrl: server.baseUrl });
  const asset = await client.upload(pngBytes(64, 48), 'hero.png');
  assert.ok(asset.id > 0);
  assert.equal(asset.mime, 'image/png');
  assert.equal(asset.width, 64);
  assert.equal(asset.height, 48);
  assert.equal(asset.provider, 'local');

  const got = await client.assets.get(asset.id);
  assert.equal(got.id, asset.id);

  const page = await client.assets.list({ start: 0, limit: 25 });
  assert.ok(page.data.some((a) => a.id === asset.id));
  assert.ok(page.meta.pagination.total >= 1);

  const deleted = await client.assets.delete(asset.id);
  assert.equal(deleted.id, asset.id);
  await assert.rejects(() => client.assets.get(asset.id), NotFoundError);
});

test('upload() dedups identical bytes to the same asset id', async () => {
  const client = createClient({ baseUrl: server.baseUrl });
  const bytes = pngBytes(16, 16);
  const a = await client.upload(bytes, 'a.png');
  const b = await client.upload(bytes, 'b-different-name.png');
  assert.equal(b.id, a.id);
});

test('SINGLE media field: write an id, read raw, read populated to a FileAsset object', async () => {
  const client = createClient({ baseUrl: server.baseUrl });
  await withType(
    server,
    { apiId: 'product', fields: [
      { name: 'title', cmsType: 'string', options: { nullable: false } },
      { name: 'cover', cmsType: 'media' },
    ] },
    async (apiId) => {
      const asset = await client.upload(pngBytes(30, 20), 'cover.png');
      const created = await client.create(apiId, { title: 'Widget', cover: asset.id });
      assert.equal(created.data.cover, asset.id); // raw id un-populated.

      const raw = await client.findOne(apiId, created.data.id as number);
      assert.equal(raw.data.cover, asset.id);

      const pop = await client.findOne(apiId, created.data.id as number, { populate: ['cover'] });
      const cover = pop.data.cover as { id: number; mime: string; width: number };
      assert.equal(cover.id, asset.id);
      assert.equal(cover.mime, 'image/png');
      assert.equal(cover.width, 30);
    },
  );
});

test('MULTIPLE media field: write an id array, populate to an ordered FileAsset[] ', async () => {
  const client = createClient({ baseUrl: server.baseUrl });
  await withType(
    server,
    { apiId: 'gallery', fields: [
      { name: 'name', cmsType: 'string', options: { nullable: false } },
      { name: 'photos', cmsType: 'media', options: { multiple: true } },
    ] },
    async (apiId) => {
      const a = await client.upload(pngBytes(10, 10), 'a.png');
      const b = await client.upload(pngBytes(11, 11), 'b.png');
      const created = await client.create(apiId, { name: 'trip', photos: [a.id, b.id] });
      assert.deepEqual(created.data.photos, [a.id, b.id]);

      const pop = await client.findOne(apiId, created.data.id as number, { populate: ['photos'] });
      const photos = pop.data.photos as { id: number }[];
      assert.deepEqual(photos.map((p) => p.id), [a.id, b.id]); // order preserved.

      // List populate works too.
      const list = await client.list(apiId, { populate: ['photos'] });
      const row = list.data.find((r) => (r.id as number) === created.data.id)!;
      assert.equal((row.photos as { id: number }[]).length, 2);
    },
  );
});

test('VALIDATION: a non-existent / non-positive media id is a 400', async () => {
  const client = createClient({ baseUrl: server.baseUrl });
  await withType(
    server,
    { apiId: 'doc', fields: [
      { name: 'title', cmsType: 'string', options: { nullable: false } },
      { name: 'cover', cmsType: 'media' },
    ] },
    async (apiId) => {
      await assert.rejects(() => client.create(apiId, { title: 'x', cover: 99999999 }), BadRequestError);
      await assert.rejects(() => client.create(apiId, { title: 'x', cover: 0 }), BadRequestError);
      await assert.rejects(() => client.create(apiId, { title: 'x', cover: -1 }), BadRequestError);
    },
  );
});

test('media field is projected with cmsType + multiple flag', async () => {
  const client = createClient({ baseUrl: server.baseUrl });
  await withType(
    server,
    { apiId: 'asset_owner', fields: [
      { name: 'single', cmsType: 'media' },
      { name: 'many', cmsType: 'media', options: { multiple: true } },
    ] },
    async (apiId) => {
      const def = await client.contentTypes.get(apiId);
      const single = def.fields.find((f) => f.name === 'single')!;
      const many = def.fields.find((f) => f.name === 'many')!;
      assert.equal(single.cmsType, 'media');
      assert.equal(single.multiple, false);
      assert.equal(many.cmsType, 'media');
      assert.equal(many.multiple, true);
    },
  );
});
