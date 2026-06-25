/**
 * Follow-up to duckdb-vs-absurd: empirically test two falsifiable claims from review.
 *
 *  EXP 1 — encoding hypothesis: the 10M axis-A failure is NOT a fundamental limit, it's a
 *          dictionary-vs-data mismatch. `title` is near-unique (high cardinality), so the `string`
 *          (dictionary-encoded) column builds a Map the size of the data and overflows. Storing it as
 *          `text` (UTF-8 arena + offsets, no Map) should build + serve 10M fine. We rebuild with
 *          title:'text' and run the axis-A page query at 10M.
 *
 *  EXP 2 — tail latency: ms/op AVERAGE undersells the read-serving thesis. The architecture's point is
 *          LOW VARIANCE (off-heap arena, no per-read allocation, no GC on the hot path) -> flat p99/p999.
 *          DuckDB plans + materializes + allocates per query -> a wandering tail. We collect the full
 *          per-op latency distribution (p50/p90/p99/p999/max) for both, at 1M, instead of the mean.
 *
 * Run: node bench/critique-followup.ts   (needs @duckdb/node-api). Honest: one machine, one run.
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { Engine } from '../src/store/engine.ts';
import type { ColumnType } from '../src/store/column.ts';

const STATUSES = ['draft', 'published', 'archived'];
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904229) >>> 0;
    return s / 0x100000000;
  };
}
interface Row { id: number; title: string; status: string; views: number; rating: number; active: boolean; }
function makeRows(n: number): Row[] {
  const rng = lcg(42);
  const rows: Row[] = new Array(n);
  for (let i = 0; i < n; i++) {
    rows[i] = {
      id: i + 1,
      title: `Article number ${i} about topic ${(rng() * 5000) | 0}`, // near-unique -> high cardinality
      status: STATUSES[(rng() * 3) | 0]!,
      views: (rng() * 100_000) | 0,
      rating: Math.round(rng() * 500) / 100,
      active: rng() < 0.5,
    };
  }
  return rows;
}

function buildAbsurd(rows: Row[], titleType: ColumnType): Engine {
  const engine = new Engine();
  const t = engine.define('article', [
    { name: 'id', type: 'i32' },
    { name: 'title', type: titleType }, // <-- the experiment knob: 'string' (dict) vs 'text' (arena)
    { name: 'status', type: 'string' },
    { name: 'views', type: 'i32' },
    { name: 'rating', type: 'f64' },
    { name: 'active', type: 'bool' },
  ]);
  t.createHashIndex('status');
  t.createSortedIndex('views');
  for (const r of rows) engine.insert('article', r);
  return engine;
}

function pctl(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}
function dist(label: string, samples: number[]): void {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const fmt = (x: number) => x.toFixed(4).padStart(10);
  console.log(
    `  ${label.padEnd(34)} p50 ${fmt(pctl(s, 50))}  p90 ${fmt(pctl(s, 90))}  p99 ${fmt(pctl(s, 99))}  p999 ${fmt(pctl(s, 99.9))}  max ${fmt(s[s.length - 1]!)}  mean ${fmt(mean)}  (ms)`,
  );
}

async function main(): Promise<void> {
  // ── EXP 1 — encoding hypothesis at 10M ──────────────────────────────────────────────────────
  console.log('\n================ EXP 1 — encoding: title as text (arena) at 10M ================');
  const N1 = 10_000_000;
  const rows10 = makeRows(N1);
  let t0 = performance.now();
  let engine10: Engine | null = null;
  let buildErr: string | null = null;
  try {
    engine10 = buildAbsurd(rows10, 'text'); // arena, NOT dictionary
  } catch (e) {
    buildErr = (e as Error).message;
  }
  if (buildErr) {
    console.log(`  title:'text' build FAILED at 10M -> ${buildErr}`);
  } else {
    console.log(`  title:'text' build OK at 10M in ${(performance.now() - t0).toFixed(0)} ms (dictionary 'string' overflowed here)`);
    const page = () =>
      engine10!.respond('article', {
        filters: [{ field: 'status', op: 'eq', value: 'published' }],
        sort: [{ field: 'views', dir: 'desc' }],
        offset: 0,
        limit: 25,
      });
    const buf = page();
    for (let i = 0; i < 5; i++) page();
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) { const s = performance.now(); page(); samples.push(performance.now() - s); }
    console.log(`  axis-A page (status=published, ORDER BY views DESC, LIMIT 25) at 10M, ${buf.length} B envelope:`);
    dist('  absurd respond -> bytes', samples);
  }
  engine10 = null; // free before EXP 2

  // ── EXP 2 — tail latency at 1M (absurd vs DuckDB) ───────────────────────────────────────────
  console.log('\n================ EXP 2 — tail latency distribution at 1M (axis A page) ================');
  const N2 = 1_000_000;
  const rows1 = makeRows(N2);
  const engine = buildAbsurd(rows1, 'string'); // 1M dict is fine
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  await conn.run('CREATE TABLE article (id INTEGER, title VARCHAR, status VARCHAR, views INTEGER, rating DOUBLE, active BOOLEAN)');
  const app = await conn.createAppender('article');
  for (const r of rows1) { app.appendInteger(r.id); app.appendVarchar(r.title); app.appendVarchar(r.status); app.appendInteger(r.views); app.appendDouble(r.rating); app.appendBoolean(r.active); app.endRow(); }
  app.flushSync(); app.closeSync();

  const absurdPage = () => engine.respond('article', { filters: [{ field: 'status', op: 'eq', value: 'published' }], sort: [{ field: 'views', dir: 'desc' }], offset: 0, limit: 25 });
  const duckPage = async () => Buffer.from((await conn.runAndReadAll("SELECT id,title,status,views,rating,active FROM article WHERE status='published' ORDER BY views DESC LIMIT 25")).getRowObjectsJson(), 'utf8');

  const ITER = 2000;
  for (let i = 0; i < 20; i++) { absurdPage(); await duckPage(); } // warmup
  const aSamples: number[] = [];
  for (let i = 0; i < ITER; i++) { const s = performance.now(); absurdPage(); aSamples.push(performance.now() - s); }
  const dSamples: number[] = [];
  for (let i = 0; i < ITER; i++) { const s = performance.now(); await duckPage(); dSamples.push(performance.now() - s); }
  console.log(`  ${ITER} samples each, sequential:`);
  dist('absurd respond -> bytes', aSamples);
  dist('DuckDB SQL -> native JSON', dSamples);
  const aS = [...aSamples].sort((x, y) => x - y), dS = [...dSamples].sort((x, y) => x - y);
  const spread = (s: number[]) => (pctl(s, 99.9) / pctl(s, 50));
  console.log(`\n  tail spread (p999 / p50):  absurd ${spread(aS).toFixed(1)}x   DuckDB ${spread(dS).toFixed(1)}x   (lower = flatter tail)`);
}

await main();
