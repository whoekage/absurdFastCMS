import net from 'node:net';
import type { Sql } from 'postgres';
import { createFileDatabase, dropFileDatabase, type FileDatabase } from '../../api/test/db-per-file.ts';
import { PostgresStore } from '../../api/src/db/postgres.store.ts';
import { createServer } from '../../api/src/http/uws.adapter.ts';
import {
  loadType,
  rebuildType as engineRebuildType,
  cursorCodecFromEnv,
} from '../../api/src/db/engine.loader.ts';
import {
  createContentType,
  dropContentType,
  type FieldSpec,
  type RelationSpec,
} from '../../api/src/db/content-type.repository.ts';
import type { Engine } from '../../api/src/store/engine.ts';
import type { Registry } from '../../api/src/store/registry.ts';

/**
 * Slice 3.5 — the mock-free integration harness for @absurd/sdk.
 *
 * NO MOCKS: startTestServer() clones a fresh per-file Postgres from the golden template (the api suite's
 * Testcontainers machinery, set up by test/global-setup.ts), boots a REAL @absurd/api uWS server over it
 * (createServer(engine, store, registry) — store+registry enable writes AND the content-type builder),
 * listens on an ephemeral port, and returns { baseUrl, close }. SDK tests point an AbsurdClient at
 * baseUrl and exercise the real wire. close() stops the socket and drops the per-file DB.
 *
 * @absurd/api exposes no public `exports`, so internals are imported by relative path — permitted for the
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
  /** The live registry the server's content-type builder mutates. */
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

/**
 * Boot a real server for one test file. `label` names the per-file DB (a test-name slug keeps stray
 * `t_*` databases identifiable on the escape-hatch external pg). Builds Engine+Registry+PostgresStore via
 * loadWithRegistry, wires createServer with store+registry (writes + builder enabled), listens on :0.
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
    ({ engine, registry } = await store.loadWithRegistry({ cursorCodec: cursorCodecFromEnv() }));
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
export interface TypeDef {
  apiId: string;
  fields: FieldSpec[];
  relations?: RelationSpec[];
  /** Opt into Draft & Publish (adds the `published_at` system column). */
  draftPublish?: boolean;
  /** Opt into i18n (adds document_id + locale system columns + UNIQUE(document_id, locale)). */
  i18n?: boolean;
}

/**
 * Create a temporary content-type for a test and drop it afterwards. Commits to Postgres via the real
 * validating repository, then live-syncs the engine+registry exactly as the content-type controller does
 * (rebuildType → loadType: define + index `id` + warm), so the running server can immediately serve it.
 *
 * Usage:
 *   await withType(server, { apiId: 'widget', fields: [{ name: 'title', cmsType: 'string' }] }, async () => {
 *     // ... hit server.baseUrl/widget with the SDK ...
 *   });
 *
 * The cleanup runs in a finally, so the type is dropped (DROP TABLE + catalog row + RAM removal) even if
 * the body throws. `def.apiId` is canonicalised by the repo; the live api_id is read back from there.
 */
export async function withType<T>(
  server: Pick<TestServer, 'sql' | 'engine' | 'registry'>,
  def: TypeDef,
  body: (apiId: string) => Promise<T>,
): Promise<T> {
  const row = await createContentType(server.sql, {
    apiId: def.apiId,
    fields: def.fields,
    ...(def.relations ? { relations: def.relations } : {}),
    ...(def.draftPublish ? { draftPublish: true } : {}),
    ...(def.i18n ? { i18n: true } : {}),
  });
  const apiId = row.api_id;
  // Live-sync RAM, mirroring content-type.controller.ts syncDefine().
  const built = await server.registry.rebuildType(server.sql, apiId);
  await loadType(server.sql, server.engine, built);
  try {
    return await body(apiId);
  } finally {
    await dropContentType(server.sql, apiId);
    server.engine.dropType(apiId);
    server.registry.removeType(apiId);
  }
}

// Keep engineRebuildType reachable for tests that mutate fields mid-test (re-stream + atomic swap),
// matching the controller's syncRebuild() path; re-exported rather than inlined to avoid a second import.
export { engineRebuildType, type FieldSpec, type RelationSpec };
