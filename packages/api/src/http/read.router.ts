import type { Engine } from '../store/engine.ts';
import { parseQuery, QueryParseError, ALL_LOCALES, type ParsedQuery } from '../store/query.parser.ts';
import { InvalidCursorError } from '../store/cursor.codec.ts';
import type { FilterNode } from '../store/table.ts';
import { config } from '../config.ts';
import { toErrorResponse, type Locale } from '../errors/index.ts';

/**
 * The HTTP request CORE — pure, with zero uWS dependency.
 *
 * {@link handleRequest} is a PURE function `(engine, { method, path, query }) -> { status, contentType, body }`.
 * It carries the entire request semantics (routing, validation, status codes, the late-materialized
 * response Buffer). The server (`server.ts`) reads the request triple off the uWS `req`, calls this, and
 * writes the result onto the uWS `res`. Keeping the core pure is what lets uWS live in ONE file while the
 * behavior here is tested in-process with no socket and no mock — it is NOT a seam for swapping uWS out.
 *
 * ROUTES (read-only this slice):
 *   GET /:type      — LIST. The raw query string (Strapi bracket syntax `filters[a][$op]=v`,
 *                     WITHOUT a leading '?') is parsed against the module's FIELD SCHEMA into
 *                     `{ options }`, then `engine.respond(type, options)` returns the PRE-SERIALIZED
 *                     response Buffer (offset-0, the body IS the buffer — no re-serialization).
 *   GET /:type/:id  — SINGLE. `id` must be a CANONICAL non-negative integer literal (reject "01",
 *                     "1.5", "-1", "abc", "" -> 404); `engine.respondById` resolves it as the PUBLIC
 *                     primary key (Postgres PK) via the eq index, 404 when no row carries it.
 *
 * STATUS CODES (correct, not 200-with-error-body):
 *   - unknown module                 -> 404
 *   - unknown / out-of-range / non-int id  -> 404
 *   - non-GET on a known route             -> 405
 *   - anything else (no route match)       -> 404
 *   - {@link QueryParseError}              -> 400 with a small JSON `{ error }` body
 *   - success                              -> 200, the engine Buffer
 *
 * Error bodies are tiny JSON and NOT the hot path, so `JSON.stringify` there is fine.
 */

/** The request triple the core needs — read synchronously off the uWS `req` by the server. */
export interface CoreRequest {
  /** Upper- or lower-case HTTP method; compared case-insensitively. */
  method: string;
  /** The URL path, e.g. `/article` or `/article/42` (no query string). */
  path: string;
  /** The raw query string WITHOUT a leading '?' (a leading '?' is tolerated/stripped). */
  query: string;
  /**
   * The resolved UI {@link Locale} for error-message localization, derived from the request's
   * `Accept-Language` at the transport edge (server.ts). Absent (non-HTTP callers / tests) → `'en'`, which
   * keeps the rendered message byte-identical to the historically thrown English.
   */
  locale?: Locale;
}

/** The response the core produces — the server writes it onto the uWS `res`. */
export interface CoreResponse {
  status: number;
  contentType: string;
  body: Buffer;
  /** Optional extra response headers (e.g. ETag / Retry-After on Builder routes). Absent on the read hot path. */
  headers?: Record<string, string>;
}

export const JSON_CT = 'application/json; charset=utf-8';

/** A canonical non-negative integer literal: "0" or a no-leading-zero digit run. */
export const CANONICAL_INT = /^(0|[1-9]\d*)$/;

/** Build a small JSON error response (not the hot path). */
export function errorResponse(status: number, message: string): CoreResponse {
  return { status, contentType: JSON_CT, body: Buffer.from(JSON.stringify({ error: message }), 'utf8') };
}

/**
 * The single typed-error boundary for the read/write cores: map an {@link AppError} (or any thrown value)
 * onto a {@link CoreResponse} via the one {@link toErrorResponse} helper. Preserves the EXISTING wire shape
 * (a `{ error }` JSON body at the same status) and now ALSO carries the additive `code` field (plus any
 * whitelisted extras / `Retry-After` header the helper emits for the builder codes). At locale `en` the
 * rendered `error` string is byte-identical to the message the class historically threw, so swapping the
 * old `errorResponse(400, e.message)` for this is purely additive (`code` is the only new field).
 */
export function appErrorResponse(e: unknown, locale: Locale): CoreResponse {
  const { status, body, headers } = toErrorResponse(e, locale);
  const res: CoreResponse = { status, contentType: JSON_CT, body: Buffer.from(JSON.stringify(body), 'utf8') };
  if (headers !== undefined) res.headers = headers;
  return res;
}

/**
 * AND-merge two optional filter trees into one (either may be undefined). Used to fold the Draft &
 * Publish status predicate into a query's existing `where` without disturbing it. Strapi semantics:
 * an explicit `filters[published_at]` (a legit scalar field on a D&P type) ANDs with the status default.
 */
function andWhere(a: FilterNode | undefined, b: FilterNode): FilterNode {
  return a === undefined ? b : { op: 'and', children: [a, b] };
}

/**
 * For a Draft & Publish type, derive the `published_at` status predicate to fold into the query. The
 * DEFAULT (status absent) is published-only (`published_at IS NOT NULL`); `status=draft` -> IS NULL;
 * `status=published` -> IS NOT NULL. Returns undefined for a NON-D&P type (so the query is byte-identical)
 * — the parser already 400s a bad status token on any type, so the value here is always draft|published.
 */
function statusWhere(engine: Engine, name: string, parsed: ParsedQuery): FilterNode | undefined {
  if (!engine.isDraftPublish(name)) return undefined;
  const status = parsed.status ?? 'published'; // DEFAULT = published-only (Strapi v5).
  const op = status === 'draft' ? 'null' : 'notNull';
  return { leaf: { field: 'published_at', op, value: true } };
}

/**
 * For an i18n type, derive the `locale` eq predicate to fold into the query. The DEFAULT (locale absent)
 * is the global {@link config.defaultLocale}; `locale=<slug>` -> eq that slug; `locale=*` -> undefined (no
 * predicate, ALL variants). Returns undefined for a NON-i18n type (so the query is byte-identical) — the
 * parser already 400s a malformed slug on any type, so the value here is always a valid slug or `*`. There
 * is NO fallback: a missing variant simply returns nothing (the eq predicate matches no row). The `locale`
 * field is eq-indexed (registry index plan), so this leaf is index-backed.
 */
function localeWhere(engine: Engine, name: string, parsed: ParsedQuery): FilterNode | undefined {
  if (!engine.isI18n(name)) return undefined;
  if (parsed.locale === ALL_LOCALES) return undefined; // all variants — no predicate.
  const loc = parsed.locale ?? config.defaultLocale;
  return { leaf: { field: 'locale', op: 'eq', value: loc } };
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
 * status + module + body Buffer. Never throws for a client error (those become 400/404/405);
 * a non-{@link QueryParseError} thrown by the engine propagates (it's a server bug, not a request).
 */
export function handleRequest(engine: Engine, req: CoreRequest): CoreResponse {
  const segs = segments(req.path);
  const isGet = req.method.toUpperCase() === 'GET';

  // LIST: /:type
  if (segs.length === 1) {
    const name = segs[0]!;
    if (!engine.has(name)) return errorResponse(404, `unknown module "${name}"`);
    if (!isGet) return errorResponse(405, `method ${req.method} not allowed`);
    // Tolerate a leading '?' so the parser never sees it (uWS getQuery() omits it; be robust anyway).
    const query = req.query.startsWith('?') ? req.query.slice(1) : req.query;
    // The cursor decode/verify happens INSIDE engine.respond (the codec lives in the Engine), so the
    // respond call is inside the try too: an InvalidCursorError -> 400, never a 500. The error body
    // is the generic message only (no secret / sig / expected-value leak).
    try {
      const parsed = parseQuery(engine.relationParseContext(name), query);
      // Draft & Publish: for a D&P type, fold the status predicate (default published-only) into the
      // query's where. For a non-D&P type statusWhere returns undefined => options untouched => the
      // assembled response (and its cache key) is BYTE-IDENTICAL to before this feature.
      const sw = statusWhere(engine, name, parsed);
      if (sw !== undefined) parsed.options.where = andWhere(parsed.options.where, sw);
      // i18n: for an i18n type, fold the locale eq predicate (default DEFAULT_LOCALE) into the query's
      // where, AND-merged with status (both are pure scalar leaves). For a non-i18n type localeWhere
      // returns undefined => options untouched => the assembled response (+ cache key) is BYTE-IDENTICAL.
      const lw = localeWhere(engine, name, parsed);
      if (lw !== undefined) parsed.options.where = andWhere(parsed.options.where, lw);
      // Relations Slice 5: the populate plan reaches respond as a 3rd arg; it resolves + validates it
      // (unknown/scalar populate name -> QueryParseError -> 400) and assembles the nested response.
      return { status: 200, contentType: JSON_CT, body: engine.respond(name, parsed.options, parsed.populate, parsed.fields) };
    } catch (e) {
      // Render the error in the caller's locale (resolved from Accept-Language at the transport edge and
      // threaded onto CoreRequest); absent → 'en', byte-identical to the historically thrown message.
      if (e instanceof QueryParseError || e instanceof InvalidCursorError) return appErrorResponse(e, req.locale ?? 'en');
      throw e;
    }
  }

  // SINGLE: /:type/:id
  if (segs.length === 2) {
    const name = segs[0]!;
    const idRaw = segs[1]!;
    if (!engine.has(name)) return errorResponse(404, `unknown module "${name}"`);
    if (!isGet) return errorResponse(405, `method ${req.method} not allowed`);
    if (!CANONICAL_INT.test(idRaw)) return errorResponse(404, `not found`);
    // `id` is the PUBLIC primary key (the Postgres PK), resolved through the eq index — NOT a dense
    // row position. An id with no matching row is a 404. Relations Slice 5: the query is now parsed
    // (it was previously ignored) inside a try so a populate-validation failure maps to 400 (a
    // malformed query on /:type/:id now 400s where it was silently ignored — acceptable + consistent),
    // and the populate plan reaches respondById which honors the SAME recursive framing.
    const query = req.query.startsWith('?') ? req.query.slice(1) : req.query;
    try {
      const parsed = parseQuery(engine.relationParseContext(name), query);
      // Draft & Publish single-item gate: the addressed row must also satisfy the status predicate
      // (default published-only) for a D&P type, else 404. Undefined for a non-D&P type => respondById
      // resolves straight through (byte-identical to before).
      // Single-item gate: the addressed row must satisfy BOTH the status (D&P) and locale (i18n) predicate
      // for its respective opted-in type, else 404. AND-merge the two scalar leaves (either may be
      // undefined); for a non-D&P/non-i18n type the merged predicate is undefined => respondById resolves
      // straight through (byte-identical to before).
      const sw = statusWhere(engine, name, parsed);
      const lw = localeWhere(engine, name, parsed);
      const gate = sw === undefined ? lw : lw === undefined ? sw : andWhere(sw, lw);
      const body = engine.respondById(name, Number(idRaw), parsed.populate, gate, parsed.fields);
      if (body === null) return errorResponse(404, `not found`);
      return { status: 200, contentType: JSON_CT, body };
    } catch (e) {
      // Locale from Accept-Language (threaded onto CoreRequest); absent → 'en' (byte-identical).
      if (e instanceof QueryParseError || e instanceof InvalidCursorError) return appErrorResponse(e, req.locale ?? 'en');
      throw e;
    }
  }

  // No route match (root, or deeper than /:type/:id).
  return errorResponse(404, `not found`);
}
