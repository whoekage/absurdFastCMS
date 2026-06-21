import uWS from 'uWebSockets.js';
import busboy from 'busboy';
import type { Engine } from '../store/engine.ts';
import type { Registry } from '../store/registry.ts';
import type { PostgresStore } from '../db/postgres.store.ts';
import { rebuildType } from '../db/engine.loader.ts';
import { handleRequest, errorResponse, type CoreResponse } from './read.router.ts';
import { handleWrite, type WriteContext } from './write.handler.ts';
import { handleContentTypeRequest, type ContentTypeContext } from './content-type.controller.ts';
import { handleComponentTypeRequest, type ComponentTypeContext } from './component-type.controller.ts';
import { handleUpload, handleListFiles, handleGetFile, handleDeleteFile, type FileContext, type ParsedUpload } from './upload.handler.ts';
import { mediaPopulateTargets, stripMediaPopulate, applyMediaPopulate } from './media.populate.ts';
import { componentPopulateTargets, applyComponentPopulate } from './component.populate.ts';
import { getStorageProvider } from '../storage/index.ts';
import { listTypes, inspectType } from '../store/inspect.ts';
import { handleAuthRoute } from '../auth/auth.bridge.ts';
import type { Auth } from '../auth/auth.ts';
import type { SessionCache, Principal } from '../auth/session.cache.ts';
import type { RbacRegistry } from '../auth/rbac.registry.ts';
import { config } from '../config.ts';

/**
 * uWS-MIGRATION SLICE 1 — the uWebSockets.js HTTP adapter, a THIN transport shim over the
 * framework-agnostic {@link handleRequest} core in `router.ts`. Since the slice-2 cutover this is the
 * one and only HTTP server. The adapter does nothing but read the request triple `{ method, path, query }`
 * SYNCHRONOUSLY off the stack-allocated uWS `req` at the top of the handler, call the pure core,
 * and write its `{ status, contentType, body }` onto the uWS `res`. All routing / validation /
 * status codes / late-materialized response Buffers stay in ONE place (the core), so the adapter
 * adds zero behavior — only plumbing.
 *
 * READS are SYNCHRONOUS — read getMethod()/getParameter()/getQuery() into locals at the top, call
 * the pure core, write the result; `req` is never touched after, so no onAborted is needed.
 *
 * WRITES (POST/PUT/DELETE, only wired when a {@link PostgresStore} is supplied) are ASYNCHRONOUS — they
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

/** The adapter handle: start/stop a real uWS server over the given engine. */
export interface UwsServer {
  /** Bind and listen on `port`. Resolves with the listen-socket token. */
  listen(port: number): Promise<ListenToken>;
  /** Close a previously-returned listen-socket token. */
  close(token: ListenToken): void;
}

/** Full HTTP status lines for the statuses the core can emit. */
const STATUS_LINE: Record<number, string> = {
  200: '200 OK',
  201: '201 Created',
  400: '400 Bad Request',
  401: '401 Unauthorized',
  403: '403 Forbidden',
  404: '404 Not Found',
  405: '405 Method Not Allowed',
  409: '409 Conflict',
  413: '413 Payload Too Large',
  415: '415 Unsupported Media Type',
  500: '500 Internal Server Error',
};

function statusLine(status: number): string {
  return STATUS_LINE[status] ?? `${status} Status`;
}

/** Write a {@link CoreResponse} onto the uWS response (synchronous; offset-safe body view). */
function writeResponse(res: uWS.HttpResponse, result: CoreResponse): void {
  res.writeStatus(statusLine(result.status));
  res.writeHeader('Content-Type', result.contentType);
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

/**
 * be-09b — the data WRITE routes (POST/PUT/DELETE /:type[/:id]), the D&P action sub-route, and the i18n
 * variant-create are now registered INLINE inside {@link createServer} so each can be wrapped by the
 * per-route RBAC gate (the gate must close over `sessionCache`/`rbac`). The shared async dispatch shape
 * (413/400/500 handling + corkSend) is preserved verbatim at each gated registration site.
 */

/** Which template a builder route is on — drives which getParameter slots to read synchronously. */
interface CtRouteOpts {
  /** Read getParameter(0) as `:apiId` (false for the `/content-types` collection). */
  hasApiId: boolean;
  /** The literal segment after `:apiId` (`'fields'`), or undefined. */
  sub?: string;
  /** Read getParameter(1) as `:name` (the `.../fields/:name` template). */
  hasName?: boolean;
}

/**
 * A CONTENT-TYPE BUILDER route — structurally identical to {@link handleWriteRoute}: capture the
 * params synchronously, read the body (reusing the {@link MAX_BODY_BYTES} cap -> 413), JSON.parse in a
 * try/catch -> 400, run the async core, then cork the response. GET/DELETE also drain the body (empty
 * -> `body=undefined`). An unexpected throw from the core maps to 500 here (no message leak).
 */
function handleContentTypeRoute(res: uWS.HttpResponse, req: uWS.HttpRequest, method: string, ctx: ContentTypeContext, opts: CtRouteOpts): void {
  const apiId = opts.hasApiId ? (req.getParameter(0) ?? '') : undefined;
  const fieldName = opts.hasName ? (req.getParameter(1) ?? '') : undefined;
  const { aborted } = readBody(res, (raw) => {
    void (async () => {
      if (raw === null) return corkSend(res, aborted, errorResponse(413, 'request body too large'));
      let body: unknown = undefined;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          return corkSend(res, aborted, errorResponse(400, 'invalid JSON body'));
        }
      }
      let result: CoreResponse;
      try {
        result = await handleContentTypeRequest(ctx, { method, apiId, fieldName, sub: opts.sub, body });
      } catch {
        result = errorResponse(500, 'internal error');
      }
      corkSend(res, aborted, result);
    })();
  });
}

/**
 * be-05 — a COMPONENT-TYPE BUILDER route. Structurally identical to {@link handleContentTypeRoute}:
 * capture params synchronously, read the body (413 cap, JSON.parse -> 400), run the async core, cork the
 * response. The `/component-types` literal prefix can never shadow a real `/:type` ('-' is illegal in an
 * api_id, and uWS matches a static segment over a `:param`).
 */
function handleComponentTypeRoute(res: uWS.HttpResponse, req: uWS.HttpRequest, method: string, ctx: ComponentTypeContext, opts: CtRouteOpts): void {
  const apiId = opts.hasApiId ? (req.getParameter(0) ?? '') : undefined;
  const fieldName = opts.hasName ? (req.getParameter(1) ?? '') : undefined;
  const { aborted } = readBody(res, (raw) => {
    void (async () => {
      if (raw === null) return corkSend(res, aborted, errorResponse(413, 'request body too large'));
      let body: unknown = undefined;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          return corkSend(res, aborted, errorResponse(400, 'invalid JSON body'));
        }
      }
      let result: CoreResponse;
      try {
        result = await handleComponentTypeRequest(ctx, { method, apiId, fieldName, sub: opts.sub, body });
      } catch {
        result = errorResponse(500, 'internal error');
      }
      corkSend(res, aborted, result);
    })();
  });
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
 * Build a uWS server over `engine`. Construction is SEPARATE from listening so tests build the
 * server once and bind it to a free port chosen by the harness.
 *
 * Pass a {@link PostgresStore} AND a {@link Registry} to ENABLE WRITES: POST/PUT/DELETE commit to
 * Postgres and then rebuild ONLY the written type's RAM storage in place ({@link Engine.replaceType}),
 * invalidating ONLY that type's response cache (sibling types stay hot). The engine object itself is
 * NEVER reassigned on a write — only its per-type storage is swapped — so the read handlers' reference
 * stays valid. Without a store the server is read-only and a write falls to the core's 405.
 */
export function createServer(
  engine: Engine,
  store?: PostgresStore,
  registry?: Registry,
  publishClock: () => Date = () => new Date(),
  auth?: Auth,
  sessionCache?: SessionCache,
  rbac?: RbacRegistry,
): UwsServer {
  const app = uWS.App();
  const current = engine;

  /**
   * be-09b — the per-request AUTH context. `principal` comes ONLY from {@link SessionCache.validate}
   * (never a body field — neutralizes the mass-assignment class); `can(perm)` is a pure
   * {@link RbacRegistry.checkPermission} set test. The warm path is ZERO-PG (validate is an off-heap probe,
   * checkPermission is a RAM Map lookup).
   */
  interface AuthContext {
    principal: Principal | null;
    can(perm: string): boolean;
  }

  /**
   * be-09b — gating is ACTIVE only when the security primitives are wired (production: server.ts passes both
   * sessionCache + rbac). A server built WITHOUT them (read-only servers AND the test/bench write servers
   * that predate auth) leaves the write/builder/media routes OPEN — exactly as before this slice — so no
   * existing behavior regresses. Production ALWAYS wires both, so production is ALWAYS gated.
   */
  const authEnabled = sessionCache !== undefined && rbac !== undefined;

  /** Resolve the {@link AuthContext} for a request. Closes over `sessionCache`/`rbac` (mirrors mediaRead). */
  async function resolveAuth(headers: Headers): Promise<AuthContext> {
    const principal = sessionCache !== undefined ? await sessionCache.validate(headers) : null;
    return {
      principal,
      can: (perm) => principal !== null && rbac !== undefined && rbac.checkPermission(principal, perm),
    };
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
      // Auth not wired (read-only / legacy write server) → the route is OPEN (no regression). Dispatch
      // synchronously without ever touching resolveAuth.
      if (!authEnabled) return proceed(body, aborted);
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
      // Auth not wired → open (no regression): skip the authz split entirely.
      if (authEnabled) {
        // Authz split FIRST — never even look at the (possibly oversized) body for an unauthorized caller.
        if (ctx!.principal === null) return corkSend(res, () => aborted, errorResponse(401, 'unauthenticated'));
        if (!ctx!.can('media.upload')) return corkSend(res, () => aborted, errorResponse(403, 'forbidden'));
      }
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

    if (!authEnabled) {
      authDone = true;
      tryFinish();
    } else {
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
  function mediaRead(res: uWS.HttpResponse, method: string, path: string, type: string, query: string): boolean {
    if (registry === undefined || store === undefined) return false;
    if (method.toUpperCase() !== 'GET') return false;
    const def = registry.get(type);
    if (def === undefined || (def.mediaFields.size === 0 && def.componentFields.size === 0)) return false;
    const mediaTargets = mediaPopulateTargets(def, query);
    const componentTargets = componentPopulateTargets(def, query);
    if (mediaTargets.size === 0 && componentTargets.size === 0) return false;

    const reg = registry;
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
        const base = handleRequest(current, { method, path, query: strippedQuery });
        // Only a successful read carries a value to resolve; a 400/404/405 passes straight through.
        if (base.status === 200) {
          let body = base.body;
          if (mediaTargets.size > 0) body = (await applyMediaPopulate(sql, body, mediaTargets)).body;
          if (componentTargets.size > 0) body = (await applyComponentPopulate(sql, current, reg, body, componentTargets)).body;
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
    // INDEX: every content-type + row count.
    app.get('/debug-inspect', (res) => {
      writeJson(res, 200, listTypes(current));
    });
    // ONE type: per-column storage/stats + relations + a decoded row window (?offset=&limit=).
    app.get('/debug-inspect/:type', (res, req) => {
      const type = req.getParameter(0) ?? '';
      const params = new URLSearchParams(req.getQuery() ?? '');
      const offset = toInt(params.get('offset'));
      const limit = toInt(params.get('limit'));
      const result = inspectType(current, type, { offset, limit });
      if (result === null) writeJson(res, 404, { error: `unknown content-type "${type}"` });
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
  // content-type can never be named `auth` and shadow these in reverse; reads of OTHER types are
  // byte-untouched. Mounted only when an auth instance is supplied (a read-only/test-only server omits it
  // → /auth falls to the core's 404). This slice gates NOTHING — it only proxies the provider.
  if (auth !== undefined) {
    const onAuth = (res: uWS.HttpResponse, req: uWS.HttpRequest): void => handleAuthRoute(res, req, auth);
    app.get('/auth/:p', onAuth);
    app.post('/auth/:p', onAuth);
    app.put('/auth/:p', onAuth);
    app.del('/auth/:p', onAuth);
    app.any('/auth/*', onAuth);
  }

  // LIST: /:type  — read everything off `req` synchronously, then delegate to the core.
  app.get('/:type', (res, req) => {
    const method = req.getMethod();
    const type = req.getParameter(0) ?? '';
    const query = req.getQuery() ?? '';
    // SYNC handler: no await past this point, so `req` is no longer touched and no onAborted needed —
    // UNLESS this is a media-populate read (registry present + a media field targeted), which needs an
    // async batched `files` lookup. mediaRead returns true iff it took the async path (else fall through).
    if (mediaRead(res, method, `/${type}`, type, query)) return;
    writeResponse(res, handleRequest(current, { method, path: `/${type}`, query }));
  });

  // SINGLE: /:type/:id
  app.get('/:type/:id', (res, req) => {
    const method = req.getMethod();
    const type = req.getParameter(0) ?? '';
    const id = req.getParameter(1) ?? '';
    const query = req.getQuery() ?? '';
    if (mediaRead(res, method, `/${type}/${id}`, type, query)) return;
    writeResponse(res, handleRequest(current, { method, path: `/${type}/${id}`, query }));
  });

  // WRITES (only when a store + registry are supplied): commit to Postgres, then rebuild ONLY the
  // written type's RAM storage in place (per-type rebuild + per-type cache invalidation).
  if (store && registry) {
    const ctx: WriteContext = {
      engine: () => current,
      registry: () => registry,
      sql: store.sql,
      rebuild: async (type: string) => {
        // A DATA write never changes the schema, so re-stream the ALREADY-RESOLVED registry def — no
        // meta re-query on the hot path (CL20). Only an actual schema mutation (addField/dropField/
        // changeFieldType) must call registry.rebuildType to re-read content_types/content_type_fields;
        // that is the future DDL hook, NOT this per-entry-write path. The def is guaranteed present: the
        // write core resolved it via registry.get(type) before any SQL ran.
        const def = registry.get(type)!;
        await rebuildType(store.sql, current, def, registry);
      },
      // Publish clock: real wall-clock by default; tests inject a fixed Date for deterministic fixtures.
      publishClock,
    };
    // CONTENT-TYPE BUILDER (runtime DDL over HTTP) — registered BEFORE the data `/:type` routes. The
    // `/content-types` prefix can never shadow a real type: '-' is not a legal api_id char, so no
    // content-type is ever named 'content-types', and uWS matches a static segment over a `:param`.
    // Wired only here (store + registry present): a read-only server has no builder, so /content-types
    // falls to any('/*') -> 404. An unsupported verb on a builder path is not a registered (path,verb),
    // so it also falls to any('/*') -> the read core -> 404 (the spec-permitted method-mismatch handling).
    const ctCtx: ContentTypeContext = { sql: store.sql, engine: () => current, registry: () => registry };

    // be-09b — GATED content-type BUILDER mutation. Captures the sync params off `req` FIRST (req is
    // stack-allocated), then gate('builder.manage') buffers the body + applies the 401/403 split, and on
    // success parses + dispatches the existing core. GET stays public (no gate).
    const ctMutate = (method: string, opts: CtRouteOpts) => (res: uWS.HttpResponse, req: uWS.HttpRequest): void => {
      const apiId = opts.hasApiId ? (req.getParameter(0) ?? '') : undefined;
      const fieldName = opts.hasName ? (req.getParameter(1) ?? '') : undefined;
      gate(res, req, 'builder.manage', true, (raw, aborted) => {
        const parsed = parseBody(raw);
        if (!parsed.ok) return corkSend(res, aborted, parsed.error);
        void (async () => {
          let result: CoreResponse;
          try {
            result = await handleContentTypeRequest(ctCtx, { method, apiId, fieldName, sub: opts.sub, body: parsed.body });
          } catch {
            result = errorResponse(500, 'internal error');
          }
          corkSend(res, aborted, result);
        })();
      });
    };
    app.post('/content-types', ctMutate('POST', { hasApiId: false }));
    app.get('/content-types', (res, req) => handleContentTypeRoute(res, req, 'GET', ctCtx, { hasApiId: false }));
    app.get('/content-types/:apiId', (res, req) => handleContentTypeRoute(res, req, 'GET', ctCtx, { hasApiId: true }));
    app.del('/content-types/:apiId', ctMutate('DELETE', { hasApiId: true }));
    app.post('/content-types/:apiId/relations', ctMutate('POST', { hasApiId: true, sub: 'relations' }));
    app.post('/content-types/:apiId/fields', ctMutate('POST', { hasApiId: true, sub: 'fields' }));
    app.put('/content-types/:apiId/fields/:name', ctMutate('PUT', { hasApiId: true, sub: 'fields', hasName: true }));
    app.del('/content-types/:apiId/fields/:name', ctMutate('DELETE', { hasApiId: true, sub: 'fields', hasName: true }));

    // be-05 COMPONENT-TYPE BUILDER (meta-only runtime schema over HTTP). Same `/component-types` literal-
    // prefix safety as `/content-types` ('-' is illegal in an api_id). No engine sync (components have no
    // engine presence) — the controller syncs only the registry's component store. GATED on builder.manage.
    const cmpCtx: ComponentTypeContext = { sql: store.sql, registry: () => registry };
    const cmpMutate = (method: string, opts: CtRouteOpts) => (res: uWS.HttpResponse, req: uWS.HttpRequest): void => {
      const apiId = opts.hasApiId ? (req.getParameter(0) ?? '') : undefined;
      const fieldName = opts.hasName ? (req.getParameter(1) ?? '') : undefined;
      gate(res, req, 'builder.manage', true, (raw, aborted) => {
        const parsed = parseBody(raw);
        if (!parsed.ok) return corkSend(res, aborted, parsed.error);
        void (async () => {
          let result: CoreResponse;
          try {
            result = await handleComponentTypeRequest(cmpCtx, { method, apiId, fieldName, sub: opts.sub, body: parsed.body });
          } catch {
            result = errorResponse(500, 'internal error');
          }
          corkSend(res, aborted, result);
        })();
      });
    };
    app.post('/component-types', cmpMutate('POST', { hasApiId: false }));
    app.get('/component-types', (res, req) => handleComponentTypeRoute(res, req, 'GET', cmpCtx, { hasApiId: false }));
    app.get('/component-types/:apiId', (res, req) => handleComponentTypeRoute(res, req, 'GET', cmpCtx, { hasApiId: true }));
    app.del('/component-types/:apiId', cmpMutate('DELETE', { hasApiId: true }));
    app.post('/component-types/:apiId/fields', cmpMutate('POST', { hasApiId: true, sub: 'fields' }));
    app.del('/component-types/:apiId/fields/:name', cmpMutate('DELETE', { hasApiId: true, sub: 'fields', hasName: true }));

    // be-09b — GATED data writes. The verb→perm map is fixed at the registration site (POST=create,
    // PUT=update, DELETE=delete); the same can(perm) fronts every verb so no method gets a weaker check.
    // Params captured sync BEFORE gate; body buffered by gate; parse + core dispatch on success.

    // Draft & Publish action sub-route (`content.publish`). 3 segments — structurally distinct from the
    // 2-segment data routes (ordering irrelevant: uWS matches by segment count + literals).
    app.post('/:type/:id/actions/:action', (res, req) => {
      const type = req.getParameter(0) ?? '';
      const idRaw = req.getParameter(1) ?? '';
      const actionRaw = req.getParameter(2) ?? '';
      gate(res, req, 'content.publish', true, (_raw, aborted) => {
        void (async () => {
          if (actionRaw !== 'publish' && actionRaw !== 'unpublish') {
            return corkSend(res, aborted, errorResponse(404, 'not found'));
          }
          let result: CoreResponse;
          try {
            result = await handleWrite(ctx, { method: 'POST', type, idRaw, body: undefined, action: actionRaw });
          } catch {
            result = errorResponse(500, 'internal error');
          }
          corkSend(res, aborted, result);
        })();
      });
    });
    // i18n variant create: POST /:type/:id/locales/:locale (`content.create`). 4 segments; literal
    // `locales` distinguishes it from `/actions/:action`.
    app.post('/:type/:id/locales/:locale', (res, req) => {
      const type = req.getParameter(0) ?? '';
      const idRaw = req.getParameter(1) ?? '';
      const variantLocale = req.getParameter(2) ?? '';
      gate(res, req, 'content.create', true, (raw, aborted) => {
        const parsed = parseBody(raw);
        if (!parsed.ok) return corkSend(res, aborted, parsed.error);
        void (async () => {
          let result: CoreResponse;
          try {
            result = await handleWrite(ctx, { method: 'POST', type, idRaw, body: parsed.body, variantLocale });
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
      gate(res, req, perm, true, (raw, aborted) => {
        const parsed = parseBody(raw);
        if (!parsed.ok) return corkSend(res, aborted, parsed.error);
        void (async () => {
          let result: CoreResponse;
          try {
            result = await handleWrite(ctx, { method, type, idRaw, body: parsed.body });
          } catch {
            result = errorResponse(500, 'internal error');
          }
          corkSend(res, aborted, result);
        })();
      });
    };
    app.post('/:type', dataWrite('POST', 'content.create', false));
    app.put('/:type/:id', dataWrite('PUT', 'content.update', true));
    app.del('/:type/:id', dataWrite('DELETE', 'content.delete', true));

    // be-04 MEDIA — asset endpoints under the `/_files` literal prefix. A leading underscore is illegal
    // in an api_id (validateFieldName / deriveTableName), so `_files` can NEVER collide with a real
    // `/:type`; uWS also matches a static segment over a `:param`. The UPLOAD (POST) + DELETE are GATED on
    // `media.upload`; the GET reads stay PUBLIC.
    const fileCtx: FileContext = { sql: store.sql, provider: getStorageProvider() };
    // GATED upload (`media.upload`): read the content-type header SYNC (multipart boundary), buffer the
    // body (up to uploadMaxBytes) while resolving auth in parallel via gateUpload, then on allow parse the
    // buffered multipart through busboy and dispatch the core.
    app.post('/_files/upload', (res, req) => {
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
    app.get('/_files', (res, req) => handleFilesRoute(res, req, 'GET', false, fileCtx));
    app.get('/_files/:id', (res, req) => handleFilesRoute(res, req, 'GET', true, fileCtx));
    // GATED delete (`media.upload`): a delete is a mutation. Capture the id sync, gate (bodyless), dispatch.
    app.del('/_files/:id', (res, req) => {
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
  }

  // Everything else (root, non-GET on a known route, deeper paths): let the core decide the status
  // (404 / 405). We pass the real method + path so a non-GET on /:type still yields 405.
  app.any('/*', (res, req) => {
    const method = req.getMethod();
    const url = req.getUrl();
    const query = req.getQuery() ?? '';
    writeResponse(res, handleRequest(current, { method, path: url, query }));
  });

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
  };
}
