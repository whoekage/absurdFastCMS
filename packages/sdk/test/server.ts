import net from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Sql } from 'postgres';
import { createFileDatabase, dropFileDatabase, type FileDatabase } from '../../api/test/db-per-file.ts';
import { schema as buildSchema, type SchemaSpec, assembleAuth } from '../../api/test/helpers.ts';
import { PostgresStore } from '../../api/src/db/postgres.store.ts';
import { createServer, type ServerDeps } from '../../api/src/http/server.ts';
import { HookRegistry } from '../../api/src/db/schema/hooks.ts';
import { closeAuth } from '../../api/src/auth/auth.dialect.ts';
import {
  loadType,
  loadAllRelations,
  rebuildType as engineRebuildType,
  cursorCodecFromEnv,
} from '../../api/src/db/engine.loader.ts';
import { migrate } from '../../api/src/db/schema/migrate.ts';
import { Registry } from '../../api/src/db/registry.ts';
import type { Schema } from '../../api/src/db/schema/model.ts';
import type { FieldSpec, RelationSpec } from '../../api/src/db/module.fields.ts';
import type { Engine } from '../../api/src/store/engine.ts';
import { createClient, type AbsurdClient, type ClientOptions } from '../src/index.ts';

/**
 * Slice 3.5 — the mock-free integration harness for @conti/sdk.
 *
 * NO MOCKS: startTestServer() clones a fresh per-file Postgres from the golden template (the api suite's
 * Testcontainers machinery, set up by test/global-setup.ts), boots a REAL @conti/api uWS server over an
 * EMPTY files-first catalog (createServer(engine, store, registry) — store+registry enable writes),
 * listens on an ephemeral port, and returns { baseUrl, close }. SDK tests point an AbsurdClient at
 * baseUrl and exercise the real wire. close() stops the socket and drops the per-file DB.
 *
 * @conti/api exposes no public `exports`, so internals are imported by relative path — permitted for the
 * test harness only (ROADMAP Slice 3.5).
 */

/** A running test server + its backing per-file DB, plus the live engine/registry for {@link withType}. */
export interface TestServer {
  /** Base URL the SDK client should target, e.g. http://127.0.0.1:54321 (no trailing slash). */
  baseUrl: string;
  /** Stop the uWS listen socket AND drop the per-file database. Idempotent-safe to call once. */
  close: () => Promise<void>;
  /** The per-file postgres.js handle (source of truth) — for {@link withType} / direct fixtures. */
  sql: Sql;
  /** The live in-RAM engine the server reads from. */
  engine: Engine;
  /** The live registry the server's write path resolves defs from. */
  registry: Registry;
  /**
   * The super-admin session cookie, bootstrapped at boot. The full server now ALWAYS gates writes/builder/
   * media (reality), so a client must carry it. Reads stay public.
   */
  cookie: string;
  /**
   * Build an {@link AbsurdClient} pre-authenticated as the bootstrapped super-admin (the cookie is sent via
   * `getHeaders`), so a test's writes pass the gate. Pass extra {@link ClientOptions} to override (e.g.
   * `timeout`/`retry`); for an UNauthenticated client (testing 401/403) call `createClient` directly.
   */
  mkClient: (opts?: Partial<ClientOptions>) => AbsurdClient;
  /**
   * A raw `fetch` PRE-AUTHENTICATED as the super-admin (the cookie is attached) — for tests that seed/poke
   * the wire directly (e.g. a raw POST) rather than through an {@link AbsurdClient}. `path` may be absolute
   * or `/`-relative to {@link baseUrl}. Reads are public, so a plain global `fetch` also works for GETs.
   */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

/** Reserve an ephemeral OS port (bind :0, read it back, release) for the server to listen on next. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else srv.close(() => reject(new Error('no port')));
    });
    srv.on('error', reject);
  });
}

/** Per-server set of currently-live schemas (so {@link withType} can migrate the union — supports nesting). */
const ACTIVE = new WeakMap<Sql, Map<string, Schema>>();

/**
 * Boot a real server for one test file over an EMPTY files-first catalog. `label` names the per-file DB
 * (a test-name slug keeps stray `t_*` databases identifiable on the escape-hatch external pg). Builds
 * Engine+Registry+PostgresStore via loadFromSchemas([]), wires createServer with store+registry (writes
 * enabled), listens on :0. Tests add types live via {@link withType}.
 */
export async function startTestServer(label = 'sdk'): Promise<TestServer> {
  const file: FileDatabase = await createFileDatabase(label);
  try {
    const store = new PostgresStore(file.sql);
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const modulesDir = await mkdtemp(path.join(os.tmpdir(), 'sdk-harness-')); // empty dir ⇒ Builder routes register

    // Assemble the FULL real auth contour (mirrors conti.ts via the api harness's assembleAuth): the auth
    // dialect runs over THIS per-file sql, teamView before the lazy session cache, rbac rebuilt.
    const { auth, sessionCache, rbac, teamView } = await assembleAuth(file.sql, baseUrl);

    // Wire the keyset cursor codec exactly as the production composition root does, so keyset pagination is
    // enabled end-to-end (an unwired engine throws InvalidCursorError on EVERY keyset read). Secret from .env.test.
    const { engine, registry } = await store.loadFromSchemas([], [], { cursorCodec: cursorCodecFromEnv() });

    // createServer now requires the FULL ServerDeps bundle (no optionals) — boot the real, gated server.
    const deps: ServerDeps = { engine, store, registry, auth, sessionCache, rbac, teamView, hooks: new HookRegistry(), modulesDir };
    const server = createServer(deps);
    const token = await server.listen(port);

    // Bootstrap the super-admin: the first sign-up fires the first-admin advisory-lock bootstrap; we ALSO
    // grant super-admin explicitly (idempotent) so the captured session cookie authorizes gated writes.
    const adminEmail = `sdk-admin-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
    const su = await fetch(`${baseUrl}/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ email: adminEmail, password: 'correct-horse-battery-staple', name: 'Admin' }),
    });
    if (su.status !== 200) throw new Error(`sdk harness: admin sign-up failed ${su.status} ${await su.clone().text()}`);
    const cookie = su.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c): c is string => c !== undefined && c.includes('=')).join('; ');
    const [row] = await file.sql<{ id: string }[]>`SELECT id FROM "user" WHERE email = ${adminEmail}`;
    if (row) {
      await file.sql`INSERT INTO user_roles (user_id, role_id) SELECT ${row.id}, id FROM roles WHERE name = 'super-admin' ON CONFLICT DO NOTHING`;
      await rbac.rebuild();
    }

    // A client pre-authenticated as the super-admin (cookie via getHeaders) so a test's writes pass the gate.
    const mkClient = (opts: Partial<ClientOptions> = {}): AbsurdClient =>
      createClient({ baseUrl, getHeaders: () => ({ cookie }), ...opts });

    // An authed raw fetch (cookie attached) for tests that seed/poke the wire directly.
    const authedFetch = (p: string, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers);
      headers.set('cookie', cookie);
      return fetch(p.startsWith('http') ? p : `${baseUrl}${p}`, { ...init, headers });
    };

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      server.close(token);
      sessionCache.stop();
      await closeAuth();
      await file.sql.end({ timeout: 5 }).catch(() => {});
      await dropFileDatabase(file.name);
    };

    return { baseUrl, close, sql: file.sql, engine, registry, cookie, mkClient, fetch: authedFetch };
  } catch (err) {
    // Boot failed — release the DB handle + drop the clone, don't leak it.
    await file.sql.end({ timeout: 5 }).catch(() => {});
    await dropFileDatabase(file.name);
    throw err;
  }
}

/** The shape {@link withType} accepts: an api_id plus its field (and optional relation) specs. */
export type TypeDef = SchemaSpec;

/**
 * The canonical demo `article` field specs (the files-first replacement for the deleted
 * `ARTICLE_SEED_FIELDS` api export). Used by the SDK integration tests via `withType(server, { apiId:
 * 'article', fields: ARTICLE_FIELDS }, ...)`. Mirrors `ARTICLE_SCHEMA` in the api test helpers.
 */
export const ARTICLE_FIELDS: FieldSpec[] = [
  { name: 'title', cmsType: 'string', options: { length: 512, nullable: true } },
  { name: 'body', cmsType: 'text', options: { nullable: false } },
  { name: 'status', cmsType: 'enumeration', options: { values: ['draft', 'published', 'archived'], nullable: false } },
  { name: 'views', cmsType: 'integer', options: { nullable: true } },
  { name: 'rating', cmsType: 'float', options: { nullable: true } },
  { name: 'active', cmsType: 'boolean', options: { nullable: false } },
  { name: 'publishedAt', cmsType: 'datetime', options: { nullable: false } },
];

/**
 * Create a temporary module for a test (files-first) and drop it afterwards. `migrate()` materializes the
 * `ct_` table from the schema IR; the def is resolved via `Registry.fromSchemas` and installed into the
 * LIVE registry + streamed into the LIVE engine (`loadType` + `loadAllRelations`), so the running server
 * serves it immediately. The cleanup (finally) drops the type from RAM and re-migrates the reduced catalog
 * (DROP TABLE + snapshot), even if the body throws. Nesting is supported (the union of active schemas is
 * migrated each step).
 *
 * Usage:
 *   await withType(server, { apiId: 'widget', fields: [{ name: 'title', cmsType: 'string' }] }, async () => {
 *     // ... hit server.baseUrl/widget with the SDK ...
 *   });
 */
export async function withType<T>(
  server: Pick<TestServer, 'sql' | 'engine' | 'registry'>,
  def: TypeDef,
  body: (apiId: string) => Promise<T>,
): Promise<T> {
  const active = ACTIVE.get(server.sql) ?? new Map<string, Schema>();
  ACTIVE.set(server.sql, active);
  const s = buildSchema(def);
  const apiId = s.apiId;
  active.set(apiId, s);

  // Materialize the ct_ table(s) from the union of active schemas, then make this type LIVE in RAM.
  await migrate(server.sql, [...active.values()], { allowDestructive: true });
  const built = Registry.fromSchemas([...active.values()]).get(apiId)!;
  server.registry.install(built);
  await loadType(server.sql, server.engine, built);
  await loadAllRelations(server.sql, server.engine, server.registry); // derive edges if any active type relates

  try {
    return await body(apiId);
  } finally {
    active.delete(apiId);
    server.engine.dropType(apiId);
    server.registry.removeType(apiId);
    await migrate(server.sql, [...active.values()], { allowDestructive: true }); // DROP TABLE + reduce snapshot
  }
}

// Keep engineRebuildType reachable for tests that mutate fields mid-test (re-stream + atomic swap).
export { engineRebuildType, type FieldSpec, type RelationSpec };
