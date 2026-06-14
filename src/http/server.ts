import { Engine } from '../store/engine.ts';
import { defineArticle } from '../store/content-type.ts';
import { PostgresStore } from '../db/postgres-store.ts';
import { createServer } from './app.ts';

/**
 * The PRODUCTION entrypoint: a SINGLE process that loads its in-memory {@link Engine} from Postgres
 * ({@link PostgresStore}) at boot and serves the uWebSockets.js app over it.
 *
 * SHARED-NOTHING, single-instance: the process builds its OWN Engine (columns, indexes, response
 * cache) — a self-contained read replica. FUTURE: the ChangeBus becomes a Redis pub/sub bus so a
 * write in a multi-instance deployment invalidates every instance's response cache. {@link seed}
 * remains an in-code data generator for benchmarks/fixtures (NOT the boot path).
 *
 * Server construction ({@link createServer}) is intentionally SEPARATE from listening so tests drive
 * a real uWS server on a free port and never go through this entrypoint.
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
 * fixture generator, NOT the production boot path (the process loads from {@link PostgresStore}). `id`
 * is a dense 1-based serial so it matches a freshly-seeded Postgres table.
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

/** Boot the server: load the Engine from Postgres, build the uWS server, and listen on `port`. */
export async function start(port: number): Promise<void> {
  const store = new PostgresStore();
  const engine = await store.load();
  const server = createServer(engine);
  await server.listen(port);
  console.log(`ready on ${port} (${engine.rowCount('article')} rows from postgres)`);
}

/** The entrypoint. Run directly: `node --env-file=.env src/http/server.ts [port]`. */
export function main(): void {
  const port = Number(process.env.PORT ?? process.argv[2] ?? 3000);
  void start(port);
}

// Run only when invoked as the entrypoint (not when imported by a test/bench).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
