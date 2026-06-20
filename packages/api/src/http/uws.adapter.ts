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
 * A write route: capture the params synchronously, read the body, then run the async write core and
 * cork the response back. `hasId` distinguishes POST (/:type) from PUT/DELETE (/:type/:id).
 */
function handleWriteRoute(res: uWS.HttpResponse, req: uWS.HttpRequest, method: string, hasId: boolean, ctx: WriteContext): void {
  const type = req.getParameter(0) ?? '';
  const idRaw = hasId ? (req.getParameter(1) ?? '') : '';
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
        result = await handleWrite(ctx, { method, type, idRaw, body });
      } catch {
        result = errorResponse(500, 'internal error');
      }
      corkSend(res, aborted, result);
    })();
  });
}

/**
 * The Draft & Publish ACTION route (`POST /:type/:id/actions/:action`). Structurally identical to
 * {@link handleWriteRoute} but reads a THIRD path param (the action token) and validates it ∈
 * {publish,unpublish} BEFORE dispatch — an unknown token is a 404 (no such action), never reaching the
 * core. The 3-segment path is structurally distinct from the 2-segment data routes, so route ordering is
 * irrelevant. Always treated as POST.
 */
function handleWriteActionRoute(res: uWS.HttpResponse, req: uWS.HttpRequest, ctx: WriteContext): void {
  const type = req.getParameter(0) ?? '';
  const idRaw = req.getParameter(1) ?? '';
  const actionRaw = req.getParameter(2) ?? '';
  const { aborted } = readBody(res, () => {
    void (async () => {
      if (actionRaw !== 'publish' && actionRaw !== 'unpublish') {
        return corkSend(res, aborted, errorResponse(404, 'not found'));
      }
      let result: CoreResponse;
      try {
        // The action sub-route carries no body (the lifecycle change is positional). body=undefined.
        result = await handleWrite(ctx, { method: 'POST', type, idRaw, body: undefined, action: actionRaw });
      } catch {
        result = errorResponse(500, 'internal error');
      }
      corkSend(res, aborted, result);
    })();
  });
}

/**
 * The i18n VARIANT-CREATE route (`POST /:type/:id/locales/:locale`). Structurally identical to
 * {@link handleWriteRoute} but reads a THIRD path param (the target locale slug) AND a body (the request
 * supplies the localized fields). The 4-segment path is structurally distinct from the 2-segment data
 * routes and the 4-segment `/actions/:action` (the literal `locales` vs `actions` disambiguates), so
 * route ordering is irrelevant (uWS matches by segment count + literals). Always treated as POST.
 */
function handleVariantCreateRoute(res: uWS.HttpResponse, req: uWS.HttpRequest, ctx: WriteContext): void {
  // Params are positional over the `:`-prefixed segments ONLY (the literal `locales` is not a param):
  // (0)=:type, (1)=:id, (2)=:locale.
  const type = req.getParameter(0) ?? '';
  const idRaw = req.getParameter(1) ?? '';
  const variantLocale = req.getParameter(2) ?? '';
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
        result = await handleWrite(ctx, { method: 'POST', type, idRaw, body, variantLocale });
      } catch {
        result = errorResponse(500, 'internal error');
      }
      corkSend(res, aborted, result);
    })();
  });
}

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
function readMultipart(res: uWS.HttpResponse, contentType: string, onDone: (r: UploadParseResult) => void): { aborted: () => boolean } {
  let aborted = false;
  res.onAborted(() => {
    aborted = true;
  });

  if (!/^multipart\/form-data/i.test(contentType)) {
    // Drain so uWS doesn't complain, then reject. Read one onData to satisfy the stream contract.
    res.onData((_ab, isLast) => {
      if (isLast) onDone({ ok: false, status: 415, message: 'expected multipart/form-data' });
    });
    return { aborted: () => aborted };
  }

  let bb: ReturnType<typeof busboy>;
  try {
    bb = busboy({ headers: { 'content-type': contentType }, limits: { files: 1, fields: 0, fileSize: config.uploadMaxBytes } });
  } catch {
    res.onData((_ab, isLast) => {
      if (isLast) onDone({ ok: false, status: 400, message: 'invalid multipart body' });
    });
    return { aborted: () => aborted };
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
      // A second file part: ignore its bytes and flag a 400.
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

  res.onData((ab, isLast) => {
    // The chunk ArrayBuffer is only valid during this callback — copy before handing to busboy.
    bb.write(Buffer.from(ab.slice(0)));
    if (isLast) bb.end();
  });

  return { aborted: () => aborted };
}

/** be-04 MEDIA — the POST /_files/upload route: stream multipart -> core -> cork the response. */
function handleUploadRoute(res: uWS.HttpResponse, req: uWS.HttpRequest, ctx: FileContext): void {
  // Read the content-type header SYNCHRONOUSLY (the req is stack-allocated, invalid after the first await).
  const contentType = req.getHeader('content-type') ?? '';
  const { aborted } = readMultipart(res, contentType, (parsed) => {
    void (async () => {
      if (!parsed.ok) return corkSend(res, aborted, errorResponse(parsed.status, parsed.message));
      let result: CoreResponse;
      try {
        result = await handleUpload(ctx, parsed.upload);
      } catch {
        result = errorResponse(500, 'internal error');
      }
      corkSend(res, aborted, result);
    })();
  });
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
export function createServer(engine: Engine, store?: PostgresStore, registry?: Registry, publishClock: () => Date = () => new Date()): UwsServer {
  const app = uWS.App();
  const current = engine;

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
    app.post('/content-types', (res, req) => handleContentTypeRoute(res, req, 'POST', ctCtx, { hasApiId: false }));
    app.get('/content-types', (res, req) => handleContentTypeRoute(res, req, 'GET', ctCtx, { hasApiId: false }));
    app.get('/content-types/:apiId', (res, req) => handleContentTypeRoute(res, req, 'GET', ctCtx, { hasApiId: true }));
    app.del('/content-types/:apiId', (res, req) => handleContentTypeRoute(res, req, 'DELETE', ctCtx, { hasApiId: true }));
    app.post('/content-types/:apiId/relations', (res, req) => handleContentTypeRoute(res, req, 'POST', ctCtx, { hasApiId: true, sub: 'relations' }));
    app.post('/content-types/:apiId/fields', (res, req) => handleContentTypeRoute(res, req, 'POST', ctCtx, { hasApiId: true, sub: 'fields' }));
    app.put('/content-types/:apiId/fields/:name', (res, req) => handleContentTypeRoute(res, req, 'PUT', ctCtx, { hasApiId: true, sub: 'fields', hasName: true }));
    app.del('/content-types/:apiId/fields/:name', (res, req) => handleContentTypeRoute(res, req, 'DELETE', ctCtx, { hasApiId: true, sub: 'fields', hasName: true }));

    // be-05 COMPONENT-TYPE BUILDER (meta-only runtime schema over HTTP). Same `/component-types` literal-
    // prefix safety as `/content-types` ('-' is illegal in an api_id). No engine sync (components have no
    // engine presence) — the controller syncs only the registry's component store.
    const cmpCtx: ComponentTypeContext = { sql: store.sql, registry: () => registry };
    app.post('/component-types', (res, req) => handleComponentTypeRoute(res, req, 'POST', cmpCtx, { hasApiId: false }));
    app.get('/component-types', (res, req) => handleComponentTypeRoute(res, req, 'GET', cmpCtx, { hasApiId: false }));
    app.get('/component-types/:apiId', (res, req) => handleComponentTypeRoute(res, req, 'GET', cmpCtx, { hasApiId: true }));
    app.del('/component-types/:apiId', (res, req) => handleComponentTypeRoute(res, req, 'DELETE', cmpCtx, { hasApiId: true }));
    app.post('/component-types/:apiId/fields', (res, req) => handleComponentTypeRoute(res, req, 'POST', cmpCtx, { hasApiId: true, sub: 'fields' }));
    app.del('/component-types/:apiId/fields/:name', (res, req) => handleComponentTypeRoute(res, req, 'DELETE', cmpCtx, { hasApiId: true, sub: 'fields', hasName: true }));

    // Draft & Publish action sub-route. 3 segments — structurally distinct from the 2-segment data
    // routes, so ordering vs put('/:type/:id') is irrelevant (uWS matches by segment count + literals).
    app.post('/:type/:id/actions/:action', (res, req) => handleWriteActionRoute(res, req, ctx));
    // i18n variant create: POST /:type/:id/locales/:locale — 4 segments, literal `locales` distinguishes
    // it from `/actions/:action`; ordering vs the data routes is irrelevant (segment count + literals).
    app.post('/:type/:id/locales/:locale', (res, req) => handleVariantCreateRoute(res, req, ctx));
    app.post('/:type', (res, req) => handleWriteRoute(res, req, 'POST', false, ctx));
    app.put('/:type/:id', (res, req) => handleWriteRoute(res, req, 'PUT', true, ctx));
    app.del('/:type/:id', (res, req) => handleWriteRoute(res, req, 'DELETE', true, ctx));

    // be-04 MEDIA — asset endpoints under the `/_files` literal prefix. A leading underscore is illegal
    // in an api_id (validateFieldName / deriveTableName), so `_files` can NEVER collide with a real
    // `/:type`; uWS also matches a static segment over a `:param`. Registered only when writes are enabled
    // (a read-only server has no asset endpoints; they fall to any('/*') -> 404).
    const fileCtx: FileContext = { sql: store.sql, provider: getStorageProvider() };
    app.post('/_files/upload', (res, req) => handleUploadRoute(res, req, fileCtx));
    app.get('/_files', (res, req) => handleFilesRoute(res, req, 'GET', false, fileCtx));
    app.get('/_files/:id', (res, req) => handleFilesRoute(res, req, 'GET', true, fileCtx));
    app.del('/_files/:id', (res, req) => handleFilesRoute(res, req, 'DELETE', true, fileCtx));
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
