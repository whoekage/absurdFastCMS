import { Engine } from '../store/engine.ts';
import type { FieldDef } from '../store/table.ts';
import { STATUSES } from '../db/seed.ts';

/**
 * In-memory benchmark / fixture generator. The PRODUCTION boot path moved to the composition root
 * ({@link createConti} in `src/compose/conti.ts`); this module now holds only the in-code Engine generator
 * used by benches/fixtures (NOT the boot path), plus a re-export of the demo seed for tests.
 *
 * Server CONSTRUCTION ({@link createServer}) stays separate from listening so tests drive a real uWS server
 * on a free port without going through the entrypoint.
 */

/** The static engine FieldDef[] mirroring the `article` seed for the in-memory bench generator. */
const ARTICLE_BENCH_FIELDS: FieldDef[] = [
  { name: 'id', type: 'i32' },
  { name: 'created_at', type: 'date' },
  { name: 'updated_at', type: 'date' },
  { name: 'title', type: 'string' },
  { name: 'body', type: 'text' },
  { name: 'status', type: 'string' },
  { name: 'views', type: 'i32' },
  { name: 'rating', type: 'f64' },
  { name: 'active', type: 'bool' },
  { name: 'publishedAt', type: 'date' },
];

function lcg(seedNum: number): () => number {
  let s = seedNum >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Build an Engine and fill the `article` module with `n` deterministic rows — a benchmark / fixture
 * generator, NOT the production boot path (which loads from {@link PostgresStore}). `id` is a dense 1-based
 * serial so it matches a freshly-seeded Postgres table. Uses a static in-memory schema + the same index plan.
 */
export function seed(n: number, seedNum = 1): Engine {
  const engine = new Engine();
  const t = engine.define('article', ARTICLE_BENCH_FIELDS);
  t.createEqIndex('id');
  t.createEqIndex('status');
  t.createSortedIndex('views');
  t.createSortedIndex('publishedAt');
  const rng = lcg(seedNum);
  const base = Date.UTC(2021, 0, 1);
  for (let i = 0; i < n; i++) {
    engine.insert('article', {
      id: i + 1,
      created_at: base + i * 3_600_000,
      updated_at: base + i * 3_600_000,
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
