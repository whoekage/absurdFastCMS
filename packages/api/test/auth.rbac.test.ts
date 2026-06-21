import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import type { Sql } from 'postgres';

import { runMigrations } from '../src/db/migration.runner.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { RbacRegistry } from '../src/auth/rbac.registry.ts';
import type { Principal } from '../src/auth/session.cache.ts';

/**
 * be-09a — the RBAC registry over REAL `roles`/`permissions`/`role_permissions`/`user_roles` rows + REAL
 * Postgres (per-file clone). NO MOCKS. Proves: a boot rebuild folds the join into RAM; checkPermission is
 * a PURE in-memory set test firing ZERO Postgres (asserted by a postgres.js `debug` query counter on the
 * shared handle); deny-by-default for unknown user/permission; and a direct `rebuild()` re-reads PG after a
 * role_permissions row changes.
 */

let db: Awaited<ReturnType<typeof createFileDatabase>>;
let sql: Sql;
let queryCount = 0;
let rbac: RbacRegistry;
let userId: string;

/** Insert a better-auth `user` row (RBAC's user_roles FKs to it) and return its id. */
async function seedUser(s: Sql, email: string): Promise<string> {
  const id = `usr_${email.replace(/[^a-z0-9]/g, '')}`;
  await s`
    INSERT INTO "user" ("id", "name", "email", "emailVerified")
    VALUES (${id}, 'RBAC Test', ${email}, false)
  `;
  return id;
}

before(async () => {
  db = await createFileDatabase('authrbac');
  await runMigrations(db.url);
  // Counted handle — same `debug` instrument as the session test (real driver telemetry).
  sql = postgres(db.url, { max: 4, prepare: true, debug: () => { queryCount++; } });

  userId = await seedUser(sql, 'rbac@example.com');
  // Seed a real RBAC graph: an `editor` role with content.read + content.write, assigned to the user.
  await sql`INSERT INTO roles (name) VALUES ('editor'), ('viewer')`;
  await sql`INSERT INTO permissions (action) VALUES ('content.read'), ('content.write'), ('content.delete')`;
  await sql`
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM roles r, permissions p
    WHERE r.name = 'editor' AND p.action IN ('content.read', 'content.write')
  `;
  await sql`
    INSERT INTO user_roles (user_id, role_id)
    SELECT ${userId}, id FROM roles WHERE name = 'editor'
  `;

  rbac = new RbacRegistry(sql);
  await rbac.rebuild();
});

after(async () => {
  await sql.end();
  await db.sql.end();
  await dropFileDatabase(db.name);
});

beforeEach(() => {
  queryCount = 0;
});

const principal = (uid: string): Principal => ({ userId: uid, sessionToken: 't' });

test('checkPermission resolves seeded grants and denies by default — with ZERO Postgres queries', () => {
  queryCount = 0;
  assert.equal(rbac.checkPermission(principal(userId), 'content.read'), true);
  assert.equal(rbac.checkPermission(principal(userId), 'content.write'), true);
  // Not granted to the editor role:
  assert.equal(rbac.checkPermission(principal(userId), 'content.delete'), false);
  // Unknown permission + unknown user → deny by default:
  assert.equal(rbac.checkPermission(principal(userId), 'totally.unknown'), false);
  assert.equal(rbac.checkPermission(principal('nobody'), 'content.read'), false);
  // THE PROOF: not one of those checks touched Postgres.
  assert.equal(queryCount, 0, 'a permission check MUST fire ZERO Postgres queries (pure RAM)');
});

test('the registry rebuilds when a role_permissions row changes (direct rebuild)', async () => {
  // Before: content.delete is NOT granted.
  assert.equal(rbac.checkPermission(principal(userId), 'content.delete'), false);

  // Grant content.delete to the editor role with a REAL row.
  await sql`
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM roles r, permissions p
    WHERE r.name = 'editor' AND p.action = 'content.delete'
  `;
  // The invalidation seam is a direct call: an RBAC mutation (a later slice) calls rebuild() to re-read PG.
  await rbac.rebuild();

  assert.equal(
    rbac.checkPermission(principal(userId), 'content.delete'),
    true,
    'after the role_permissions change + invalidate, the new grant must be served from RAM',
  );
});

test('rebuild on EMPTY tables yields an all-deny registry', async () => {
  const empty = await createFileDatabase('authrbacempty');
  try {
    await runMigrations(empty.url);
    const r = new RbacRegistry(empty.sql);
    await r.rebuild();
    assert.equal(r.checkPermission(principal('anyone'), 'content.read'), false);
    assert.equal(r.permissionsOf('anyone').size, 0);
  } finally {
    await empty.sql.end();
    await dropFileDatabase(empty.name);
  }
});
