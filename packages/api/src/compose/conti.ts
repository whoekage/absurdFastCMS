import { runMigrations } from '../db/migration.runner.ts';
import { PostgresStore } from '../db/postgres.store.ts';
import { seedArticleIfAbsent } from '../db/seed.ts';
import { createServer, type ListenToken } from '../http/uws.adapter.ts';
import { CursorCodec } from '../store/cursor.codec.ts';
import { buildAuth } from '../auth/auth.ts';
import { setAuthSql } from '../auth/auth.dialect.ts';
import { SessionCache } from '../auth/session.cache.ts';
import { RbacRegistry } from '../auth/rbac.registry.ts';
import { TeamView } from '../auth/team.view.ts';
import { loadConfigFromEnv, type ContiConfig } from './config.ts';

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

export function createConti(config: ContiConfig): ContiApp {
  // Captured at start() for stop().
  let store: PostgresStore | undefined;
  let sessionCache: SessionCache | undefined;
  let close: ((token: ListenToken) => void) | undefined;
  let listenToken: ListenToken | undefined;

  async function start(): Promise<void> {
    await runMigrations(config.database.url);
    store = new PostgresStore(config.database.url);
    await seedArticleIfAbsent(store.sql);
    // Keyset cursor codec (HMAC over the configured secret) wired once at the composition root.
    const { engine, registry } = await store.loadWithRegistry({ cursorCodec: new CursorCodec(config.cursor.secret) });

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

    const server = createServer(engine, store, registry, undefined, auth, sessionCache, rbac, teamView);
    close = server.close;
    listenToken = await server.listen(config.server.port);
    const rows = engine.has('article') ? engine.rowCount('article') : 0;
    console.log(`ready on ${config.server.port} (${rows} article rows from postgres)`);
  }

  async function stop(): Promise<void> {
    if (close !== undefined && listenToken !== undefined) close(listenToken);
    sessionCache?.stop();
    if (store !== undefined) await store.close();
  }

  return { start, stop };
}

/** The entrypoint. Run directly: `node --env-file=.env src/compose/conti.ts [port]`. */
export function main(): void {
  void createConti(loadConfigFromEnv(process.argv[2])).start();
}

// Run only when invoked as the entrypoint (not when imported by a test/bench).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
