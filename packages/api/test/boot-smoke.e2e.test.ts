import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { createFileDatabase, dropFileDatabase } = await import('./db-per-file.ts');
const { freePort } = await import('./helpers.ts');
const { createConti } = await import('../src/compose/conti.ts');
const { loadConfigFromEnv } = await import('../src/compose/config.ts');

/**
 * Phase 2 (T2) boot smoke: prove createConti() boots the FULL lifted stack (migrate → seed → load the
 * in-memory Engine+Registry → auth/rbac/team → listen) over a REAL per-file Postgres on a free port,
 * serves a content read, and stops cleanly (socket closed, session sweep stopped, owned PG handle ended —
 * the process exits with no hang). NO mocks.
 */

let db: Awaited<ReturnType<typeof createFileDatabase>>;
let app: ReturnType<typeof createConti>;
let port: number;

before(async () => {
  db = await createFileDatabase('bootsmoke');
  // loadConfigFromEnv() reads config.databaseUrl; the per-file harness doesn't set DATABASE_URL, so set it
  // here (node isolates each test file in its own process → no cross-file leak). createConti's store is
  // pinned to db.url explicitly below regardless.
  process.env.DATABASE_URL = db.url;
  port = await freePort();
  app = createConti({ ...loadConfigFromEnv(), database: { url: db.url }, server: { port } });
  await app.start();
});

after(async () => {
  if (app) await app.stop();
  if (db) {
    await db.sql.end();
    await dropFileDatabase(db.name);
  }
});

test('createConti boots the full stack and serves a content read', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/article`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: unknown };
  assert.ok(Array.isArray(body.data), 'GET /article returns a {data:[...]} collection');
});

test('stop() before start() is a safe no-op', async () => {
  // A never-started app holds no resources, so stop() must resolve without touching anything.
  const fresh = createConti({ ...loadConfigFromEnv(), database: { url: db.url }, server: { port } });
  await fresh.stop();
});

// MUST be the last test: it tears down the shared `app`. stop() is idempotent, so the after() hook's
// stop() (a 3rd call) is a no-op; calling it twice here proves no double-close / re-run.
test('stop() is idempotent (double call is safe)', async () => {
  await app.stop();
  await app.stop();
});
