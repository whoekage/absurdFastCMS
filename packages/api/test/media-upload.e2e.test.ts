import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Sql } from 'postgres';

// Point the local storage provider at a fresh temp dir BEFORE any config access (config caches on first
// read). Done at module top so the singleton getStorageProvider() resolves to this dir for the whole file.
const STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'absurd-media-e2e-'));
process.env.LOCAL_STORAGE_PATH = STORAGE_DIR;
delete process.env.S3_BUCKET; // ensure the LOCAL provider is selected in this run.

const { runMigrations } = await import('../src/db/migration.runner.ts');
const { createFileDatabase, dropFileDatabase } = await import('./db-per-file.ts');
const { startTestServerFromSchemas } = await import('./helpers.ts');
const { getStorageProvider, resetStorageProvider } = await import('../src/storage/index.ts');
const { pngBytes, textBytes } = await import('./storage-fixtures.ts');

/**
 * be-04 MEDIA — the upload-route E2E over a REAL uWS server + REAL Postgres (per-file clone) + REAL
 * local-fs storage (a temp dir). NO mocks anywhere. Exercises busboy -> provider -> repo end-to-end via a
 * real multipart/form-data fetch (Node 24 FormData + Blob), then asserts the files row + that the bytes
 * are physically retrievable through the provider. Also proves: dedup, non-image null dims, oversized
 * reject, traversal-filename sanitization, and delete-removes-both.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let base: string;
let close: (token: unknown) => void;
let token: unknown;

before(async () => {
  resetStorageProvider();
  db = await createFileDatabase('mediaupload');
  sql = db.sql;
  await runMigrations(db.url);
  const srv = await startTestServerFromSchemas(sql, []); // media routes are catalog-agnostic; empty schema

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

interface Asset {
  id: number; filename: string; mime: string; size: number;
  width: number | null; height: number | null; hash: string;
  provider: string; storageKey: string; url: string | null; createdAt: string;
}

async function upload(bytes: Buffer, filename: string, mime: string): Promise<Response> {
  const fd = new FormData();
  fd.set('file', new Blob([bytes], { type: mime }), filename);
  return fetch(`${base}/_files/upload`, { method: 'POST', body: fd });
}

test('upload a real PNG: 201, row carries sniffed mime/size/dims/hash, bytes are retrievable', async () => {
  const bytes = pngBytes(20, 30);
  const res = await upload(bytes, 'photo.png', 'image/png');
  assert.equal(res.status, 201);
  const { data } = (await res.json()) as { data: Asset };
  assert.equal(data.mime, 'image/png');
  assert.equal(data.size, bytes.byteLength);
  assert.equal(data.width, 20);
  assert.equal(data.height, 30);
  assert.match(data.hash, /^[a-f0-9]{64}$/);
  assert.equal(data.provider, 'local');
  assert.match(data.storageKey, /^[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.png$/);

  // The bytes are physically retrievable through the SAME provider the server wrote them with.
  const got = await getStorageProvider().get(data.storageKey);
  assert.equal(Buffer.compare(got, bytes), 0);

  // GET /_files/:id returns the same row; GET /_files lists it.
  const one = (await (await fetch(`${base}/_files/${data.id}`)).json()) as { data: Asset };
  assert.equal(one.data.id, data.id);
  const listed = (await (await fetch(`${base}/_files`)).json()) as { data: Asset[]; meta: { pagination: { total: number } } };
  assert.ok(listed.data.some((a) => a.id === data.id));
  assert.ok(listed.meta.pagination.total >= 1);
});

test('dedup: re-uploading identical bytes returns the SAME row (200, no new id)', async () => {
  const bytes = pngBytes(8, 8);
  const first = (await (await upload(bytes, 'a.png', 'image/png')).json()) as { data: Asset };
  const second = await upload(bytes, 'different-name.png', 'image/png');
  assert.equal(second.status, 200); // dedup short-circuit (not 201)
  const { data } = (await second.json()) as { data: Asset };
  assert.equal(data.id, first.data.id);
  assert.equal(data.hash, first.data.hash);
});

test('non-image upload records null dimensions', async () => {
  const bytes = textBytes('plain text file content here');
  const res = await upload(bytes, 'notes.txt', 'text/plain');
  assert.equal(res.status, 201);
  const { data } = (await res.json()) as { data: Asset };
  assert.equal(data.width, null);
  assert.equal(data.height, null);
  assert.equal(data.mime, 'text/plain');
});

test('empty upload is rejected (400)', async () => {
  const res = await upload(Buffer.alloc(0), 'empty.bin', 'application/octet-stream');
  assert.equal(res.status, 400);
});

test('oversized upload is rejected (413) without a row', async () => {
  // The default cap is 25 MiB; send 26 MiB of zeros.
  const big = Buffer.alloc(26 * 1024 * 1024, 0);
  const res = await upload(big, 'big.bin', 'application/octet-stream');
  assert.equal(res.status, 413);
});

test('a traversal-laden filename is sanitized to a safe basename (no escape)', async () => {
  const bytes = pngBytes(5, 5);
  const res = await upload(bytes, '../../../etc/passwd.png', 'image/png');
  assert.equal(res.status, 201);
  const { data } = (await res.json()) as { data: Asset };
  // The recorded filename is the bare basename over the safe alphabet — no slashes, no `..`.
  assert.ok(!data.filename.includes('/'));
  assert.ok(!data.filename.includes('..'));
  assert.equal(data.filename, 'passwd.png');
  // The storage key is hash-based, never the filename.
  assert.match(data.storageKey, /^[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.png$/);
});

test('a non-multipart upload body is rejected (415)', async () => {
  const res = await fetch(`${base}/_files/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ not: 'multipart' }),
  });
  assert.equal(res.status, 415);
});

test('DELETE removes BOTH the record and the bytes', async () => {
  const bytes = pngBytes(9, 11);
  const created = (await (await upload(bytes, 'del.png', 'image/png')).json()) as { data: Asset };
  const key = created.data.storageKey;
  assert.equal(await getStorageProvider().exists(key), true);

  const del = await fetch(`${base}/_files/${created.data.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);

  // Record gone (404) AND bytes gone.
  assert.equal((await fetch(`${base}/_files/${created.data.id}`)).status, 404);
  assert.equal(await getStorageProvider().exists(key), false);
});

test('DELETE of a missing id is 404', async () => {
  assert.equal((await fetch(`${base}/_files/99999999`, { method: 'DELETE' })).status, 404);
});

test('GET /_files/:id with a non-canonical id is 404', async () => {
  assert.equal((await fetch(`${base}/_files/01`)).status, 404);
  assert.equal((await fetch(`${base}/_files/abc`)).status, 404);
});
