/**
 * absurd columnar in-memory engine  vs  DuckDB — a FAIR, two-axis benchmark.
 *
 * Run: node bench/duckdb-vs-absurd.bench.ts   (needs @duckdb/node-api devDep)
 *
 * The two engines are built for DIFFERENT jobs, so we measure BOTH axes and report honestly:
 *
 *   Axis A — CMS read (filter + sort + paginate -> JSON BYTES ready to send).
 *     This is absurd's actual workload. absurd's thesis is serialize-on-write: the row JSON is
 *     materialized to bytes ONCE at insert time, so a read is a zero-copy arena-slice concat.
 *     DuckDB must run the SQL AND serialize the result set to JSON on every read. To be fair we
 *     include JSON encoding for DuckDB, and we give DuckDB its BEST path too (native getRowObjectsJson).
 *
 *   Axis B — analytics (COUNT/GROUP BY, SUM/AVG over the whole table).
 *     absurd's query API CANNOT do this (no aggregation surface). DuckDB is a vectorized OLAP engine
 *     built exactly for it. For context we time a naive JS column-scan (the ceiling of "what absurd's
 *     storage could do if we hand-rolled it"), NOT something the product exposes — labeled as such.
 *
 * Data is identical in both engines (one deterministic LCG-seeded row array fed to both). No mocks.
 * Numbers are order-of-magnitude on one machine; absolute values vary, the RATIO is the point.
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { Engine } from '../src/store/engine.ts';

const STATUSES = ['draft', 'published', 'archived'];

/** Seeded LCG — deterministic data, no Math.random (matches scan.bench.ts). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904229) >>> 0;
    return s / 0x100000000;
  };
}

interface Row {
  id: number;
  title: string;
  status: string;
  views: number;
  rating: number;
  active: boolean;
}

function makeRows(n: number): Row[] {
  const rng = lcg(42);
  const rows: Row[] = new Array(n);
  for (let i = 0; i < n; i++) {
    rows[i] = {
      id: i + 1,
      title: `Article number ${i} about topic ${(rng() * 5000) | 0}`,
      status: STATUSES[(rng() * 3) | 0]!,
      views: (rng() * 100_000) | 0,
      rating: Math.round(rng() * 500) / 100,
      active: rng() < 0.5,
    };
  }
  return rows;
}

function time(fn: () => void, iterations: number, warmup = 5): number {
  for (let i = 0; i < warmup; i++) fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return (performance.now() - start) / iterations;
}

function line(label: string, ms: number, extra = ''): void {
  console.log(`  ${label.padEnd(46)} ${ms.toFixed(4).padStart(11)} ms/op  ${extra}`);
}

// ── absurd setup ────────────────────────────────────────────────────────────────────────────────
function buildAbsurd(rows: Row[]): Engine {
  const engine = new Engine();
  const t = engine.define('article', [
    { name: 'id', type: 'i32' },
    { name: 'title', type: 'string' },
    { name: 'status', type: 'string' },
    { name: 'views', type: 'i32' },
    { name: 'rating', type: 'f64' },
    { name: 'active', type: 'bool' },
  ]);
  t.createHashIndex('status'); // low-card eq index (draft/published/archived)
  t.createSortedIndex('views'); // range/ORDER BY index
  for (const r of rows) engine.insert('article', r);
  if (typeof (t as { warmIndexes?: () => void }).warmIndexes === 'function') {
    (t as { warmIndexes: () => void }).warmIndexes();
  }
  return engine;
}

// ── DuckDB setup ────────────────────────────────────────────────────────────────────────────────
async function buildDuck(rows: Row[]) {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  await conn.run(
    'CREATE TABLE article (id INTEGER, title VARCHAR, status VARCHAR, views INTEGER, rating DOUBLE, active BOOLEAN)',
  );
  const app = await conn.createAppender('article');
  for (const r of rows) {
    app.appendInteger(r.id);
    app.appendVarchar(r.title);
    app.appendVarchar(r.status);
    app.appendInteger(r.views);
    app.appendDouble(r.rating);
    app.appendBoolean(r.active);
    app.endRow();
  }
  app.flushSync();
  app.closeSync();
  return conn;
}

async function main(): Promise<void> {
  const N = Number(process.env.BENCH_N ?? 1_000_000);
  console.log(`\n========================================================================`);
  console.log(` absurd vs DuckDB — ${N.toLocaleString()} rows (article: id/title/status/views/rating/active)`);
  console.log(`========================================================================`);

  // AXIS=B skips the absurd build + axis A (absurd's dictionary-string column can't hold N near-unique
  // titles past ~10M — a known structural limit for high-card strings, unrelated to analytics speed). This
  // lets us push DuckDB-vs-naive analytics to the scale where vectorization actually pays off.
  const axisBOnly = process.env.BENCH_AXIS === 'B';

  const rows = makeRows(N);

  let t0 = performance.now();
  const engine = axisBOnly ? null : buildAbsurd(rows);
  if (engine) console.log(`\nbuild absurd (insert + serialize-on-write + index):  ${(performance.now() - t0).toFixed(0)} ms`);
  t0 = performance.now();
  const duck = await buildDuck(rows);
  console.log(`build DuckDB (appender load):                        ${(performance.now() - t0).toFixed(0)} ms`);

  // Pre-build a flat column view for the naive-JS analytics ceiling (NOT a product feature).
  const statusCode = new Int32Array(N);
  const viewsArr = new Int32Array(N);
  const ratingArr = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    statusCode[i] = STATUSES.indexOf(rows[i]!.status);
    viewsArr[i] = rows[i]!.views;
    ratingArr[i] = rows[i]!.rating;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // AXIS A — CMS read: filter + sort + paginate -> JSON bytes ready to send.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  // async timing helper for DuckDB (used by both axes)
  const timeAsync = async (fn: () => Promise<void>, iter: number, warm = 5): Promise<number> => {
    for (let i = 0; i < warm; i++) await fn();
    const s = performance.now();
    for (let i = 0; i < iter; i++) await fn();
    return (performance.now() - s) / iter;
  };

  if (!axisBOnly && engine) {
  console.log(`\n── AXIS A — CMS read (this is absurd's workload): page of 25, status='published', ORDER BY views DESC ──`);
  const ITER_A = 200;

  // absurd: Engine.respond returns the {data,meta} Buffer (serialize-on-write; zero-copy arena slices).
  const absurdPage = (offset: number) =>
    engine.respond('article', {
      filters: [{ field: 'status', op: 'eq', value: 'published' }],
      sort: [{ field: 'views', dir: 'desc' }],
      offset,
      limit: 25,
    });
  // sanity: produce identical row count from both
  const aBuf = absurdPage(0);

  // DuckDB path (a): typical Node path — fetch rows, JSON.stringify in JS.
  const duckPageRowsJS = async (offset: number) => {
    const r = await duck.runAndReadAll(
      `SELECT id,title,status,views,rating,active FROM article WHERE status='published' ORDER BY views DESC LIMIT 25 OFFSET ${offset}`,
    );
    return Buffer.from(JSON.stringify({ data: r.getRows() }), 'utf8');
  };
  // DuckDB path (b): DuckDB's BEST path — native C++ JSON serialization.
  const duckPageNativeJson = async (offset: number) => {
    const r = await duck.runAndReadAll(
      `SELECT id,title,status,views,rating,active FROM article WHERE status='published' ORDER BY views DESC LIMIT 25 OFFSET ${offset}`,
    );
    return Buffer.from(r.getRowObjectsJson(), 'utf8');
  };

  const dBuf = await duckPageRowsJS(0);
  console.log(`  (sanity: absurd ${aBuf.length} B envelope vs DuckDB ${dBuf.length} B data — both 25 rows)\n`);

  line('absurd  Engine.respond -> bytes (page 1)', time(() => void absurdPage(0), ITER_A));
  line('absurd  Engine.respond -> bytes (deep page, offset 10k)', time(() => void absurdPage(10_000), ITER_A));

  line('DuckDB  SQL -> rows -> JS JSON.stringify (page 1)', await timeAsync(() => duckPageRowsJS(0).then(() => {}), ITER_A));
  line('DuckDB  SQL -> native getRowObjectsJson (page 1)', await timeAsync(() => duckPageNativeJson(0).then(() => {}), ITER_A));
  line('DuckDB  SQL -> native JSON (deep page, offset 10k)', await timeAsync(() => duckPageNativeJson(10_000).then(() => {}), ITER_A));
  } // end axis A

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // AXIS B — analytics: COUNT/GROUP BY + SUM/AVG over the whole table.
  // absurd's QUERY API CANNOT do this. Naive-JS = the hand-rolled ceiling over our columns (context).
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log(`\n── AXIS B — analytics (DuckDB's workload; absurd's API has NO aggregation) ──`);
  const ITER_B = 50;

  // COUNT(*) GROUP BY status
  const duckGroupCount = async () => {
    await (await duck.runAndReadAll('SELECT status, COUNT(*) FROM article GROUP BY status')).getRows();
  };
  const naiveGroupCount = () => {
    const c = [0, 0, 0];
    for (let i = 0; i < N; i++) c[statusCode[i]!]!++;
    return c;
  };
  line('DuckDB  COUNT(*) GROUP BY status', await timeAsync(() => duckGroupCount(), ITER_B));
  line('naive-JS column-scan COUNT GROUP BY (NOT a feature)', time(() => void naiveGroupCount(), ITER_B));

  // SUM(views) + AVG(rating)
  const duckAgg = async () => {
    await (await duck.runAndReadAll('SELECT SUM(views), AVG(rating) FROM article')).getRows();
  };
  const naiveAgg = () => {
    let sum = 0;
    let racc = 0;
    for (let i = 0; i < N; i++) {
      sum += viewsArr[i]!;
      racc += ratingArr[i]!;
    }
    return [sum, racc / N];
  };
  line('DuckDB  SUM(views), AVG(rating)', await timeAsync(() => duckAgg(), ITER_B));
  line('naive-JS column-scan SUM+AVG (NOT a feature)', time(() => void naiveAgg(), ITER_B));

  console.log(`\n(ratio is the point; lower ms/op is faster. Axis A = absurd's job; Axis B = DuckDB's job.)\n`);
}

await main();
