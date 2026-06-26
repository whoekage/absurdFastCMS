import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { createFileDatabase, dropFileDatabase } = await import('./db-per-file.ts');
const { freePort } = await import('./helpers.ts');
const { createConti } = await import('../src/compose/conti.ts');

/**
 * Phase 2 (T5) — the two-file contract end-to-end. Loads the ACTUAL project files (conti.config.ts +
 * bootstrap.ts), confirms they default-export a valid ContiConfig / ServerLifecycle, and drives a real
 * boot from them over a per-file Postgres (overriding db/port for the test). Proves the files are valid,
 * typed, and wire createConti(config, lifecycle) — the shape a `conti init` project will scaffold. NO mocks.
 */

let db: Awaited<ReturnType<typeof createFileDatabase>>;
before(async () => {
  db = await createFileDatabase('twofile');
  process.env.DATABASE_URL = db.url; // conti.config.ts evaluates loadConfigFromEnv() at import
});
after(async () => {
  if (db) {
    await db.sql.end();
    await dropFileDatabase(db.name);
  }
});

test('conti.config.ts + bootstrap.ts load and drive a real boot', async () => {
  const { default: config } = await import('../conti.config.ts');
  const { default: lifecycle } = await import('../bootstrap.ts');
  assert.ok(config.database?.url && typeof config.server?.port === 'number', 'config is a ContiConfig');
  assert.equal(typeof lifecycle, 'object', 'bootstrap default-exports a ServerLifecycle object');

  const port = await freePort();
  const app = createConti({ ...config, database: { url: db.url }, server: { port } }, lifecycle);
  await app.start(); // exercises the real bootstrap.ts onAfterStart (warmup fetch + ready log)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/article`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: unknown };
    assert.ok(Array.isArray(body.data));
  } finally {
    await app.stop(); // exercises the real bootstrap.ts onShutdown
  }
});
