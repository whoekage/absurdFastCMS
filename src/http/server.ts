import cluster from 'node:cluster';
import os from 'node:os';
import { Engine } from '../store/engine.ts';
import { createServer } from './app.ts';
import type { FieldDef } from '../store/table.ts';

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
 * cache) via {@link seed}. There is no cross-worker shared memory in this slice — a worker is a
 * self-contained read replica. FUTURE: instead of the in-code {@link seed}, each worker loads its
 * rows from Postgres at boot (and the ChangeBus becomes a Redis pub/sub bus so a write fanned out to
 * every worker invalidates each worker's response cache). For now the seed is a deterministic
 * in-code data set so the server is runnable end-to-end.
 *
 * Server construction ({@link createServer}) is intentionally SEPARATE from listening so tests drive
 * a real uWS server on a free port and never go through this cluster bootstrap.
 */

const FIELDS: FieldDef[] = [
  { name: 'title', type: 'string' },
  { name: 'body', type: 'text' },
  { name: 'status', type: 'string' },
  { name: 'views', type: 'i32' },
  { name: 'rating', type: 'f64' },
  { name: 'active', type: 'bool' },
  { name: 'publishedAt', type: 'date' },
];
const STATUSES = ['draft', 'published', 'archived'];

function lcg(seedNum: number): () => number {
  let s = seedNum >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Build a worker's Engine and fill the `article` content-type with `n` deterministic rows. FUTURE:
 * replace the body with a Postgres `SELECT` at boot; the signature stays the same.
 */
export function seed(n: number, seedNum = 1): Engine {
  const engine = new Engine();
  const t = engine.define('article', FIELDS);
  t.createEqIndex('status');
  t.createSortedIndex('views');
  t.createSortedIndex('publishedAt');
  const rng = lcg(seedNum);
  const base = Date.UTC(2021, 0, 1);
  for (let i = 0; i < n; i++) {
    engine.insert('article', {
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

/** Start one worker: build its own Engine, build the uWS server, listen on `port` (SO_REUSEPORT). */
async function startWorker(port: number, rows: number): Promise<void> {
  const engine = seed(rows);
  const server = createServer(engine);
  await server.listen(port);
  console.log(`worker ${process.pid} ready on ${port} (${rows} rows)`);
}

/** The cluster entrypoint. Run directly: `node src/http/server.ts [port] [workers] [rows]`. */
export function main(): void {
  const port = Number(process.env.PORT ?? process.argv[2] ?? 3000);
  const workers = Number(process.argv[3] ?? Math.max(1, os.availableParallelism()));
  const rows = Number(process.argv[4] ?? 10000);

  if (cluster.isPrimary) {
    console.log(`cluster primary ${process.pid}: forking ${workers} workers on :${port}`);
    for (let i = 0; i < workers; i++) cluster.fork();
    cluster.on('exit', (worker) => {
      console.log(`worker ${worker.process.pid} exited; refork`);
      cluster.fork();
    });
  } else {
    void startWorker(port, rows);
  }
}

// Run only when invoked as the entrypoint (not when imported by a test/bench).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
