import uWS from 'uWebSockets.js';
import type { Engine } from '../store/engine.ts';
import { handleRequest, type CoreResponse } from './router.ts';

/**
 * uWS-MIGRATION SLICE 1 — the uWebSockets.js HTTP adapter, a THIN transport shim over the
 * framework-agnostic {@link handleRequest} core in `router.ts`. Since the slice-2 cutover this is the
 * one and only HTTP server. The adapter does nothing but read the request triple `{ method, path, query }`
 * SYNCHRONOUSLY off the stack-allocated uWS `req` at the top of the handler, call the pure core,
 * and write its `{ status, contentType, body }` onto the uWS `res`. All routing / validation /
 * status codes / late-materialized response Buffers stay in ONE place (the core), so the adapter
 * adds zero behavior — only plumbing.
 *
 * uWS GOTCHAS handled here:
 *  - `req` is STACK-ALLOCATED and invalid after the handler yields. Our handlers are fully
 *    SYNCHRONOUS (engine.respond is sync), so we read getMethod()/getParameter()/getQuery() into
 *    locals at the very top and never touch `req` again — no onAborted needed. WARNING: any FUTURE
 *    async handler (await before res.end) MUST res.onAborted(...) to track aborts AND res.cork(...)
 *    around the writeStatus/writeHeader/end so the response isn't lost or split.
 *  - getQuery() returns the query string WITHOUT the leading '?' (the core tolerates either form).
 *  - getParameter(0) is `:type`, getParameter(1) is `:id`. We reconstruct the path for the core so
 *    its segment-based router stays the single source of routing truth.
 *  - The body is sent as a correctly-BOUNDED view: res.end(new Uint8Array(body.buffer,
 *    body.byteOffset, body.byteLength)). The engine's Buffers are subarray views into a shared/
 *    pooled ArrayBuffer (the OutputArena), so passing the raw Buffer could send the wrong bytes —
 *    the explicit (buffer, byteOffset, byteLength) view sends EXACTLY this row's bytes.
 *  - writeStatus takes a FULL status line ('200 OK', '404 Not Found', ...).
 *  - Routing: get('/:type') + get('/:type/:id') + any('/*') for 404/405 (the core decides which).
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
  400: '400 Bad Request',
  404: '404 Not Found',
  405: '405 Method Not Allowed',
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

/**
 * Build a uWS server over `engine`. Construction is SEPARATE from listening so tests build the
 * server once and bind it to a free port chosen by the harness.
 */
export function createServer(engine: Engine): UwsServer {
  const app = uWS.App();

  // LIST: /:type  — read everything off `req` synchronously, then delegate to the core.
  app.get('/:type', (res, req) => {
    const method = req.getMethod();
    const type = req.getParameter(0) ?? '';
    const query = req.getQuery();
    // SYNC handler: no await past this point, so `req` is no longer touched and no onAborted needed.
    writeResponse(res, handleRequest(engine, { method, path: `/${type}`, query }));
  });

  // SINGLE: /:type/:id
  app.get('/:type/:id', (res, req) => {
    const method = req.getMethod();
    const type = req.getParameter(0) ?? '';
    const id = req.getParameter(1) ?? '';
    const query = req.getQuery();
    writeResponse(res, handleRequest(engine, { method, path: `/${type}/${id}`, query }));
  });

  // Everything else (root, non-GET on a known route, deeper paths): let the core decide the status
  // (404 / 405). We pass the real method + path so a non-GET on /:type still yields 405.
  app.any('/*', (res, req) => {
    const method = req.getMethod();
    const url = req.getUrl();
    const query = req.getQuery();
    writeResponse(res, handleRequest(engine, { method, path: url, query }));
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
