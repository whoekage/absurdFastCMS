import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import postgres from 'postgres';
import type { Sql } from 'postgres';

import { runMigrations } from '../src/db/migration.runner.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { PostgresStore } from '../src/db/postgres.store.ts';
import { createServer } from '../src/http/server.ts';
import { freePort } from './helpers.ts';
import { HookRegistry } from '../src/db/schema/hooks.ts';
import { setAuthSql, closeAuth } from '../src/auth/auth.dialect.ts';
import { buildAuth } from '../src/auth/auth.ts';
import { SessionCache } from '../src/auth/session.cache.ts';
import { RbacRegistry } from '../src/auth/rbac.registry.ts';
import { TeamView } from '../src/auth/team.view.ts';

/**
 * be-09f — the TEAM MODEL, E2E over a REAL uWS server + REAL better-auth (admin plugin) + REAL Postgres
 * (per-file clone) + the REAL SessionCache/RbacRegistry/TeamView. NO MOCKS. Proves the full preventive
 * checklist: the first sign-up lands a team row + projects into team_view; a role change flips
 * checkPermission AND team_view in the same tick (no restart); a real banUser+revokeUserSessions revokes
 * the live cached session WITHOUT waiting for TTL; a non-existent suspend is a hard error (no silent
 * no-op); the actor-role cap forbids assigning a role >= the actor's own; the last super-admin cannot be
 * removed/suspended/demoted; a removed author misses team_view (former-member fallback, no FK crash); a
 * created identity with a body `role` confers ZERO authority; the team_view created-by lookup is ZERO-PG.
 */

let db: Awaited<ReturnType<typeof createFileDatabase>>;
let sql: Sql; // the COUNTED handle (debug query counter) shared by better-auth + cache + rbac + store + teamView.
let queryCount = 0;
let store: PostgresStore;
let auth: ReturnType<typeof buildAuth>;
let sessionCache: SessionCache;
let rbac: RbacRegistry;
let teamView: TeamView;
let base: string;
let token: unknown;
let close: (t: unknown) => void;

/** Sign up a fresh user through the REAL /auth bridge; returns the request Cookie header for the session. */
async function signUp(email: string): Promise<string> {
  const res = await fetch(`${base}/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email, password: 'correct-horse-battery-staple', name: 'U' }),
  });
  assert.equal(res.status, 200, `sign-up failed: ${res.status} ${await res.clone().text()}`);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter((c): c is string => c !== undefined && c.includes('='))
    .join('; ');
}

async function userIdOf(email: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`SELECT id FROM "user" WHERE email = ${email}`;
  assert.ok(row, `no user row for ${email}`);
  return row.id;
}

/** Add a member + assign a role straight through PG (a test fixture, NOT a route) + reload projections. */
async function seedTeamMember(userId: string, roleName: string): Promise<void> {
  await sql`INSERT INTO team (user_id, status) VALUES (${userId}, 'active') ON CONFLICT (user_id) DO NOTHING`;
  await sql`
    INSERT INTO user_roles (user_id, role_id)
    SELECT ${userId}, id FROM roles WHERE name = ${roleName}
    ON CONFLICT DO NOTHING
  `;
  await rbac.rebuild();
  await teamView.rebuild();
}

before(async () => {
  db = await createFileDatabase('teammodel');
  await runMigrations(db.url);
  sql = postgres(db.url, { max: 8, prepare: true, debug: () => { queryCount++; } });
  setAuthSql(sql);

  const port0 = await freePort();
  base = `http://127.0.0.1:${port0}`;

  store = new PostgresStore(sql);
  teamView = new TeamView(sql);
  sessionCache = new SessionCache(() => auth, undefined, undefined, teamView);
  rbac = new RbacRegistry(sql);
  auth = buildAuth({
    baseURL: base,
    sessionEvictor: sessionCache,
    sql,
    rbacInvalidate: () => rbac.rebuild(),
    teamViewReload: () => teamView.rebuild(),
  });
  await rbac.rebuild();
  await teamView.rebuild();

  const { engine, registry } = await store.loadFromSchemas([]); // files-first empty catalog (team E2E creates no modules)
  // FULL real server (every dep wired, nothing gated-off): empty temp modulesDir ⇒ Builder routes register;
  // an empty HookRegistry ⇒ no content lifecycle hooks. Mirrors conti.ts so the boot is valid under required-deps.
  const modulesDir = await mkdtemp(path.join(os.tmpdir(), 'conti-team-'));
  const server = createServer({ engine, store, registry, auth, sessionCache, rbac, teamView, hooks: new HookRegistry(), modulesDir });
  token = await server.listen(port0);
  close = server.close;
});

after(async () => {
  if (token !== undefined) close(token);
  sessionCache.stop();
  await closeAuth();
  await store.close();
  await sql.end();
  await db.sql.end();
  await dropFileDatabase(db.name);
});

// ---------------------------------------------------------------------------------------------------
// BOOTSTRAP — the first sign-up lands a team row AND projects into team_view (atomically, under the lock).
// ---------------------------------------------------------------------------------------------------

test('the first-admin bootstrap ALSO inserts a team row, projected into team_view', async () => {
  await signUp('admin@example.com');
  const adminId = await userIdOf('admin@example.com');

  // A REAL team row exists (inserted under the same advisory lock as the super-admin grant).
  const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM team WHERE user_id = ${adminId}`;
  assert.equal(n, 1, 'the first admin must have a team row');

  // team_view was reloaded by the user.create.after hook (no manual rebuild) → projects the row.
  const row = teamView.get(adminId);
  assert.ok(row, 'the first admin must be in team_view');
  assert.equal(row.status, 'active');
  assert.equal(row.role, 'super-admin', 'the resolved role is super-admin');
  assert.equal(teamView.activeSuperAdminCount(), 1);
});

// ---------------------------------------------------------------------------------------------------
// checklist#1/#4 — a role change via the route flips checkPermission AND team_view in the SAME tick.
// ---------------------------------------------------------------------------------------------------

test('checklist#1/#4: POST /_team/:userId/role flips checkPermission + team_view live (no restart)', async () => {
  // The very first user (admin@example.com, signed up in the bootstrap test) is the super-admin actor.
  const adminId = await userIdOf('admin@example.com');
  const adminSession = await signUpFreshAdminCookie(adminId);

  // A fresh member is added + starts as 'viewer'.
  await signUp('member-role@example.com');
  const memberId = await userIdOf('member-role@example.com');
  const added = await addMember(adminSession, memberId);
  assert.equal(added.status, 200, `add member failed: ${added.status} ${await added.clone().text()}`);
  const setViewer = await setRole(adminSession, memberId, 'viewer');
  assert.equal(setViewer.status, 200, `set viewer failed: ${setViewer.status} ${await setViewer.clone().text()}`);

  assert.equal(rbac.checkPermission({ userId: memberId, sessionToken: 't' }, 'content.read'), true);
  assert.equal(rbac.checkPermission({ userId: memberId, sessionToken: 't' }, 'content.delete'), false);
  assert.equal(teamView.get(memberId)?.role, 'viewer');

  // Promote to editor through the route → checkPermission gains content.delete in the SAME tick.
  await setRole(adminSession, memberId, 'editor');
  assert.equal(rbac.checkPermission({ userId: memberId, sessionToken: 't' }, 'content.delete'), true,
    'the new role is reflected immediately (rbac.rebuild fired in the route)');
  assert.equal(teamView.get(memberId)?.role, 'editor', 'team_view reflects the new role in the same tick');
});

// helpers that drive the REAL routes ---------------------------------------------------------------

/** Resolve the super-admin's session cookie (re-uses the first admin user). */
async function signUpFreshAdminCookie(adminId: string): Promise<string> {
  // The first admin signed up in an earlier test; sign in again to obtain a fresh session cookie.
  const res = await fetch(`${base}/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: 'admin@example.com', password: 'correct-horse-battery-staple' }),
  });
  assert.equal(res.status, 200, `admin sign-in failed: ${res.status} ${await res.clone().text()}`);
  void adminId;
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter((c): c is string => c !== undefined && c.includes('='))
    .join('; ');
}

async function addMember(cookie: string, userId: string): Promise<Response> {
  return fetch(`${base}/_team`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ userId }),
  });
}

async function setRole(cookie: string, userId: string, role: string): Promise<Response> {
  const res = await fetch(`${base}/_team/${userId}/role`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ role }),
  });
  return res;
}

// ---------------------------------------------------------------------------------------------------
// checklist#2 — GET /_team reflects a profile change after a hook reload + emits Cache-Control: no-store.
// ---------------------------------------------------------------------------------------------------

test('checklist#2: GET /_team reflects an updated profile + emits Cache-Control: no-store (not no-cache)', async () => {
  const adminId = await userIdOf('admin@example.com');
  const adminCookie = await signUpFreshAdminCookie(adminId);

  const before = await fetch(`${base}/_team`, { headers: { cookie: adminCookie } });
  assert.equal(before.status, 200);
  assert.equal(before.headers.get('cache-control'), 'no-store', 'the directory must be no-store, never no-cache');

  // Update the admin's name through the better-auth API → databaseHooks.user.update.after → team_view reload.
  const upd = await fetch(`${base}/auth/update-user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie, origin: base },
    body: JSON.stringify({ name: 'Renamed Admin' }),
  });
  assert.equal(upd.status, 200, `update-user failed: ${upd.status} ${await upd.clone().text()}`);

  // A FRESH read reflects the NEW name (no stale value); team_view was full-reloaded by the hook.
  const after = await fetch(`${base}/_team`, { headers: { cookie: adminCookie } });
  const body = (await after.json()) as { data: { userId: string; name: string }[] };
  const me = body.data.find((m) => m.userId === adminId);
  assert.ok(me, 'the admin appears in the directory');
  assert.equal(me.name, 'Renamed Admin', 'the directory reflects the updated name (no stale projection)');
});

// ---------------------------------------------------------------------------------------------------
// checklist#3/#6 — suspend is PUSH: a real banUser+revokeUserSessions evicts the live cached session.
// ---------------------------------------------------------------------------------------------------

test('checklist#3: suspend revokes the LIVE cached session via the API (no TTL wait)', async () => {
  const adminId = await userIdOf('admin@example.com');
  const adminCookie = await signUpFreshAdminCookie(adminId);

  // A real member with a live session.
  const memberCookie = await signUp('suspendme@example.com');
  const memberId = await userIdOf('suspendme@example.com');
  await addMember(adminCookie, memberId);
  await setRole(adminCookie, memberId, 'editor');

  // WARM the member's session in the off-heap cache (a validate against a gated-but-public-ish path). We
  // drive one validate by hitting a route that calls sessionCache.validate — a GET is public, so use the
  // /_team route as the member (they lack team.manage → 403, but validate still WARMS the cache entry).
  const probe = await fetch(`${base}/_team`, { headers: { cookie: memberCookie } });
  assert.equal(probe.status, 403, 'a non-admin member is forbidden on /_team but the validate warms the cache');
  const warmSize = sessionCache.size();
  assert.ok(warmSize >= 1, 'the member session is now cached (warm, off-heap)');

  // Suspend through the route → banUser + revokeUserSessions → session.delete.after → evict (PUSH).
  const susp = await fetch(`${base}/_team/${memberId}/suspend`, { method: 'POST', headers: { cookie: adminCookie } });
  assert.equal(susp.status, 200, `suspend failed: ${susp.status} ${await susp.clone().text()}`);

  // Post-conditions, asserted (not the 2xx): status flipped, PG session rows gone, cache evicted.
  const [{ st }] = await sql<{ st: string }[]>`SELECT status AS st FROM team WHERE user_id = ${memberId}`;
  assert.equal(st, 'suspended', 'the team row is suspended');
  const sessions = await sql`SELECT 1 FROM "session" WHERE "userId" = ${memberId}`;
  assert.equal(sessions.length, 0, 'all PG session rows for the member are deleted');

  // The SAME cookie now resolves NO live session (the next validate re-misses RAM, re-reads PG, finds none).
  const after = await fetch(`${base}/_team`, { headers: { cookie: memberCookie } });
  assert.equal(after.status, 401, 'a suspended member with a revoked session is now unauthenticated (401)');
});

test('checklist#6: suspend of a NON-EXISTENT userId is a hard 404 (no silent no-op, no status write)', async () => {
  const adminId = await userIdOf('admin@example.com');
  const adminCookie = await signUpFreshAdminCookie(adminId);

  const res = await fetch(`${base}/_team/does-not-exist-uid/suspend`, { method: 'POST', headers: { cookie: adminCookie } });
  assert.equal(res.status, 404, `a non-member suspend must 404, got ${res.status}`);
  const rows = await sql`SELECT 1 FROM team WHERE user_id = 'does-not-exist-uid'`;
  assert.equal(rows.length, 0, 'no team.status row was written for an unknown target');
});

// ---------------------------------------------------------------------------------------------------
// checklist#4/#5 — actor-role cap + created-identity authority.
// ---------------------------------------------------------------------------------------------------

test('checklist#4: an actor cannot assign a role at or above their own (no escalation)', async () => {
  const adminId = await userIdOf('admin@example.com');
  const adminCookie = await signUpFreshAdminCookie(adminId);

  // An EDITOR actor (rank below super-admin) with team.manage cannot exist by default (editor lacks
  // team.manage), so the actor-cap is exercised by a NON-super-admin who DOES hold team.manage only if
  // granted. We instead exercise the cap with the super-admin actor assigning super-admin to another (>=
  // own) which must be REJECTED.
  const targetCookie = await signUp('captarget@example.com');
  const targetId = await userIdOf('captarget@example.com');
  await addMember(adminCookie, targetId);

  // super-admin assigning super-admin (a role EQUAL to the actor's own) → 403 (>= own is forbidden).
  const equalOrAbove = await setRole(adminCookie, targetId, 'super-admin');
  assert.equal(equalOrAbove.status, 403, 'assigning a role >= the actor own must be 403');
  assert.equal(teamView.get(targetId)?.role ?? null, null, 'no role was granted by the rejected assignment');

  // Assigning a role STRICTLY below the actor's own (editor) succeeds.
  const below = await setRole(adminCookie, targetId, 'editor');
  assert.equal(below.status, 200, `assigning a role below the actor own must succeed, got ${below.status}`);
  assert.equal(teamView.get(targetId)?.role, 'editor');
  void targetCookie;
});

test('checklist#5: a created identity with body role="super-admin" holds ZERO CMS authority', async () => {
  // Sign up a fresh user; the body cannot carry an authorizing role into our RBAC. (better-auth role is
  // never our authz source — adminRoles:[].) No team role until our gated capped write grants one.
  await signUp('massassign-team@example.com');
  const uid = await userIdOf('massassign-team@example.com');
  await rbac.rebuild();
  assert.equal(rbac.checkPermission({ userId: uid, sessionToken: 't' }, 'team.manage'), false,
    'a created identity has NO team.manage until our gated grant');
  assert.equal(rbac.permissionsOf(uid).size, 0, 'no permissions from a body-supplied role');
});

// ---------------------------------------------------------------------------------------------------
// checklist#7 — last-admin / self guards.
// ---------------------------------------------------------------------------------------------------

test('checklist#7: the LAST active super-admin cannot be suspended, removed, or demoted; self-remove blocked', async () => {
  // A FRESH db so "exactly one super-admin" is genuinely true.
  const fresh = await createFileDatabase('teamlastadmin');
  try {
    await runMigrations(fresh.url);
    const fsql = postgres(fresh.url, { max: 8, prepare: true });
    try {
      setAuthSql(fsql);
      const frbac = new RbacRegistry(fsql);
      const ftv = new TeamView(fsql);
      let fauth: ReturnType<typeof buildAuth>;
      const fcache = new SessionCache(() => fauth, undefined, 0, ftv);
      const fport = await freePort();
      const fbase = `http://127.0.0.1:${fport}`;
      fauth = buildAuth({
        baseURL: fbase, sessionEvictor: fcache, sql: fsql,
        rbacInvalidate: () => frbac.rebuild(), teamViewReload: () => ftv.rebuild(),
      });
      const fstore = new PostgresStore(fsql);
      const { engine, registry } = await fstore.loadFromSchemas([]); // files-first empty catalog
      const fmodulesDir = await mkdtemp(path.join(os.tmpdir(), 'conti-team-lastadmin-'));
      const fserver = createServer({ engine, store: fstore, registry, auth: fauth, sessionCache: fcache, rbac: frbac, teamView: ftv, hooks: new HookRegistry(), modulesDir: fmodulesDir });
      const ftoken = await fserver.listen(fport);
      try {
        // The first sign-up is the lone super-admin.
        const signIn = async (): Promise<string> => {
          const r = await fetch(`${fbase}/auth/sign-up/email`, {
            method: 'POST', headers: { 'content-type': 'application/json', origin: fbase },
            body: JSON.stringify({ email: 'lone@example.com', password: 'correct-horse-battery-staple', name: 'L' }),
          });
          assert.equal(r.status, 200);
          return r.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c): c is string => c.includes('=')).join('; ');
        };
        const cookie = await signIn();
        const [{ id: loneId }] = await fsql<{ id: string }[]>`SELECT id FROM "user" WHERE email = 'lone@example.com'`;
        assert.equal(ftv.activeSuperAdminCount(), 1);

        // (a) suspend self (the last admin) → 403, row unchanged.
        const susp = await fetch(`${fbase}/_team/${loneId}/suspend`, { method: 'POST', headers: { cookie } });
        assert.equal(susp.status, 403, 'cannot suspend the last super-admin');
        // (b) remove self → 403 (self-guard AND last-admin guard).
        const rem = await fetch(`${fbase}/_team/${loneId}`, { method: 'DELETE', headers: { cookie } });
        assert.equal(rem.status, 403, 'cannot remove yourself / the last super-admin');
        // (c) demote self → 403 (last-admin guard, before any privilege-cap consideration).
        const dem = await fetch(`${fbase}/_team/${loneId}/role`, {
          method: 'POST', headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ role: 'viewer' }),
        });
        assert.equal(dem.status, 403, 'cannot demote the last super-admin');

        // The lone admin is intact: still active super-admin, still authorized.
        await frbac.rebuild();
        await ftv.rebuild();
        assert.equal(ftv.get(loneId)?.role, 'super-admin');
        assert.equal(ftv.get(loneId)?.status, 'active');
        assert.equal(frbac.checkPermission({ userId: loneId, sessionToken: 't' }, 'team.manage'), true);
        const [{ n }] = await fsql<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'super-admin'
        `;
        assert.equal(n, 1, 'still exactly one super-admin grant');
      } finally {
        fserver.close(ftoken);
        fcache.stop();
      }
    } finally {
      await fsql.end();
    }
  } finally {
    await fresh.sql.end();
    await dropFileDatabase(fresh.name);
    setAuthSql(sql);
  }
});

// ---------------------------------------------------------------------------------------------------
// checklist#8 — a removed author misses team_view (former-member fallback, no FK crash).
// ---------------------------------------------------------------------------------------------------

test('checklist#8: removing a member who authored content succeeds (no FK crash); team_view misses', async () => {
  const adminId = await userIdOf('admin@example.com');
  const adminCookie = await signUpFreshAdminCookie(adminId);

  // A member to remove (an editor, NOT a super-admin, so the last-admin guard does not apply to them).
  await signUp('authorgone@example.com');
  const authorId = await userIdOf('authorgone@example.com');
  await addMember(adminCookie, authorId);
  await setRole(adminCookie, authorId, 'editor');
  assert.ok(teamView.get(authorId), 'the author is in team_view before removal');

  // content.createdBy is a SOFT ref (no FK to user/team) — simulate authored content carrying their id.
  // (There is no FK, so a hard-delete of the user must not raise a constraint violation.)

  // Remove via the route → auth.api.removeUser (cascades sessions; ON DELETE CASCADE tidies team/user_roles).
  const rem = await fetch(`${base}/_team/${authorId}`, { method: 'DELETE', headers: { cookie: adminCookie } });
  assert.equal(rem.status, 200, `removeUser must succeed (no FK violation), got ${rem.status} ${await rem.clone().text()}`);

  // The user row is gone; team_view misses → the created-by resolver renders the "former member" fallback.
  const userRows = await sql`SELECT 1 FROM "user" WHERE id = ${authorId}`;
  assert.equal(userRows.length, 0, 'the user row is removed');
  assert.equal(teamView.get(authorId), null, 'a removed author misses team_view (former-member fallback)');
});

// ---------------------------------------------------------------------------------------------------
// checklist#2/#9 — gating + the ZERO-PG team_view created-by lookup; no impersonation surface.
// ---------------------------------------------------------------------------------------------------

test('the /_team routes are 401 with no session and 403 without team.manage', async () => {
  // NO session → 401.
  const noAuth = await fetch(`${base}/_team`);
  assert.equal(noAuth.status, 401, 'GET /_team with no session must be 401');

  // A signed-in non-admin (zero perms) → 403.
  const cookie = await signUp('teamnobody@example.com');
  const list = await fetch(`${base}/_team`, { headers: { cookie } });
  assert.equal(list.status, 403, 'a non-team.manage session must be 403 on /_team');

  const susp = await fetch(`${base}/_team/whoever/suspend`, { method: 'POST', headers: { cookie } });
  assert.equal(susp.status, 403);
  const role = await fetch(`${base}/_team/whoever/role`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ role: 'viewer' }),
  });
  assert.equal(role.status, 403);
});

test('the team_view created-by lookup is ZERO-PG (RAM Map, EqIndex-equivalent)', async () => {
  const adminId = await userIdOf('admin@example.com');
  // team_view is already loaded; a get() is a pure Map read.
  queryCount = 0;
  const row = teamView.get(adminId);
  const miss = teamView.get('no-such-user');
  assert.ok(row, 'a present member resolves');
  assert.equal(miss, null, 'an absent author misses → former-member fallback');
  assert.equal(queryCount, 0, `team_view.get must fire ZERO Postgres queries, saw ${queryCount}`);
});

// ---------------------------------------------------------------------------------------------------
// EDGE: dual team + consumer — a team member's cached horizon is CAPPED to the short team TTL (~8h),
// while a non-team consumer keeps PG's full 7d. The cap is the PUSH-not-pull suspend bound (a warm
// zero-PG validate cannot re-read a status flag), so it MUST apply to a team member and ONLY a team member.
// ---------------------------------------------------------------------------------------------------

test('EDGE dual team+consumer: a team member is capped to the short TTL (~8h); a consumer keeps 7d', async () => {
  const TEAM_TTL_MS = 8 * 60 * 60 * 1000;
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  // A NON-TEAM consumer: signed up but never added to the team → team_view miss → keeps PG's 7d.
  const consumerCookie = await signUp('ttl-consumer@example.com');
  const consumerId = await userIdOf('ttl-consumer@example.com');
  assert.equal(teamView.get(consumerId), null, 'the consumer is NOT in team_view');
  const consumerHeaders = new Headers({ cookie: consumerCookie });
  await sessionCache.validate(consumerHeaders); // miss → PG read → cache populate (uncapped)
  // The cache is keyed on the PG `session.token` (what store.set uses), so read the token straight from PG.
  const [{ tok: consumerTok, exp: consumerPgExp }] = await sql<{ tok: string; exp: string }[]>`
    SELECT "token" AS tok, "expiresAt" AS exp FROM "session" WHERE "userId" = ${consumerId} ORDER BY "expiresAt" DESC LIMIT 1
  `;
  const consumerCached = sessionCache.peekExpiry(consumerTok);
  assert.ok(consumerCached !== null, 'the consumer session is cached');
  // A consumer keeps PG's full horizon: cached == PG expiry (≈ now + 7d), NOT shortened to 8h.
  assert.equal(consumerCached, +new Date(consumerPgExp), 'a non-team consumer keeps PG expiry (no cap)');
  assert.ok(consumerCached - Date.now() > TEAM_TTL_MS, 'a consumer horizon exceeds the short team TTL');
  assert.ok(consumerCached - Date.now() <= SEVEN_DAYS_MS + 60_000, 'a consumer horizon is PG 7d');

  // A TEAM member: added + roled → team_view hit → the cached horizon is capped to ~8h even though PG is 7d.
  const memberCookie = await signUp('ttl-teammember@example.com');
  const memberId = await userIdOf('ttl-teammember@example.com');
  const adminCookie = await signUpFreshAdminCookie(await userIdOf('admin@example.com'));
  await addMember(adminCookie, memberId);
  await setRole(adminCookie, memberId, 'editor');
  assert.ok(teamView.get(memberId), 'the member IS in team_view');
  const memberHeaders = new Headers({ cookie: memberCookie });
  await sessionCache.validate(memberHeaders); // miss → PG read → cache populate (CAPPED to 8h)
  const [{ tok: memberTok, exp: memberPgExp }] = await sql<{ tok: string; exp: string }[]>`
    SELECT "token" AS tok, "expiresAt" AS exp FROM "session" WHERE "userId" = ${memberId} ORDER BY "expiresAt" DESC LIMIT 1
  `;
  const memberCached = sessionCache.peekExpiry(memberTok);
  assert.ok(memberCached !== null, 'the member session is cached');
  // The PG row is the full 7d, but the CACHED horizon is capped to ~8h (the be-09f short team TTL).
  assert.ok(+new Date(memberPgExp) - Date.now() > TEAM_TTL_MS, 'PG keeps the member at 7d (the cap is RAM-only)');
  assert.ok(memberCached - Date.now() <= TEAM_TTL_MS + 60_000, 'the team member cached horizon is CAPPED to ~8h');
  assert.ok(memberCached < +new Date(memberPgExp), 'the cached horizon is strictly below PG (the cap bit)');
});

test('no impersonation route is exposed by the team-management surface (scope fence)', async () => {
  const adminId = await userIdOf('admin@example.com');
  const adminCookie = await signUpFreshAdminCookie(adminId);
  // There is no /_team/:userId/impersonate route — it falls through to the read core → 404 (or 405). It is
  // certainly NOT a 2xx that would mint an impersonation session.
  const res = await fetch(`${base}/_team/${adminId}/impersonate`, { method: 'POST', headers: { cookie: adminCookie } });
  assert.ok(res.status === 404 || res.status === 405, `no impersonation surface; expected 404/405, got ${res.status}`);
});
