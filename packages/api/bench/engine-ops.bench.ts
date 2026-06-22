/**
 * ENGINE OPERATOR BASELINE — load N rows (millions to tens of millions) into the in-memory engine across
 * EVERY column type, then benchmark every operator class (point lookup, equality, set, range, substring,
 * affix, case-insensitive, boolean, decimal/i64, null, compound, sort, deep-offset pagination, full
 * serialize) over INDEXED and BRUTE paths, reporting the full latency distribution (p50/p90/p99/p999/max)
 * + memory. The RESPONSE CACHE IS DISABLED so every number is the RAW compute path (filter + scan +
 * serialize) — the surface a refactor would change — not a warm cache Map.get.
 *
 * This is a REFACTORING BASELINE: run it before and after an engine change and diff the numbers.
 *
 * Run (default 10M rows; --expose-gc for clean memory):
 *   node --expose-gc bench/engine-ops.bench.ts
 * Override the row count (tens of millions need RAM — ~0.5 GB per million here):
 *   BENCH_N=20000000 node --expose-gc bench/engine-ops.bench.ts
 *
 * NO Math.random / Date.now (determinism): a seeded LCG drives the generator; the build wall-clock is
 * measured via performance.now (allowed). Honest: one machine, one run, single-threaded.
 */
import { Engine } from '../src/store/engine.ts';
import type { FieldDef } from '../src/store/table.ts';

const N = Number(process.env.BENCH_N ?? 10_000_000);
const STATUSES = ['draft', 'published', 'archived'];
const CATEGORIES = Array.from({ length: 500 }, (_, i) => `category-${i}`);

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A schema spanning EVERY engine ColumnType, with a realistic index plan. */
const FIELDS: FieldDef[] = [
  { name: 'id', type: 'i32' },
  { name: 'status', type: 'string' }, // low-card dict (3) — eq-indexed
  { name: 'category', type: 'string' }, // mid-card dict (500) — eq-indexed
  { name: 'title', type: 'string' }, // HIGH-card dict (near-unique) — off-heap interner; contains/affix/sort
  { name: 'body', type: 'text' }, // arena — contains over the arena
  { name: 'views', type: 'i32' }, // sorted-indexed — range + sort
  { name: 'rating', type: 'f64' }, // brute range
  { name: 'active', type: 'bool' },
  { name: 'price', type: 'decimal', scale: 2, precision: 12 }, // i64-backed fixed-point range
  { name: 'bigid', type: 'i64' }, // exact 64-bit range
  { name: 'created_at', type: 'date' }, // sorted-indexed — date range + sort
  { name: 'meta', type: 'json' }, // stored verbatim, not filterable
];

function mb(b: number): string {
  return (b / 1024 / 1024).toFixed(0) + ' MB';
}

function pctl(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

interface Stat { label: string; p50: number; p90: number; p99: number; p999: number; max: number; mean: number; n: number; bytes: number; }
const stats: Stat[] = [];

/**
 * Time-budgeted measurement: warm `warm` times, then sample until `maxIters` OR `budgetMs` elapsed
 * (whichever first), so a cheap indexed op gets thousands of samples and an O(N) brute scan a few dozen
 * — both with a stable distribution. `fn` returns the response Buffer (so we also record the envelope size).
 */
function measure(label: string, fn: () => Buffer | null, warm = 10, maxIters = 3000, budgetMs = 1500): void {
  for (let i = 0; i < warm; i++) fn();
  const samples: number[] = [];
  let bytes = 0;
  const start = performance.now();
  let it = 0;
  for (; it < maxIters; it++) {
    const t0 = performance.now();
    const buf = fn();
    const dt = performance.now() - t0;
    samples.push(dt);
    if (buf !== null) bytes = buf.length;
    if (performance.now() - start > budgetMs) { it++; break; }
  }
  const s = samples.sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  stats.push({ label, p50: pctl(s, 50), p90: pctl(s, 90), p99: pctl(s, 99), p999: pctl(s, 99.9), max: s[s.length - 1]!, mean, n: it, bytes });
}

async function main(): Promise<void> {
  console.log(`\n================ ENGINE OPERATOR BASELINE — ${N.toLocaleString()} rows, response cache DISABLED ================`);

  // ── BUILD ───────────────────────────────────────────────────────────────────────────────────
  const engine = new Engine({ cache: { enabled: false } });
  const t = engine.define('article', FIELDS);
  // RESOLVED (be-22b): the EqIndex value->code intern is now OFF-HEAP (value-interner.ts) — the unique
  // primary key `id` no longer overflows the V8 Map. `createEqIndex('id')` builds at 10M (it used to THROW
  // a RangeError at >~8.4M / 2^23 effective, the old `new Map<unknown,number>()` ceiling — see the prior
  // baseline's Finding A). i32 `id` 1..N hits the dense direct-address fast path: code = value - min, an
  // O(1) point lookup. The sorted index stays for ordered range/between scans on id.
  t.createEqIndex('id');
  t.createSortedIndex('id');
  t.createEqIndex('status'); // low-card (3) — fine
  t.createEqIndex('category'); // mid-card (500) — fine
  t.createSortedIndex('views');
  t.createSortedIndex('created_at');
  // title is NOT eq-indexed on purpose (same ceiling); it serves contains/affix via the off-heap
  // dictionary + the opt-in trigram accelerator. It DOES get a sorted index (be-22c): the dict-rank
  // StringSortedIndex makes ORDER BY title fast (Finding #5 was 2169 ms via the brute comparator).
  t.createSortedIndex('title');

  const rng = lcg(1);
  const base = Date.UTC(2020, 0, 1);
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const frac = ((rng() * 100) | 0).toString().padStart(2, '0');
    engine.insert('article', {
      id: i + 1,
      status: STATUSES[(rng() * 3) | 0]!,
      category: CATEGORIES[(rng() * CATEGORIES.length) | 0]!,
      title: rng() < 0.08 ? null : `Article ${i} about ${(rng() * 9000) | 0} topic ${(rng() * 9000) | 0}`,
      body: `Body ${i}: lorem ipsum dolor sit amet consectetur ${(rng() * 100000) | 0} adipiscing elit sed do`,
      views: rng() < 0.05 ? null : (rng() * 1_000_000) | 0,
      rating: rng() < 0.05 ? null : Math.round(rng() * 500) / 100,
      active: rng() < 0.5,
      price: `${(rng() * 100000) | 0}.${frac}`,
      bigid: BigInt(Math.floor(rng() * 9_000_000_000_000)),
      created_at: base + ((rng() * 157_000_000_000) | 0),
      meta: { src: 'bench', n: i, tag: CATEGORIES[(rng() * 10) | 0] },
    });
  }
  t.warmIndexes();
  const buildMs = performance.now() - t0;

  if (typeof globalThis.gc === 'function') globalThis.gc();
  const mem = process.memoryUsage();
  console.log(`build: ${(buildMs / 1000).toFixed(1)}s (${Math.round(N / (buildMs / 1000)).toLocaleString()} rows/s)`);
  console.log(`memory: rss ${mb(mem.rss)} | arrayBuffers ${mb(mem.arrayBuffers)} | external ${mb(mem.external)} | heapUsed ${mb(mem.heapUsed)}`);
  console.log(`        => ${(mem.rss / N).toFixed(0)} bytes/row RSS\n`);

  const page = (filters: { field: string; op: any; value: unknown }[], sort?: { field: string; dir: any }[], offset = 0, limit = 25) =>
    engine.respond('article', { filters: filters as any, sort: sort as any, offset, limit });

  // ── POINT LOOKUP by id (off-heap EqIndex dense direct-address — was sorted-index/brute, see RESOLVED) ──
  let idTick = 0;
  measure('point lookup id=X    [eq-index, dense-int]', () => page([{ field: 'id', op: 'eq', value: ((idTick++ * 7919) % N) + 1 }], undefined, 0, 1));

  // ── EQUALITY / SET ──────────────────────────────────────────────────────────────────────────
  measure('eq status=published  [eq-index, low-card]', () => page([{ field: 'status', op: 'eq', value: 'published' }]));
  measure('eq category=<one>    [eq-index, mid-card]', () => page([{ field: 'category', op: 'eq', value: 'category-42' }]));
  measure('ne status!=draft     [low-card]', () => page([{ field: 'status', op: 'ne', value: 'draft' }]));
  measure('in status IN(2)      [eq-index]', () => page([{ field: 'status', op: 'in', value: ['draft', 'published'] }]));
  measure('notIn category(3)', () => page([{ field: 'category', op: 'notIn', value: ['category-1', 'category-2', 'category-3'] }]));
  measure('eqi status (folded)', () => page([{ field: 'status', op: 'eqi', value: 'PUBLISHED' }]));

  // ── NUMERIC / TEMPORAL RANGE ────────────────────────────────────────────────────────────────
  measure('views > 500k        [sorted-index]', () => page([{ field: 'views', op: 'gt', value: 500_000 }]));
  measure('views BETWEEN       [sorted-index]', () => page([{ field: 'views', op: 'between', value: [200_000, 800_000] }]));
  measure('created_at BETWEEN  [sorted-index, date]', () => page([{ field: 'created_at', op: 'between', value: [base, base + 78_000_000_000] }]));
  measure('rating > 2.5        [f64 brute]', () => page([{ field: 'rating', op: 'gt', value: 2.5 }]));
  measure('price BETWEEN       [decimal brute]', () => page([{ field: 'price', op: 'between', value: ['100.00', '50000.00'] }]));
  // i64 filter value passed as a STRING (the wire/parser form; coerceI64 accepts digit strings). A raw
  // bigint here would crash the cache-key builder (response.cache.ts encodeValue -> JSON.stringify chokes
  // on BigInt) — a latent fragility worth a 1-line hardening even though the cache is disabled (queryKey
  // is still computed before the disabled get).
  measure('bigid > mid         [i64 brute]', () => page([{ field: 'bigid', op: 'gt', value: '4500000000000' }]));
  measure('active = true       [bool]', () => page([{ field: 'active', op: 'eq', value: true }]));

  // ── NULL ────────────────────────────────────────────────────────────────────────────────────
  measure('title IS NULL', () => page([{ field: 'title', op: 'null', value: null }]));
  measure('title IS NOT NULL', () => page([{ field: 'title', op: 'notNull', value: null }]));

  // ── SUBSTRING / AFFIX — BRUTE (no trigram index yet) ────────────────────────────────────────
  measure('title contains  [dict brute]', () => page([{ field: 'title', op: 'contains', value: 'topic 42' }]));
  measure('title startsWith [dict brute]', () => page([{ field: 'title', op: 'startsWith', value: 'Article 1' }]));
  measure('title containsi [folded brute]', () => page([{ field: 'title', op: 'containsi', value: 'TOPIC 42' }]));
  measure('body contains   [arena brute]', () => page([{ field: 'body', op: 'contains', value: 'ipsum dolor' }]));

  // ── COMPOUND (implicit AND) ─────────────────────────────────────────────────────────────────
  measure('status=published AND views>500k', () => page([{ field: 'status', op: 'eq', value: 'published' }, { field: 'views', op: 'gt', value: 500_000 }]));
  measure('status=published AND title contains', () => page([{ field: 'status', op: 'eq', value: 'published' }, { field: 'title', op: 'contains', value: 'topic 7' }]));

  // ── SORT + PAGINATION ───────────────────────────────────────────────────────────────────────
  measure('page: status=pub ORDER BY views DESC LIMIT 25', () => page([{ field: 'status', op: 'eq', value: 'published' }], [{ field: 'views', dir: 'desc' }]));
  measure('page: ORDER BY created_at DESC LIMIT 25', () => page([], [{ field: 'created_at', dir: 'desc' }]));
  measure('deep offset: ORDER BY views DESC OFFSET 100k LIMIT 25', () => page([], [{ field: 'views', dir: 'desc' }], 100_000, 25));
  measure('full serialize: ORDER BY views DESC LIMIT 100', () => page([], [{ field: 'views', dir: 'desc' }], 0, 100));
  // string sort — may be unsupported (createSortedIndex rejects strings); record the outcome either way.
  try {
    measure('page: ORDER BY title ASC LIMIT 25  [string sort]', () => page([], [{ field: 'title', dir: 'asc' }]));
  } catch (e) {
    console.log(`  [string sort] ORDER BY title -> NOT SUPPORTED: ${(e as Error).message}`);
  }

  // ── SUBSTRING — TRIGRAM ACCELERATED (opt-in index) ──────────────────────────────────────────
  t.enableSubstringIndex('title');
  t.enableSubstringIndex('body');
  // trigger lazy build + warm
  page([{ field: 'title', op: 'contains', value: 'topic 42' }]);
  page([{ field: 'body', op: 'contains', value: 'ipsum dolor' }]);
  measure('title contains  [TRIGRAM]', () => page([{ field: 'title', op: 'contains', value: 'topic 42' }]));
  measure('body contains   [TRIGRAM arena]', () => page([{ field: 'body', op: 'contains', value: 'ipsum dolor' }]));

  // ── REPORT ──────────────────────────────────────────────────────────────────────────────────
  const fmt = (x: number) => x.toFixed(4).padStart(9);
  console.log(`operation                                          p50       p90       p99      p999       max      mean   samples  envelope`);
  console.log('-'.repeat(132));
  for (const s of stats) {
    console.log(`${s.label.padEnd(48)} ${fmt(s.p50)} ${fmt(s.p90)} ${fmt(s.p99)} ${fmt(s.p999)} ${fmt(s.max)} ${fmt(s.mean)}   ${String(s.n).padStart(6)}  ${(s.bytes / 1024).toFixed(1)}KB`);
  }
  console.log('-'.repeat(132));
  console.log('(all times in ms; response cache DISABLED — raw compute. envelope = serialized {data,meta} bytes of the last call.)');
  console.log('\nFINDINGS:');
  console.log(`  * RESOLVED (be-22b): the EqIndex value->code intern is now OFF-HEAP — createEqIndex('id') BUILDS at ${N.toLocaleString()} rows`);
  console.log(`    (it used to THROW a RangeError at >~8.4M / 2^23, the old new Map ceiling). The unique i32 id hits the dense`);
  console.log(`    direct-address fast path (code = value - min) — point lookup is O(1), no Map, off the object heap.`);
  console.log(`  * The off-heap string dictionary (be-22) carries the high-card 'title' column at ${N.toLocaleString()} rows with no Map ceiling.\n`);
}

await main();
