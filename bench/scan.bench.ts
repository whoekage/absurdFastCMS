/**
 * Rough throughput sketch for the columnar store: raw scans, index-accelerated
 * filters, and ORDER BY + pagination. Not rigorous — just order-of-magnitude.
 *
 * Run: npm run bench
 *
 * Slice 10 extends this with the new-operator surface ($in/$ne/$null/$between/$containsi),
 * the cardinality-gate memory proof (a high-card slug column stays CSR/dict — no per-value
 * planes — vs a low-card status column that IS a plane), and the two headline wins from
 * docs/research/filter-datastructures.md: the trigram substring accelerator vs the brute
 * floor (~260x claimed), the selectivity probe vs the bitset-AND combiner, and the
 * warm-at-publish p99.9 tail (interleaved publish+read, with vs without `warmIndexes()`).
 *
 * Everything is driven through the real `Table.insert` / `scan` / `query` — NO mocks. Data is
 * deterministic (a seeded LCG, no Math.random). Numbers are order-of-magnitude, clearly labeled.
 */
import { StringColumn } from '../src/store/column.ts';
import { Table } from '../src/store/table.ts';

const N = 1_000_000;
const STATUSES = ['draft', 'published', 'archived'];

/** Seeded LCG so the data — and thus the bench — is deterministic (no Math.random). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904229) >>> 0;
    return s / 0x100000000;
  };
}

function makeTable(withIndexes: boolean): Table {
  const t = new Table([
    { name: 'price', type: 'f64' },
    { name: 'stock', type: 'i32' },
    { name: 'status', type: 'string' },
    { name: 'active', type: 'bool' },
  ]);
  if (withIndexes) {
    t.createHashIndex('status');
    t.createHashIndex('stock'); // 500 distinct values → ~2000 rows each (selective eq)
    t.createSortedIndex('price');
  }
  for (let i = 0; i < N; i++) {
    t.insert({
      price: (i * 37) % 1000,
      stock: i % 500,
      status: STATUSES[i % 3]!,
      active: (i & 1) === 0,
    });
  }
  return t;
}

function time<T>(fn: () => T, iterations: number): number {
  for (let i = 0; i < 5; i++) fn(); // warmup
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return (performance.now() - start) / iterations;
}

function row(label: string, ms: number, extra = ''): void {
  console.log(`${label.padEnd(42)} ${ms.toFixed(4)} ms/op   ${extra}`);
}

const ITER = 200;

console.log(`\n--- build (${N.toLocaleString()} rows) ---`);
let t0 = performance.now();
const plain = makeTable(false);
console.log(`no indexes:   ${(performance.now() - t0).toFixed(0)} ms`);
t0 = performance.now();
const indexed = makeTable(true);
console.log(`with indexes: ${(performance.now() - t0).toFixed(0)} ms`);

console.log(`\n--- filter: status='published' AND price>=500 AND active ---`);
const filters = [
  { field: 'status', op: 'eq' as const, value: 'published' },
  { field: 'price', op: 'gte' as const, value: 500 },
  { field: 'active', op: 'eq' as const, value: true },
];
row('full scan (no indexes)', time(() => plain.scan(filters).count(), ITER));
row('index-accelerated', time(() => indexed.scan(filters).count(), ITER));

console.log(`\n--- selective filter: stock = 250 (~2000 of 1M rows, 0.2%) ---`);
const selective = [{ field: 'stock', op: 'eq' as const, value: 250 }];
row('full scan (no index)', time(() => plain.scan(selective).count(), ITER));
row('hash index', time(() => indexed.scan(selective).count(), ITER));

console.log(`\n--- ORDER BY price DESC, page (offset/limit) ---`);
// Force the index to build once before timing the walk.
indexed.query({ sort: [{ field: 'price', dir: 'desc' }], limit: 1 });
row(
  'sorted-index walk, page 1 (limit 20)',
  time(() => indexed.query({ sort: [{ field: 'price', dir: 'desc' }], offset: 0, limit: 20 }), ITER),
  'early-terminates',
);
row(
  'sorted-index walk, deep page (offset 500k)',
  time(() => indexed.query({ sort: [{ field: 'price', dir: 'desc' }], offset: 500_000, limit: 20 }), ITER),
);

console.log(`\n--- realistic: published, newest-priced first, page 1 ---`);
row(
  'filter + sort + paginate (indexed)',
  time(
    () =>
      indexed.query({
        filters: [{ field: 'status', op: 'eq', value: 'published' }],
        sort: [{ field: 'price', dir: 'desc' }],
        offset: 0,
        limit: 20,
      }),
    ITER,
  ),
);

// ── Slice 10: new-operator surface ───────────────────────────────────────────
// $in / $ne / $null / $between / $containsi, each timed on the 1M-row indexed table, with the
// matched count printed so the number is anchored to a real result, not an empty scan.
console.log(`\n--- new operators ($in / $ne / $null / $between / $containsi) @ ${N.toLocaleString()} rows ---`);

const inFilter = [{ field: 'stock', op: 'in' as const, value: [10, 20, 30, 40, 50] }]; // ~5 * 2000
row('$in stock {10,20,30,40,50}', time(() => indexed.scan(inFilter).count(), ITER),
  `matched ${indexed.scan(inFilter).count().toLocaleString()}`);

const neFilter = [{ field: 'status', op: 'ne' as const, value: 'draft' }]; // ~2/3 of rows
row('$ne status != draft', time(() => indexed.scan(neFilter).count(), ITER),
  `matched ${indexed.scan(neFilter).count().toLocaleString()}`);

const nullFilter = [{ field: 'status', op: 'null' as const, value: null }]; // none null here
row('$null status (none null)', time(() => indexed.scan(nullFilter).count(), ITER),
  `matched ${indexed.scan(nullFilter).count().toLocaleString()}`);

const betweenFilter = [{ field: 'price', op: 'between' as const, value: [100, 200] as [number, number] }];
row('$between price [100,200]', time(() => indexed.scan(betweenFilter).count(), ITER),
  `matched ${indexed.scan(betweenFilter).count().toLocaleString()}`);

// $containsi over the low-card status dictionary — brute over the deduped dict (D=3), O(n) expand.
const containsiFilter = [{ field: 'status', op: 'containsi' as const, value: 'LISH' }]; // matches 'published'
row('$containsi status ~ "LISH"', time(() => indexed.scan(containsiFilter).count(), ITER),
  `matched ${indexed.scan(containsiFilter).count().toLocaleString()}`);

// ── Slice 10: cardinality-gate memory proof ──────────────────────────────────
// A high-cardinality slug column (slug ≈ n distinct) MUST NOT get a dense plane per value (that is
// ~60 GB OOM); the gate routes it to dict/csr at ~4n bytes (one Int32 code per row). A low-card
// status column (3 distinct) IS the plane tier. We print the chosen strategy and the order-of-
// magnitude index memory: ~4n for the high-card column vs c*ceil(n/32)*4 (planes) for low-card.
console.log(`\n--- cardinality gate: high-card slug stays ~4n (NO per-value planes) ---`);
{
  const gate = new Table([
    { name: 'slug', type: 'string' }, // ≈ n distinct => near-unique => dict (NOT plane)
    { name: 'status', type: 'string' }, // 3 distinct => low-card => plane
  ]);
  gate.createEqIndex('slug');
  gate.createEqIndex('status');
  for (let i = 0; i < N; i++) {
    gate.insert({ slug: `slug-${i}`, status: STATUSES[i % 3]! });
  }
  gate.warmIndexes();

  const slugStrat = gate.eqStrategy('slug');
  const statusStrat = gate.eqStrategy('status');
  // The proof: the high-card column must NOT be on the plane tier (no 500k planes / 60 GB blowup).
  const slugBytes = 4 * N; // the dict-code Int32 per row — the whole equality footprint at this tier.
  const wordsPerPlane = Math.ceil(N / 32);
  const statusPlaneBytes = STATUSES.length * wordsPerPlane * 4; // c dense planes.
  const hypotheticalSlugPlaneBytes = N * wordsPerPlane * 4; // what a plane-per-slug WOULD cost.
  console.log(`slug   strategy = ${slugStrat.padEnd(5)}  ${slugStrat !== 'plane' ? 'OK — no per-value planes' : 'FAIL — planes!'}`);
  console.log(`status strategy = ${statusStrat.padEnd(5)}  ${statusStrat === 'plane' ? 'OK — low-card plane tier' : 'unexpected'}`);
  console.log(`slug   index mem  ~ ${(slugBytes / 1e6).toFixed(1)} MB  (≈4n, one Int32 code/row)`);
  console.log(`status plane mem  ~ ${(statusPlaneBytes / 1e6).toFixed(1)} MB  (${STATUSES.length} planes)`);
  console.log(`slug-as-planes WOULD cost ~ ${(hypotheticalSlugPlaneBytes / 1e9).toFixed(1)} GB  (the OOM the gate avoids)`);
  if (slugStrat === 'plane') throw new Error('cardinality gate FAILED: slug column materialized planes');
}

// ── Slice 10 / HEADLINE WIN 1: trigram substring accelerator vs brute floor ──
// A large-distinct contains-heavy string column. Time a selective ≥3-char $contains with the
// SubstringIndex ENABLED (intersect rarest postings + verify) vs DISABLED (the brute dictionary
// `includes()` floor). Research claimed ~260x; we print the measured speedup and confirm the
// match counts are IDENTICAL (the accelerator is a pure speed win, byte-identical rows).
console.log(`\n--- HEADLINE WIN 1: trigram $contains accelerator vs brute floor ---`);
{
  const DISTINCT = 300_000; // large-distinct: a contains-heavy column where the dict ≈ N rows.
  const rng = lcg(0xC0FFEE);
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
  const distinctVals: string[] = [];
  for (let i = 0; i < DISTINCT; i++) {
    const a = words[(rng() * words.length) | 0]!;
    const b = words[(rng() * words.length) | 0]!;
    distinctVals.push(`${a}-${i}-${b}-${(rng() * 99999) | 0}`);
  }

  function buildContainsTable(accel: boolean): Table {
    const t = new Table([{ name: 's', type: 'string' }]);
    if (accel) t.enableSubstringIndex('s');
    for (let i = 0; i < DISTINCT; i++) t.insert({ s: distinctVals[i]! });
    return t;
  }
  const accelT = buildContainsTable(true);
  const bruteT = buildContainsTable(false);

  // A SELECTIVE needle (≥3 chars) drawn from real data so its trigrams all exist and the path
  // fires. We use a long tail slice (the "-<id>-<word>-<num>" suffix) so it matches just a handful
  // of rows — selectivity is what lets the trigram intersection beat the O(D) brute dict scan; a
  // short non-selective needle is row-expansion-bound and shows a smaller win.
  const sample = distinctVals[(DISTINCT / 2) | 0]!;
  const needle = sample.slice(sample.indexOf('-')); // e.g. "-150000-echo-4271" — highly selective.

  // Build both indexes once before timing (accel builds lazily on first query; this is on-publish).
  const accelCount = accelT.scan([{ field: 's', op: 'contains', value: needle }]).count();
  const bruteCount = bruteT.scan([{ field: 's', op: 'contains', value: needle }]).count();

  const accelMs = time(() => accelT.scan([{ field: 's', op: 'contains', value: needle }]).count(), 50);
  const bruteMs = time(() => bruteT.scan([{ field: 's', op: 'contains', value: needle }]).count(), 50);
  const col = accelT.column('s') as StringColumn;
  console.log(`distinct values = ${DISTINCT.toLocaleString()}  needle = ${JSON.stringify(needle)}  matched = ${accelCount.toLocaleString()}`);
  row('brute floor ($contains, accel OFF)', bruteMs);
  row('trigram accelerated (accel ON)', accelMs, `accel fired ${col.substringAccelHits}x`);
  console.log(`speedup ~ ${(bruteMs / accelMs).toFixed(0)}x   (research claimed ~260x — order-of-magnitude sketch)`);
  if (accelCount !== bruteCount) throw new Error(`accel/brute count mismatch: ${accelCount} vs ${bruteCount}`);
  console.log(`match counts identical: ${accelCount} === ${bruteCount}  OK`);
}

// ── Slice 10 / HEADLINE WIN 2: selectivity probe vs bitset-AND ───────────────
// A selective-lead multi-predicate AND: a tiny eq lead (stock=250 ≈ 0.2%) plus residual range/eq
// predicates. With probeEnabled the engine iterates the tiny lead and probes residuals against raw
// TypedArrays; with it off, every leaf builds a full bitset and AND-combines word-wise. Same result,
// the probe just skips the residual bitset builds. We print the speedup and confirm identical rows.
console.log(`\n--- HEADLINE WIN 2: selectivity probe vs bitset-AND combiner ---`);
{
  indexed.warmIndexes(); // ensure no rebuild lands inside the timed loop and counts are available.
  const andFilters = [
    { field: 'stock', op: 'eq' as const, value: 250 }, // tiny lead ~0.2%
    { field: 'price', op: 'gte' as const, value: 100 }, // residual range
    { field: 'active', op: 'eq' as const, value: true }, // residual eq
  ];

  indexed.probeEnabled = true;
  indexed.probeHits = 0;
  const probeRows = indexed.scan(andFilters).toArray();
  const probeFired = indexed.probeHits > 0;
  const probeMs = time(() => indexed.scan(andFilters).count(), ITER);

  indexed.probeEnabled = false;
  const bitsetRows = indexed.scan(andFilters).toArray();
  const bitsetMs = time(() => indexed.scan(andFilters).count(), ITER);
  indexed.probeEnabled = true;

  row('bitset-AND combiner (probe OFF)', bitsetMs, `matched ${bitsetRows.length}`);
  row('selectivity probe (probe ON)', probeMs, `probe fired: ${probeFired}`);
  console.log(`speedup ~ ${(bitsetMs / probeMs).toFixed(1)}x   (skips residual bitset builds + word-wise AND)`);
  const same = probeRows.length === bitsetRows.length && probeRows.every((r, i) => r === bitsetRows[i]);
  if (!same) throw new Error('probe vs bitset row mismatch');
  console.log(`identical results: ${same}  OK`);
}

// ── Slice 10 / WARM-AT-PUBLISH p99.9 ─────────────────────────────────────────
// An interleaved publish+read loop. Without warmIndexes(), the FIRST read after a publish batch
// pays the O(n log n) sorted-index rebuild (a p99.9 spike). With Table.warmIndexes() at end-of-batch
// the rebuild happens off the reader's critical path, so the spike disappears. We report p50 and
// p99.9 for both and show warmIndexes flattens the tail. (No sampling — every read is timed.)
console.log(`\n--- WARM-AT-PUBLISH: p99.9 read latency, interleaved publish+read ---`);
{
  const BATCH = 5_000; // rows appended per publish batch
  const BATCHES = 60; // publish batches
  const READS_PER_BATCH = 20; // reads after each batch (the first pays the rebuild if cold)

  function pct(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx]!;
  }

  function runInterleaved(warm: boolean): { p50: number; p999: number; max: number } {
    const t = new Table([
      { name: 'price', type: 'f64' },
      { name: 'status', type: 'string' },
    ]);
    t.createSortedIndex('price');
    t.createHashIndex('status');
    const rng = lcg(0xBEEF);
    const reads: number[] = [];
    let next = 0;
    for (let b = 0; b < BATCHES; b++) {
      for (let i = 0; i < BATCH; i++) {
        t.insert({ price: (rng() * 100000) | 0, status: STATUSES[next++ % 3]! });
      }
      // Warm-at-publish: pay the rebuild here, OFF the reader's critical path.
      if (warm) t.warmIndexes();
      for (let r = 0; r < READS_PER_BATCH; r++) {
        const start = performance.now();
        // A read that consults the sorted index (range filter) — the first read after a cold batch
        // triggers the O(n log n) rebuild if not already warmed.
        t.query({ filters: [{ field: 'price', op: 'gte', value: 50000 }], limit: 20 });
        reads.push(performance.now() - start);
      }
    }
    reads.sort((a, b) => a - b);
    return { p50: pct(reads, 50), p999: pct(reads, 99.9), max: reads[reads.length - 1]! };
  }

  const cold = runInterleaved(false);
  const hot = runInterleaved(true);
  console.log(`COLD (no warmIndexes): p50 ${cold.p50.toFixed(4)} ms   p99.9 ${cold.p999.toFixed(2)} ms   max ${cold.max.toFixed(2)} ms`);
  console.log(`WARM (warmIndexes):    p50 ${hot.p50.toFixed(4)} ms   p99.9 ${hot.p999.toFixed(4)} ms   max ${hot.max.toFixed(4)} ms`);
  console.log(`tail flattened: p99.9 ${cold.p999.toFixed(2)} ms -> ${hot.p999.toFixed(4)} ms  (~${(cold.p999 / Math.max(hot.p999, 1e-6)).toFixed(0)}x lower with warm-at-publish)`);
}

console.log('');
