import net from 'node:net';
import type { Sql } from 'postgres';
import { createFileDatabase, dropFileDatabase, type FileDatabase } from '../../api/test/db-per-file.ts';
import { schema as buildSchema, type SchemaSpec } from '../../api/test/helpers.ts';
import { PostgresStore } from '../../api/src/db/postgres.store.ts';
import { createServer } from '../../api/src/http/server.ts';
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
  let store: PostgresStore;
  let engine: Engine;
  let registry: Registry;
  try {
    store = new PostgresStore(file.sql);
    // Wire the keyset cursor codec exactly as the production composition root does (server.ts), so
    // keyset pagination is enabled end-to-end (an unwired engine throws InvalidCursorError on EVERY
    // keyset read, even the empty-cursor first-page bootstrap). The secret comes from .env.test.
    ({ engine, registry } = await store.loadFromSchemas([], [], { cursorCodec: cursorCodecFromEnv() }));
  } catch (err) {
    // Boot failed before we owned a socket — release the DB handle + drop the clone, don't leak it.
    await file.sql.end({ timeout: 5 }).catch(() => {});
    await dropFileDatabase(file.name);
    throw err;
  }

  const server = createServer(engine, store, registry);
  const port = await freePort();
  const token = await server.listen(port);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    server.close(token);
    await file.sql.end({ timeout: 5 }).catch(() => {});
    await dropFileDatabase(file.name);
  };

  return { baseUrl: `http://127.0.0.1:${port}`, close, sql: file.sql, engine, registry };
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
