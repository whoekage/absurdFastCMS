import type uWS from 'uWebSockets.js';
import { writeCapturedCors } from './cors.ts';
import { errorResponse, JSON_CT, type CoreResponse } from './read.router.ts';
import { toErrorResponse, type Locale } from '../errors/index.ts';
import { MigrationBlockedError } from '../db/schema/migrate.ts';
import { SchemaChangeConflictError } from '../db/ddl.ts';

/**
 * Pure transport responders for the uWS HTTP layer — the framework-plumbing helpers that take a uWS
 * `res` (and never any server state) and write a {@link CoreResponse}/JSON onto it. Extracted from
 * `server.ts` so the route modules share ONE copy; behaviour is byte-identical to the inline originals.
 */

/** Full HTTP status lines for the statuses the core can emit. */
const STATUS_LINE: Record<number, string> = {
  200: '200 OK',
  201: '201 Created',
  304: '304 Not Modified',
  400: '400 Bad Request',
  401: '401 Unauthorized',
  403: '403 Forbidden',
  404: '404 Not Found',
  405: '405 Method Not Allowed',
  409: '409 Conflict',
  410: '410 Gone',
  412: '412 Precondition Failed',
  413: '413 Payload Too Large',
  415: '415 Unsupported Media Type',
  422: '422 Unprocessable Entity',
  428: '428 Precondition Required',
  500: '500 Internal Server Error',
};

export function statusLine(status: number): string {
  return STATUS_LINE[status] ?? `${status} Status`;
}

/** Write a {@link CoreResponse} onto the uWS response (synchronous; offset-safe body view). */
export function writeResponse(res: uWS.HttpResponse, result: CoreResponse): void {
  res.writeStatus(statusLine(result.status));
  writeCapturedCors(res); // CORS headers (when a cross-origin policy captured them); no-op same-origin
  // A 304 MUST carry no message body (HTTP semantics) — write status + headers (ETag) only.
  if (result.status === 304) {
    if (result.headers) for (const [k, v] of Object.entries(result.headers)) res.writeHeader(k, v);
    res.end();
    return;
  }
  res.writeHeader('Content-Type', result.contentType);
  // Optional extra headers (Builder routes only). Absent on the read hot path ⇒ byte-identical output.
  if (result.headers) for (const [k, v] of Object.entries(result.headers)) res.writeHeader(k, v);
  const body = result.body;
  // Offset-safe view: the engine's Buffer is a subarray of the shared OutputArena ArrayBuffer.
  res.end(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
}

/** Serialize an arbitrary value as a pretty JSON response (debug inspector only — not a hot path). */
export function writeJson(res: uWS.HttpResponse, status: number, value: unknown): void {
  res.writeStatus(statusLine(status));
  res.writeHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value, null, 2));
}

/** Parse an optional non-negative integer query param; undefined when absent or unparseable. */
export function toInt(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Reject bodies above this; tests send a few hundred bytes, real CMS writes are small. */
export const MAX_BODY_BYTES = 1 << 20; // 1 MiB

/**
 * Read the full request body asynchronously. Calls `onDone(body)` exactly once when the last chunk
 * arrives — `body` is `null` if the body exceeded {@link MAX_BODY_BYTES}. Returns an `aborted()` probe
 * (set if the client disconnects mid-read) so the async continuation can avoid writing to a dead res.
 */
export function readBody(res: uWS.HttpResponse, onDone: (body: Buffer | null) => void): { aborted: () => boolean } {
  let aborted = false;
  res.onAborted(() => {
    aborted = true;
  });
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  res.onData((ab, isLast) => {
    if (!tooLarge) {
      // The chunk ArrayBuffer is only valid during this callback — slice(0) makes an owned copy.
      const chunk = Buffer.from(ab.slice(0));
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    }
    if (isLast) onDone(tooLarge ? null : Buffer.concat(chunks));
  });
  return { aborted: () => aborted };
}

/** Send a response from an ASYNC continuation: skip if the client aborted, else cork the write. */
export function corkSend(res: uWS.HttpResponse, aborted: () => boolean, result: CoreResponse): void {
  if (aborted()) return;
  res.cork(() => writeResponse(res, result));
}

/** A Builder JSON response (the uniform envelope shape). `applied`/`blocked` default to [] so the SPA never
 *  branches on status to learn "nothing changed". */
export function builderJson(status: number, fields: Record<string, unknown>, headers?: Record<string, string>): CoreResponse {
  const body = Buffer.from(JSON.stringify(fields), 'utf8');
  return headers ? { status, contentType: JSON_CT, body, headers } : { status, contentType: JSON_CT, body };
}

/** Map a Builder/migrate throw to its HTTP status + envelope fields. A blocked-by-lint case is a RETURN, not here. */
export function builderErrorFields(e: unknown, locale: Locale): { status: number; fields: Record<string, unknown> } {
  // `locale` is resolved from the request's Accept-Language at the route's synchronous edge (uWS req is
  // sync-only) and threaded in. At locale 'en' render() === the historically thrown e.message, so the wire
  // stays byte-identical; another locale localizes the `error` string (the `code` is the additive key).
  const { status, body } = toErrorResponse(e, locale);
  // Two codes whose builder wire `error` is a FIXED string that DIVERGES from render(): keep that fixed
  // string and take ONLY status (+ extras / Retry-After header, the latter applied in builderError).
  if (e instanceof MigrationBlockedError) return { status, fields: { ok: false, blocked: e.blocked, error: 'requires allowDestructive' } };
  if (e instanceof SchemaChangeConflictError) return { status, fields: { ok: false, error: 'schema lock timed out; retry' } };
  // Every other code uses e.message === render(code, params, 'en'), so body.error is byte-identical;
  // `...body` carries { error, code, ...whitelisted extras } (data_loss -> table/column/affected). The
  // non-AppError fallthrough yields the hard { error: 'internal error', code: 'internal' } at status 500.
  return { status, fields: { ok: false, ...body } };
}

/** The CoreResponse form of {@link builderErrorFields} (the transient lock 409 carries Retry-After). */
export function builderError(e: unknown, locale: Locale): CoreResponse {
  const { status, fields } = builderErrorFields(e, locale);
  return e instanceof SchemaChangeConflictError ? builderJson(status, fields, { 'Retry-After': '1' }) : builderJson(status, fields);
}

/**
 * be-09f — send an admin-internal `/_team` response with `Cache-Control: no-store` (NOT `no-cache`): the
 * member directory is a derived projection that must never be replayed from an HTTP cache after a
 * logout/role change/suspend. `writeResponse` carries no custom header, so this writes the status + the
 * `no-store` header + the JSON body itself, corked + abort-guarded like {@link corkSend}.
 */
export function corkSendNoStore(res: uWS.HttpResponse, aborted: () => boolean, status: number, value: unknown): void {
  if (aborted()) return;
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.cork(() => {
    res.writeStatus(statusLine(status));
    writeCapturedCors(res);
    res.writeHeader('Cache-Control', 'no-store');
    res.writeHeader('Content-Type', JSON_CT);
    res.end(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  });
}

/** be-09b — parse a pre-buffered JSON body (null => 413, empty => undefined, bad => 400-as-error). */
export type ParsedBody = { ok: true; body: unknown } | { ok: false; error: CoreResponse };
export function parseBody(raw: Buffer | null): ParsedBody {
  if (raw === null) return { ok: false, error: errorResponse(413, 'request body too large') };
  if (raw.length === 0) return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false, error: errorResponse(400, 'invalid JSON body') };
  }
}
