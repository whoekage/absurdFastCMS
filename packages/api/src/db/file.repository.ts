import type { Sql } from 'postgres';

/**
 * be-04 MEDIA — the asset registry repository over the system `files` table (NOT a ct_ engine type). All
 * statements use tagged-template queries with BOUND params and FIXED column literals (the entry-repo
 * doctrine: identifiers are never client-derived, values are always bound). `size` is a bigint and comes
 * back from postgres.js as a STRING — {@link rowToAsset} coerces it to a Number (a file size always fits
 * in a JS safe integer well below 2^53).
 */

/** A row of the `files` registry, engine/wire-named (camelCase) for the response envelope. */
export interface FileAsset {
  id: number;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  hash: string;
  provider: string;
  storageKey: string;
  url: string | null;
  createdAt: string;
}

/** The fields to INSERT for a new asset (id/createdAt are DB-assigned). */
export interface NewFileAsset {
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  hash: string;
  provider: string;
  storageKey: string;
  url: string | null;
}

/** Map a raw DB row (snake_case, bigint-as-string) into the wire {@link FileAsset}. */
function rowToAsset(r: Record<string, unknown>): FileAsset {
  return {
    id: r.id as number,
    filename: r.filename as string,
    mime: r.mime as string,
    size: Number(r.size),
    width: r.width === null ? null : (r.width as number),
    height: r.height === null ? null : (r.height as number),
    hash: r.hash as string,
    provider: r.provider as string,
    storageKey: r.storage_key as string,
    url: (r.url as string | null) ?? null,
    createdAt: (r.created_at as Date).toISOString(),
  };
}

/** The SELECT column list (storage_key aliased only positionally; mapped in {@link rowToAsset}). */
const COLS = 'id, filename, mime, size, width, height, hash, provider, storage_key, url, created_at';

/** INSERT one asset, returning the stored row (with its serial id + created_at). */
export async function insertFile(sql: Sql, a: NewFileAsset): Promise<FileAsset> {
  const rows = await sql`
    INSERT INTO files (filename, mime, size, width, height, hash, provider, storage_key, url)
    VALUES (${a.filename}, ${a.mime}, ${a.size}, ${a.width}, ${a.height}, ${a.hash}, ${a.provider}, ${a.storageKey}, ${a.url})
    RETURNING ${sql.unsafe(COLS)}
  `;
  return rowToAsset(rows[0] as Record<string, unknown>);
}

/** Fetch one asset by id, or null when no row carries it. */
export async function getFileById(sql: Sql, id: number): Promise<FileAsset | null> {
  const rows = await sql`SELECT ${sql.unsafe(COLS)} FROM files WHERE id = ${id}`;
  return rows.length ? rowToAsset(rows[0] as Record<string, unknown>) : null;
}

/** Fetch one asset by content hash (the dedup short-circuit), or null. */
export async function getFileByHash(sql: Sql, hash: string): Promise<FileAsset | null> {
  const rows = await sql`SELECT ${sql.unsafe(COLS)} FROM files WHERE hash = ${hash}`;
  return rows.length ? rowToAsset(rows[0] as Record<string, unknown>) : null;
}

/** A page of assets (id-descending), bounded by limit/offset. */
export async function listFiles(sql: Sql, limit: number, offset: number): Promise<FileAsset[]> {
  const rows = await sql`
    SELECT ${sql.unsafe(COLS)} FROM files ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}
  `;
  return (rows as Record<string, unknown>[]).map(rowToAsset);
}

/** Total asset count (for the list-response pagination meta). */
export async function countFiles(sql: Sql): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS n FROM files`;
  return (rows[0] as { n: number }).n;
}

/** DELETE one asset by id, returning the deleted row (so the caller can clean its bytes), or null. */
export async function deleteFile(sql: Sql, id: number): Promise<FileAsset | null> {
  const rows = await sql`DELETE FROM files WHERE id = ${id} RETURNING ${sql.unsafe(COLS)}`;
  return rows.length ? rowToAsset(rows[0] as Record<string, unknown>) : null;
}

/**
 * be-04 MEDIA — the WRITE-side referential-integrity check for media fields. Given candidate `files.id`s
 * referenced by a write body, return the SUBSET that does NOT exist (so the caller 400s naming the
 * dangling ids). There is no DB FK from a ct_ media column to `files` (the engine is a RAM rebuild + a
 * `multiple` jsonb array can't carry a column FK), so this is the existence gate that keeps a write from
 * storing an id pointing at no asset. Empty input -> empty result (no query). Ids bound; IN via `= ANY`.
 * Runs INSIDE the caller's tx so the check + the insert commit atomically.
 */
export async function missingFileIds(sql: Sql, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)];
  const rows = await sql<{ id: number }[]>`SELECT id FROM files WHERE id = ANY(${unique}::int[])`;
  const present = new Set(rows.map((r) => r.id));
  return unique.filter((id) => !present.has(id));
}

/**
 * be-04 MEDIA — fetch many assets by id in ONE round-trip (the populate batch lookup). Returns a Map
 * id -> asset for the ids that exist; a requested id with no row is simply absent (the populate post-step
 * emits `null` for a dangling single ref / drops it from a multiple array). Empty input -> empty Map.
 */
export async function getFilesByIds(sql: Sql, ids: number[]): Promise<Map<number, FileAsset>> {
  const out = new Map<number, FileAsset>();
  if (ids.length === 0) return out;
  const unique = [...new Set(ids)];
  const rows = await sql`SELECT ${sql.unsafe(COLS)} FROM files WHERE id = ANY(${unique}::int[])`;
  for (const r of rows as Record<string, unknown>[]) {
    const a = rowToAsset(r);
    out.set(a.id, a);
  }
  return out;
}
