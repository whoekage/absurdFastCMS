import uWS from 'uWebSockets.js';
import { loadAdminBundle, mountAdmin } from './static.ts';
import busboy from 'busboy';
import type { Engine } from '../store/engine.ts';
import type { Registry } from '../db/registry.ts';
import type { PostgresStore } from '../db/postgres.store.ts';
import { rebuildType } from '../db/engine.loader.ts';
import { handleRequest, errorResponse, JSON_CT, type CoreResponse } from './read.router.ts';
import { handleWrite, type WriteContext } from './write.handler.ts';
import { HookRegistry } from '../db/schema/hooks.ts';
import { applySchemaEdit, applySchemaDelete, previewSchemaEdit, BuilderBusyError, type ModuleDraft, type SchemaEditResult } from '../compose/builder.ts';
import { swapFromIR } from '../db/engine.swap.ts';
import { loadTypes, loadTypesCacheBusted } from '../db/schema/load.ts';
import { readAppliedSchemas, ensureAppliedTable, MigrationBlockedError } from '../db/schema/migrate.ts';
import { SchemaChangeConflictError } from '../db/ddl.ts';
import { toErrorResponse, localeFromAcceptLanguage, type Locale } from '../errors/index.ts';
import { computeCatalogVersion, hashRequest } from '../compose/catalog-version.ts';
import { ensureIdempotencyTable, idempotencyLookup, recordIdempotency, pruneIdempotency } from '../compose/builder-idempotency.ts';
import { handleUpload, handleListFiles, handleGetFile, handleDeleteFile, type FileContext, type ParsedUpload } from './upload.handler.ts';
import { mediaPopulateTargets, stripMediaPopulate, applyMediaPopulate } from './media.populate.ts';
import { componentPopulateTargets, applyComponentPopulate } from './component.populate.ts';
import { getStorageProvider } from '../storage/index.ts';
import { listTypes, inspectType } from '../store/inspect.ts';
import { handleAuthRoute } from '../auth/auth.bridge.ts';
import type { Auth } from '../auth/auth.ts';
import type { SessionCache, Principal } from '../auth/session.cache.ts';
import { readSessionToken } from '../auth/session.cache.ts';
import { resolveKey, buildScopePermissions } from '../auth/key.auth.ts';
import type { RbacRegistry } from '../auth/rbac.registry.ts';
import type { TeamView, TeamRow } from '../auth/team.view.ts';
import { config } from '../config.ts';

/**
 * The HTTP server, built directly on uWebSockets.js. uWS is the committed transport (single-instance
 * deploy target, throughput-first) — there is no transport-abstraction layer by design, and none is wanted.
 *
 * What IS abstracted is the routing CORE, not the transport: this module reads the request triple
 * `{ method, path, query }` off the uWS `req`, calls the framework-agnostic {@link handleRequest} /
 * {@link handleWrite} cores, and writes their `{ status, contentType, body }` onto the uWS `res`. All
 * routing / validation / status codes / late-materialized response Buffers live in ONE place (the cores),
 * so this file adds zero behavior — only uWS plumbing. That split keeps uWS contained to this one file
 * (and {@link auth.bridge.ts}) and lets the cores be unit-tested without a socket; it is NOT a seam for
 * swapping uWS out.
 *
 * READS are SYNCHRONOUS — read getMethod()/getParameter()/getQuery() into locals at the top, call
 * the pure core, write the result; `req` is never touched after, so no onAborted is needed.
 *
 * WRITES (POST/PUT/DELETE — always wired now that every {@link ServerDeps} is required) are ASYNCHRONOUS — they
 * read the request body and hit Postgres. uWS makes that delicate, handled in {@link readBody}/{@link corkSend}:
 *  - `req` is STACK-ALLOCATED and invalid after the handler yields — so the `:type`/`:id` params are
 *    read SYNCHRONOUSLY before the first await / before onData fires.
 *  - the body arrives via res.onData(chunk, isLast); each `chunk` ArrayBuffer is only valid DURING the
 *    callback, so it is COPIED (`ab.slice(0)`) before being buffered.
 *  - res.onAborted(...) tracks a client disconnect; after the await we must NOT write to a dead res.
 *  - the response is written inside res.cork(...) so the status/header/end are coalesced into one send.
 *  - an oversized body is rejected (413) without buffering the whole thing.
 *
 * Other uWS notes: getQuery() omits the leading '?' (core tolerates either); getParameter(0) is
 * `:type`, getParameter(1) is `:id`; writeStatus takes a FULL status line ('200 OK', ...); the body is
 * sent as a correctly-BOUNDED `Uint8Array(buffer, byteOffset, byteLength)` view because the engine's
 * Buffers are subarray views into the shared OutputArena ArrayBuffer.
 *
 * Routing: get('/:type'), get('/:type/:id'); when writes are enabled post('/:type'), put('/:type/:id'),
 * del('/:type/:id'); and any('/*') last so the core decides 404/405 for everything else.
 */

/** A uWS listen-socket token (opaque) returned by listen(), passed back to close(). */
export type ListenToken = unknown;

/** The server handle: start/stop the HTTP server over the given engine. */
export interface Server {
  /** Bind and listen on `port`. Resolves with the listen-socket token. */
  listen(port: number): Promise<ListenToken>;
  /** Close a previously-returned listen-socket token. */
  close(token: ListenToken): void;
  /**
   * S4: apply a files-first schema edit and make it LIVE in-process (write file + migrate + atomic engine
   * swap), WITHOUT a restart. ALWAYS provided (every dep, incl. `modulesDir`, is now required).
   * Throws on a migrate failure (last-good keeps serving); a blocked/no-op edit returns without swapping.
   */
  applyEdit?(draft: ModuleDraft, opts?: { allowDestructive?: boolean }): Promise<SchemaEditResult>;
}

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

function statusLine(status: number): string {
  return STATUS_LINE[status] ?? `${status} Status`;
}

/** Write a {@link CoreResponse} onto the uWS response (synchronous; offset-safe body view). */
function writeResponse(res: uWS.HttpResponse, result: CoreResponse): void {
  res.writeStatus(statusLine(result.status));
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
function writeJson(res: uWS.HttpResponse, status: number, value: unknown): void {
  res.writeStatus(statusLine(status));
  res.writeHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value, null, 2));
}

/** Parse an optional non-negative integer query param; undefined when absent or unparseable. */
function toInt(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Reject bodies above this; tests send a few hundred bytes, real CMS writes are small. */
const MAX_BODY_BYTES = 1 << 20; // 1 MiB

/**
 * Read the full request body asynchronously. Calls `onDone(body)` exactly once when the last chunk
 * arrives — `body` is `null` if the body exceeded {@link MAX_BODY_BYTES}. Returns an `aborted()` probe
 * (set if the client disconnects mid-read) so the async continuation can avoid writing to a dead res.
 */
function readBody(res: uWS.HttpResponse, onDone: (body: Buffer | null) => void): { aborted: () => boolean } {
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
function corkSend(res: uWS.HttpResponse, aborted: () => boolean, result: CoreResponse): void {
  if (aborted()) return;
  res.cork(() => writeResponse(res, result));
}

/** A Builder JSON response (the uniform envelope shape). `applied`/`blocked` default to [] so the SPA never
 *  branches on status to learn "nothing changed". */
function builderJson(status: number, fields: Record<string, unknown>, headers?: Record<string, string>): CoreResponse {
  const body = Buffer.from(JSON.stringify(fields), 'utf8');
  return headers ? { status, contentType: JSON_CT, body, headers } : { status, contentType: JSON_CT, body };
}

/** Map a Builder/migrate throw to its HTTP status + envelope fields. A blocked-by-lint case is a RETURN, not here. */
function builderErrorFields(e: unknown, locale: Locale): { status: number; fields: Record<string, unknown> } {
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
function builderError(e: unknown, locale: Locale): CoreResponse {
  const { status, fields } = builderErrorFields(e, locale);
  return e instanceof SchemaChangeConflictError ? builderJson(status, fields, { 'Retry-After': '1' }) : builderJson(status, fields);
}

/**
 * be-09f — send an admin-internal `/_team` response with `Cache-Control: no-store` (NOT `no-cache`): the
 * member directory is a derived projection that must never be replayed from an HTTP cache after a
 * logout/role change/suspend. `writeResponse` carries no custom header, so this writes the status + the
 * `no-store` header + the JSON body itself, corked + abort-guarded like {@link corkSend}.
 */
function corkSendNoStore(res: uWS.HttpResponse, aborted: () => boolean, status: number, value: unknown): void {
  if (aborted()) return;
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.cork(() => {
    res.writeStatus(statusLine(status));
    res.writeHeader('Cache-Control', 'no-store');
    res.writeHeader('Content-Type', JSON_CT);
    res.end(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  });
}

/**
 * be-09b — the data WRITE routes (POST/PUT/DELETE /:type[/:id]), the D&P action sub-route, and the i18n
 * variant-create are now registered INLINE inside {@link createServer} so each can be wrapped by the
 * per-route RBAC gate (the gate must close over `sessionCache`/`rbac`). The shared async dispatch shape
 * (413/400/500 handling + corkSend) is preserved verbatim at each gated registration site.
 */

/** Which template a builder route is on — drives which getParameter slots to read synchronously. */
interface CtRouteOpts {
  /** Read getParameter(0) as `:apiId` (false for the `/modules` collection). */
  hasApiId: boolean;
  /** The literal segment after `:apiId` (`'fields'`), or undefined. */
  sub?: string;
  /** Read getParameter(1) as `:name` (the `.../fields/:name` template). */
  hasName?: boolean;
}

// be-04 MEDIA — sanitize a busboy-reported filename to its bare basename over a safe alphabet. NEVER used
// to build a storage path (that is the content-addressed key); recorded only for display. Strips any
// directory component (defends against `../../etc/passwd` or a backslash-path), collapses everything
// outside `[A-Za-z0-9._-]`, caps length, and falls back to `upload` when nothing survives.
function sanitizeFilename(raw: string): string {
  // basename over BOTH separators (a Windows client may send backslashes).
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 255);
  return cleaned.length > 0 ? cleaned : 'upload';
}

/** A media upload-route outcome: a parsed single file, or a client error to surface verbatim. */
type UploadParseResult = { ok: true; upload: ParsedUpload } | { ok: false; status: number; message: string };

/**
 * be-04 MEDIA — stream the multipart/form-data body through busboy into a SINGLE bounded file buffer.
 * Uses a SEPARATE cap (`config.uploadMaxBytes`) — the 1 MiB JSON `MAX_BODY_BYTES` is untouched. busboy
 * enforces the size natively (`limits.fileSize`) and emits the file stream's `limit` event when exceeded
 * => we reject 413 WITHOUT buffering the whole oversized body. `files:1` rejects a second file part. The
 * `content-type` header MUST be read synchronously off the stack-allocated `req` before the first onData.
 */
/**
 * be-09b — parse an ALREADY-BUFFERED multipart body through busboy (single-file, bounded). Used by the
 * GATED upload path: the gate resolves auth (async) WHILE the body buffers synchronously, so by dispatch
 * time the bytes are in hand and we feed busboy in one `write`+`end`. Mirrors {@link readMultipart}'s
 * settle/limit/extra-file rules; the size cap is enforced by the caller's buffering (uploadMaxBytes).
 */
function parseMultipartBuffer(contentType: string, raw: Buffer, onDone: (r: UploadParseResult) => void): void {
  if (!/^multipart\/form-data/i.test(contentType)) {
    onDone({ ok: false, status: 415, message: 'expected multipart/form-data' });
    return;
  }
  let bb: ReturnType<typeof busboy>;
  try {
    bb = busboy({ headers: { 'content-type': contentType }, limits: { files: 1, fields: 0, fileSize: config.uploadMaxBytes } });
  } catch {
    onDone({ ok: false, status: 400, message: 'invalid multipart body' });
    return;
  }
  let settled = false;
  const settle = (r: UploadParseResult): void => {
    if (settled) return;
    settled = true;
    onDone(r);
  };
  const chunks: Buffer[] = [];
  let sawFile = false;
  let tooLarge = false;
  let extraFile = false;
  let filename = 'upload';
  let declaredMime = 'application/octet-stream';
  bb.on('file', (_name, stream, info) => {
    if (sawFile) {
      extraFile = true;
      stream.resume();
      return;
    }
    sawFile = true;
    filename = sanitizeFilename(info.filename ?? '');
    declaredMime = (info.mimeType ?? 'application/octet-stream').slice(0, 127);
    stream.on('data', (d: Buffer) => {
      if (!tooLarge) chunks.push(d);
    });
    stream.on('limit', () => {
      tooLarge = true;
    });
    stream.on('error', () => settle({ ok: false, status: 400, message: 'invalid multipart body' }));
  });
  bb.on('filesLimit', () => {
    extraFile = true;
  });
  bb.on('error', () => settle({ ok: false, status: 400, message: 'invalid multipart body' }));
  bb.on('close', () => {
    if (tooLarge) return settle({ ok: false, status: 413, message: 'upload too large' });
    if (extraFile) return settle({ ok: false, status: 400, message: 'expected exactly one file part' });
    if (!sawFile) return settle({ ok: false, status: 400, message: 'no file part' });
    settle({ ok: true, upload: { bytes: Buffer.concat(chunks), filename, declaredMime } });
  });
  bb.end(raw);
}

/**
 * be-04 MEDIA — the GET /_files[, /:id] + DELETE /_files/:id routes. GET-list reads ?start&limit off the
 * query synchronously; the :id routes validate a canonical int id (404 otherwise, like the data routes).
 * No body is read (these verbs carry none), so this is synchronous-capture + async-core, corked.
 */
function handleFilesRoute(res: uWS.HttpResponse, req: uWS.HttpRequest, method: 'GET' | 'DELETE', hasId: boolean, ctx: FileContext): void {
  const idRaw = hasId ? (req.getParameter(0) ?? '') : '';
  const query = req.getQuery() ?? '';
  let aborted = false;
  res.onAborted(() => {
    aborted = true;
  });
  void (async () => {
    let result: CoreResponse;
    try {
      if (!hasId) {
        const params = new URLSearchParams(query);
        const start = toInt(params.get('start')) ?? 0;
        const limit = toInt(params.get('limit')) ?? 25;
        result = await handleListFiles(ctx, start, limit);
      } else {
        // Canonical non-negative int id, else 404 — symmetric with the data routes.
        if (!/^(0|[1-9]\d*)$/.test(idRaw)) result = errorResponse(404, 'not found');
        else if (method === 'GET') result = await handleGetFile(ctx, Number(idRaw));
        else result = await handleDeleteFile(ctx, Number(idRaw));
      }
    } catch {
      result = errorResponse(500, 'internal error');
    }
    if (!aborted) res.cork(() => writeResponse(res, result));
  })();
}

/**
 * The full dependency bundle for {@link createServer}. EVERY field is REQUIRED except `publishClock`
 * (which keeps a real wall-clock default inside createServer; D&P / i18n tests pin a fixed Date). The
 * single production caller ({@link createConti}) and the test harness (`startTestServer`) both construct
 * the complete bundle, so every capability is ALWAYS wired — the server is never built partial.
 */
export interface ServerDeps {
  engine: Engine;
  store: PostgresStore;
  registry: Registry;
  /** Optional: defaults to `() => new Date()` inside createServer. Pinned by D&P / i18n tests. */
  publishClock?: () => Date;
  auth: Auth;
  sessionCache: SessionCache;
  rbac: RbacRegistry;
  teamView: TeamView;
  hooks: HookRegistry;
  modulesDir: string;
  /** API route prefix, e.g. '/api'. Default '' = routes at root (the test/SDK harness). */
  basePath?: string;
  /** When set, serve the prebuilt admin SPA from this dir at the ROOT (every non-API path). */
  adminDir?: string;
}

/**
 * Build a uWS server over the supplied {@link ServerDeps}. Construction is SEPARATE from listening so
 * tests build the server once and bind it to a free port chosen by the harness.
 *
 * Every dep is REQUIRED, so WRITES (POST/PUT/DELETE) always commit to Postgres and then rebuild ONLY the
 * written type's RAM storage in place ({@link Engine.replaceType}), invalidating ONLY that type's response
 * cache (sibling types stay hot). The engine object itself is NEVER reassigned on a write — only its
 * per-type storage is swapped — so the read handlers' reference stays valid. READS are PUBLIC; only the
 * WRITE / builder / media routes are gated by the wired RBAC.
 */
export function createServer(deps: ServerDeps): Server {
  const { engine, store, registry, publishClock = () => new Date(), auth, sessionCache, rbac, teamView, hooks, modulesDir, basePath = '', adminDir } = deps;
  const app = uWS.App();
  // Every API route registers under `basePath` (default '' = root). createConti sets '/api' so the admin
  // SPA can own the root. Route handlers reconstruct the core path from getParameter(), so the prefix is
  // transparent to the router; only the `app.any` fallback (which reads getUrl) strips it (below).
  const P = basePath;
  type UwsHandler = (res: uWS.HttpResponse, req: uWS.HttpRequest) => void;
  const route = {
    get: (p: string, h: UwsHandler) => app.get(P + p, h),
    post: (p: string, h: UwsHandler) => app.post(P + p, h),
    put: (p: string, h: UwsHandler) => app.put(P + p, h),
    del: (p: string, h: UwsHandler) => app.del(P + p, h),
    any: (p: string, h: UwsHandler) => app.any(P + p, h),
  };
  // S1 (Builder live-reload): the SINGLE mutable cell every schema-reading route closure reads through.
  // A schema edit (Builder route, S4) rebuilds a fresh Engine/Registry off-side and swaps these three
  // references in ONE synchronous assignment — JS is single-threaded, so no in-flight request observes a
  // half-swap. At construction it holds exactly the passed engine/registry/hooks ⇒ ZERO behavior change;
  // it exists so the swap has a place to land. The `live` OBJECT (not the values) is what later scopes
  // capture, so a reassignment of `live.engine` is seen everywhere.
  const live: { engine: Engine; registry: Registry; hooks: HookRegistry } = { engine, registry, hooks };

  /**
   * be-09b/be-09c — the per-request AUTH context. `principal` comes ONLY from {@link SessionCache.validate}
   * (a session cookie) OR {@link resolveKey} (an `x-api-key` header) — NEVER a body field (neutralizes the
   * mass-assignment class). `can(perm)` is the SINGLE authz gate:
   *   - SESSION path: a pure {@link RbacRegistry.checkPermission} set test (owner RBAC; no narrowing).
   *   - KEY path: owner RBAC ∩ token scope — a key can only NARROW the owner's authority, never exceed it.
   * `via` records HOW the request authenticated so the key-MANAGEMENT routes can be session-only (a key may
   * not mint/revoke keys for itself — no self-escalation). The session warm path is ZERO-PG; the key path
   * costs exactly one indexed digest lookup (verifyApiKey) and is otherwise zero-PG.
   */
  type AuthVia = 'session' | 'key' | 'none';
  interface AuthContext {
    principal: Principal | null;
    can(perm: string): boolean;
    via: AuthVia;
  }

  /**
   * be-09c — assemble an {@link AuthContext}. `can()` is where EFFECTIVE perms = owner RBAC ∩ token scope is
   * enforced: the owner MUST hold the perm (pure-RAM checkPermission) AND, on the key path, the scope must
   * include it (`scope === null` ⇒ a SESSION ⇒ no narrowing). better-auth's own `verifyApiKey` only checks
   * request ⊆ stored scope — it does NOT intersect with owner RBAC, so the intersection lives HERE.
   */
  function makeCtx(principal: Principal | null, scope: ReadonlySet<string> | null, via: AuthVia): AuthContext {
    return {
      principal,
      can: (perm) =>
        principal !== null &&
        rbac.checkPermission(principal, perm) && // owner MUST hold it (RAM, zero-PG)
        (scope === null || scope.has(perm)), // a token can only NARROW; null scope = session (no narrowing)
      via,
    };
  }

  /**
   * be-09b/be-09c — resolve the {@link AuthContext}. COOKIE-FIRST and MUTUALLY EXCLUSIVE: a session cookie
   * resolves ONLY via {@link SessionCache.validate} (full owner RBAC, no narrowing); ELSE an `x-api-key`
   * header resolves ONLY via {@link resolveKey} (owner Principal + token scope). A value is NEVER tried as
   * both — a session token in `x-api-key` fails verifyApiKey (not a hashed key row), a raw key in the cookie
   * fails getSession; a query-string key is never read. Closes over `sessionCache`/`rbac`/`auth`/`teamView`.
   */
  async function resolveAuth(headers: Headers): Promise<AuthContext> {
    // SESSION PATH (cookie only).
    if (readSessionToken(headers) !== null) {
      const principal = await sessionCache.validate(headers);
      return makeCtx(principal, null, principal !== null ? 'session' : 'none');
    }
    // KEY PATH (x-api-key header only).
    const rawKey = headers.get('x-api-key');
    if (rawKey !== null && rawKey.length > 0) {
      const resolved = await resolveKey(auth, rawKey, teamView);
      if (resolved !== null) return makeCtx(resolved.principal, resolved.scope, 'key');
      return makeCtx(null, null, 'none');
    }
    return makeCtx(null, null, 'none');
  }

  /**
   * be-09b — the GATE primitive. uWS forces `res.onData`/`res.onAborted` to be registered SYNCHRONOUSLY in
   * the handler callback, so we cannot await auth BEFORE buffering the body. The discipline:
   *   1. capture the sync request bits the caller needs (params) BEFORE calling gate (caller closes over them),
   *   2. read the `Headers` SYNC off `req`, and (for body routes) start the SYNC body buffer via `readBody`,
   *   3. in the body callback (or immediately for bodyless), resolve auth + apply the 401/403 split,
   *   4. on success, run `proceed(body)` — the existing parse + core dispatch, but corked HERE.
   *
   * 401 (no/invalid/expired session) is precisely distinct from 403 (session present, perm missing); body
   * fields are NEVER consulted for authz (the Principal comes ONLY from {@link SessionCache.validate}).
   *
   * `proceed` receives the buffered body Buffer (null when oversized) and the abort probe, and is fully
   * responsible for the response from there (it corks). `readsBody:false` (DELETE /_files/:id) skips the
   * body buffer (those verbs carry none) and dispatches with a null body.
   */
  function gate(
    res: uWS.HttpResponse,
    req: uWS.HttpRequest,
    perm: string,
    readsBody: boolean,
    proceed: (body: Buffer | null, aborted: () => boolean) => void,
  ): void {
    // SYNCHRONOUS header read — `req` is invalid after the first await.
    const headers = new Headers();
    req.forEach((k, v) => headers.set(k, v));

    const run = (body: Buffer | null, aborted: () => boolean): void => {
      void (async () => {
        let ctx: AuthContext;
        try {
          ctx = await resolveAuth(headers);
        } catch {
          return corkSend(res, aborted, errorResponse(500, 'internal error'));
        }
        if (ctx.principal === null) return corkSend(res, aborted, errorResponse(401, 'unauthenticated'));
        if (!ctx.can(perm)) return corkSend(res, aborted, errorResponse(403, 'forbidden'));
        proceed(body, aborted);
      })();
    };

    if (readsBody) {
      const { aborted } = readBody(res, (body) => run(body, aborted));
    } else {
      let aborted = false;
      res.onAborted(() => {
        aborted = true;
      });
      run(null, () => aborted);
    }
  }

  /**
   * be-09f — GATE a `/_team` route and HAND THE RESOLVED PRINCIPAL to `proceed`. Identical 401/403 split as
   * {@link gate}, but the team handlers need the ACTOR's userId (resolved ONLY from the session — never the
   * body) to apply the privilege cap + self-guard. The principal passed here is the sole authz subject; the
   * route/body `:userId` only ever designates the TARGET. Auth is ALWAYS enabled (sessionCache + rbac +
   * teamView are required deps), so there is no open-route branch.
   */
  function gateTeam(
    res: uWS.HttpResponse,
    req: uWS.HttpRequest,
    readsBody: boolean,
    proceed: (principal: Principal, headers: Headers, body: Buffer | null, aborted: () => boolean) => void,
  ): void {
    const headers = new Headers();
    req.forEach((k, v) => headers.set(k, v));

    const run = (body: Buffer | null, aborted: () => boolean): void => {
      void (async () => {
        let ctx: AuthContext;
        try {
          ctx = await resolveAuth(headers);
        } catch {
          return corkSend(res, aborted, errorResponse(500, 'internal error'));
        }
        if (ctx.principal === null) return corkSend(res, aborted, errorResponse(401, 'unauthenticated'));
        if (!ctx.can('team.manage')) return corkSend(res, aborted, errorResponse(403, 'forbidden'));
        // The acting admin's headers are forwarded to the lifecycle `auth.api.*` calls so better-auth's own
        // admin endpoints resolve the actor's session (their authz is satisfied by adminRoles:['super-admin']
        // matching the better-auth user.role we set for super-admins). Our RBAC (checkPermission) remains the
        // SOLE CMS authz source — it never reads better-auth's role field.
        proceed(ctx.principal, headers, body, aborted);
      })();
    };

    if (readsBody) {
      const { aborted } = readBody(res, (body) => run(body, aborted));
    } else {
      let aborted = false;
      res.onAborted(() => {
        aborted = true;
      });
      run(null, () => aborted);
    }
  }

  /**
   * be-09c — GATE a `/_keys` route. Like {@link gateTeam} it resolves auth (session OR key) and hands the
   * full {@link AuthContext} (principal + can + via) to `proceed`, which applies its OWN authz: the self
   * routes (create/list/revoke-own) are SESSION-ONLY (a key may not mint/revoke keys — `ctx.via === 'key'`
   * is rejected so a key can never self-escalate), and the cross-user routes gate on `token.manage`. The
   * principal is the sole authz subject; a route/body `:userId` only ever designates the TARGET owner.
   */
  function gateKeys(
    res: uWS.HttpResponse,
    req: uWS.HttpRequest,
    readsBody: boolean,
    proceed: (ctx: AuthContext, headers: Headers, body: Buffer | null, aborted: () => boolean) => void,
  ): void {
    const headers = new Headers();
    req.forEach((k, v) => headers.set(k, v));

    const run = (body: Buffer | null, aborted: () => boolean): void => {
      void (async () => {
        let ctx: AuthContext;
        try {
          ctx = await resolveAuth(headers);
        } catch {
          return corkSend(res, aborted, errorResponse(500, 'internal error'));
        }
        if (ctx.principal === null) return corkSend(res, aborted, errorResponse(401, 'unauthenticated'));
        proceed(ctx, headers, body, aborted);
      })();
    };

    if (readsBody) {
      const { aborted } = readBody(res, (body) => run(body, aborted));
    } else {
      let aborted = false;
      res.onAborted(() => {
        aborted = true;
      });
      run(null, () => aborted);
    }
  }

  /**
   * be-09b — GATE the multipart upload. The upload body can be up to `uploadMaxBytes` (25 MiB) — much
   * larger than the 1 MiB JSON `MAX_BODY_BYTES` — so it does NOT use `gate`'s `readBody`. Instead it
   * buffers the raw multipart bytes SYNCHRONOUSLY (its own cap) WHILE resolving auth in parallel; once both
   * the body is fully read AND auth resolved, it applies the 401/403 split and (on allow) feeds the buffer
   * to busboy. onData/onAborted are registered synchronously (uWS requirement); the auth decision is
   * deferred but the bytes are never lost.
   */
  function gateUpload(
    res: uWS.HttpResponse,
    req: uWS.HttpRequest,
    contentType: string,
    proceed: (raw: Buffer, aborted: () => boolean) => void,
  ): void {
    const headers = new Headers();
    req.forEach((k, v) => headers.set(k, v));

    let aborted = false;
    res.onAborted(() => {
      aborted = true;
    });

    const cap = config.uploadMaxBytes;
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let body: Buffer | null = null;
    let bodyDone = false;
    let authDone = false;
    let ctx: AuthContext | null = null;
    let authFailed = false;

    const tryFinish = (): void => {
      if (!bodyDone || !authDone) return;
      if (authFailed) return corkSend(res, () => aborted, errorResponse(500, 'internal error'));
      // Authz split FIRST — never even look at the (possibly oversized) body for an unauthorized caller.
      if (ctx!.principal === null) return corkSend(res, () => aborted, errorResponse(401, 'unauthenticated'));
      if (!ctx!.can('media.upload')) return corkSend(res, () => aborted, errorResponse(403, 'forbidden'));
      if (body === null) return corkSend(res, () => aborted, errorResponse(413, 'upload too large'));
      proceed(body, () => aborted);
    };

    res.onData((ab, isLast) => {
      if (!tooLarge) {
        const chunk = Buffer.from(ab.slice(0));
        size += chunk.length;
        if (size > cap) tooLarge = true;
        else chunks.push(chunk);
      }
      if (isLast) {
        body = tooLarge ? null : Buffer.concat(chunks);
        bodyDone = true;
        tryFinish();
      }
    });

    void (async () => {
      try {
        ctx = await resolveAuth(headers);
      } catch {
        authFailed = true;
      }
      authDone = true;
      tryFinish();
    })();
  }

  /** be-09b — parse a pre-buffered JSON body (null => 413, empty => undefined, bad => 400-as-error). */
  type ParsedBody = { ok: true; body: unknown } | { ok: false; error: CoreResponse };
  function parseBody(raw: Buffer | null): ParsedBody {
    if (raw === null) return { ok: false, error: errorResponse(413, 'request body too large') };
    if (raw.length === 0) return { ok: true, body: undefined };
    try {
      return { ok: true, body: JSON.parse(raw.toString('utf8')) };
    } catch {
      return { ok: false, error: errorResponse(400, 'invalid JSON body') };
    }
  }

  /**
   * be-04 MEDIA + be-05 COMPONENT — the OPTIONAL populate-post-step wrapper around a GET read. When the
   * registry is present and the request asked to populate >=1 MEDIA field and/or >=1 COMPONENT field of the
   * addressed type, this:
   *   1. STRIPS the targeted media + component populate names from the query (so the engine's relation-only
   *      populate parser never 400s on a scalar media / json component field), runs the pure read core,
   *   2. on a 200, applies the media populate (inline asset record(s)) AND the component populate (resolve
   *      inline media refs inside the component trees), each over the parsed envelope — corked + onAborted.
   * Returns true iff it OWNED the response (took the async path); false => the caller runs the normal
   * SYNCHRONOUS byte-identical read path. With no registry / no media+component field / no such populate
   * asked, it always returns false => the existing zero-copy read path is byte-identical.
   */
  function mediaRead(res: uWS.HttpResponse, method: string, path: string, type: string, query: string, locale: Locale): boolean {
    const reg = live.registry; // read the LIVE registry per-call so a post-swap type/field is seen
    if (method.toUpperCase() !== 'GET') return false;
    const def = reg.get(type);
    if (def === undefined || (def.mediaFields.size === 0 && def.componentFields.size === 0)) return false;
    const mediaTargets = mediaPopulateTargets(def, query);
    const componentTargets = componentPopulateTargets(def, query);
    if (mediaTargets.size === 0 && componentTargets.size === 0) return false;

    const sql = store.sql;
    // Strip BOTH the media + component populate names so the engine's relation-only parser never 400s.
    const stripNames = new Set<string>([...mediaTargets.keys(), ...componentTargets.keys()]);
    const strippedQuery = stripMediaPopulate(query, stripNames);
    let aborted = false;
    res.onAborted(() => {
      aborted = true;
    });
    void (async () => {
      let result: CoreResponse;
      try {
        const base = handleRequest(live.engine, { method, path, query: strippedQuery, locale });
        // Only a successful read carries a value to resolve; a 400/404/405 passes straight through.
        if (base.status === 200) {
          let body = base.body;
          if (mediaTargets.size > 0) body = (await applyMediaPopulate(sql, body, mediaTargets)).body;
          if (componentTargets.size > 0) body = (await applyComponentPopulate(sql, live.engine, reg, body, componentTargets)).body;
          result = { status: 200, contentType: base.contentType, body };
        } else {
          result = base;
        }
      } catch {
        result = errorResponse(500, 'internal error');
      }
      if (!aborted) res.cork(() => writeResponse(res, result));
    })();
    return true;
  }

  // DEBUG INSPECTOR (dev-only, read-only) — mounted ONLY when DEBUG_INSPECTOR=1 outside production. The
  // `debug-inspect` segment contains '-', illegal in an api_id, so it can never shadow a real `/:type`.
  // Synchronous like the read routes: decode straight off the live engine, emit JSON, never mutate.
  if (config.debugInspector) {
    // INDEX: every module + row count.
    route.get('/debug-inspect', (res) => {
      writeJson(res, 200, listTypes(live.engine));
    });
    // ONE type: per-column storage/stats + relations + a decoded row window (?offset=&limit=).
    route.get('/debug-inspect/:type', (res, req) => {
      const type = req.getParameter(0) ?? '';
      const params = new URLSearchParams(req.getQuery() ?? '');
      const offset = toInt(params.get('offset'));
      const limit = toInt(params.get('limit'));
      const result = inspectType(live.engine, type, { offset, limit } as { offset?: number; limit?: number });
      if (result === null) writeJson(res, 404, { error: `unknown module "${type}"` });
      else writeJson(res, 200, result);
    });
  }

  // AUTH (better-auth provider) — mounted under the `/auth/...` prefix BEFORE the `/:type` data routes.
  // CRITICAL uWS ROUTING NOTES (verified against uWS v20.52):
  //  1. A bare `/auth/*` WILDCARD does NOT outrank the data route `/:type/:id` for a 2-segment path — uWS
  //     ranks a parameter route above a wildcard, so `/auth/get-session` would match `/:type/:id`
  //     (type='auth', id='get-session') and hit the read core → a spurious 404.
  //  2. A LITERAL-PREFIXED PARAMETER route `/auth/:p` outranks `/:type/:id` ONLY when registered with the
  //     SAME method specificity. A method-specific `app.get('/:type/:id')` BEATS an `app.any('/auth/:p')`.
  //     So the 2-segment auth routes must be registered with the SAME concrete verbs (get/post/put/del),
  //     not `any`, to win over the data GET routes.
  // We therefore register the concrete verbs for the 2-segment `/auth/:p` form (covers GET /get-session,
  // POST /sign-out, ...) PLUS an `any('/auth/*')` for the deeper paths (/sign-in/email, /sign-up/email,
  // /api-key/*), all funnelling through the one Fetch bridge. The leading literal `auth` also means a
  // module can never be named `auth` and shadow these in reverse; reads of OTHER types are
  // byte-untouched. ALWAYS mounted (auth is a required dep). This slice gates NOTHING — it only proxies
  // the provider.
  const onAuth = (res: uWS.HttpResponse, req: uWS.HttpRequest): void => handleAuthRoute(res, req, auth);
  route.get('/auth/:p', onAuth);
  route.post('/auth/:p', onAuth);
  route.put('/auth/:p', onAuth);
  route.del('/auth/:p', onAuth);
  route.any('/auth/*', onAuth);

  // LIST: /:type  — read everything off `req` synchronously, then delegate to the core.
  route.get('/:type', (res, req) => {
    const method = req.getMethod();
    const type = req.getParameter(0) ?? '';
    const query = req.getQuery() ?? '';
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // read sync (uWS req)
    // SYNC handler: no await past this point, so `req` is no longer touched and no onAborted needed —
    // UNLESS this is a media-populate read (registry present + a media field targeted), which needs an
    // async batched `files` lookup. mediaRead returns true iff it took the async path (else fall through).
    if (mediaRead(res, method, `/${type}`, type, query, locale)) return;
    writeResponse(res, handleRequest(live.engine, { method, path: `/${type}`, query, locale }));
  });

  // SINGLE: /:type/:id
  route.get('/:type/:id', (res, req) => {
    const method = req.getMethod();
    const type = req.getParameter(0) ?? '';
    const id = req.getParameter(1) ?? '';
    const query = req.getQuery() ?? '';
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // read sync (uWS req)
    if (mediaRead(res, method, `/${type}/${id}`, type, query, locale)) return;
    writeResponse(res, handleRequest(live.engine, { method, path: `/${type}/${id}`, query, locale }));
  });

  // S4: the files-first Builder apply+swap, exposed on the returned server. `modulesDir` is required, so
  // the Builder is ALWAYS wired and this is assigned unconditionally below, before the server handle returns.
  let applyEditFn: NonNullable<Server['applyEdit']>;

  // WRITES (store + registry are required deps): commit to Postgres, then rebuild ONLY the written
  // type's RAM storage in place (per-type rebuild + per-type cache invalidation).
  const ctx: WriteContext = {
    engine: () => live.engine,
    registry: () => live.registry,
    sql: store.sql,
    rebuild: async (type: string) => {
      // A DATA write never changes the schema, so re-stream the ALREADY-RESOLVED registry def — no
      // meta re-query on the hot path (CL20). Only an actual schema mutation (addField/dropField/
      // changeFieldType) must call registry.rebuildType to re-read content_types/content_type_fields;
      // that is the future DDL hook, NOT this per-entry-write path. The def is guaranteed present: the
      // write core resolved it via registry.get(type) before any SQL ran.
      const def = live.registry.get(type)!;
      await rebuildType(store.sql, live.engine, def, live.registry);
    },
    // Publish clock: real wall-clock by default; tests inject a fixed Date for deterministic fixtures.
    publishClock,
    // S4: read hooks through the LIVE cell (a getter, not a by-value capture) so a schema-edit swap that
    // installs a new type's hooks.ts is seen by the write path immediately. Always present (required dep).
    get hooks() {
      return live.hooks;
    },
  };
  // S4 FILES-FIRST BUILDER — apply a whole-type edit + make it LIVE in-process (no restart). `modulesDir`
  // is a required dep, so the Builder always wires. applySchemaEdit writes the file + migrates atomically; on success the
  // engine is rebuilt incrementally from the returned `next` IR and the live cell is swapped. A blocked /
  // no-op edit does NOT swap; a migrate failure THROWS (last-good keeps serving).
  const dir = modulesDir;
  const sql = store.sql;
  // S6 per-server state: the on-disk catalog version (sha256) + the single-writer mutex flag. NEVER
  // module-scope (two test servers must not share). Warm both best-effort at construction (createServer
  // is sync, so cannot await); a defensive lazy recompute covers a request that races the warm.
  let currentVersion = '';
  let writerBusy = false;
  // Ensure the on-demand bookkeeping tables EXACTLY ONCE per server (memoized) — never a fire-and-forget
  // warm: a `CREATE TABLE IF NOT EXISTS` racing a concurrent one trips pg_type's unique index. Memoizing
  // collapses concurrent first-callers onto one promise; the ensure helpers also swallow the race defensively.
  let tablesReady: Promise<void> | undefined;
  const ensureTables = (): Promise<void> =>
    (tablesReady ??= (async () => { await ensureAppliedTable(sql); await ensureIdempotencyTable(sql); })());
  const ensureVersion = async (): Promise<string> => {
    if (currentVersion === '') currentVersion = await computeCatalogVersion(dir);
    return currentVersion;
  };
  // Read the applied catalog, tolerating a not-yet-created _schema_applied (a GET before any apply).
  const readApplied = async (): Promise<Awaited<ReturnType<typeof readAppliedSchemas>>> => {
    await ensureTables();
    return readAppliedSchemas(sql);
  };

  // The apply core (no mutex — the caller holds it). Re-loads hooks (a NEW type's hooks.ts is merged;
  // ESM-cache invariant: an existing type's cached hooks.ts is correct; an out-of-band hooks.ts edit needs
  // a restart), then swaps. A blocked / no-op result returns without swapping.
  const swapAfter = async (result: SchemaEditResult): Promise<SchemaEditResult> => {
    if (!result.ok || result.next === undefined || (result.applied?.length ?? 0) === 0) return result;
    const { hooks: nextHooks } = await loadTypes(dir);
    await swapFromIR(sql, live, result.next, result.applied!, new HookRegistry(nextHooks));
    return result;
  };
  const runEdit = async (draft: ModuleDraft, opts?: { allowDestructive?: boolean }): Promise<SchemaEditResult> =>
    swapAfter(await applySchemaEdit(sql, dir, draft, opts ?? {}));
  const runDelete = async (apiId: string): Promise<SchemaEditResult> => swapAfter(await applySchemaDelete(sql, dir, apiId));

  // Programmatic entry (srv.applyEdit): serialize via the SAME mutex; a contended call THROWS (it cannot
  // return a CoreResponse). The HTTP path calls runEdit DIRECTLY from inside its own held mutex (no double-acquire).
  applyEditFn = async (draft, opts) => {
    if (writerBusy) throw new BuilderBusyError('builder busy');
    writerBusy = true;
    try { return await runEdit(draft, opts); } finally { writerBusy = false; }
  };

  // The success envelope FIELDS (also the stored idempotency body). `applied`/`blocked` always present.
  const successFields = (r: SchemaEditResult): Record<string, unknown> =>
    ({ ok: true, version: currentVersion, applied: r.applied ?? [], blocked: [], live: true, ...(r.schema !== undefined ? { schema: r.schema } : {}) });

  // The shared mutating flow (PUT/DELETE): acquire-FIRST (zero awaits before set) → version precheck →
  // idempotency lookup/replay → exec → recompute version → record idempotency → envelope. Release in finally.
  const runMutation = (
    res: uWS.HttpResponse, aborted: () => boolean,
    pre: { ifMatch: string; bodyVersion: string | undefined; idemKey: string; requestHash: string },
    exec: () => Promise<SchemaEditResult>,
    locale: Locale,
  ): void => {
    void (async () => {
      if (writerBusy) return corkSend(res, aborted, builderJson(409, { ok: false, error: 'builder busy' }, { 'Retry-After': '1' }));
      writerBusy = true;
      try {
        await ensureTables();
        // Idempotency replay FIRST (before the version precheck): a lost-response retry resends the
        // ORIGINAL If-Match, so checking the version first would 412 a request whose result we already have.
        // A keyed replay is unconditional — it returns the stored outcome regardless of the current version.
        if (pre.idemKey !== '') {
          await pruneIdempotency(sql).catch(() => {});
          const hit = await idempotencyLookup(sql, pre.idemKey);
          if (hit !== undefined) {
            if (hit.requestHash !== pre.requestHash) return corkSend(res, aborted, builderJson(422, { ok: false, error: 'idempotency key reused for a different request' }));
            const etag = hit.status === 200 ? { ETag: String((hit.response as { version?: string }).version ?? '') } : undefined;
            return corkSend(res, aborted, builderJson(hit.status, hit.response, etag));
          }
        }
        await ensureVersion();
        const expected = pre.ifMatch !== '' ? pre.ifMatch : pre.bodyVersion;
        if (expected !== currentVersion) return corkSend(res, aborted, builderJson(412, { ok: false, error: 'stale version', currentVersion }, { ETag: currentVersion }));
        let r: SchemaEditResult;
        try {
          r = await exec();
        } catch (e) {
          if (pre.idemKey !== '') {
            const { status, fields } = builderErrorFields(e, locale);
            if (status >= 400 && status < 500 && !(e instanceof SchemaChangeConflictError)) await recordIdempotency(sql, pre.idemKey, pre.requestHash, status, fields).catch(() => {});
          }
          throw e;
        }
        if (!r.ok) { // blocked: requires allowDestructive (deterministic terminal → 409, idempotent)
          const fields = { ok: false, applied: [], blocked: r.blocked ?? [], error: 'requires allowDestructive' };
          if (pre.idemKey !== '') await recordIdempotency(sql, pre.idemKey, pre.requestHash, 409, fields).catch(() => {});
          return corkSend(res, aborted, builderJson(409, fields));
        }
        if ((r.applied?.length ?? 0) > 0) currentVersion = await computeCatalogVersion(dir); // skip on no-op
        const fields = successFields(r);
        if (pre.idemKey !== '') await recordIdempotency(sql, pre.idemKey, pre.requestHash, 200, fields).catch(() => {});
        corkSend(res, aborted, builderJson(200, fields, { ETag: currentVersion }));
      } catch (e) {
        corkSend(res, aborted, builderError(e, locale)); // SchemaChangeConflictError → 409+Retry-After
      } finally {
        writerBusy = false; // runs on EVERY path incl client abort; the 409-busy loser never entered this try
      }
    })();
  };

  // ---- BUILDER ROUTE SURFACE (design §1). GET reads are PUBLIC; mutations gated on builder.manage. ----

  // GET list — applied catalog (with ids) + ETag/304.
  route.get('/builder/modules', (res, req) => {
    const inm = req.getHeader('if-none-match');
    let aborted = false;
    res.onAborted(() => { aborted = true; });
    void (async () => {
      try {
        await ensureVersion();
        if (inm !== '' && inm === currentVersion) return corkSend(res, () => aborted, builderJson(304, {}, { ETag: currentVersion }));
        const schemas = await readApplied();
        corkSend(res, () => aborted, builderJson(200, { ok: true, schemas, version: currentVersion }, { ETag: currentVersion }));
      } catch { corkSend(res, () => aborted, builderJson(500, { ok: false, error: 'internal error' })); }
    })();
  });

  // GET one — 404 when absent; else the single schema WITH ids + ETag/304.
  route.get('/builder/modules/:apiId', (res, req) => {
    const apiId = req.getParameter(0) ?? '';
    const inm = req.getHeader('if-none-match');
    let aborted = false;
    res.onAborted(() => { aborted = true; });
    void (async () => {
      try {
        await ensureVersion();
        const schema = (await readApplied()).find((s) => s.apiId === apiId);
        if (schema === undefined) return corkSend(res, () => aborted, builderJson(404, { ok: false, error: `module "${apiId}" does not exist` }));
        if (inm !== '' && inm === currentVersion) return corkSend(res, () => aborted, builderJson(304, {}, { ETag: currentVersion }));
        corkSend(res, () => aborted, builderJson(200, { ok: true, schema, version: currentVersion }, { ETag: currentVersion }));
      } catch { corkSend(res, () => aborted, builderJson(500, { ok: false, error: 'internal error' })); }
    })();
  });

  // POST preview — dry-run (no write/migrate/swap), no mutex/version. GATED.
  route.post('/builder/modules/:apiId/preview', (res, req) => {
    const apiId = req.getParameter(0) ?? '';
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'builder.manage', true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const body = parsed.body as { allowDestructive?: boolean } & ModuleDraft;
      if (body.apiId !== apiId) return corkSend(res, aborted, builderJson(422, { ok: false, error: 'body.apiId must equal the path apiId' }));
      void (async () => {
        let result: CoreResponse;
        try {
          const p = await previewSchemaEdit(sql, body, { allowDestructive: body.allowDestructive === true });
          result = builderJson(200, { ok: p.ok, applied: p.changes, blocked: p.blocked, schema: p.schema, generatedSource: p.generatedSource });
        } catch (e) { result = builderError(e, locale); }
        corkSend(res, aborted, result);
      })();
    });
  });

  // PUT upsert — create / update / apiId-rename. GATED + mutex + If-Match/version + idempotency.
  route.put('/builder/modules/:apiId', (res, req) => {
    const apiId = req.getParameter(0) ?? '';
    const ifMatch = req.getHeader('if-match'); // '' when absent (uWS; lowercase key)
    const idemKey = req.getHeader('idempotency-key');
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'builder.manage', true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const body = parsed.body as { allowDestructive?: boolean; version?: string } & ModuleDraft;
      if (body.apiId !== apiId) return corkSend(res, aborted, builderJson(422, { ok: false, error: 'body.apiId must equal the path apiId' }));
      if (ifMatch === '' && body.version === undefined) return corkSend(res, aborted, builderJson(428, { ok: false, error: 'precondition required (If-Match)' }));
      const { allowDestructive, version: _v, ...meaningful } = body;
      const requestHash = hashRequest({ m: 'PUT', apiId, body: meaningful });
      runMutation(res, aborted, { ifMatch, bodyVersion: body.version, idemKey, requestHash },
        () => runEdit(body, { allowDestructive: allowDestructive === true }), locale);
    });
  });

  // DELETE — drop a whole type (always destructive → require allowDestructive). GATED + same wrap.
  route.del('/builder/modules/:apiId', (res, req) => {
    const apiId = req.getParameter(0) ?? '';
    const ifMatch = req.getHeader('if-match');
    const idemKey = req.getHeader('idempotency-key');
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'builder.manage', true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const body = parsed.body as { allowDestructive?: boolean; version?: string };
      if (body.allowDestructive !== true) return corkSend(res, aborted, builderJson(409, { ok: false, applied: [], blocked: [], error: 'requires allowDestructive' }));
      if (ifMatch === '' && body.version === undefined) return corkSend(res, aborted, builderJson(428, { ok: false, error: 'precondition required (If-Match)' }));
      const requestHash = hashRequest({ m: 'DELETE', apiId });
      runMutation(res, aborted, { ifMatch, bodyVersion: body.version, idemKey, requestHash }, () => runDelete(apiId), locale);
    });
  });

  // POST reload — operator escape hatch: cache-busted re-import + swap (registry/hooks/relations), NO
  // migrate; advances the version so a pre-reload PUT carrying the old version fails 412. GATED + mutex.
  route.post('/builder/reload', (res, req) => {
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'builder.manage', false, (_raw, aborted) => {
      void (async () => {
        if (writerBusy) return corkSend(res, aborted, builderJson(409, { ok: false, error: 'builder busy' }, { 'Retry-After': '1' }));
        writerBusy = true;
        try {
          const { schemas, hooks } = await loadTypesCacheBusted(dir, `reload:${process.pid}:${Date.now()}`);
          await swapFromIR(sql, live, schemas, [], new HookRegistry(hooks)); // applied=[] → swaps registry/hooks/relations, no per-type rebuild
          currentVersion = await computeCatalogVersion(dir);
          corkSend(res, aborted, builderJson(200, { ok: true, version: currentVersion }, { ETag: currentVersion }));
        } catch (e) { corkSend(res, aborted, builderError(e, locale)); }
        finally { writerBusy = false; }
      })();
    });
  });

  // be-09b — GATED data writes. The verb→perm map is fixed at the registration site (POST=create,
  // PUT=update, DELETE=delete); the same can(perm) fronts every verb so no method gets a weaker check.
  // Params captured sync BEFORE gate; body buffered by gate; parse + core dispatch on success.

  // Draft & Publish action sub-route (`content.publish`). 3 segments — structurally distinct from the
  // 2-segment data routes (ordering irrelevant: uWS matches by segment count + literals).
  route.post('/:type/:id/actions/:action', (res, req) => {
    const type = req.getParameter(0) ?? '';
    const idRaw = req.getParameter(1) ?? '';
    const actionRaw = req.getParameter(2) ?? '';
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'content.publish', true, (_raw, aborted) => {
      void (async () => {
        if (actionRaw !== 'publish' && actionRaw !== 'unpublish') {
          return corkSend(res, aborted, errorResponse(404, 'not found'));
        }
        let result: CoreResponse;
        try {
          result = await handleWrite(ctx, { method: 'POST', type, idRaw, body: undefined, action: actionRaw, locale });
        } catch {
          result = errorResponse(500, 'internal error');
        }
        corkSend(res, aborted, result);
      })();
    });
  });
  // i18n variant create: POST /:type/:id/locales/:locale (`content.create`). 4 segments; literal
  // `locales` distinguishes it from `/actions/:action`.
  route.post('/:type/:id/locales/:locale', (res, req) => {
    const type = req.getParameter(0) ?? '';
    const idRaw = req.getParameter(1) ?? '';
    const variantLocale = req.getParameter(2) ?? '';
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // UI error locale (header), distinct from the variantLocale data slug
    gate(res, req, 'content.create', true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      void (async () => {
        let result: CoreResponse;
        try {
          result = await handleWrite(ctx, { method: 'POST', type, idRaw, body: parsed.body, variantLocale, locale });
        } catch {
          result = errorResponse(500, 'internal error');
        }
        corkSend(res, aborted, result);
      })();
    });
  });
  const dataWrite = (method: string, perm: string, hasId: boolean) => (res: uWS.HttpResponse, req: uWS.HttpRequest): void => {
    const type = req.getParameter(0) ?? '';
    const idRaw = hasId ? (req.getParameter(1) ?? '') : '';
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, perm, true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      void (async () => {
        let result: CoreResponse;
        try {
          result = await handleWrite(ctx, { method, type, idRaw, body: parsed.body, locale });
        } catch {
          result = errorResponse(500, 'internal error');
        }
        corkSend(res, aborted, result);
      })();
    });
  };
  route.post('/:type', dataWrite('POST', 'content.create', false));
  route.put('/:type/:id', dataWrite('PUT', 'content.update', true));
  route.del('/:type/:id', dataWrite('DELETE', 'content.delete', true));

  // be-04 MEDIA — asset endpoints under the `/_files` literal prefix. A leading underscore is illegal
  // in an api_id (validateFieldName / deriveTableName), so `_files` can NEVER collide with a real
  // `/:type`; uWS also matches a static segment over a `:param`. The UPLOAD (POST) + DELETE are GATED on
  // `media.upload`; the GET reads stay PUBLIC.
  const fileCtx: FileContext = { sql: store.sql, provider: getStorageProvider() };
  // GATED upload (`media.upload`): read the content-type header SYNC (multipart boundary), buffer the
  // body (up to uploadMaxBytes) while resolving auth in parallel via gateUpload, then on allow parse the
  // buffered multipart through busboy and dispatch the core.
  route.post('/_files/upload', (res, req) => {
    const contentType = req.getHeader('content-type') ?? '';
    gateUpload(res, req, contentType, (raw, aborted) => {
      parseMultipartBuffer(contentType, raw, (parsed) => {
        void (async () => {
          if (!parsed.ok) return corkSend(res, aborted, errorResponse(parsed.status, parsed.message));
          let result: CoreResponse;
          try {
            result = await handleUpload(fileCtx, parsed.upload);
          } catch {
            result = errorResponse(500, 'internal error');
          }
          corkSend(res, aborted, result);
        })();
      });
    });
  });
  route.get('/_files', (res, req) => handleFilesRoute(res, req, 'GET', false, fileCtx));
  route.get('/_files/:id', (res, req) => handleFilesRoute(res, req, 'GET', true, fileCtx));
  // GATED delete (`media.upload`): a delete is a mutation. Capture the id sync, gate (bodyless), dispatch.
  route.del('/_files/:id', (res, req) => {
    const idRaw = req.getParameter(0) ?? '';
    gate(res, req, 'media.upload', false, (_raw, aborted) => {
      void (async () => {
        let result: CoreResponse;
        try {
          if (!/^(0|[1-9]\d*)$/.test(idRaw)) result = errorResponse(404, 'not found');
          else result = await handleDeleteFile(fileCtx, Number(idRaw));
        } catch {
          result = errorResponse(500, 'internal error');
        }
        corkSend(res, aborted, result);
      })();
    });
  });

  // be-09c — API-TOKEN management routes under the `/_keys` literal prefix (a leading `_` is illegal in an
  // api_id → it can NEVER shadow `/:type`; same precedent as `_files`/`_team`). auth + rbac are required
  // deps, so these always mount. ALL self routes (create/list/revoke-own) are SESSION-ONLY (gateKeys rejects ctx.via ===
  // 'key' so a key can never mint/revoke keys → no self-escalation). Owner is ALWAYS principal.userId — a
  // body `userId` is NEVER trusted (and is schema-server-only upstream → CVE-2025-61928 neutralized). The
  // raw secret is returned EXACTLY ONCE at create (corkSendNoStore, no-store, never logged); list/revoke
  // never echo it. Cross-user create/revoke require `token.manage`.
  const keysAuth = auth;
  const keysRbac = rbac;
  const keysSql = store.sql;

  const readJsonBodyKeys = (raw: Buffer | null): { ok: true; body: Record<string, unknown> } | { ok: false; error: CoreResponse } => {
    if (raw === null) return { ok: false, error: errorResponse(413, 'request body too large') };
    if (raw.length === 0) return { ok: true, body: {} };
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: errorResponse(400, 'invalid JSON body') };
      }
      return { ok: true, body: parsed as Record<string, unknown> };
    } catch {
      return { ok: false, error: errorResponse(400, 'invalid JSON body') };
    }
  };

  // Project a created/listed key row to the SAFE shape — NEVER the secret (`key`). The plugin already
  // strips `key` from list/verify; this projection is the SECOND wall. The raw secret (`createResult.key`)
  // is included ONLY by the create route, exactly once.
  const projectKey = (k: Record<string, unknown>): Record<string, unknown> => ({
    id: k.id,
    name: k.name ?? null,
    prefix: k.prefix ?? null,
    start: k.start ?? null,
    expiresAt: k.expiresAt ?? null,
    lastRequest: k.lastRequest ?? null,
    enabled: k.enabled ?? null,
    permissions: k.permissions ?? null,
    metadata: k.metadata ?? null,
    createdAt: k.createdAt ?? null,
  });

  // Validate the optional create inputs off a parsed body. `permissions` is the REQUESTED scope (a flat
  // array of CMS perm actions); every requested action MUST be in the OWNER's resolved RBAC set (a key
  // may not be MINTED with a scope its owner lacks — the runtime ∩ denies anyway, but failing at create
  // is honest and avoids a misleading "valid" key). Absent permissions ⇒ a no-scope key (grants nothing).
  type CreateInput =
    | { ok: true; name: string | undefined; prefix: string | undefined; expiresIn: number | undefined; scope: string[]; metadata: Record<string, unknown> | undefined }
    | { ok: false; error: CoreResponse };
  const parseCreateInput = (body: Record<string, unknown>, ownerId: string): CreateInput => {
    const name = typeof body.name === 'string' ? body.name : undefined;
    const prefix = typeof body.prefix === 'string' ? body.prefix : undefined;
    let expiresIn: number | undefined;
    if (body.expiresIn !== undefined) {
      if (typeof body.expiresIn !== 'number' || !Number.isFinite(body.expiresIn) || body.expiresIn < 1) {
        return { ok: false, error: errorResponse(400, 'expiresIn must be a positive number of seconds') };
      }
      expiresIn = body.expiresIn;
    }
    let scope: string[] = [];
    if (body.permissions !== undefined) {
      if (!Array.isArray(body.permissions) || body.permissions.some((a) => typeof a !== 'string')) {
        return { ok: false, error: errorResponse(400, 'permissions must be an array of action strings') };
      }
      scope = body.permissions as string[];
    }
    const owned = keysRbac.permissionsOf(ownerId);
    const exceeds = scope.filter((a) => !owned.has(a));
    if (exceeds.length > 0) {
      return { ok: false, error: errorResponse(400, `scope exceeds owner permissions: ${exceeds.join(', ')}`) };
    }
    let metadata: Record<string, unknown> | undefined;
    if (body.metadata !== undefined) {
      if (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata)) {
        return { ok: false, error: errorResponse(400, 'metadata must be an object') };
      }
      metadata = body.metadata as Record<string, unknown>;
    }
    return { ok: true, name, prefix, expiresIn, scope, metadata };
  };

  // Map a thrown error to a CoreResponse: a better-auth plugin validation error (an APIError with a 4xx
  // `statusCode`, e.g. EXPIRES_IN_IS_TOO_SMALL / INVALID prefix) surfaces as an HONEST 400 with the
  // plugin's message; anything else is an opaque 500. The raw secret is NEVER in an error path.
  const keyError = (err: unknown): CoreResponse => {
    const status = (err as { statusCode?: unknown })?.statusCode;
    const body = (err as { body?: { message?: unknown } })?.body;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const msg = typeof body?.message === 'string' ? body.message : 'invalid request';
      return errorResponse(400, msg);
    }
    return errorResponse(500, 'internal error');
  };

  // Mint a key for `ownerId`. SERVER call (NO headers) so `permissions` + `userId` are accepted (they are
  // server-only on a client request) — the owner is derived by US, never proxied from a client body. The
  // raw secret is returned ONCE; only non-secret fields are logged (none logged here — no log on this path).
  const mintKey = async (ownerId: string, input: Extract<CreateInput, { ok: true }>): Promise<Record<string, unknown>> => {
    const created = await keysAuth.api.createApiKey({
      body: {
        userId: ownerId,
        name: input.name,
        prefix: input.prefix,
        expiresIn: input.expiresIn,
        permissions: buildScopePermissions(input.scope),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    });
    return created as unknown as Record<string, unknown>;
  };

  // POST /_keys — create a key for SELF (session-only). owner = principal.userId. Returns the raw secret
  // EXACTLY ONCE (the `key` field of the create result), projected alongside the safe metadata.
  route.post('/_keys', (res, req) => {
    gateKeys(res, req, true, (authCtx, _headers, raw, aborted) => {
      if (authCtx.via !== 'session') return corkSendNoStore(res, aborted, 403, { error: 'key management requires a session' });
      const parsed = readJsonBodyKeys(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const ownerId = authCtx.principal!.userId;
      const input = parseCreateInput(parsed.body, ownerId);
      if (!input.ok) return corkSend(res, aborted, input.error);
      void (async () => {
        try {
          const created = await mintKey(ownerId, input);
          // The raw secret (`created.key`) is surfaced ONCE here; everything else is the safe projection.
          corkSendNoStore(res, aborted, 200, { data: { ...projectKey(created), key: created.key } });
        } catch (err) {
          corkSend(res, aborted, keyError(err));
        }
      })();
    });
  });

  // POST /_keys/for/:userId — create a key for ANOTHER user (gated `token.manage`). owner = the route
  // `:userId`; the scope-vs-owner check uses the TARGET's resolved RBAC set. Session-only (no key may
  // drive a cross-user mint).
  route.post('/_keys/for/:userId', (res, req) => {
    const targetId = req.getParameter(0) ?? '';
    gateKeys(res, req, true, (authCtx, _headers, raw, aborted) => {
      if (authCtx.via !== 'session') return corkSendNoStore(res, aborted, 403, { error: 'key management requires a session' });
      if (!authCtx.can('token.manage')) return corkSend(res, aborted, errorResponse(403, 'forbidden'));
      const parsed = readJsonBodyKeys(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      if (targetId.length === 0) return corkSend(res, aborted, errorResponse(400, 'userId is required'));
      const input = parseCreateInput(parsed.body, targetId);
      if (!input.ok) return corkSend(res, aborted, input.error);
      void (async () => {
        try {
          const exists = await keysSql`SELECT 1 FROM "user" WHERE id = ${targetId}`;
          if (exists.length === 0) return corkSendNoStore(res, aborted, 404, { error: 'user not found' });
          const created = await mintKey(targetId, input);
          corkSendNoStore(res, aborted, 200, { data: { ...projectKey(created), key: created.key } });
        } catch (err) {
          corkSend(res, aborted, keyError(err));
        }
      })();
    });
  });

  // GET /_keys — list MY keys (session-only, own-only). `listApiKeys` returns the owner's keys with the
  // secret structurally absent; we project to the safe shape (NEVER `key`) as the second wall.
  route.get('/_keys', (res, req) => {
    gateKeys(res, req, false, (authCtx, headers, _body, aborted) => {
      if (authCtx.via !== 'session') return corkSendNoStore(res, aborted, 403, { error: 'key management requires a session' });
      void (async () => {
        try {
          // listApiKeys returns `{ apiKeys, total, limit, offset }` — the secret is already stripped.
          const result = (await keysAuth.api.listApiKeys({ headers })) as unknown as { apiKeys: Record<string, unknown>[] };
          const data = result.apiKeys.map(projectKey);
          corkSendNoStore(res, aborted, 200, { data });
        } catch {
          corkSend(res, aborted, errorResponse(500, 'internal error'));
        }
      })();
    });
  });

  // DELETE /_keys/:id — REVOKE a key. own-only unless `token.manage`. We resolve the key's owner from PG
  // (apikey.referenceId) FIRST, then: an own key → delete via the better-auth API (the plugin enforces
  // referenceId === session.user.id); a NON-own key → require `token.manage`, then SQL-delete the row
  // (the plugin's deleteApiKey is hard own-only, and the apikey row in PG is the DURABLE truth verifyApiKey
  // reads, so a SQL delete is instantly effective). A key id the caller neither owns nor may manage → 403,
  // NEVER a blind delete-by-id (no IDOR). A missing id → 404. Revocation is INSTANT: no key cache, the
  // next verifyApiKey misses → 401.
  route.del('/_keys/:id', (res, req) => {
    const keyId = req.getParameter(0) ?? '';
    gateKeys(res, req, false, (authCtx, headers, _body, aborted) => {
      if (authCtx.via !== 'session') return corkSendNoStore(res, aborted, 403, { error: 'key management requires a session' });
      void (async () => {
        try {
          if (keyId.length === 0) return corkSendNoStore(res, aborted, 404, { error: 'not found' });
          const rows = await keysSql<{ referenceId: string }[]>`SELECT "referenceId" FROM apikey WHERE id = ${keyId}`;
          if (rows.length === 0) return corkSendNoStore(res, aborted, 404, { error: 'not found' });
          const ownerId = rows[0]!.referenceId;
          const isOwn = ownerId === authCtx.principal!.userId;
          if (!isOwn && !authCtx.can('token.manage')) {
            return corkSend(res, aborted, errorResponse(403, 'forbidden'));
          }
          if (isOwn) {
            await keysAuth.api.deleteApiKey({ body: { keyId }, headers });
          } else {
            // Cross-user revoke (token.manage): the plugin API is hard own-only, so delete the durable PG
            // row directly. PG is the truth verifyApiKey consults → the next request with the key is 401.
            await keysSql`DELETE FROM apikey WHERE id = ${keyId}`;
          }
          corkSendNoStore(res, aborted, 200, { data: { id: keyId, revoked: true } });
        } catch {
          corkSend(res, aborted, errorResponse(500, 'internal error'));
        }
      })();
    });
  });

  // be-09f — TEAM-MANAGEMENT routes under the `/_team` literal prefix (a leading `_` is illegal in an
  // api_id, so it can NEVER shadow `/:type`; same precedent as `_files`). teamView is a required dep, so
  // these always mount. EVERY route is gated on `team.manage` (super-admin only this
  // slice). The actor/principal comes ONLY from the session (gateTeam); the route/body `:userId` only
  // designates the TARGET (no mass-assignment). Lifecycle (suspend/remove/revoke) goes through the
  // better-auth API so the adapter fires per-session `session.delete.after` → our evict (PUSH revocation);
  // raw SQL on user/session is forbidden by policy. team_view + RBAC are reloaded DIRECTLY (no event bus).
  const tv = teamView;
  const teamSql = store.sql;

  // Privilege ranking for the actor-role cap + last-admin guard. A higher number = more privilege. An
  // unknown/unranked role is 0 (the floor) so it can assign nothing. super-admin is the ceiling.
  const ROLE_RANK: Record<string, number> = { 'super-admin': 4, editor: 3, author: 2, viewer: 1 };
  const rankOf = (role: string | null): number => (role !== null ? (ROLE_RANK[role] ?? 0) : 0);

  const readJsonBody = (raw: Buffer | null): { ok: true; body: unknown } | { ok: false; error: CoreResponse } => {
    if (raw === null) return { ok: false, error: errorResponse(413, 'request body too large') };
    if (raw.length === 0) return { ok: true, body: {} };
    try {
      return { ok: true, body: JSON.parse(raw.toString('utf8')) as unknown };
    } catch {
      return { ok: false, error: errorResponse(400, 'invalid JSON body') };
    }
  };

  // GET /_team — the member directory straight from RAM (ZERO-PG). `no-store` so a stale directory can
  // never be replayed from an HTTP cache after a logout/role change.
  route.get('/_team', (res, req) => {
    gateTeam(res, req, false, (_principal, _headers, _body, aborted) => {
      const members: TeamRow[] = tv.list();
      corkSendNoStore(res, aborted, 200, { data: members });
    });
  });

  // POST /_team — add a member (idempotent). The `userId` is the TARGET; it must be an existing identity.
  // NO role is assigned here (an added identity has no team role until POST /_team/:userId/role).
  route.post('/_team', (res, req) => {
    gateTeam(res, req, true, (_principal, _headers, raw, aborted) => {
      const parsed = readJsonBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const userId = (parsed.body as { userId?: unknown }).userId;
      if (typeof userId !== 'string' || userId.length === 0) {
        return corkSend(res, aborted, errorResponse(400, 'userId is required'));
      }
      void (async () => {
        try {
          const inserted = await teamSql<{ user_id: string }[]>`
            INSERT INTO team (user_id, status)
              SELECT ${userId}, 'active' WHERE EXISTS (SELECT 1 FROM "user" WHERE id = ${userId})
            ON CONFLICT (user_id) DO NOTHING
            RETURNING user_id
          `;
          // No row inserted AND not already present AND the user does not exist → 404. (An idempotent
          // re-add of an existing member returns 200.)
          if (inserted.length === 0 && tv.get(userId) === null) {
            const exists = await teamSql`SELECT 1 FROM "user" WHERE id = ${userId}`;
            if (exists.length === 0) return corkSendNoStore(res, aborted, 404, { error: 'user not found' });
          }
          await tv.rebuild();
          const row = tv.get(userId);
          corkSendNoStore(res, aborted, 200, { data: row });
        } catch {
          corkSend(res, aborted, errorResponse(500, 'internal error'));
        }
      })();
    });
  });

  // POST /_team/:userId/role — set the target's RBAC role in OUR user_roles. Guards (in order):
  //   (1) target must be in team_view (404 on miss);
  //   (2) PRIVILEGE CAP — the requested role's rank must be STRICTLY below the actor's own resolved role
  //       (no actor can assign a role >= their own; a non-super-admin can never assign super-admin);
  //   (3) LAST-ADMIN GUARD — a demotion that would drop active super-admins to zero is rejected.
  // On success: DELETE+INSERT the user_roles row in one tx, then rbac.rebuild() AND teamView.rebuild().
  route.post('/_team/:userId/role', (res, req) => {
    const targetId = req.getParameter(0) ?? '';
    gateTeam(res, req, true, (principal, _headers, raw, aborted) => {
      const parsed = readJsonBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const role = (parsed.body as { role?: unknown }).role;
      if (typeof role !== 'string' || role.length === 0) {
        return corkSend(res, aborted, errorResponse(400, 'role is required'));
      }
      void (async () => {
        try {
          const target = tv.get(targetId);
          if (target === null) return corkSendNoStore(res, aborted, 404, { error: 'not a team member' });
          // The actor's authority is resolved from team_view (session-derived), never the body.
          const actorRank = rankOf(tv.get(principal.userId)?.role ?? null);
          const requestedRank = rankOf(role);
          if (requestedRank === 0) return corkSendNoStore(res, aborted, 400, { error: 'unknown role' });
          if (requestedRank >= actorRank) {
            return corkSendNoStore(res, aborted, 403, { error: 'cannot assign a role at or above your own' });
          }
          // Last-admin guard: demoting the target away from super-admin must not zero the active admins.
          if (target.role === 'super-admin' && role !== 'super-admin' && target.status === 'active'
            && tv.activeSuperAdminCount() <= 1) {
            return corkSendNoStore(res, aborted, 403, { error: 'cannot demote the last super-admin' });
          }
          const roleRow = await teamSql<{ id: number }[]>`SELECT id FROM roles WHERE name = ${role}`;
          if (roleRow.length === 0) return corkSendNoStore(res, aborted, 400, { error: 'unknown role' });
          await teamSql.begin(async (txn) => {
            await txn`DELETE FROM user_roles WHERE user_id = ${targetId}`;
            await txn`INSERT INTO user_roles (user_id, role_id) VALUES (${targetId}, ${roleRow[0]!.id})`;
            // be-09f — keep the better-auth `user.role` column in lock-step with the resolved CMS role so
            // better-auth's OWN admin-endpoint authz (adminRoles:['super-admin']) recognizes a super-admin
            // as able to drive lifecycle. This column is NOT a CMS authz source (RbacRegistry never reads
            // it); it is a non-session field, so this write does not bypass session coherence.
            await txn`UPDATE "user" SET "role" = ${role}, "updatedAt" = now() WHERE id = ${targetId}`;
          });
          await rbac.rebuild();
          await tv.rebuild();
          corkSendNoStore(res, aborted, 200, { data: tv.get(targetId) });
        } catch {
          corkSend(res, aborted, errorResponse(500, 'internal error'));
        }
      })();
    });
  });

  // POST /_team/:userId/suspend — PUSH revocation. (1) resolve target (404 on miss); (2) last-admin guard;
  // (3) flip team.status='suspended'; (4) ban + revoke ALL sessions via the better-auth API (deletes the
  // PG session rows and fires session.delete.after → SessionCache.evict per session); (5) rbac.rebuild()
  // (a suspended member keeps no effective authority via team_view's status) + teamView.rebuild().
  route.post('/_team/:userId/suspend', (res, req) => {
    const targetId = req.getParameter(0) ?? '';
    gateTeam(res, req, false, (_principal, headers, _body, aborted) => {
      void (async () => {
        try {
          const target = tv.get(targetId);
          if (target === null) return corkSendNoStore(res, aborted, 404, { error: 'not a team member' });
          if (target.role === 'super-admin' && target.status === 'active' && tv.activeSuperAdminCount() <= 1) {
            return corkSendNoStore(res, aborted, 403, { error: 'cannot suspend the last super-admin' });
          }
          await teamSql`UPDATE team SET status = 'suspended', updated_at = now() WHERE user_id = ${targetId}`;
          // Lifecycle THROUGH the API (the acting admin's headers carry the session) — the adapter deletes
          // the PG session rows and fires the per-session evict. We assert post-conditions (status flipped
          // + sessions gone), not the API's 2xx.
          await auth.api.banUser({ body: { userId: targetId }, headers });
          await auth.api.revokeUserSessions({ body: { userId: targetId }, headers });
          // be-09c — DURABLE owner-key revoke. The apikey row in PG is the truth verifyApiKey reads, so a
          // SQL delete of every key the suspended owner holds makes them ALL fail the very next request
          // (the token analog of revokeUserSessions). Belt-and-suspenders alongside the resolution-time
          // suspended-owner deny + the empty-RBAC intersection (rbac.rebuild below).
          await teamSql`DELETE FROM apikey WHERE "referenceId" = ${targetId}`;
          await rbac.rebuild();
          await tv.rebuild();
          corkSendNoStore(res, aborted, 200, { data: tv.get(targetId) });
        } catch {
          corkSend(res, aborted, errorResponse(500, 'internal error'));
        }
      })();
    });
  });

  // DELETE /_team/:userId — hard-remove a member. (1) resolve target (404); (2) self-guard + last-admin
  // guard; (3) removeUser via the API (cascades session deletes → evict; ON DELETE CASCADE tidies
  // team/user_roles); (4) teamView.rebuild() + rbac.rebuild(). content.createdBy is a SOFT ref (no FK) so
  // removal never hits an FK violation — a removed author simply misses team_view ("former member").
  route.del('/_team/:userId', (res, req) => {
    const targetId = req.getParameter(0) ?? '';
    gateTeam(res, req, false, (principal, headers, _body, aborted) => {
      void (async () => {
        try {
          const target = tv.get(targetId);
          if (target === null) return corkSendNoStore(res, aborted, 404, { error: 'not a team member' });
          if (targetId === principal.userId) {
            return corkSendNoStore(res, aborted, 403, { error: 'cannot remove yourself' });
          }
          if (target.role === 'super-admin' && target.status === 'active' && tv.activeSuperAdminCount() <= 1) {
            return corkSendNoStore(res, aborted, 403, { error: 'cannot remove the last super-admin' });
          }
          // be-09c — revoke the target's API keys BEFORE removeUser. ON DELETE CASCADE on `user` would
          // drop the apikey rows in PG anyway, but — like sessions — a DB cascade does NOT fire any
          // better-auth hook, so we revoke explicitly + durably (the apikey row is verifyApiKey's truth →
          // the next request with any of the removed user's keys is 401). Three walls: this revoke, the
          // verifyApiKey INVALID_REFERENCE_ID (no user row), and the empty-RBAC intersection.
          await teamSql`DELETE FROM apikey WHERE "referenceId" = ${targetId}`;
          await auth.api.removeUser({ body: { userId: targetId }, headers });
          await tv.rebuild();
          await rbac.rebuild();
          corkSendNoStore(res, aborted, 200, { data: { userId: targetId, removed: true } });
        } catch {
          corkSend(res, aborted, errorResponse(500, 'internal error'));
        }
      })();
    });
  });

  // Everything else (root, non-GET on a known route, deeper paths): let the core decide the status
  // (404 / 405). We pass the real method + path so a non-GET on /:type still yields 405.
  route.any('/*', (res, req) => {
    const method = req.getMethod();
    const url = req.getUrl();
    const query = req.getQuery() ?? '';
    // `url` from getUrl() INCLUDES basePath (this is the only handler that reads it) — strip it so the
    // core sees the bare path (e.g. '/api/foo' -> '/foo'); an empty basePath is a no-op.
    const path = P !== '' && url.startsWith(P) ? url.slice(P.length) || '/' : url;
    writeResponse(res, handleRequest(live.engine, { method, path, query }));
  });

  // The admin SPA: serve its prebuilt bundle from RAM at the ROOT (every non-API path), registered LAST so
  // the more-specific basePath routes win. Only when an adminDir is supplied (createConti) — the test/SDK
  // harness passes none, so the root stays the content API and behavior is byte-identical.
  if (adminDir !== undefined) {
    const bundle = loadAdminBundle(adminDir);
    if (bundle) mountAdmin(app, bundle);
  }

  return {
    listen(port: number): Promise<ListenToken> {
      return new Promise((resolve, reject) => {
        app.listen(port, (token) => {
          if (token) resolve(token);
          else reject(new Error(`uWS failed to listen on port ${port}`));
        });
      });
    },
    close(token: ListenToken): void {
      if (token) uWS.us_listen_socket_close(token as uWS.us_listen_socket);
    },
    // The Builder (applyEdit) is always wired now (modulesDir is required), so always expose it.
    applyEdit: applyEditFn,
  };
}
