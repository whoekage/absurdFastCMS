import net from 'node:net';
import type { Sql } from 'postgres';
import { PostgresStore } from '../src/db/postgres.store.ts';
import { createServer } from '../src/http/uws.adapter.ts';
import { loadTypes } from '../src/db/schema/load.ts';
import { HookRegistry } from '../src/db/schema/hooks.ts';
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

/** Clean-start each test: drop every runtime per-type table + wipe the catalog (never the static `articles`). */
export async function cleanCatalog(sql: Sql): Promise<void> {
  // Drop link tables FIRST (not ct_-prefixed; the ct_ sweep below misses them). The META path records them
  // in content_type_relations; the FILES-FIRST migrate path writes NO meta, so ALSO sweep by the `_lnk`
  // suffix (dropping a ct_ table CASCADE only removes the FK constraint, not the link table itself).
  const links = await sql<{ link_table: string }[]>`SELECT DISTINCT link_table FROM content_type_relations`;
  for (const { link_table } of links) await sql.unsafe(`DROP TABLE IF EXISTS "${link_table}" CASCADE`);
  const lnk = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%\\_lnk'`;
  for (const { table_name } of lnk) await sql.unsafe(`DROP TABLE IF EXISTS "${table_name}" CASCADE`);
  const tables = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'ct\\_%'`;
  for (const { table_name } of tables) await sql.unsafe(`DROP TABLE IF EXISTS "${table_name}" CASCADE`);
  await sql`TRUNCATE content_type_relations, content_type_fields, content_types RESTART IDENTITY CASCADE`;
  // be-05: wipe the component catalog too (component_type_fields cascades from component_types).
  await sql`TRUNCATE component_type_fields, component_types RESTART IDENTITY CASCADE`;
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

/** Bring up a real uWS server over the given sql: load engine+registry, create + listen on a free port. */
export async function startTestServer(
  sql: Sql,
): Promise<{ base: string; close: (token: unknown) => void; token: unknown; engine: Engine; registry: Registry }> {
  const store = new PostgresStore(sql);
  const { engine, registry } = await store.loadWithRegistry();
  const server = createServer(engine, store, registry);
  const port = await freePort();
  const token = await server.listen(port);
  return { base: `http://127.0.0.1:${port}`, close: server.close, token, engine, registry };
}

/**
 * FILES-FIRST test server (S4): build engine+registry from `entitiesDir`'s files and wire the Builder so
 * `applyEdit` makes a schema change LIVE in-process. Asserting via HTTP GET against `base` is the contract —
 * never re-`loadTypes` the edited file (ESM-cached) nor read the returned engine ref after a swap.
 */
export async function startTestServerFromFiles(
  sql: Sql,
  entitiesDir: string,
): Promise<{
  base: string;
  close: (token: unknown) => void;
  token: unknown;
  applyEdit: NonNullable<ReturnType<typeof createServer>['applyEdit']>;
}> {
  const store = new PostgresStore(sql);
  const { schemas, hooks } = await loadTypes(entitiesDir);
  const { engine, registry } = await store.loadFromSchemas(schemas);
  const server = createServer(engine, store, registry, undefined, undefined, undefined, undefined, undefined, new HookRegistry(hooks), entitiesDir);
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
  entitiesDir: string,
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
  const { schemas, hooks } = await loadTypes(entitiesDir);
  const { engine, registry } = await store.loadFromSchemas(schemas);
  // positions: auth=5, sessionCache=6, rbac=7 ⇒ authEnabled; HookRegistry=9, entitiesDir=10 ⇒ builderActive.
  const server = createServer(engine, store, registry, undefined, auth, sessionCache, rbac, undefined, new HookRegistry(hooks), entitiesDir);
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

/** Re-export so a test's teardown can close the shared auth instance. */
export { closeAuth };
