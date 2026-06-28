import type uWS from 'uWebSockets.js';
import { splitCookiesString } from 'set-cookie-parser';
import { config } from '../config.ts';
import type { Auth } from './auth.ts';

/**
 * The uWS ↔ WHATWG-Fetch BRIDGE for better-auth. better-auth's `auth.handler(Request): Promise<Response>`
 * is framework-agnostic Fetch; uWS is a stack-allocated callback API. This adapts one to the other in
 * the proven uWS way (mirroring `server.ts`'s write path):
 *
 *  INBOUND (uWS req → Request), read SYNCHRONOUSLY at handler top because `req` is stack-allocated and
 *  invalid after the first await:
 *    - method + url + query, and ALL headers via `req.forEach` — CRITICALLY the `Cookie` header (the
 *      session token rides there).
 *    - body: GET/HEAD carry none; other verbs buffer the body (capped) and pass the Buffer. better-auth
 *      bodies are tiny JSON, so buffering (reusing the proven onData/onAborted pattern) beats a new
 *      streaming path and respects a hard cap.
 *
 *  OUTBOUND (Response → uWS res), inside res.cork(), guarded by the abort probe:
 *    - status line, then every header EXCEPT set-cookie.
 *    - SET-COOKIE SPLIT (the critical bit): a WHATWG `Headers` FOLDS multiple Set-Cookie into ONE
 *      comma-joined value. We prefer `getSetCookie()` (Node 24) and fall back to `splitCookiesString`
 *      over the folded value, then emit ONE `writeHeader('Set-Cookie', c)` per cookie — never the
 *      comma-joined blob (which corrupts cookies containing a comma, e.g. an Expires date).
 *    - body: `res.end` the response bytes.
 *
 * This bridge GATES NOTHING and validates no session — it only proxies `/auth/*` to better-auth.
 */

/** The body-buffer cap for auth requests (sign-in/up payloads are a few hundred bytes; 1 MiB is ample). */
const MAX_AUTH_BODY_BYTES = 1 << 20;

/** Methods that never carry a request body. */
const BODYLESS = new Set(['GET', 'HEAD']);

/**
 * Build a WHATWG `Request` from the synchronously-read uWS triple + headers + (optional) buffered body.
 * The origin is irrelevant to `auth.handler` (it routes on path + headers + cookies + body); we use a
 * fixed `http://localhost` origin so the URL is absolute.
 */
function toRequest(method: string, path: string, query: string, headers: Headers, body: Buffer | null): Request {
  const url = `http://localhost${path}${query.length > 0 ? `?${query}` : ''}`;
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (body !== null && body.length > 0) {
    init.body = new Uint8Array(body);
    init.duplex = 'half';
  }
  return new Request(url, init);
}

/** Extract the (already-split) Set-Cookie list from a Response, fold-safe across Node/runtime variants. */
function setCookies(res: Response): string[] {
  const getter = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getter === 'function') {
    const list = getter.call(res.headers);
    if (list.length > 0) return list;
  }
  const folded = res.headers.get('set-cookie');
  return folded === null ? [] : splitCookiesString(folded);
}

/**
 * Write a WHATWG `Response` onto a uWS response inside a cork (caller guards the abort probe). `corkHook`
 * runs inside the cork right after the status line — the http layer threads its CORS-header writer here so
 * the auth layer never imports http (layering: auth must not depend on http).
 */
async function writeFetchResponse(
  res: uWS.HttpResponse,
  response: Response,
  aborted: () => boolean,
  corkHook: (res: uWS.HttpResponse) => void,
): Promise<void> {
  // Read the body BEFORE corking (await is illegal inside the synchronous cork callback).
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (aborted()) return;
  const cookies = setCookies(response);
  res.cork(() => {
    res.writeStatus(`${response.status} ${response.statusText || ''}`.trim());
    corkHook(res); // http layer's CORS-header writer (no-op same-origin)
    response.headers.forEach((value, key) => {
      // Set-Cookie is emitted separately (split), never via the folded Headers value.
      if (key.toLowerCase() === 'set-cookie') return;
      res.writeHeader(key, value);
    });
    for (const cookie of cookies) res.writeHeader('Set-Cookie', cookie);
    res.end(bytes);
  });
}

/** Decode the uWS socket address (an ArrayBuffer of the IP text, e.g. "127.0.0.1" / an IPv6 form). */
function decodeRemoteIp(res: uWS.HttpResponse): string {
  try {
    return new TextDecoder().decode(res.getRemoteAddressAsText()).trim();
  } catch {
    return '';
  }
}

/**
 * Anti-enumeration LOGIN STALL: pad the `/sign-in/email` response to a constant floor (config.loginStallMs)
 * so the total time is identical whether the email exists ("wrong password" → slow hash) or not ("no such
 * user" → fast) — a timing side-channel that would otherwise leak which accounts exist. Other paths pass
 * through untouched; 0 (test env) disables it.
 */
async function stalledHandle(path: string, run: () => Promise<Response>): Promise<Response> {
  const floor = config.loginStallMs;
  if (floor <= 0 || !path.endsWith('/sign-in/email')) return run();
  const start = Date.now();
  const response = await run();
  const remaining = floor - (Date.now() - start);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  return response;
}

/**
 * The `/auth/*` catch-all handler. Reads the uWS request synchronously, buffers any body, calls
 * `auth.handler`, and writes the Fetch `Response` back (splitting Set-Cookie). Mounted in
 * `createServer` BEFORE the `app.any('/*')` fallthrough.
 */
export function handleAuthRoute(
  res: uWS.HttpResponse,
  req: uWS.HttpRequest,
  auth: Auth,
  corkHook: (res: uWS.HttpResponse) => void = () => {},
): void {
  // SYNCHRONOUS reads off the stack-allocated req (invalid after the first await).
  const method = req.getMethod().toUpperCase();
  const path = req.getUrl();
  const query = req.getQuery() ?? '';
  const headers = new Headers();
  req.forEach((k, v) => headers.set(k, v));

  // Real client IP for better-auth's per-IP rate limiter (it has no socket-IP fallback in a custom server).
  // Default: the uWS socket address. Behind a TRUSTED reverse proxy (CONTI_TRUST_PROXY=true) the proxy's
  // X-Forwarded-For (leftmost) is the real client — read it ONLY then, so a raw spoofed header can't rotate
  // the rate-limit key when we're directly exposed. better-auth reads only this computed `x-conti-client-ip`.
  const fwd = config.trustProxy ? headers.get('x-forwarded-for')?.split(',')[0]?.trim() : undefined;
  const clientIp = fwd || decodeRemoteIp(res);
  if (clientIp) headers.set('x-conti-client-ip', clientIp);

  let aborted = false;
  res.onAborted(() => {
    aborted = true;
  });

  const dispatch = (body: Buffer | null): void => {
    void (async () => {
      try {
        const request = toRequest(method, path, query, headers, body);
        const response = await stalledHandle(path, () => auth.handler(request));
        if (!aborted) await writeFetchResponse(res, response, () => aborted, corkHook);
      } catch {
        if (!aborted) {
          res.cork(() => {
            res.writeStatus('500 Internal Server Error');
            res.writeHeader('Content-Type', 'application/json');
            res.end('{"error":"auth handler error"}');
          });
        }
      }
    })();
  };

  if (BODYLESS.has(method)) {
    dispatch(null);
    return;
  }

  // Buffer the body (capped), then dispatch. Mirrors server.ts readBody: each chunk ArrayBuffer is
  // valid only during the callback, so it is copied before buffering; an oversized body → 413.
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  res.onData((ab, isLast) => {
    if (!tooLarge) {
      const chunk = Buffer.from(ab.slice(0));
      size += chunk.length;
      if (size > MAX_AUTH_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    }
    if (!isLast) return;
    if (tooLarge) {
      if (!aborted) {
        res.cork(() => {
          res.writeStatus('413 Payload Too Large');
          res.end();
        });
      }
      return;
    }
    dispatch(Buffer.concat(chunks));
  });
}
