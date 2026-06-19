/**
 * be-04 MEDIA — the storage PROVIDER abstraction. A provider owns the BYTES of an uploaded asset,
 * keyed by an opaque, content-addressed {@link STORAGE_KEY_RE storage key} (never a raw filename). Two
 * impls exist: `local` (a real filesystem dir) and `s3` (any S3-compatible endpoint via @aws-sdk). The
 * upload pipeline + the asset endpoints speak ONLY this interface, so the byte backend is swappable by
 * config with zero call-site change.
 *
 * SECURITY DOCTRINE (mirrors the SQL identifier gate `assertTableName` in src/db/engine.loader.ts):
 *   - The key is ALWAYS the hash-based safe key (`ab/cd/<sha256hex>.<ext>` — see {@link STORAGE_KEY_RE}),
 *     so it can never carry `..`, an absolute prefix, a backslash, a quote, or a path-traversal segment.
 *   - Every provider RE-VALIDATES the key shape (`assertStorageKey`) before any filesystem path join or
 *     S3 Key — belt-and-suspenders, identical posture to the loader's table-name re-assertion.
 *   - `delete` is IDEMPOTENT (a missing key is NOT an error) — this is what makes the orphan-cleanup
 *     paths (insert-failed rollback, asset-delete) safe to call after the object may already be gone.
 *   - `url(key)` is a PURE SYNC function (no I/O) so it can be spliced into a serialized read response.
 */

/**
 * Content-addressed storage key shape: two hex fan-out dirs + the full sha256 hex + an optional
 * lower-`[a-z0-9]` extension. e.g. `ab/cd/abcd…<64 hex>.png`. NOTHING outside this alphabet is allowed,
 * so a key is structurally incapable of path traversal.
 */
export const STORAGE_KEY_RE = /^[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}(\.[a-z0-9]+)?$/;

/** The two backends a {@link StorageProvider} can be. Recorded in `files.provider`. */
export type ProviderName = 'local' | 's3';

/**
 * The storage backend contract. Keyed by an opaque {@link STORAGE_KEY_RE} key. All byte methods are
 * async (filesystem / network); `url` is pure-sync.
 */
export interface StorageProvider {
  /** Which backend this is — recorded in `files.provider` so a row knows where its bytes live. */
  readonly name: ProviderName;
  /** Write `body` under `key` (overwrite-safe: content-addressed keys make a re-put a no-op in effect). */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Read the bytes at `key`; throws {@link ObjectNotFoundError} when the key is absent. */
  get(key: string): Promise<Buffer>;
  /** Remove the bytes at `key`. IDEMPOTENT: a missing key is NOT an error. */
  delete(key: string): Promise<void>;
  /** Whether `key` currently has bytes. */
  exists(key: string): Promise<boolean>;
  /** The PUBLIC URL for `key` (pure, sync — no I/O). */
  url(key: string): string;
}

/** Thrown by `get` when the key is absent. The endpoints map it to a 404. */
export class ObjectNotFoundError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`object not found`);
    this.name = 'ObjectNotFoundError';
    this.key = key;
  }
}

/**
 * Defense-in-depth: re-assert the {@link STORAGE_KEY_RE} key shape before it is ever joined into a
 * filesystem path or used as an S3 Key. Symmetric with the loader's `assertTableName`. The message NEVER
 * echoes the offending key (no leak).
 */
export function assertStorageKey(key: string): void {
  if (!STORAGE_KEY_RE.test(key)) {
    throw new Error('storage key failed the identifier gate');
  }
}
