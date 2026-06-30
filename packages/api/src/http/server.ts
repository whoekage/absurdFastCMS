import uWS from 'uWebSockets.js';
import { loadAdminBundle, mountAdmin } from './static.ts';
import { type CorsPolicy, captureCors, writeCapturedCors, preflightHeaders } from './cors.ts';
import type { Engine } from '../store/engine.ts';
import type { Registry } from '../db/registry.ts';
import type { PostgresStore } from '../db/postgres.store.ts';
import { rebuildType } from '../db/engine.loader.ts';
import { handleRequest, errorResponse, type CoreResponse } from './read.router.ts';
import { type WriteContext } from './write.handler.ts';
import { HookRegistry } from '../db/schema/hooks.ts';
import { applySchemaEdit, applySchemaDelete, previewSchemaEdit, BuilderBusyError, type ModuleDraft, type SchemaEditResult, applyComponentEdit, applyComponentDelete, previewComponentEdit, readComponents, type ComponentDraft } from '../compose/builder.ts';
import { swapFromIR } from '../db/engine.swap.ts';
import { loadTypes, loadTypesCacheBusted } from '../db/schema/load.ts';
import type { ComponentSchema } from '../db/schema/model.ts';
import { readAppliedSchemas, ensureAppliedTable } from '../db/schema/migrate.ts';
import { SchemaChangeConflictError } from '../db/ddl.ts';
import { localeFromAcceptLanguage, type Locale } from '../errors/index.ts';
import { computeCatalogVersion, hashRequest } from '../compose/catalog-version.ts';
import { ensureIdempotencyTable, idempotencyLookup, recordIdempotency, pruneIdempotency } from '../compose/builder-idempotency.ts';
import { type FileContext } from './upload.handler.ts';
import { getStorageProvider } from '../storage/index.ts';
import { handleAuthRoute } from '../auth/auth.bridge.ts';
import type { Auth } from '../auth/auth.ts';
import type { SessionCache } from '../auth/session.cache.ts';
import type { RbacRegistry } from '../auth/rbac.registry.ts';
import type { TeamView } from '../auth/team.view.ts';
import {
  writeResponse,
  readBody,
  corkSend,
  builderJson,
  builderErrorFields,
  builderError,
  parseBody,
} from './responders.ts';
import { createGates } from './auth-gates.ts';
import type { ServerContext } from './context.ts';
import { registerTeamRoutes } from './routes/team.ts';
import { registerKeyRoutes } from './routes/keys.ts';
import { registerMediaRoutes } from './routes/media.ts';
import { registerReadRoutes } from './routes/read.ts';
import { registerDataRoutes } from './routes/data.ts';

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

  // The shared context handed to every extracted register*Routes(rctx) module. `apply` (the schema-write
  // core) is added in the apply-core extraction step; the route families below don't mutate the catalog.
  const rctx: ServerContext = { route, gates, live, writeCtx: ctx, store, sql, dir, auth, rbac, teamView, fileCtx };
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

  // S4: the files-first Builder apply+swap, exposed on the returned server. `modulesDir` is required, so
  // the Builder is ALWAYS wired and this is assigned unconditionally below, before the server handle returns.
  let applyEditFn: NonNullable<Server['applyEdit']>;

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
    // Re-load hooks AND component definitions so the rebuilt registry keeps both — without the components a
    // module that uses one would lose its component field on the swap. (A project with none passes [].)
    const { hooks: nextHooks, components: nextComponents } = await loadTypes(dir);
    await swapFromIR(sql, live, result.next, result.applied!, new HookRegistry(nextHooks), nextComponents);
    return result;
  };
  const runEdit = async (draft: ModuleDraft, opts?: { allowDestructive?: boolean }): Promise<SchemaEditResult> =>
    swapAfter(await applySchemaEdit(sql, dir, draft, opts ?? {}));
  const runDelete = async (name: string): Promise<SchemaEditResult> => swapAfter(await applySchemaDelete(sql, dir, name));

  // Re-import the catalog (cache-busted) and swap the live registry/hooks/relations/components from disk —
  // NO migrate. Shared by POST /builder/reload and the component routes (a component edit changes no table,
  // so its only effect is a registry rebuild that picks up the new/edited/removed component file).
  const reloadFromDisk = async (): Promise<void> => {
    const { schemas, hooks, components } = await loadTypesCacheBusted(dir, `reload:${process.pid}:${Date.now()}`);
    await swapFromIR(sql, live, schemas, [], new HookRegistry(hooks), components);
  };

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

  // The component-edit concurrency wrapper — mirrors runMutation (busy mutex, idempotency replay, If-Match
  // version precheck, version bump) but for the migrate-free component path: exec resolves+writes the
  // component file and swaps the registry, then the catalog version advances (a component edit always
  // changes the catalog). Success carries the resolved component + the new version.
  const runComponentMutation = (
    res: uWS.HttpResponse,
    aborted: () => boolean,
    pre: { ifMatch: string; bodyVersion: string | undefined; idemKey: string; requestHash: string },
    exec: () => Promise<{ component?: ComponentSchema }>,
    locale: Locale,
  ): void => {
    void (async () => {
      if (writerBusy) return corkSend(res, aborted, builderJson(409, { ok: false, error: 'builder busy' }, { 'Retry-After': '1' }));
      writerBusy = true;
      try {
        await ensureTables();
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
        let r: { component?: ComponentSchema };
        try {
          r = await exec();
        } catch (e) {
          if (pre.idemKey !== '') {
            const { status, fields } = builderErrorFields(e, locale);
            if (status >= 400 && status < 500 && !(e instanceof SchemaChangeConflictError)) await recordIdempotency(sql, pre.idemKey, pre.requestHash, status, fields).catch(() => {});
          }
          throw e;
        }
        currentVersion = await computeCatalogVersion(dir);
        const fields = { ok: true as const, ...(r.component !== undefined ? { component: r.component } : {}), version: currentVersion };
        if (pre.idemKey !== '') await recordIdempotency(sql, pre.idemKey, pre.requestHash, 200, fields).catch(() => {});
        corkSend(res, aborted, builderJson(200, fields, { ETag: currentVersion }));
      } catch (e) {
        corkSend(res, aborted, builderError(e, locale));
      } finally {
        writerBusy = false;
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
  route.get('/builder/modules/:name', (res, req) => {
    const name = req.getParameter(0) ?? '';
    const inm = req.getHeader('if-none-match');
    let aborted = false;
    res.onAborted(() => { aborted = true; });
    void (async () => {
      try {
        await ensureVersion();
        const schema = (await readApplied()).find((s) => s.name === name);
        if (schema === undefined) return corkSend(res, () => aborted, builderJson(404, { ok: false, error: `module "${name}" does not exist` }));
        if (inm !== '' && inm === currentVersion) return corkSend(res, () => aborted, builderJson(304, {}, { ETag: currentVersion }));
        corkSend(res, () => aborted, builderJson(200, { ok: true, schema, version: currentVersion }, { ETag: currentVersion }));
      } catch { corkSend(res, () => aborted, builderJson(500, { ok: false, error: 'internal error' })); }
    })();
  });

  // POST preview — dry-run (no write/migrate/swap), no mutex/version. GATED.
  route.post('/builder/modules/:name/preview', (res, req) => {
    const name = req.getParameter(0) ?? '';
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'builder.manage', true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const body = parsed.body as { allowDestructive?: boolean } & ModuleDraft;
      if (body.name !== name) return corkSend(res, aborted, builderJson(422, { ok: false, error: 'body.name must equal the path name' }));
      void (async () => {
        let result: CoreResponse;
        try {
          const p = await previewSchemaEdit(sql, dir, body, { allowDestructive: body.allowDestructive === true });
          result = builderJson(200, { ok: p.ok, applied: p.changes, blocked: p.blocked, schema: p.schema, generatedSource: p.generatedSource });
        } catch (e) { result = builderError(e, locale); }
        corkSend(res, aborted, result);
      })();
    });
  });

  // PUT upsert — create / update / name-rename. GATED + mutex + If-Match/version + idempotency.
  route.put('/builder/modules/:name', (res, req) => {
    const name = req.getParameter(0) ?? '';
    const ifMatch = req.getHeader('if-match'); // '' when absent (uWS; lowercase key)
    const idemKey = req.getHeader('idempotency-key');
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'builder.manage', true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const body = parsed.body as { allowDestructive?: boolean; version?: string } & ModuleDraft;
      if (body.name !== name) return corkSend(res, aborted, builderJson(422, { ok: false, error: 'body.name must equal the path name' }));
      if (ifMatch === '' && body.version === undefined) return corkSend(res, aborted, builderJson(428, { ok: false, error: 'precondition required (If-Match)' }));
      const { allowDestructive, version: _v, ...meaningful } = body;
      const requestHash = hashRequest({ m: 'PUT', name, body: meaningful });
      runMutation(res, aborted, { ifMatch, bodyVersion: body.version, idemKey, requestHash },
        () => runEdit(body, { allowDestructive: allowDestructive === true }), locale);
    });
  });

  // DELETE — drop a whole type (always destructive → require allowDestructive). GATED + same wrap.
  route.del('/builder/modules/:name', (res, req) => {
    const name = req.getParameter(0) ?? '';
    const ifMatch = req.getHeader('if-match');
    const idemKey = req.getHeader('idempotency-key');
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'builder.manage', true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const body = parsed.body as { allowDestructive?: boolean; version?: string };
      if (body.allowDestructive !== true) return corkSend(res, aborted, builderJson(409, { ok: false, applied: [], blocked: [], error: 'requires allowDestructive' }));
      if (ifMatch === '' && body.version === undefined) return corkSend(res, aborted, builderJson(428, { ok: false, error: 'precondition required (If-Match)' }));
      const requestHash = hashRequest({ m: 'DELETE', name });
      runMutation(res, aborted, { ifMatch, bodyVersion: body.version, idemKey, requestHash }, () => runDelete(name), locale);
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
          await reloadFromDisk(); // applied=[] → swaps registry/hooks/relations/components, no per-type rebuild
          currentVersion = await computeCatalogVersion(dir);
          corkSend(res, aborted, builderJson(200, { ok: true, version: currentVersion }, { ETag: currentVersion }));
        } catch (e) { corkSend(res, aborted, builderError(e, locale)); }
        finally { writerBusy = false; }
      })();
    });
  });

  // ---- COMPONENT-DEFINITION ROUTE SURFACE — reusable nested field groups (modules/components/*.ts). GET
  //      reads are PUBLIC; mutations gated on builder.manage. Components have NO table, so writes never
  //      migrate — they write the file + swap the registry. They share the catalog version/ETag with modules.

  // GET list components — defined components (with ids) + ETag/304.
  route.get('/builder/components', (res, req) => {
    const inm = req.getHeader('if-none-match');
    let aborted = false;
    res.onAborted(() => { aborted = true; });
    void (async () => {
      try {
        await ensureVersion();
        if (inm !== '' && inm === currentVersion) return corkSend(res, () => aborted, builderJson(304, {}, { ETag: currentVersion }));
        const components = await readComponents(dir);
        corkSend(res, () => aborted, builderJson(200, { ok: true, components, version: currentVersion }, { ETag: currentVersion }));
      } catch { corkSend(res, () => aborted, builderJson(500, { ok: false, error: 'internal error' })); }
    })();
  });

  // GET one component — 404 when absent; else the single component WITH ids + ETag/304.
  route.get('/builder/components/:name', (res, req) => {
    const name = req.getParameter(0) ?? '';
    const inm = req.getHeader('if-none-match');
    let aborted = false;
    res.onAborted(() => { aborted = true; });
    void (async () => {
      try {
        await ensureVersion();
        const component = (await readComponents(dir)).find((c) => c.name === name);
        if (component === undefined) return corkSend(res, () => aborted, builderJson(404, { ok: false, error: `component "${name}" does not exist` }));
        if (inm !== '' && inm === currentVersion) return corkSend(res, () => aborted, builderJson(304, {}, { ETag: currentVersion }));
        corkSend(res, () => aborted, builderJson(200, { ok: true, component, version: currentVersion }, { ETag: currentVersion }));
      } catch { corkSend(res, () => aborted, builderJson(500, { ok: false, error: 'internal error' })); }
    })();
  });

  // POST preview component — dry-run (no write/swap), no mutex/version. GATED.
  route.post('/builder/components/:name/preview', (res, req) => {
    const name = req.getParameter(0) ?? '';
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'builder.manage', true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const body = parsed.body as ComponentDraft;
      if (body.name !== name) return corkSend(res, aborted, builderJson(422, { ok: false, error: 'body.name must equal the path name' }));
      void (async () => {
        let result: CoreResponse;
        try {
          const p = await previewComponentEdit(dir, body);
          result = builderJson(200, { ok: true, component: p.component, generatedSource: p.generatedSource });
        } catch (e) { result = builderError(e, locale); }
        corkSend(res, aborted, result);
      })();
    });
  });

  // PUT upsert a component — create / update. GATED + mutex + If-Match/version + idempotency. NO migrate.
  route.put('/builder/components/:name', (res, req) => {
    const name = req.getParameter(0) ?? '';
    const ifMatch = req.getHeader('if-match');
    const idemKey = req.getHeader('idempotency-key');
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'builder.manage', true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const body = parsed.body as { version?: string } & ComponentDraft;
      if (body.name !== name) return corkSend(res, aborted, builderJson(422, { ok: false, error: 'body.name must equal the path name' }));
      if (ifMatch === '' && body.version === undefined) return corkSend(res, aborted, builderJson(428, { ok: false, error: 'precondition required (If-Match)' }));
      const { version: _v, ...meaningful } = body;
      const requestHash = hashRequest({ m: 'PUT-component', name, body: meaningful });
      runComponentMutation(res, aborted, { ifMatch, bodyVersion: body.version, idemKey, requestHash }, async () => {
        const component = await applyComponentEdit(dir, body);
        await reloadFromDisk();
        return { component };
      }, locale);
    });
  });

  // DELETE a component — blocked (422) while any field references it. GATED + same wrap. NO migrate.
  route.del('/builder/components/:name', (res, req) => {
    const name = req.getParameter(0) ?? '';
    const ifMatch = req.getHeader('if-match');
    const idemKey = req.getHeader('idempotency-key');
    const locale = localeFromAcceptLanguage(req.getHeader('accept-language')); // sync: uWS req is dead after gate's await
    gate(res, req, 'builder.manage', true, (raw, aborted) => {
      const parsed = parseBody(raw);
      if (!parsed.ok) return corkSend(res, aborted, parsed.error);
      const body = parsed.body as { version?: string };
      if (ifMatch === '' && body.version === undefined) return corkSend(res, aborted, builderJson(428, { ok: false, error: 'precondition required (If-Match)' }));
      const requestHash = hashRequest({ m: 'DELETE-component', name });
      runComponentMutation(res, aborted, { ifMatch, bodyVersion: body.version, idemKey, requestHash }, async () => {
        await applyComponentDelete(dir, name);
        await reloadFromDisk();
        return {};
      }, locale);
    });
  });

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
    applyEdit: applyEditFn,
  };
}
