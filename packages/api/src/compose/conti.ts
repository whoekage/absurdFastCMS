import path from 'node:path';
import { runMigrations } from '../db/migration.runner.ts';
import { PostgresStore } from '../db/postgres.store.ts';
import { loadTypes } from '../db/schema/load.ts';
import { reconcileBoot } from './boot-reconcile.ts';
import { HookRegistry } from '../db/schema/hooks.ts';
import { createServer, type ListenToken } from '../http/uws.adapter.ts';
import { CursorCodec } from '../store/cursor.codec.ts';
import { buildAuth } from '../auth/auth.ts';
import { setAuthSql } from '../auth/auth.dialect.ts';
import { SessionCache } from '../auth/session.cache.ts';
import { RbacRegistry } from '../auth/rbac.registry.ts';
import { TeamView } from '../auth/team.view.ts';
import type { ContiConfig } from './config.ts';

/**
 * The composition root: turn the single-process boot into a LIBRARY entry. `createConti(config)` wires the
 * same shared-nothing, single-instance server the legacy `start()` did (migrate → seed → load the in-memory
 * Engine+Registry from Postgres → auth/rbac/team → listen), but driven by a {@link ContiConfig} instead of
 * reading env directly, and returns a handle with `start()`/`stop()`.
 *
 * Phase 2 (T2) drives `database.url`, `server.port` and `cursor.secret` from the config; `auth.secret`,
 * storage, i18n default and the debug inspector are still read by their subsystems from the env-config
 * module (same values → byte-identical boot) and will be threaded incrementally. So pass
 * {@link loadConfigFromEnv}() (the entrypoint does) — config and env then agree.
 *
 * `stop()` here is BASIC teardown (close the listen socket, stop the session sweep, end the owned PG handle)
 * so the process / a boot test exits cleanly. T3 hardens it (idempotency, ordering, graceful drain).
 */
export interface ContiApp {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Context handed to server-lifecycle hooks. Intentionally MINIMAL — `{ config, log }` (+ the resolved
 * `port` once listening). It deliberately does NOT expose the columnar engine/store/registry: the read
 * engine stays out of user/extension reach by design (data access is a separate concern, not server
 * lifecycle). Contrast Strapi, which hands hooks the whole `strapi` instance.
 */
export interface ServerContext {
  readonly config: ContiConfig;
  /** Namespaced logger (currently console-backed). */
  log(message: string): void;
}
/** {@link ServerContext} plus the resolved listen port (only known after the server is listening). */
export interface StartedContext extends ServerContext {
  readonly port: number;
}
/**
 * SERVER lifecycle — the `bootstrap.ts` contract. This is NOT the content/data hook system (that is a
 * separate, later concern). Modelled on Strapi register/bootstrap/destroy + Fastify onReady/onListen/
 * onClose; hooks are awaited sequentially. Error semantics:
 * - `onBeforeStart` throwing ABORTS boot (nothing is opened yet) — like a failed Strapi register().
 * - `onAfterStart` throwing is LOGGED and the server STAYS UP (it is already listening) — like Fastify onListen.
 * - `onShutdown` throwing is COLLECTED and teardown CONTINUES (a hook failure must never leak resources).
 */
export interface ServerLifecycle {
  /** Before any boot work (no DB/engine yet): env checks, registering external resources. Throw = abort boot. */
  onBeforeStart?(ctx: ServerContext): void | Promise<void>;
  /** After the server is listening (ready): warmup pings, readiness signals. Throw = logged, server stays up. */
  onAfterStart?(ctx: StartedContext): void | Promise<void>;
  /** During shutdown, after the listen socket is closed (no new requests): release the user's own resources. */
  onShutdown?(ctx: ServerContext): void | Promise<void>;
}
/** Typed-authoring helper for `bootstrap.ts` (mirrors {@link defineConfig}). */
export function defineBootstrap(lifecycle: ServerLifecycle): ServerLifecycle {
  return lifecycle;
}

export function createConti(config: ContiConfig, lifecycle: ServerLifecycle = {}): ContiApp {
  const log = (message: string): void => console.log(message);
  const ctx: ServerContext = { config, log };
  // Captured at start() for stop().
  let store: PostgresStore | undefined;
  let sessionCache: SessionCache | undefined;
  let close: ((token: ListenToken) => void) | undefined;
  let listenToken: ListenToken | undefined;

  async function start(): Promise<void> {
    // onBeforeStart: nothing is opened yet, so a throw cleanly ABORTS boot (start() rejects).
    if (lifecycle.onBeforeStart) await lifecycle.onBeforeStart(ctx);
    await runMigrations(config.database.url);
    store = new PostgresStore(config.database.url);
    // CODE-FIRST source of truth: import the project's committed modules/<apiId>/schema.ts modules at the
    // EDGE (loadTypes → the IR). The S3 boot guard then shapes the DB to a CONSISTENT IR before the served
    // engine reads it — migrate-forward (files ahead) / recover-forward (files behind, the S2 crash window) /
    // clean — superseding the old unconditional create-if-absent seed. Default to <cwd>/modules.
    const modulesDir = config.modules?.dir ?? path.join(process.cwd(), 'modules');
    const { schemas: filesIR, hooks: filesHooks } = await loadTypes(modulesDir);
    const { schemas, hooks } = await reconcileBoot(store.sql, modulesDir, filesIR, filesHooks);
    const hookRegistry = new HookRegistry(hooks);
    // Keyset cursor codec (HMAC over the configured secret) wired once at the composition root.
    const { engine, registry } = await store.loadFromSchemas(schemas, [], { cursorCodec: new CursorCodec(config.cursor.secret) });

    // AUTH (be-09a/b/f): build over the SAME postgres.js handle. teamView BEFORE auth (auth's user hooks call
    // teamView.rebuild) and BEFORE the session cache (caps a team member's cached TTL); the cache references
    // `auth` lazily (thunk) so it can be built before the auth instance whose delete-hook evicts it.
    setAuthSql(store.sql);
    let auth: ReturnType<typeof buildAuth>;
    const teamView = new TeamView(store.sql);
    sessionCache = new SessionCache(() => auth, undefined, undefined, teamView);
    const rbac = new RbacRegistry(store.sql);
    auth = buildAuth({
      sessionEvictor: sessionCache,
      sql: store.sql,
      rbacInvalidate: () => rbac.rebuild(),
      teamViewReload: () => teamView.rebuild(),
    });
    await rbac.rebuild();
    await teamView.rebuild();

    const server = createServer(engine, store, registry, undefined, auth, sessionCache, rbac, teamView, hookRegistry, modulesDir);
    close = server.close;
    listenToken = await server.listen(config.server.port);
    const rows = engine.has('article') ? engine.rowCount('article') : 0;
    console.log(`ready on ${config.server.port} (${rows} article rows from postgres)`);
    // onAfterStart: the server is already listening, so a throw is logged and does NOT bring it down.
    if (lifecycle.onAfterStart) {
      try {
        await lifecycle.onAfterStart({ ...ctx, port: config.server.port });
      } catch (e) {
        log(`onAfterStart hook failed (server stays up): ${String(e)}`);
      }
    }
  }

  // Idempotent, ordered, error-resilient teardown (Strapi destroy() style: stop services, close
  // connections, remove timers — sequentially, each step guarded). The FIRST call runs it; every later
  // call awaits the SAME result, so double-stop and stop-before-start are safe. Ordering follows the Node
  // graceful-shutdown rule: (1) stop accepting new connections (close the uWS listen socket), (2) stop the
  // background session sweep timer, (3) drain + close the owned PG pool — postgres.js `end()` waits for
  // in-flight queries, and warm reads are zero-PG so they are unaffected.
  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    if (stopping !== undefined) return stopping;
    stopping = (async () => {
      const errors: unknown[] = [];
      if (close !== undefined && listenToken !== undefined) {
        try {
          close(listenToken);
        } catch (e) {
          errors.push(e);
        }
      }
      // onShutdown: the listen socket is already closed (no new requests). A throw is collected and
      // teardown continues so a hook failure never leaks the session sweep / PG pool.
      if (lifecycle.onShutdown) {
        try {
          await lifecycle.onShutdown(ctx);
        } catch (e) {
          errors.push(e);
        }
      }
      if (sessionCache !== undefined) {
        try {
          sessionCache.stop();
        } catch (e) {
          errors.push(e);
        }
      }
      if (store !== undefined) {
        try {
          await store.close();
        } catch (e) {
          errors.push(e);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'errors during conti shutdown');
    })();
    return stopping;
  }

  return { start, stop };
}

// The process entrypoint lives in @conti/cli (`conti start` / `conti dev`): the CLI resolves the project
// directory, loads conti.config.ts + bootstrap.ts, then calls createConti(config, lifecycle).start() and
// wires signal-based graceful shutdown. @conti/core is a pure library — no entrypoint, no project-file load.
