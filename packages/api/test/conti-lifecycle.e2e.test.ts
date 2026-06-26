import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerLifecycle } from '../src/compose/conti.ts';

const { createFileDatabase, dropFileDatabase } = await import('./db-per-file.ts');
const { freePort } = await import('./helpers.ts');
const { createConti } = await import('../src/compose/conti.ts');
const { loadConfigFromEnv } = await import('../src/compose/config.ts');

/**
 * Phase 2 (T4) server-lifecycle hooks (the bootstrap.ts contract), over a REAL per-file Postgres + uWS.
 * Verifies the firing order/context and the researched error semantics (Strapi register / Fastify onListen /
 * destroy): onBeforeStart throw ABORTS boot; onAfterStart throw is logged + server stays up; onShutdown
 * throw is collected into an AggregateError but teardown still completes. NO mocks.
 */

let db: Awaited<ReturnType<typeof createFileDatabase>>;
before(async () => {
  db = await createFileDatabase('lifecycle');
  process.env.DATABASE_URL = db.url; // per-file process isolation; createConti is pinned to db.url anyway
});
after(async () => {
  if (db) {
    await db.sql.end();
    await dropFileDatabase(db.name);
  }
});

const cfg = (port: number) => ({ ...loadConfigFromEnv(), database: { url: db.url }, server: { port } });

test('hooks fire in order with the right context around a real boot', async () => {
  const events: string[] = [];
  const port = await freePort();
  const lifecycle: ServerLifecycle = {
    onBeforeStart: (ctx) => {
      events.push(`before:${ctx.config.server.port}`);
    },
    onAfterStart: (ctx) => {
      events.push(`after:${ctx.port}`);
    },
    onShutdown: () => {
      events.push('shutdown');
    },
  };
  const app = createConti(cfg(port), lifecycle);
  await app.start();
  const res = await fetch(`http://127.0.0.1:${port}/api/article`);
  assert.equal(res.status, 200);
  await app.stop();
  assert.deepEqual(events, [`before:${port}`, `after:${port}`, 'shutdown']);
});

test('onBeforeStart throwing aborts boot — server never listens, onAfterStart not called', async () => {
  const calls: string[] = [];
  const port = await freePort();
  const app = createConti(cfg(port), {
    onBeforeStart: () => {
      calls.push('before');
      throw new Error('abort-boot');
    },
    onAfterStart: () => {
      calls.push('after');
    },
  });
  await assert.rejects(app.start(), /abort-boot/);
  assert.deepEqual(calls, ['before']); // onAfterStart never ran
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/article`)); // nothing is listening
  await app.stop(); // nothing was opened -> safe no-op
});

test('onAfterStart throwing is logged but the server stays up and serves', async () => {
  const port = await freePort();
  const app = createConti(cfg(port), {
    onAfterStart: () => {
      throw new Error('after-boom');
    },
  });
  await app.start(); // resolves despite the hook throwing
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/article`);
    assert.equal(res.status, 200);
  } finally {
    await app.stop();
  }
});

test('onShutdown throwing rejects stop() with AggregateError but still tears down', async () => {
  const port = await freePort();
  const app = createConti(cfg(port), {
    onShutdown: () => {
      throw new Error('shutdown-boom');
    },
  });
  await app.start();
  await assert.rejects(app.stop(), (e: unknown) => e instanceof AggregateError);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/article`)); // socket still closed -> torn down
});
