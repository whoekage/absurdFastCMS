import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import type { Sql } from 'postgres';
import { PostgresStore } from '../src/db/postgres.store.ts';
import { createServer, type ServerDeps } from '../src/http/server.ts';
import { loadTypes } from '../src/db/schema/load.ts';
import { migrate } from '../src/db/schema/migrate.ts';
import { HookRegistry } from '../src/db/schema/hooks.ts';
import { mintId, type Schema, type ComponentSchema, type FieldType } from '../src/db/schema/model.ts';
import type { FieldOptions } from '../src/db/type.catalog.ts';
import type { RelationKind } from '../src/db/ddl.ts';
import { setAuthSql, closeAuth } from '../src/auth/auth.dialect.ts';
import { buildAuth, type Auth } from '../src/auth/auth.ts';
import { SessionCache } from '../src/auth/session.cache.ts';
import { RbacRegistry } from '../src/auth/rbac.registry.ts';
import { TeamView } from '../src/auth/team.view.ts';
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
 * Assemble the FULL real auth stack EXACTLY as `conti.ts` does, in the cycle-breaking order: `setAuthSql`
 * first; `teamView` BEFORE `auth` (auth's user hooks call `teamView.rebuild`) and BEFORE the session cache
 * (caps a team member's cached TTL); the `() => auth` thunk lets the cache exist before the `auth` instance
 * whose delete-hook evicts it; `rbacInvalidate`/`teamViewReload` thunks fire the first-admin bootstrap. Shared
 * by {@link startTestServer} and {@link startTestServerFromFilesWithAuth} so the wiring never drifts.
 */
export async function assembleAuth(
  sql: Sql,
  base: string,
  basePath?: string,
  authOpts?: { pwnedPasswords?: boolean; pwnedEndpoint?: string; pwnedTimeoutMs?: number; rateLimit?: boolean },
): Promise<{ auth: Auth; sessionCache: SessionCache; rbac: RbacRegistry; teamView: TeamView }> {
  setAuthSql(sql); // FIRST: the auth dialect runs over the shared per-file handle
  let auth: Auth;
  const teamView = new TeamView(sql);
  const sessionCache = new SessionCache(() => auth, undefined, undefined, teamView); // lazy ()=>auth breaks the cycle
  const rbac = new RbacRegistry(sql);
  auth = buildAuth({
    baseURL: base,
    ...(basePath !== undefined ? { basePath: `${basePath}/auth` } : {}),
    sessionEvictor: sessionCache,
    sql,
    rbacInvalidate: () => rbac.rebuild(),
    teamViewReload: () => teamView.rebuild(),
    // The HIBP guard is OFF for the harness by default (committed, NOT reliant on a gitignored .env.test) so
    // the per-file admin bootstrap makes no network call; pwned-passwords.test.ts opts IN explicitly.
    pwnedPasswords: authOpts?.pwnedPasswords ?? false,
    ...(authOpts?.pwnedEndpoint !== undefined ? { pwnedEndpoint: authOpts.pwnedEndpoint } : {}),
    ...(authOpts?.pwnedTimeoutMs !== undefined ? { pwnedTimeoutMs: authOpts.pwnedTimeoutMs } : {}),
    // Rate limiting OFF for the harness by default (the suite does many sign-ins); auth-ratelimit.e2e opts IN.
    rateLimit: authOpts?.rateLimit ?? false,
  });
  await rbac.rebuild();
  await teamView.rebuild();
  return { auth, sessionCache, rbac, teamView };
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
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const store = new PostgresStore(sql);
  const { auth, sessionCache, rbac, teamView } = await assembleAuth(sql, base);
  const { schemas, hooks } = await loadTypes(modulesDir);
  const { engine, registry } = await store.loadFromSchemas(schemas);
  const deps: ServerDeps = { engine, store, registry, auth, sessionCache, rbac, teamView, hooks: new HookRegistry(hooks), modulesDir };
  const server = createServer(deps);
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
 * Convert the old `createContentType` spec shape (`{ name, fields:[{name, cmsType, options}], relations,
 * draftPublish, i18n }`) into a files-first {@link Schema} (stable ids minted, `cmsType`→`type`).
 * Lets a meta-path test migrate by wrapping its specs in `schema(...)` + `startTestServerFromSchemas` instead of
 * imperative `createContentType` + `addRelation` calls.
 */
export interface SchemaSpec {
  name: string;
  fields: { name: string; cmsType: FieldType; options?: FieldOptions; localized?: boolean }[];
  relations?: { field: string; kind: RelationKind; target: string; inverseField?: string }[];
  draftPublish?: boolean;
  i18n?: boolean;
}
export function schema(spec: SchemaSpec): Schema {
  const out: Schema = {
    id: mintId('ct'),
    name: spec.name,
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
  name: 'article',
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

/** Per-call knobs for {@link startTestServer}; every one is optional so the bare `(sql, schemas)` form works. */
export interface StartTestServerOpts {
  /** In-memory component schemas threaded into `loadFromSchemas` (component-write / relation-in-component). */
  components?: ComponentSchema[];
  /** Insert fixture rows AFTER `migrate` creates the tables, BEFORE the engine streams them. */
  seed?: () => Promise<void>;
  /** Pin the publish clock for byte-deterministic `published_at` (draft-publish / i18n). */
  publishClock?: () => Date;
  /** Content lifecycle hooks (hooks.e2e). Defaults to an empty registry. */
  hooks?: HookRegistry;
  /** API route prefix (admin-serving test). Default '' = routes at root; auth aligns to `${basePath}/auth`. */
  basePath?: string;
  /** Serve a prebuilt admin SPA bundle from this dir at the root (admin-serving test). */
  adminDir?: string;
  /** Cross-origin CORS + CSRF policy (cors.e2e). Default null = same-origin only. */
  cors?: import('../src/http/cors.ts').CorsPolicy | null;
}

/** The handle {@link startTestServer} returns: the FULL gated server + an authed + an anon fetch + auth helpers. */
export interface TestServer {
  base: string;
  close: (token: unknown) => void;
  token: unknown;
  sql: Sql;
  engine: Engine;
  registry: Registry;
  /** AUTHENTICATED fetch — carries the bootstrapped super-admin cookie, so gated writes/builder/media pass. */
  fetch: (pathOrUrl: string, init?: RequestInit) => Promise<Response>;
  /** ANONYMOUS fetch — no cookie; for asserting public reads + the 401 unauthenticated-write path. */
  anonFetch: (pathOrUrl: string, init?: RequestInit) => Promise<Response>;
  signUp: (email: string) => Promise<string>;
  userIdOf: (email: string) => Promise<string>;
  grantRole: (userId: string, roleName: string) => Promise<void>;
  sessionCache: SessionCache;
  rbac: RbacRegistry;
  applyEdit: NonNullable<ReturnType<typeof createServer>['applyEdit']>;
}

/**
 * THE UNIFIED HARNESS. Assembles the FULL real server EXACTLY as `conti.ts` does (every dep wired, nothing
 * gated-off), bootstraps a super-admin, and returns an AUTHENTICATED `fetch` so write tests "just work":
 * reads stay public (use `anonFetch`), writes carry the admin cookie (use `fetch`).
 *
 * Mirrors the prod assembly order (load-bearing — it breaks the construction cycle): teamView BEFORE auth +
 * sessionCache; the `() => auth` thunk lets the cache exist before the auth instance whose delete-hook evicts
 * it; `setAuthSql` first; `rbacInvalidate`/`teamViewReload` thunks fire the first-admin bootstrap. Unlike
 * conti it takes the IR `schemas` DIRECTLY (migrate + loadFromSchemas) instead of `loadTypes`-ing a real
 * `modules/` dir, and creates an EMPTY temp `modulesDir` solely so the Builder routes register (the tightened
 * signature requires it); builder-route/engine-swap tests that need real on-disk modules keep using
 * {@link startTestServerFromFilesWithAuth}.
 *
 * BOOTSTRAP: per-file DBs (clone of golden) share the auth tables across a file's tests, so "first sign-up →
 * super-admin" can't be relied on for a second server. So we sign up a UNIQUE email then EXPLICITLY
 * `grantRole(..., 'super-admin')` (idempotent with the advisory-lock bootstrap) — the returned `fetch` is
 * authed as super-admin regardless of bootstrap timing.
 *
 * Built ADDITIVELY: it calls `createServer` with ALL deps, valid under BOTH the current optional signature
 * and the future required {@link ServerDeps} signature. TEARDOWN (caller): `close(token)` + `sessionCache.stop()`
 * + `closeAuth()` + `sql.end()`.
 */
export async function startTestServer(sql: Sql, schemas: Schema[], opts: StartTestServerOpts = {}): Promise<TestServer> {
  await migrate(sql, schemas, { allowDestructive: true }); // CREATE TABLE ct_* + reconcile the snapshot
  if (opts.seed) await opts.seed(); // fixture rows AFTER the tables exist, BEFORE the engine streams them

  const modulesDir = await mkdtemp(path.join(os.tmpdir(), 'conti-harness-')); // empty dir ⇒ Builder routes register
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const store = new PostgresStore(sql);

  // AUTH cycle (mirror conti.ts EXACTLY via assembleAuth): teamView BEFORE auth + the session cache; the cache
  // references `auth` lazily; `setAuthSql` runs first inside assembleAuth (migrate/seed above use raw sql).
  const { auth, sessionCache, rbac, teamView } = await assembleAuth(sql, base, opts.basePath);

  const { engine, registry } = await store.loadFromSchemas(schemas, opts.components ?? []);
  // The full ServerDeps bundle — mirrors conti.ts. publishClock is omitted unless a test pins it (createServer
  // defaults to wall-clock); exactOptionalPropertyTypes forbids assigning an explicit `undefined` to it.
  const deps: ServerDeps = {
    engine,
    store,
    registry,
    ...(opts.publishClock !== undefined ? { publishClock: opts.publishClock } : {}),
    auth,
    sessionCache,
    rbac,
    teamView,
    hooks: opts.hooks ?? new HookRegistry(),
    modulesDir,
    ...(opts.basePath !== undefined ? { basePath: opts.basePath } : {}),
    ...(opts.adminDir !== undefined ? { adminDir: opts.adminDir } : {}),
    ...(opts.cors !== undefined ? { cors: opts.cors } : {}),
  };
  const server = createServer(deps);
  const token = await server.listen(port);

  // signUp / userIdOf / grantRole — reused VERBATIM from startTestServerFromFilesWithAuth.
  // Auth lives under the server's basePath (default '' → '/auth'; '/api' → '/api/auth').
  const authPrefix = opts.basePath ?? '';
  const signUp = async (email: string): Promise<string> => {
    const res = await fetch(`${base}${authPrefix}/auth/sign-up/email`, {
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

  // Bootstrap the super-admin: unique email so a SECOND server in the same file never collides, then sign up
  // (the first-admin advisory-lock bootstrap fires for the very first user) AND explicitly grant super-admin
  // (idempotent ON CONFLICT) so the captured cookie is authed as super-admin regardless of bootstrap timing.
  const adminEmail = `harness-admin-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const cookie = await signUp(adminEmail);
  await grantRole(await userIdOf(adminEmail), 'super-admin');

  const url = (p: string): string => (p.startsWith('http') ? p : `${base}${p}`);
  const authedFetch = (p: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers); // tolerate Headers | record | array forms
    headers.set('cookie', cookie); // the captured super-admin session cookie ⇒ SessionCache.validate resolves it
    return fetch(url(p), { ...init, headers });
  };
  const anonFetch = (p: string, init: RequestInit = {}): Promise<Response> => fetch(url(p), init);

  return {
    base,
    close: server.close,
    token,
    sql,
    engine,
    registry,
    fetch: authedFetch,
    anonFetch,
    signUp,
    userIdOf,
    grantRole,
    sessionCache,
    rbac,
    applyEdit: server.applyEdit!,
  };
}
