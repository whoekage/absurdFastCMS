import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalStorageProvider } from '../src/storage/local.provider.ts';
import { extractMetadata, storageKeyFor } from '../src/storage/metadata.ts';
import { runProviderContract } from './storage-contract.ts';
import { pngBytes, textBytes } from './storage-fixtures.ts';

/**
 * be-04 MEDIA — the LOCAL-FS provider against a REAL temp dir (no mocks, real node:fs). Runs the shared
 * provider contract + a metadata-pipeline sanity check (mime/size/dimensions/hash; null dims for a
 * non-image) + a traversal backstop proof that the resolved path stays under the base.
 */

let dir: string;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'absurd-media-local-'));
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

runProviderContract('local', () => new LocalStorageProvider(dir, 'http://localhost:3000'));

test('[local] bytes land at the content-addressed path under the base dir', async () => {
  const p = new LocalStorageProvider(dir, 'http://localhost:3000');
  const bytes = pngBytes(4, 7);
  const meta = extractMetadata(bytes, 'image/png', 'photo.png');
  const key = storageKeyFor(meta.hash, meta.ext);
  await p.put(key, bytes, meta.mime);
  // The real file exists at <dir>/ab/cd/<hash>.png and holds the exact bytes.
  const onDisk = await readFile(path.join(dir, key));
  assert.equal(Buffer.compare(onDisk, bytes), 0);
  assert.equal(p.url(key), `http://localhost:3000/uploads/${key}`);
});

test('[local] metadata: a real PNG records mime/size/dimensions/hash', () => {
  const bytes = pngBytes(12, 34);
  const meta = extractMetadata(bytes, 'application/octet-stream', 'p.png');
  assert.equal(meta.mime, 'image/png'); // sniffed, beats the declared octet-stream
  assert.equal(meta.width, 12);
  assert.equal(meta.height, 34);
  assert.equal(meta.size, bytes.byteLength);
  assert.match(meta.hash, /^[a-f0-9]{64}$/);
  assert.equal(meta.ext, 'png');
});

test('[local] metadata: a non-image records null dimensions gracefully', () => {
  const bytes = textBytes('not an image, just text');
  const meta = extractMetadata(bytes, 'text/plain', 'notes.txt');
  assert.equal(meta.width, null);
  assert.equal(meta.height, null);
  assert.equal(meta.mime, 'text/plain'); // falls back to the declared mime
  assert.equal(meta.size, bytes.byteLength);
  assert.match(meta.hash, /^[a-f0-9]{64}$/);
});

test('[local] identical bytes hash to the identical key (content-addressed dedup)', () => {
  const a = extractMetadata(pngBytes(3, 3), 'image/png', 'a.png');
  const b = extractMetadata(pngBytes(3, 3), 'image/png', 'totally-different-name.png');
  assert.equal(a.hash, b.hash);
  assert.equal(storageKeyFor(a.hash, a.ext), storageKeyFor(b.hash, b.ext));
});
