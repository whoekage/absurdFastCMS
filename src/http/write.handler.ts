import type { Sql } from 'postgres';
import type { Engine } from '../store/engine.ts';
import type { Registry, ContentTypeDef } from '../store/registry.ts';
import { validateBody, BodyParseError } from '../store/body.parser.ts';
import { insertEntry, updateEntry, deleteEntry, serializeEntry, EntryWriteError } from '../db/entry.repository.ts';
import { applyRelationOps } from '../db/relation.repository.ts';
import { CANONICAL_INT, JSON_CT, errorResponse, type CoreResponse } from './read.router.ts';

/**
 * The Postgres int4 serial PK range upper bound. CANONICAL_INT accepts arbitrarily long digit runs, so
 * an id above this (or beyond a safe JS integer) can never name an existing row — it is uniformly a 404,
 * resolved BEFORE any SQL, so a caller can't distinguish "out of int4 range" (would be a 22003 -> 400)
 * from "id not present" (404).
 */
const MAX_INT4 = 2147483647;

/** Parse the `:id` path segment to an in-range int4, or `null` (treated as a 404 — no such row). */
function parseId(idRaw: string): number | null {
  if (!CANONICAL_INT.test(idRaw)) return null;
  const id = Number(idRaw);
  if (!Number.isSafeInteger(id) || id > MAX_INT4) return null;
  return id;
}

/**
 * The WRITE core — the async counterpart to the pure read {@link handleRequest}. Postgres is the
 * source of truth, so each verb: validates the body against the type's REGISTRY def, commits ONE
 * Postgres statement, then asks the caller to {@link WriteContext.rebuild} ONLY this type's RAM storage
 * (per-type rebuild + per-type cache invalidation — sibling types stay hot) so subsequent reads reflect
 * the write.
 *
 *   POST   /:type      -> 201 { data }   (create; body validated as a full create)
 *   PUT    /:type/:id  -> 200 { data }   (partial update, Strapi semantics; 404 if no such id)
 *   DELETE /:type/:id  -> 200 { data }   (returns the deleted row; 404 if no such id)
 *
 * Errors mirror the read core: {@link BodyParseError}/{@link EntryWriteError} -> 400, unknown type /
 * unknown id -> 404, a non-validation throw propagates (the adapter maps it to 500). No SQL/constraint
 * detail is ever echoed.
 */
export interface WriteContext {
  /** The CURRENT engine (read live each call — its per-type storage is swapped by {@link rebuild}). */
  engine(): Engine;
  /** The runtime registry (resolves the validated def for `:type`). */
  registry(): Registry;
  /** The postgres.js handle (source of truth) for the write statement. */
  sql: Sql;
  /** Refresh + rebuild ONLY this type's RAM storage from Postgres after a committed write. */
  rebuild(type: string): Promise<void>;
}

export interface WriteRequest {
  method: string;
  type: string;
  /** The `:id` path segment for PUT/DELETE (empty for POST). */
  idRaw: string;
  /** The parsed JSON body (`undefined` when the request carried no body). */
  body: unknown;
}

/** Build the write response Buffer: `{"data":<serialized row>,"meta":{}}`, byte-consistent with GET. */
function writeOk(status: number, def: ContentTypeDef, row: Record<string, unknown>): CoreResponse {
  return {
    status,
    contentType: JSON_CT,
    body: Buffer.from(`{"data":${serializeEntry(def, row)},"meta":{}}`, 'utf8'),
  };
}

export async function handleWrite(ctx: WriteContext, req: WriteRequest): Promise<CoreResponse> {
  const { method, type, idRaw, body } = req;
  // Registry membership === engine membership (same canonical api_id). Gate BEFORE any SQL.
  const def = ctx.registry().get(type);
  if (def === undefined || !ctx.engine().has(type)) return errorResponse(404, `unknown content-type "${type}"`);

  try {
    if (method === 'POST') {
      const { data, relationOps } = validateBody(def, body, 'create');
      // ONE tx: INSERT scalars RETURNING id, then apply the relation ops with that id. A FK 23503 on a
      // non-existent related id rolls the WHOLE tx back -> no orphan ct_ row, no partial link write.
      const row = await ctx.sql.begin(async (tx) => {
        const r = await insertEntry(tx, def, data);
        await applyRelationOps(tx, def, Number(r['id']), relationOps);
        return r;
      });
      await ctx.rebuild(type); // AFTER commit: re-derive the CSR so reads (both directions) reflect the edges.
      return writeOk(201, def, row);
    }

    if (method === 'PUT') {
      const id = parseId(idRaw);
      if (id === null) return errorResponse(404, 'not found');
      const { data, relationOps } = validateBody(def, body, 'update');
      // ONE tx: update scalars (also confirms the row exists), then apply relation ops on the URL id.
      const row = await ctx.sql.begin(async (tx) => {
        const r = await updateEntry(tx, def, id, data);
        if (r === null) return null; // missing owner -> abort the tx, do NO link work.
        await applyRelationOps(tx, def, id, relationOps);
        return r;
      });
      if (row === null) return errorResponse(404, 'not found');
      await ctx.rebuild(type);
      return writeOk(200, def, row);
    }

    if (method === 'DELETE') {
      const id = parseId(idRaw);
      if (id === null) return errorResponse(404, 'not found');
      // Single statement; ON DELETE CASCADE prunes this owner's link rows. Wrap for symmetry.
      const row = await ctx.sql.begin((tx) => deleteEntry(tx, def, id));
      if (row === null) return errorResponse(404, 'not found');
      await ctx.rebuild(type);
      return writeOk(200, def, row);
    }

    return errorResponse(405, `method ${method} not allowed`);
  } catch (e) {
    if (e instanceof BodyParseError) return errorResponse(400, e.message);
    if (e instanceof EntryWriteError) return errorResponse(400, e.message);
    throw e; // server bug / DB error -> adapter maps to 500
  }
}
