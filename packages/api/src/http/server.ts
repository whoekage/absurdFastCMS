import uWS from 'uWebSockets.js';
import { loadAdminBundle, mountAdmin } from './static.ts';
import { type CorsPolicy, captureCors, writeCapturedCors, preflightHeaders } from './cors.ts';
import type { Engine } from '../store/engine.ts';
import type { Registry } from '../db/registry.ts';
import type { PostgresStore } from '../db/postgres.store.ts';
import { rebuildType } from '../db/engine.loader.ts';
import { handleRequest } from './read.router.ts';
import { type WriteContext } from './write.handler.ts';
import { HookRegistry } from '../db/schema/hooks.ts';
import { type ModuleDraft, type SchemaEditResult } from '../compose/builder.ts';
import { type FileContext } from './upload.handler.ts';
import { getStorageProvider } from '../storage/index.ts';
import { handleAuthRoute } from '../auth/auth.bridge.ts';
import type { Auth } from '../auth/auth.ts';
import type { SessionCache } from '../auth/session.cache.ts';
import type { RbacRegistry } from '../auth/rbac.registry.ts';
import type { TeamView } from '../auth/team.view.ts';
import { writeResponse } from './responders.ts';
import { createGates } from './auth-gates.ts';
import type { ServerContext } from './context.ts';
import { registerTeamRoutes } from './routes/team.ts';
import { registerKeyRoutes } from './routes/keys.ts';
import { registerMediaRoutes } from './routes/media.ts';
import { registerReadRoutes } from './routes/read.ts';
import { registerDataRoutes } from './routes/data.ts';
import { registerBuilderRoutes } from './routes/builder.ts';
import { createApplyCore } from './apply-core.ts';

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

/**
 * be-09b — the data WRITE routes (POST/PUT/DELETE /:type[/:id]), the D&P action sub-route, and the i18n
 * variant-create are now registered INLINE inside {@link createServer} so each can be wrapped by the
 * per-route RBAC gate (the gate must close over `sessionCache`/`rbac`). The shared async dispatch shape
 * (413/400/500 handling + corkSend) is preserved verbatim at each gated registration site.
 */

/** Which template a builder route is on — drives which getParameter slots to read synchronously. */
interface CtRouteOpts {
  /** Read getParameter(0) as `:name` (false for the `/modules` collection). */
  hasName: boolean;
  /** The literal segment after `:name` (`'fields'`), or undefined. */
  sub?: string;
  /** Read getParameter(1) as a field `:name` (the `.../fields/:name` template). */
  hasFieldName?: boolean;
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
  adminDir?: string | undefined;
  /**
   * Absolute API base injected into the served admin index.html (`window.__CONTI__.apiBase`) — set ONLY when
   * the admin runs on a different origin than the API (e.g. `https://example.com/api`). Omit for same-origin:
   * the admin then defaults to a relative `/api` and the HTML is served byte-for-byte unchanged.
   */
  adminApiBase?: string | undefined;
  /**
   * Cross-origin policy (CORS + CSRF) for credentialed requests from the admin on another origin. `null`
   * (the default) = same-origin only: every CORS/preflight/CSRF code path is skipped and responses are
   * byte-identical. Built by {@link createConti} from `cors.trustedOrigins`.
   */
  cors?: CorsPolicy | null;
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
  const { engine, store, registry, publishClock = () => new Date(), auth, sessionCache, rbac, teamView, hooks, modulesDir, basePath = '', adminDir, adminApiBase, cors = null } = deps;
  const corsPolicy = cors;
  const app = uWS.App();
  // Every API route registers under `basePath` (default '' = root). createConti sets '/api' so the admin
  // SPA can own the root. Route handlers reconstruct the core path from getParameter(), so the prefix is
  // transparent to the router; only the `app.any` fallback (which reads getUrl) strips it (below).
  const P = basePath;
  type UwsHandler = (res: uWS.HttpResponse, req: uWS.HttpRequest) => void;
  // When a CORS policy is active, capture each request's CORS headers SYNCHRONOUSLY here (the Origin is read
  // before the handler touches `req`) and stash them for the response writers; null policy → identity wrap →
  // zero overhead, byte-identical. Covers EVERY API route uniformly — no per-handler capture to forget.
  const corsWrap = corsPolicy
    ? (h: UwsHandler): UwsHandler => (res, req) => {
        captureCors(res, req.getHeader('origin'), corsPolicy);
        h(res, req);
      }
    : (h: UwsHandler): UwsHandler => h;
  const route = {
    get: (p: string, h: UwsHandler) => app.get(P + p, corsWrap(h)),
    post: (p: string, h: UwsHandler) => app.post(P + p, corsWrap(h)),
    put: (p: string, h: UwsHandler) => app.put(P + p, corsWrap(h)),
    del: (p: string, h: UwsHandler) => app.del(P + p, corsWrap(h)),
    any: (p: string, h: UwsHandler) => app.any(P + p, corsWrap(h)),
  };
  // Preflight: answer OPTIONS on every API path with the allow-set (when the Origin is trusted) or a bare
  // Vary (when not — the browser then blocks). Only registered in cross-origin mode.
  if (corsPolicy) {
    app.options(`${P}/*`, (res, req) => {
      const headers = preflightHeaders(corsPolicy, req.getHeader('origin') || null);
      res.cork(() => {
        res.writeStatus('204 No Content');
        for (const k in headers) res.writeHeader(k, headers[k]!);
        res.end();
      });
    });
  }
  // S1 (Builder live-reload): the SINGLE mutable cell every schema-reading route closure reads through.
  // A schema edit (Builder route, S4) rebuilds a fresh Engine/Registry off-side and swaps these three
  // references in ONE synchronous assignment — JS is single-threaded, so no in-flight request observes a
  // half-swap. At construction it holds exactly the passed engine/registry/hooks ⇒ ZERO behavior change;
  // it exists so the swap has a place to land. The `live` OBJECT (not the values) is what later scopes
  // capture, so a reassignment of `live.engine` is seen everywhere.
  const live: { engine: Engine; registry: Registry; hooks: HookRegistry } = { engine, registry, hooks };

  // be-09b/be-09c — the auth GATE primitives (extracted to ./auth-gates.ts). Destructured here so the
  // inline route registrations keep calling bare `gate`/`gateTeam`/`gateKeys`/`gateUpload`; `gates` is also
  // threaded into the ServerContext for the extracted route modules.
  const gates = createGates({ sessionCache, rbac, auth, teamView, corsPolicy });
  const { gate } = gates;

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
  const dir = modulesDir;
  const sql = store.sql;
  // be-04 MEDIA — the storage provider context for the `/_files` asset endpoints.
  const fileCtx: FileContext = { sql: store.sql, provider: getStorageProvider() };
  // S4/S6 — the schema-write core: owns the catalog version + single-writer mutex; drives the builder routes
  // and the programmatic srv.applyEdit. Always wired (modulesDir is required).
  const apply = createApplyCore({ live, sql, dir });

  // The shared context handed to every extracted register*Routes(rctx) module.
  const rctx: ServerContext = { route, gates, live, writeCtx: ctx, apply, store, sql, dir, auth, rbac, teamView, fileCtx };
  registerReadRoutes(rctx);

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
  // corsPolicy ? writeCapturedCors : a no-op — the auth bridge stays http-agnostic (layering), the CORS
  // headers captured by corsWrap above are emitted inside the auth response cork only in cross-origin mode.
  const onAuth = (res: uWS.HttpResponse, req: uWS.HttpRequest): void => handleAuthRoute(res, req, auth, corsPolicy ? writeCapturedCors : undefined);
  route.get('/auth/:p', onAuth);
  route.post('/auth/:p', onAuth);
  route.put('/auth/:p', onAuth);
  route.del('/auth/:p', onAuth);
  route.any('/auth/*', onAuth);

  registerBuilderRoutes(rctx);
  registerDataRoutes(rctx);
  registerTeamRoutes(rctx);
  registerKeyRoutes(rctx);
  registerMediaRoutes(rctx);

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
    const bundle = loadAdminBundle(adminDir, adminApiBase);
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
    applyEdit: apply.applyEdit,
  };
}
