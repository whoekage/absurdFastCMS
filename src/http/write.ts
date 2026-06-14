import type { Sql } from 'postgres';
import type { Engine } from '../store/engine.ts';
import { parseArticleBody, BodyParseError } from '../store/body-parser.ts';
import { materializeRow } from '../store/content-type.ts';
import { insertArticle, updateArticle, deleteArticle } from '../db/article-repo.ts';
import { CANONICAL_INT, JSON_CT, errorResponse, type CoreResponse } from './router.ts';

/**
 * The WRITE core — the async counterpart to the pure read {@link handleRequest}. Postgres is the
 * source of truth, so each verb: validates the body, commits ONE Postgres statement, then asks the
 * caller to {@link WriteContext.rebuild} the RAM engine from Postgres (full rebuild for this slice —
 * surgical incremental mutation is a later optimization) so subsequent reads reflect the write.
 *
 *   POST   /:type      -> 201 { data }   (create; body validated as a full create)
 *   PUT    /:type/:id  -> 200 { data }   (partial update, Strapi semantics; 404 if no such id)
 *   DELETE /:type/:id  -> 200 { data }   (returns the deleted row; 404 if no such id)
 *
 * Errors mirror the read core: {@link BodyParseError} -> 400, unknown type / unknown id -> 404, a
 * non-validation throw propagates (the adapter maps it to 500).
 */
export interface WriteContext {
  /** The CURRENT engine (read live each call — it is swapped by {@link rebuild}). */
  engine(): Engine;
  /** The postgres.js handle (source of truth) for the write statement. */
  sql: Sql;
  /** Rebuild + atomically swap the RAM engine from Postgres after a committed write. */
  rebuild(): Promise<void>;
}

export interface WriteRequest {
  method: string;
  type: string;
  /** The `:id` path segment for PUT/DELETE (empty for POST). */
  idRaw: string;
  /** The parsed JSON body (`undefined` when the request carried no body). */
  body: unknown;
}

const JSON_OK = (status: number, row: Record<string, unknown>): CoreResponse => ({
  status,
  contentType: JSON_CT,
  body: Buffer.from(JSON.stringify({ data: materializeRow(row), meta: {} }), 'utf8'),
});

export async function handleWrite(ctx: WriteContext, req: WriteRequest): Promise<CoreResponse> {
  const { method, type, idRaw, body } = req;
  if (!ctx.engine().has(type)) return errorResponse(404, `unknown content-type "${type}"`);

  try {
    if (method === 'POST') {
      const data = parseArticleBody(body, 'create');
      const row = await insertArticle(ctx.sql, data);
      await ctx.rebuild();
      return JSON_OK(201, row);
    }

    if (method === 'PUT') {
      if (!CANONICAL_INT.test(idRaw)) return errorResponse(404, 'not found');
      const data = parseArticleBody(body, 'update');
      const row = await updateArticle(ctx.sql, Number(idRaw), data);
      if (row === null) return errorResponse(404, 'not found');
      await ctx.rebuild();
      return JSON_OK(200, row);
    }

    if (method === 'DELETE') {
      if (!CANONICAL_INT.test(idRaw)) return errorResponse(404, 'not found');
      const row = await deleteArticle(ctx.sql, Number(idRaw));
      if (row === null) return errorResponse(404, 'not found');
      await ctx.rebuild();
      return JSON_OK(200, row);
    }

    return errorResponse(405, `method ${method} not allowed`);
  } catch (e) {
    if (e instanceof BodyParseError) return errorResponse(400, e.message);
    throw e; // server bug / DB error -> adapter maps to 500
  }
}
