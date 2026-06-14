import type { Engine } from '../store/engine.ts';
import { parseQuery, QueryParseError } from '../store/query-parser.ts';

/**
 * uWS-MIGRATION SLICE 0 — the framework-agnostic HTTP request CORE.
 *
 * {@link handleRequest} is a PURE function `(engine, { method, path, query }) -> { status, contentType, body }`.
 * It carries the entire request semantics (routing, validation, status codes, the late-materialized
 * response Buffer) with ZERO dependency on any HTTP framework — the uWS adapter (`app.ts`) is a
 * thin shim that builds the request triple, calls this, and writes the result on its own response
 * object. That keeps the behavior in ONE place tested in-process with no socket and no mock, and the
 * adapter reduced to transport plumbing. (Hono drove this same core before the slice-2 cutover; it
 * has been removed — uWS is now the one and only HTTP server.)
 *
 * ROUTES (read-only this slice):
 *   GET /:type      — LIST. The raw query string (Strapi bracket syntax `filters[a][$op]=v`,
 *                     WITHOUT a leading '?') is parsed against the content-type's FIELD SCHEMA into
 *                     `{ options }`, then `engine.respond(type, options)` returns the PRE-SERIALIZED
 *                     response Buffer (offset-0, the body IS the buffer — no re-serialization).
 *   GET /:type/:id  — SINGLE. `id` must be a CANONICAL non-negative integer literal within
 *                     `[0, rowCount)` (reject "01", "1.5", "-1", "abc", "" -> 404); `engine.respondOne`
 *                     returns the single-item envelope Buffer.
 *
 * STATUS CODES (correct, not 200-with-error-body):
 *   - unknown content-type                 -> 404
 *   - unknown / out-of-range / non-int id  -> 404
 *   - non-GET on a known route             -> 405
 *   - anything else (no route match)       -> 404
 *   - {@link QueryParseError}              -> 400 with a small JSON `{ error }` body
 *   - success                              -> 200, the engine Buffer
 *
 * Error bodies are tiny JSON and NOT the hot path, so `JSON.stringify` there is fine.
 */

/** A transport-agnostic request: everything the core needs, read synchronously by the adapter. */
export interface CoreRequest {
  /** Upper- or lower-case HTTP method; compared case-insensitively. */
  method: string;
  /** The URL path, e.g. `/article` or `/article/42` (no query string). */
  path: string;
  /** The raw query string WITHOUT a leading '?' (a leading '?' is tolerated/stripped). */
  query: string;
}

/** A transport-agnostic response: the adapter maps this onto its own response object. */
export interface CoreResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const JSON_CT = 'application/json; charset=utf-8';

/** A canonical non-negative integer literal: "0" or a no-leading-zero digit run. */
const CANONICAL_INT = /^(0|[1-9]\d*)$/;

/** Build a small JSON error response (not the hot path). */
function errorResponse(status: number, message: string): CoreResponse {
  return { status, contentType: JSON_CT, body: Buffer.from(JSON.stringify({ error: message }), 'utf8') };
}

/** Split a path into its non-empty segments: `/article/42` -> `['article', '42']`. */
function segments(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part !== '') out.push(part);
  }
  return out;
}

/**
 * The pure request core. Routes the request, validates it against the engine, and returns the
 * status + content-type + body Buffer. Never throws for a client error (those become 400/404/405);
 * a non-{@link QueryParseError} thrown by the engine propagates (it's a server bug, not a request).
 */
export function handleRequest(engine: Engine, req: CoreRequest): CoreResponse {
  const segs = segments(req.path);
  const isGet = req.method.toUpperCase() === 'GET';

  // LIST: /:type
  if (segs.length === 1) {
    const name = segs[0]!;
    if (!engine.has(name)) return errorResponse(404, `unknown content-type "${name}"`);
    if (!isGet) return errorResponse(405, `method ${req.method} not allowed`);
    // Tolerate a leading '?' so the parser never sees it (uWS getQuery() omits it; be robust anyway).
    const query = req.query.startsWith('?') ? req.query.slice(1) : req.query;
    let options;
    try {
      options = parseQuery(engine.fields(name), query).options;
    } catch (e) {
      if (e instanceof QueryParseError) return errorResponse(400, e.message);
      throw e;
    }
    return { status: 200, contentType: JSON_CT, body: engine.respond(name, options) };
  }

  // SINGLE: /:type/:id
  if (segs.length === 2) {
    const name = segs[0]!;
    const idRaw = segs[1]!;
    if (!engine.has(name)) return errorResponse(404, `unknown content-type "${name}"`);
    if (!isGet) return errorResponse(405, `method ${req.method} not allowed`);
    if (!CANONICAL_INT.test(idRaw)) return errorResponse(404, `not found`);
    // `id` is the PUBLIC primary key (the Postgres PK), resolved through the eq index — NOT a dense
    // row position. An id with no matching row is a 404.
    const body = engine.respondById(name, Number(idRaw));
    if (body === null) return errorResponse(404, `not found`);
    return { status: 200, contentType: JSON_CT, body };
  }

  // No route match (root, or deeper than /:type/:id).
  return errorResponse(404, `not found`);
}
