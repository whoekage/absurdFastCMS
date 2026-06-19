import { mkdir, writeFile, readFile, unlink, access } from 'node:fs/promises';
import path from 'node:path';
import { assertStorageKey, ObjectNotFoundError, type StorageProvider } from './provider.ts';

/**
 * be-04 MEDIA — the LOCAL-FILESYSTEM storage provider. Bytes live under a configurable base dir
 * (`config.localStoragePath`); the public URL is `${publicBaseUrl}/uploads/<key>`. No new dependency —
 * `node:fs/promises` + `node:path` only.
 *
 * TRAVERSAL BACKSTOP (two layers): (1) `assertStorageKey` rejects anything off the content-addressed key
 * alphabet — a key already cannot contain `..`/`/`-escape/quote; (2) AFTER the path join we re-assert the
 * resolved absolute path is still UNDER the base dir (`resolved === base || resolved.startsWith(base+sep)`).
 * The same defense-in-depth posture as the SQL identifier gate.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local' as const;
  /** Absolute, normalized base dir the keys resolve under. */
  private readonly base: string;
  /** Public URL prefix (no trailing slash), e.g. `http://localhost:3000`. */
  private readonly publicBaseUrl: string;

  constructor(basePath: string, publicBaseUrl: string) {
    this.base = path.resolve(basePath);
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/, '');
  }

  /** Resolve a key to an absolute path UNDER the base, throwing if it would escape (belt-and-suspenders). */
  private resolve(key: string): string {
    assertStorageKey(key);
    const resolved = path.resolve(this.base, key);
    const sep = path.sep;
    if (resolved !== this.base && !resolved.startsWith(this.base + sep)) {
      throw new Error('storage key escapes the base directory');
    }
    return resolved;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }

  async get(key: string): Promise<Buffer> {
    const file = this.resolve(key);
    try {
      return await readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ObjectNotFoundError(key);
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    const file = this.resolve(key);
    try {
      await unlink(file);
    } catch (e) {
      // Idempotent: a missing object is not an error.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
  }

  async exists(key: string): Promise<boolean> {
    const file = this.resolve(key);
    try {
      await access(file);
      return true;
    } catch {
      return false;
    }
  }

  url(key: string): string {
    assertStorageKey(key);
    return `${this.publicBaseUrl}/uploads/${key}`;
  }
}
