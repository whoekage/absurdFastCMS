import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type uWS from 'uWebSockets.js';

/**
 * The admin SPA static server. The prebuilt admin `dist/` is loaded ONCE into RAM (a Map keyed by URL
 * path) and served from memory — zero per-request filesystem access, which also makes path traversal
 * STRUCTURALLY impossible (a request can only ever hit a key that exists in the Map; there is no path
 * join with user input). createServer mounts this at the ROOT (every non-API path) ONLY in production
 * (createConti supplies an adminDir); the test/SDK harness supplies none, so the root stays the content API.
 */

interface BundleEntry {
  body: Buffer;
  contentType: string;
  /** A content-hashed asset (under /assets/) → cache forever; index.html → no-cache. */
  immutable: boolean;
}

export type AdminBundle = Map<string, BundleEntry>;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

const mimeFor = (name: string): string => MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';

/**
 * Inject runtime config into the SPA's index.html so the admin discovers WHERE the API lives at load time
 * instead of having it baked into the bundle at OUR build time. A single classic inline `<script>` sets
 * `window.__CONTI__` before the deferred app module runs (classic inline scripts execute during parse;
 * `type=module` scripts are deferred), so the value is always present when the app reads it. Only used when
 * an absolute `apiBase` is supplied (cross-origin admin); same-origin deploys leave the HTML untouched.
 */
function injectRuntimeConfig(html: Buffer, apiBase: string): Buffer {
  // Replace every "<" with its unicode JSON escape so a value containing a closing-script sequence cannot
  // terminate the inline tag and inject markup (JSON.stringify alone does NOT escape "<"). It parses back to
  // the identical string in JS — the standard safe-JSON-in-script pattern. publicUrl is operator config, but
  // escape defensively anyway.
  const json = JSON.stringify({ apiBase }).replace(/</g, '\\u003c');
  const tag = `<script>window.__CONTI__=${json};</script>`;
  const s = html.toString('utf8');
  const i = s.indexOf('</head>');
  return Buffer.from(i === -1 ? tag + s : s.slice(0, i) + tag + s.slice(i), 'utf8');
}

/**
 * Read every file under `dir` into an in-memory bundle keyed by URL path ('/' + relative path), plus the
 * SPA entry at '/'. Returns null when `dir` is missing/empty or has no index.html (not a real build). When
 * `apiBase` is given (the admin runs on a different origin than the API), it is injected into the served
 * index.html as `window.__CONTI__.apiBase`; omit it for same-origin (the admin defaults to relative `/api`).
 */
export function loadAdminBundle(dir: string, apiBase?: string): AdminBundle | null {
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const bundle: AdminBundle = new Map();
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs)) {
      const childAbs = path.join(abs, name);
      const childRel = `${rel}/${name}`;
      if (statSync(childAbs).isDirectory()) walk(childAbs, childRel);
      else {
        bundle.set(childRel, {
          body: readFileSync(childAbs),
          contentType: mimeFor(name),
          immutable: childRel.includes('/assets/'),
        });
      }
    }
  };
  walk(dir, '');
  let index = bundle.get('/index.html');
  if (!index) return null; // not an SPA build — refuse rather than serve a half-bundle.
  if (apiBase) {
    index = { ...index, body: injectRuntimeConfig(index.body, apiBase) };
    bundle.set('/index.html', index); // a direct GET /index.html carries the config too
  }
  bundle.set('/', { ...index, immutable: false });
  return bundle;
}

const IMMUTABLE_CC = 'public, max-age=31536000, immutable';
const NOCACHE_CC = 'no-cache';

function serve(res: uWS.HttpResponse, entry: BundleEntry): void {
  res.cork(() => {
    res.writeStatus('200 OK');
    res.writeHeader('Content-Type', entry.contentType);
    res.writeHeader('Cache-Control', entry.immutable ? IMMUTABLE_CC : NOCACHE_CC);
    const b = entry.body;
    res.end(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
  });
}

function notFound(res: uWS.HttpResponse): void {
  res.cork(() => {
    res.writeStatus('404 Not Found');
    res.end();
  });
}

/** A request for a real asset (its last path segment has a file extension, or it's under /assets/). */
function looksLikeAsset(url: string): boolean {
  const last = url.slice(url.lastIndexOf('/') + 1);
  return last.includes('.') || url.includes('/assets/');
}

/**
 * Register the ROOT catch-all that serves the admin bundle. An exact bundle hit is served verbatim; a miss
 * on an asset-looking path is a 404; any other miss (a client-side SPA route like `/modules`) falls back to
 * `index.html` so the SPA router can take over. Non-GET/HEAD at the root → 404 (the API owns the verbs it
 * needs under its own prefix). Registered AFTER the prefixed API routes, so uWS specificity keeps the API winning.
 */
export function mountAdmin(app: uWS.TemplatedApp, bundle: AdminBundle): void {
  const index = bundle.get('/');
  if (!index) return;
  app.any('/*', (res, req) => {
    const method = req.getMethod();
    if (method !== 'get' && method !== 'head') return notFound(res);
    const url = req.getUrl();
    const hit = bundle.get(url);
    if (hit) return serve(res, hit);
    if (looksLikeAsset(url)) return notFound(res);
    serve(res, index); // SPA client route → index.html
  });
}
