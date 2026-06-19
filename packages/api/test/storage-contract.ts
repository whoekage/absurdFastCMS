import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectNotFoundError, type StorageProvider } from '../src/storage/provider.ts';

/**
 * be-04 MEDIA — the provider CONTRACT suite, run UNCHANGED against BOTH the local-fs provider (real temp
 * dir) and the S3 provider (real MinIO). Proves put/get round-trip the exact bytes, exists tracks
 * presence, delete removes AND is idempotent, get throws ObjectNotFoundError on a missing key, and url is
 * a pure non-empty string. No mocks: each provider talks to its real backend.
 */
export function runProviderContract(label: string, makeProvider: () => StorageProvider): void {
  // A valid content-addressed key (matches STORAGE_KEY_RE): 2/2 hex fan-out + 64-hex stem + ext.
  const key = `ab/cd/${'a'.repeat(64)}.png`;
  const bytes = Buffer.from('the quick brown fox \u{1f98a} jumps', 'utf8');

  test(`[${label}] put then get round-trips the exact bytes`, async () => {
    const p = makeProvider();
    await p.delete(key); // clean any leftover from a reused container
    await p.put(key, bytes, 'image/png');
    const got = await p.get(key);
    assert.ok(Buffer.isBuffer(got));
    assert.equal(Buffer.compare(got, bytes), 0, 'bytes must round-trip identically');
    await p.delete(key);
  });

  test(`[${label}] exists tracks presence`, async () => {
    const p = makeProvider();
    await p.delete(key);
    assert.equal(await p.exists(key), false);
    await p.put(key, bytes, 'image/png');
    assert.equal(await p.exists(key), true);
    await p.delete(key);
    assert.equal(await p.exists(key), false);
  });

  test(`[${label}] delete removes the bytes and is idempotent`, async () => {
    const p = makeProvider();
    await p.put(key, bytes, 'image/png');
    await p.delete(key);
    assert.equal(await p.exists(key), false);
    // Idempotent: deleting a missing key is NOT an error.
    await p.delete(key);
    await p.delete(key);
  });

  test(`[${label}] get on a missing key throws ObjectNotFoundError`, async () => {
    const p = makeProvider();
    await p.delete(key);
    await assert.rejects(() => p.get(key), (e) => e instanceof ObjectNotFoundError);
  });

  test(`[${label}] url is a pure non-empty string containing the key`, () => {
    const p = makeProvider();
    const u = p.url(key);
    assert.equal(typeof u, 'string');
    assert.ok(u.includes(key), 'url should embed the storage key');
  });

  test(`[${label}] a traversal-shaped key is rejected by the identifier gate`, async () => {
    const p = makeProvider();
    await assert.rejects(() => p.get('../../etc/passwd'));
    await assert.rejects(() => p.put('../escape', bytes, 'text/plain'));
  });
}
