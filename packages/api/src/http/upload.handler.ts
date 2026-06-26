import type { Sql } from 'postgres';
import { type CoreResponse, JSON_CT, errorResponse } from './read.router.ts';
import type { StorageProvider } from '../storage/provider.ts';
import { ObjectNotFoundError } from '../storage/provider.ts';
import { extractMetadata, storageKeyFor } from '../storage/metadata.ts';
import {
  insertFile,
  getFileById,
  getFileByHash,
  listFiles,
  countFiles,
  deleteFile,
  type FileAsset,
} from '../db/file.repository.ts';

/**
 * be-04 MEDIA — the pure CORE for the asset endpoints. Mirrors the other cores' shape:
 * pure-ish functions returning a {@link CoreResponse} `{status,contentType,body}`. The server (`server.ts`)
 * does only uWS plumbing (read the multipart stream into a buffer, call here, cork the response).
 *
 *   handleUpload   — POST /_files/upload : sniff metadata, dedup by hash, put bytes, insert the row.
 *   handleListFiles— GET  /_files        : paged list (offset meta).
 *   handleGetFile  — GET  /_files/:id    : one asset (404 if absent).
 *   handleDeleteFile DELETE /_files/:id  : remove BOTH bytes and record (bytes-first; partial-fail safe).
 */
export interface FileContext {
  sql: Sql;
  provider: StorageProvider;
}

/** A successfully-parsed multipart upload, handed to {@link handleUpload} by the server's busboy stream. */
export interface ParsedUpload {
  /** The single file's bytes (already bounded by the upload cap). */
  bytes: Buffer;
  /** The SANITIZED original filename (basename, `[A-Za-z0-9._-]` only) — display/ext only, never a key. */
  filename: string;
  /** The client-declared part mime (trusted only as a fallback when the bytes aren't a sniffable image). */
  declaredMime: string;
}

const JSON_HEADERS = JSON_CT;

/** Serialize one asset as the single-item envelope `{data:<asset>}`. */
function single(status: number, asset: FileAsset): CoreResponse {
  return { status, contentType: JSON_HEADERS, body: Buffer.from(JSON.stringify({ data: asset }), 'utf8') };
}

/**
 * UPLOAD core. Given the parsed file, derive metadata + the content-addressed key, dedup by hash, store
 * the bytes, then insert the record. PARTIAL-FAILURE: bytes are put BEFORE the insert; if the insert
 * fails the bytes are deleted (idempotent) so no orphan is left, and the error surfaces. A concurrent
 * upload of the SAME bytes can race to the unique `files_hash_uq` — that 23505 is treated as "already
 * have it": we re-read by hash and return the winner's row (idempotent, no orphan since the key is shared).
 */
export async function handleUpload(ctx: FileContext, up: ParsedUpload): Promise<CoreResponse> {
  if (up.bytes.byteLength === 0) return errorResponse(400, 'empty upload');

  const meta = extractMetadata(up.bytes, up.declaredMime, up.filename);

  // Dedup short-circuit: identical bytes already stored => return the existing row (200, not 201).
  const existing = await getFileByHash(ctx.sql, meta.hash);
  if (existing !== null) return single(200, existing);

  const key = storageKeyFor(meta.hash, meta.ext);
  await ctx.provider.put(key, up.bytes, meta.mime);

  try {
    const asset = await insertFile(ctx.sql, {
      filename: up.filename,
      mime: meta.mime,
      size: meta.size,
      width: meta.width,
      height: meta.height,
      hash: meta.hash,
      provider: ctx.provider.name,
      storageKey: key,
      url: ctx.provider.url(key),
    });
    return single(201, asset);
  } catch (e) {
    // Concurrent same-hash upload won the unique index: the bytes are the SAME (content-addressed key),
    // so the winner's bytes are already correct — return their row, do NOT delete the shared key.
    if ((e as { code?: string }).code === '23505') {
      const winner = await getFileByHash(ctx.sql, meta.hash);
      if (winner !== null) return single(200, winner);
    }
    // Any other insert failure: roll back the bytes we just wrote (idempotent) so no orphan is left.
    await ctx.provider.delete(key).catch(() => {});
    throw e;
  }
}

/** LIST core: a page of assets with offset pagination meta `{data,meta:{pagination:{...}}}`. */
export async function handleListFiles(ctx: FileContext, start: number, limit: number): Promise<CoreResponse> {
  const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 25;
  const safeStart = Number.isInteger(start) && start >= 0 ? start : 0;
  const [rows, total] = await Promise.all([
    listFiles(ctx.sql, safeLimit, safeStart),
    countFiles(ctx.sql),
  ]);
  const body = JSON.stringify({ data: rows, meta: { pagination: { start: safeStart, limit: safeLimit, total } } });
  return { status: 200, contentType: JSON_HEADERS, body: Buffer.from(body, 'utf8') };
}

/** GET-one core: the asset, or 404. */
export async function handleGetFile(ctx: FileContext, id: number): Promise<CoreResponse> {
  const asset = await getFileById(ctx.sql, id);
  if (asset === null) return errorResponse(404, 'not found');
  return single(200, asset);
}

/**
 * DELETE core: remove BOTH the bytes and the record. ORDER = bytes-FIRST: a dangling record (record kept,
 * bytes gone) is self-healing — the row can be re-deleted and `provider.delete` is idempotent — whereas
 * orphan bytes (record gone, bytes kept) leak silently and unreachably. So we read the row (404 if gone),
 * delete the bytes (idempotent — a missing object is fine), then delete the record. A byte-delete failure
 * surfaces as a thrown error (=> 500) BEFORE the record is removed, so the caller can retry.
 */
export async function handleDeleteFile(ctx: FileContext, id: number): Promise<CoreResponse> {
  const asset = await getFileById(ctx.sql, id);
  if (asset === null) return errorResponse(404, 'not found');
  // Bytes first (idempotent). A failure here throws => 500, record intact => retryable.
  await ctx.provider.delete(asset.storageKey);
  const deleted = await deleteFile(ctx.sql, id);
  // If the row vanished between the read and the delete (concurrent delete), still report the asset.
  return single(200, deleted ?? asset);
}

export { ObjectNotFoundError };
