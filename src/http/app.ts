import uWS from 'uWebSockets.js';
import type { Engine } from '../store/engine.ts';
import type { PostgresStore } from '../db/postgres-store.ts';
import { handleRequest, errorResponse, type CoreResponse } from './router.ts';
import { handleWrite, type WriteContext } from './write.ts';

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
  413: '413 Payload Too Large',
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
 * Build a uWS server over `engine`. Construction is SEPARATE from listening so tests build the
 * server once and bind it to a free port chosen by the harness.
 *
 * Pass a {@link PostgresStore} to ENABLE WRITES: POST/PUT/DELETE commit to Postgres and then rebuild
 * the in-memory engine from it ({@link WriteContext.rebuild} swaps the live `current` engine, so reads
 * after a write reflect it). Without a store the server is read-only and a write falls to the core's
 * 405. The read handlers reference `current` (not the original `engine`) so the swap is seen live.
 */
export function createServer(engine: Engine, store?: PostgresStore): UwsServer {
  const app = uWS.App();
  let current = engine;

  // LIST: /:type  — read everything off `req` synchronously, then delegate to the core.
  app.get('/:type', (res, req) => {
    const method = req.getMethod();
    const type = req.getParameter(0) ?? '';
    const query = req.getQuery();
    // SYNC handler: no await past this point, so `req` is no longer touched and no onAborted needed.
    writeResponse(res, handleRequest(current, { method, path: `/${type}`, query }));
  });

  // SINGLE: /:type/:id
  app.get('/:type/:id', (res, req) => {
    const method = req.getMethod();
    const type = req.getParameter(0) ?? '';
    const id = req.getParameter(1) ?? '';
    const query = req.getQuery();
    writeResponse(res, handleRequest(current, { method, path: `/${type}/${id}`, query }));
  });

  // WRITES (only when a store is supplied): commit to Postgres, then rebuild the RAM engine.
  if (store) {
    const ctx: WriteContext = {
      engine: () => current,
      sql: store.sql,
      rebuild: async () => {
        current = await store.load();
      },
    };
    app.post('/:type', (res, req) => handleWriteRoute(res, req, 'POST', false, ctx));
    app.put('/:type/:id', (res, req) => handleWriteRoute(res, req, 'PUT', true, ctx));
    app.del('/:type/:id', (res, req) => handleWriteRoute(res, req, 'DELETE', true, ctx));
  }

  // Everything else (root, non-GET on a known route, deeper paths): let the core decide the status
  // (404 / 405). We pass the real method + path so a non-GET on /:type still yields 405.
  app.any('/*', (res, req) => {
    const method = req.getMethod();
    const url = req.getUrl();
    const query = req.getQuery();
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
