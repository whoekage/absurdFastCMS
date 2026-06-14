import cluster from 'node:cluster';
import os from 'node:os';
import { Engine } from '../store/engine.ts';
import { defineArticle } from '../store/content-type.ts';
import { PostgresStore } from '../db/postgres-store.ts';
import { createServer } from './app.ts';

/**
 * uWS-MIGRATION SLICE 1 — the PRODUCTION entrypoint: a Node cluster of N workers, each serving the
 * uWebSockets.js app over its OWN {@link Engine}.
 *
 * CLUSTERING uWS (NOT node's socket-sharing cluster): we fork N workers; each worker builds its own
 * Engine + uWS.App + app.listen(PORT). uWS binds with SO_REUSEPORT, so the KERNEL load-balances
 * incoming connections across the workers — there is no shared listen socket handed down from the
 * primary. The primary only forks/reforks; it does not bind a port.
 *
 * SHARED-NOTHING per worker: each worker builds its OWN Engine (its own columns, indexes, response
 * cache) by loading from Postgres ({@link PostgresStore}) at boot. There is no cross-worker shared
 * memory in this slice — a worker is a self-contained read replica. FUTURE: the ChangeBus becomes a
 * Redis pub/sub bus so a write fanned out to every worker invalidates each worker's response cache.
 * {@link seed} remains an in-code data generator for benchmarks/fixtures (NOT the boot path).
 *
 * Server construction ({@link createServer}) is intentionally SEPARATE from listening so tests drive
 * a real uWS server on a free port and never go through this cluster bootstrap.
 */

const STATUSES = ['draft', 'published', 'archived'];

function lcg(seedNum: number): () => number {
  let s = seedNum >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Build an Engine and fill the `article` content-type with `n` deterministic rows — a benchmark /
 * fixture generator, NOT the production boot path (workers load from {@link PostgresStore}). `id` is
 * a dense 1-based serial so it matches a freshly-seeded Postgres table.
 */
export function seed(n: number, seedNum = 1): Engine {
  const engine = new Engine();
  const t = defineArticle(engine);
  const rng = lcg(seedNum);
  const base = Date.UTC(2021, 0, 1);
  for (let i = 0; i < n; i++) {
    engine.insert('article', {
      id: i + 1,
      title: rng() < 0.1 ? null : `Title "${i}" e zh`,
      body: `Body text for row ${i}, lorem ipsum dolor sit amet.`,
      status: STATUSES[(rng() * STATUSES.length) | 0]!,
      views: rng() < 0.08 ? null : (rng() * 100000) | 0,
      rating: rng() < 0.08 ? null : Math.round(rng() * 1000) / 100,
      active: rng() < 0.5,
      publishedAt: base + i * 3_600_000,
    });
  }
  t.warmIndexes();
  return engine;
}

/** Start one worker: load its Engine from Postgres, build the uWS server, listen (SO_REUSEPORT). */
async function startWorker(port: number): Promise<void> {
  const store = new PostgresStore();
  const engine = await store.load();
  const server = createServer(engine);
  await server.listen(port);
  console.log(`worker ${process.pid} ready on ${port} (${engine.rowCount('article')} rows from postgres)`);
}

/** The cluster entrypoint. Run directly: `node --env-file=.env src/http/server.ts [port] [workers]`. */
export function main(): void {
  const port = Number(process.env.PORT ?? process.argv[2] ?? 3000);
  const workers = Number(process.argv[3] ?? Math.max(1, os.availableParallelism()));

  if (cluster.isPrimary) {
    console.log(`cluster primary ${process.pid}: forking ${workers} workers on :${port}`);
    for (let i = 0; i < workers; i++) cluster.fork();
    cluster.on('exit', (worker) => {
      console.log(`worker ${worker.process.pid} exited; refork`);
      cluster.fork();
    });
  } else {
    void startWorker(port);
  }
}

// Run only when invoked as the entrypoint (not when imported by a test/bench).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
