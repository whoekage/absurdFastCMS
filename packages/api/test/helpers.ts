import net from 'node:net';
import type { Sql } from 'postgres';
import { PostgresStore } from '../src/db/postgres.store.ts';
import { createServer } from '../src/http/uws.adapter.ts';
import { loadTypes } from '../src/db/schema/load.ts';
import { migrate } from '../src/db/schema/migrate.ts';
import { HookRegistry } from '../src/db/schema/hooks.ts';
import { mintId, type Schema, type ComponentSchema, type FieldType } from '../src/db/schema/model.ts';
import type { FieldOptions } from '../src/db/type.catalog.ts';
import type { RelationKind } from '../src/db/ddl.ts';
import { setAuthSql, closeAuth } from '../src/auth/auth.dialect.ts';
import { buildAuth } from '../src/auth/auth.ts';
import { SessionCache } from '../src/auth/session.cache.ts';
import { RbacRegistry } from '../src/auth/rbac.registry.ts';
import type { Engine } from '../src/store/engine.ts';
import type { Registry } from '../src/db/registry.ts';

/** Shared test helpers: extracted verbatim from the per-file copies so behavior stays byte-identical. */

/** Reserve an ephemeral OS port (bind :0, read it back, release) for a server to listen on next. */
export function freePort(): Promise<number> {
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

/** Clean-start each test: drop every runtime per-type table + reset the files-first snapshot (the legacy
 *  meta tables are gone — files + `_schema_applied` are the sole source of truth). */
export async function cleanCatalog(sql: Sql): Promise<void> {
  // Drop link tables FIRST (suffix `_lnk`; the ct_ sweep below misses them — dropping a ct_ table CASCADE
  // only removes the FK constraint, not the link table itself). The files-first `migrate()` path writes NO
  // meta, so the suffix sweep is the only record of them.
  const lnk = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%\\_lnk'`;
  for (const { table_name } of lnk) await sql.unsafe(`DROP TABLE IF EXISTS "${table_name}" CASCADE`);
  const tables = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'ct\\_%'`;
  for (const { table_name } of tables) await sql.unsafe(`DROP TABLE IF EXISTS "${table_name}" CASCADE`);
  // Files-first tests re-`migrate()` per test, which diffs against the `_schema_applied` snapshot — so wipe
  // it (and reset the document_id sequence) for a clean per-test start. `_schema_applied` is created lazily
  // by `migrate()`, so IF EXISTS guards the pre-first-migrate beforeEach.
  await sql`DROP TABLE IF EXISTS _schema_applied`;
  await sql`ALTER SEQUENCE IF EXISTS document_id_seq RESTART`;
}

/** Whether a table physically exists. */
export async function tableExists(sql: Sql, table: string): Promise<boolean> {
  const r = await sql`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${table}`;
  return r.length > 0;
}

/** Read the real columns of a table from information_schema, in ordinal order. */
export async function physicalColumns(sql: Sql, table: string): Promise<{ name: string; type: string; nullable: boolean }[]> {
  const rows = await sql<{ column_name: string; data_type: string; udt_name: string; is_nullable: string; character_maximum_length: number | null; numeric_precision: number | null; numeric_scale: number | null }[]>`
    SELECT column_name, data_type, udt_name, is_nullable, character_maximum_length, numeric_precision, numeric_scale
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} ORDER BY ordinal_position
  `;
  return rows.map((r) => ({ name: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES' }));
}

/**
 * Extract the raw bytes of one field from a single-item response (avoids JSON.parse precision loss).
 * Accepts a Buffer or string; depth-tracking walk reads a string value or a balanced object/array.
 */
export function rawField(buf: Buffer | string, field: string): string {
  const s = typeof buf === 'string' ? buf : buf.toString('utf8');
  const key = `"${field}":`;
  const start = s.indexOf(key) + key.length;
  let depth = 0;
  let i = start;
  if (s[i] === '"') {
    i++;
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\') i++;
      i++;
    }
    return s.slice(start, i + 1);
  }
  while (i < s.length) {
    const c = s[i]!;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      if (depth === 0) break;
      depth--;
    } else if (c === ',' && depth === 0) break;
    i++;
  }
  return s.slice(start, i);
}

/**
 * FILES-FIRST test server (S4): build engine+registry from `modulesDir`'s files and wire the Builder so
 * `applyEdit` makes a schema change LIVE in-process. Asserting via HTTP GET against `base` is the contract —
 * never re-`loadTypes` the edited file (ESM-cached) nor read the returned engine ref after a swap.
 */
export async function startTestServerFromFiles(
  sql: Sql,
  modulesDir: string,
): Promise<{
  base: string;
  close: (token: unknown) => void;
  token: unknown;
  applyEdit: NonNullable<ReturnType<typeof createServer>['applyEdit']>;
}> {
  const store = new PostgresStore(sql);
  const { schemas, hooks } = await loadTypes(modulesDir);
  const { engine, registry } = await store.loadFromSchemas(schemas);
  const server = createServer(engine, store, registry, undefined, undefined, undefined, undefined, undefined, new HookRegistry(hooks), modulesDir);
  const port = await freePort();
  const token = await server.listen(port);
  return { base: `http://127.0.0.1:${port}`, close: server.close, token, applyEdit: server.applyEdit! };
}

/**
 * S6: a files-first Builder server WITH the real auth stack wired, so the `builder.manage` gate is ENFORCED
 * (401 unauthenticated / 403 under-privileged). Returns the auth helpers bound to this server. Each
 * privileged test must EXPLICITLY `grantRole(userIdOf(email), 'super-admin')` — unique emails per test mean
 * the first-admin bootstrap can't be relied on. Teardown MUST call `sessionCache.stop()` + `closeAuth()`.
 */
export async function startTestServerFromFilesWithAuth(
  sql: Sql,
  modulesDir: string,
): Promise<{
  base: string;
  close: (token: unknown) => void;
  token: unknown;
  applyEdit: NonNullable<ReturnType<typeof createServer>['applyEdit']>;
  sessionCache: SessionCache;
  rbac: RbacRegistry;
  signUp: (email: string) => Promise<string>;
  userIdOf: (email: string) => Promise<string>;
  grantRole: (userId: string, roleName: string) => Promise<void>;
}> {
  setAuthSql(sql);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const store = new PostgresStore(sql);
  let auth: ReturnType<typeof buildAuth>;
  const sessionCache = new SessionCache(() => auth); // lazy ()=>auth breaks the construction cycle
  const rbac = new RbacRegistry(sql);
  auth = buildAuth({ baseURL: base, sessionEvictor: sessionCache, sql, rbacInvalidate: () => rbac.rebuild() });
  await rbac.rebuild();
  const { schemas, hooks } = await loadTypes(modulesDir);
  const { engine, registry } = await store.loadFromSchemas(schemas);
  // positions: auth=5, sessionCache=6, rbac=7 ⇒ authEnabled; HookRegistry=9, modulesDir=10 ⇒ builderActive.
  const server = createServer(engine, store, registry, undefined, auth, sessionCache, rbac, undefined, new HookRegistry(hooks), modulesDir);
  const token = await server.listen(port);

  const signUp = async (email: string): Promise<string> => {
    const res = await fetch(`${base}/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email, password: 'correct-horse-battery-staple', name: 'U' }),
    });
    if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.clone().text()}`);
    return res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c): c is string => c !== undefined && c.includes('=')).join('; ');
  };
  const userIdOf = async (email: string): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`SELECT id FROM "user" WHERE email = ${email}`;
    if (!row) throw new Error(`no user row for ${email}`);
    return row.id;
  };
  const grantRole = async (userId: string, roleName: string): Promise<void> => {
    await sql`INSERT INTO user_roles (user_id, role_id) SELECT ${userId}, id FROM roles WHERE name = ${roleName} ON CONFLICT DO NOTHING`;
    await rbac.rebuild();
  };

  return { base, close: server.close, token, applyEdit: server.applyEdit!, sessionCache, rbac, signUp, userIdOf, grantRole };
}

/**
 * The files-first replacement for the meta-path `createContentType(...) + startTestServer(...)` setup:
 * `migrate()` materializes the `ct_*` tables (+ writes `_schema_applied`) with ZERO meta, then the engine is
 * built via `loadFromSchemas`. Tests pass their content-type IR (and optional in-memory components) directly.
 */
export async function startTestServerFromSchemas(
  sql: Sql,
  schemas: Schema[],
  opts: { components?: ComponentSchema[]; seed?: () => Promise<void> } = {},
): Promise<{ base: string; close: (token: unknown) => void; token: unknown; engine: Engine; registry: Registry }> {
  await migrate(sql, schemas, { allowDestructive: true }); // CREATE TABLE ct_* + reconcile the snapshot
  if (opts.seed) await opts.seed(); // insert fixture rows AFTER the tables exist, BEFORE the engine streams them
  const store = new PostgresStore(sql);
  const { engine, registry } = await store.loadFromSchemas(schemas, opts.components ?? []);
  const server = createServer(engine, store, registry);
  const port = await freePort();
  const token = await server.listen(port);
  return { base: `http://127.0.0.1:${port}`, close: server.close, token, engine, registry };
}

/**
 * Convert the old `createContentType` spec shape (`{ apiId, fields:[{name, cmsType, options}], relations,
 * draftPublish, i18n }`) into a files-first {@link Schema} (stable ids minted, `cmsType`→`type`).
 * Lets a meta-path test migrate by wrapping its specs in `schema(...)` + `startTestServerFromSchemas` instead of
 * imperative `createContentType` + `addRelation` calls.
 */
export interface SchemaSpec {
  apiId: string;
  fields: { name: string; cmsType: FieldType; options?: FieldOptions; localized?: boolean }[];
  relations?: { field: string; kind: RelationKind; target: string; inverseField?: string }[];
  draftPublish?: boolean;
  i18n?: boolean;
}
export function schema(spec: SchemaSpec): Schema {
  const out: Schema = {
    id: mintId('ct'),
    apiId: spec.apiId,
    fields: spec.fields.map((f) => ({
      id: mintId('f'),
      name: f.name,
      type: f.cmsType,
      ...(f.options !== undefined ? { options: f.options } : {}),
      ...(f.localized !== undefined ? { localized: f.localized } : {}),
    })),
  };
  if (spec.draftPublish || spec.i18n) out.options = { ...(spec.draftPublish ? { draftAndPublish: true } : {}), ...(spec.i18n ? { i18n: true } : {}) };
  if (spec.relations !== undefined) out.relations = spec.relations.map((r) => (r.inverseField !== undefined ? { id: mintId('rel'), field: r.field, kind: r.kind, target: r.target, inverseField: r.inverseField } : { id: mintId('rel'), field: r.field, kind: r.kind, target: r.target }));
  return out;
}

/** The `article` demo type as a files-first IR (mirrors the old `ARTICLE_SEED_FIELDS`) — a shared test fixture. */
export const ARTICLE_SCHEMA: Schema = {
  id: 'ct_article',
  apiId: 'article',
  fields: [
    { id: 'f_title', name: 'title', type: 'string', options: { length: 512, nullable: true } },
    { id: 'f_body', name: 'body', type: 'text', options: { nullable: false } },
    { id: 'f_status', name: 'status', type: 'enumeration', options: { values: ['draft', 'published', 'archived'], nullable: false } },
    { id: 'f_views', name: 'views', type: 'integer', options: { nullable: true } },
    { id: 'f_rating', name: 'rating', type: 'float', options: { nullable: true } },
    { id: 'f_active', name: 'active', type: 'boolean', options: { nullable: false } },
    { id: 'f_publishedAt', name: 'publishedAt', type: 'datetime', options: { nullable: false } },
  ],
};

/** Re-export so a test's teardown can close the shared auth instance. */
export { closeAuth };
