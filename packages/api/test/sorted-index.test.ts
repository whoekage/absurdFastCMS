import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef } from '../src/store/table.ts';
import { SortedIndex } from '../src/store/indexes/sorted.index.ts';
import { NumericColumn } from '../src/store/column.ts';

/**
 * Slice 5 — sorted-index hardening tests. No mocks: everything drives the real
 * Table/columns/indexes, and every expectation is a brute-force O(n) ORACLE over the inserted
 * rows (matching test/index.test.ts style). Pseudo-data is a deterministic seeded LCG.
 */

// Deterministic LCG (Numerical Recipes constants) so the "randomized" data is reproducible.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const FIELDS: FieldDef[] = [
  { name: 'price', type: 'f64' },
  { name: 'stock', type: 'i32' },
  { name: 'status', type: 'string' },
  { name: 'active', type: 'bool' },
];

const STATUSES = ['draft', 'published', 'archived'];

function build(n: number, withIndexes: boolean): Table {
  const t = new Table(FIELDS);
  if (withIndexes) {
    t.createHashIndex('status');
    t.createSortedIndex('price');
    t.createSortedIndex('stock');
  }
  for (let i = 0; i < n; i++) {
    t.insert({
      price: (i * 37) % 1000,
      stock: i % 500,
      status: STATUSES[i % 3]!,
      active: (i & 1) === 0,
    });
  }
  return t;
}

// --- $between equivalence vs brute force ------------------------------------------------------

test('$between (i32 stock) equals brute force over a grid of bounds, indexed == unindexed', () => {
  const N = 2000;
  const plain = build(N, false);
  const indexed = build(N, true);
  // Grid covers normal ranges, single-point (lo==hi), empty interior, reversed (lo>hi => empty),
  // and ranges spilling past the value domain.
  const bounds: [number, number][] = [
    [0, 0], [0, 499], [10, 10], [100, 200], [499, 499], [250, 250],
    [200, 100], [600, 100], [-5, 5], [495, 600], [0, 1000], [1000, 2000],
  ];
  for (const [lo, hi] of bounds) {
    const oracle: number[] = [];
    for (let r = 0; r < N; r++) {
      const x = indexed.column('stock').at(r) as number;
      if (x >= lo && x <= hi) oracle.push(r);
    }
    const a = plain.scan([{ field: 'stock', op: 'between', value: [lo, hi] }]).toArray();
    const b = indexed.scan([{ field: 'stock', op: 'between', value: [lo, hi] }]).toArray();
    assert.deepEqual(a, oracle, `unindexed stock between [${lo},${hi}]`);
    assert.deepEqual(b, oracle, `indexed stock between [${lo},${hi}]`);
  }
});

test('$between (f64 price) equals brute force, indexed == unindexed', () => {
  const N = 2000;
  const plain = build(N, false);
  const indexed = build(N, true);
  const bounds: [number, number][] = [
    [0, 0], [0, 999], [37, 37], [100.5, 500.25], [999, 999],
    [500, 100], [-10, -1], [950, 2000], [0, 1000],
  ];
  for (const [lo, hi] of bounds) {
    const oracle: number[] = [];
    for (let r = 0; r < N; r++) {
      const x = indexed.column('price').at(r) as number;
      if (x >= lo && x <= hi) oracle.push(r);
    }
    const a = plain.scan([{ field: 'price', op: 'between', value: [lo, hi] }]).toArray();
    const b = indexed.scan([{ field: 'price', op: 'between', value: [lo, hi] }]).toArray();
    assert.deepEqual(a, oracle, `unindexed price between [${lo},${hi}]`);
    assert.deepEqual(b, oracle, `indexed price between [${lo},${hi}]`);
  }
});

test('$between reversed bounds (lo > hi) is empty; single point (lo == hi) is equality', () => {
  const t = build(500, true);
  assert.equal(t.scan([{ field: 'stock', op: 'between', value: [300, 100] }]).count(), 0);
  // Single point equals an $eq scan.
  const eq = t.scan([{ field: 'stock', op: 'eq', value: 123 }]).toArray();
  const point = t.scan([{ field: 'stock', op: 'between', value: [123, 123] }]).toArray();
  assert.deepEqual(point, eq);
});

test('$between excludes NULL rows (three-valued logic at the Table boundary)', () => {
  const t = new Table(FIELDS);
  t.createSortedIndex('stock');
  const rng = lcg(7);
  const N = 600;
  const vals: (number | null)[] = [];
  for (let i = 0; i < N; i++) {
    // ~25% NULLs; a NULL carries the dense sentinel 0 which a naive scan of [0,hi] would match.
    const isNull = rng() < 0.25;
    const v = isNull ? null : Math.floor(rng() * 100);
    vals.push(v);
    t.insert({ price: 0, stock: v, status: 'x', active: true });
  }
  t.warmIndexes();
  const bounds: [number, number][] = [[0, 0], [0, 50], [0, 99], [25, 75]];
  for (const [lo, hi] of bounds) {
    const oracle: number[] = [];
    for (let r = 0; r < N; r++) {
      const v = vals[r];
      if (v !== null && v >= lo && v <= hi) oracle.push(r);
    }
    const got = t.scan([{ field: 'stock', op: 'between', value: [lo, hi] }]).toArray();
    assert.deepEqual(got, oracle, `between [${lo},${hi}] with nulls`);
  }
});

// --- Radix-sorted index equivalence to the previous comparator sort ---------------------------

// A reference "previous" sort: stable comparator over the real values (what order[].sort() did).
function comparatorOrder(vals: number[]): number[] {
  const order = vals.map((_, i) => i);
  order.sort((a, b) => vals[a]! - vals[b]! || a - b);
  return order;
}

function sortedRowsViaIndex(type: 'i32' | 'f64', vals: number[]): number[] {
  const col = new NumericColumn(type);
  for (const v of vals) col.push(v);
  const idx = new SortedIndex();
  const out: number[] = [];
  idx.ensureBuilt(col, vals.length);
  idx.forEachOrdered('asc', (r) => {
    out.push(r);
    return true;
  });
  return out;
}

test('radix sort (i32) returns the same ordered rows as the comparator sort', () => {
  const rng = lcg(101);
  const N = 5000;
  const vals: number[] = [];
  for (let i = 0; i < N; i++) {
    // Negatives, zero, positives, with deliberate duplicates to exercise stable tie-break.
    vals.push((Math.floor(rng() * 2000) - 1000));
  }
  const viaIndex = sortedRowsViaIndex('i32', vals);
  const viaComparator = comparatorOrder(vals);
  // Values must be identically ordered. (Row ids for equal values match because both are stable.)
  const keyIndex = viaIndex.map((r) => vals[r]!);
  const keyComparator = viaComparator.map((r) => vals[r]!);
  assert.deepEqual(keyIndex, keyComparator);
  assert.deepEqual(viaIndex, viaComparator);
});

test('radix sort (f64) returns the same ordered rows as the comparator sort, incl. -0.0/fractions', () => {
  const rng = lcg(202);
  const N = 5000;
  const vals: number[] = [];
  for (let i = 0; i < N; i++) {
    const pick = rng();
    if (pick < 0.05) vals.push(-0.0);
    else if (pick < 0.1) vals.push(0.0);
    else vals.push((rng() * 2000 - 1000) + (rng() < 0.5 ? 0.25 : -0.75));
  }
  const viaIndex = sortedRowsViaIndex('f64', vals);
  const viaComparator = comparatorOrder(vals);
  // -0.0 and +0.0 are order-EQUIVALENT (both compare equal under `<`), so a -0 row and a +0 row
  // may legitimately swap stable positions between the two sort engines. Normalize -0 -> +0
  // (add 0) before comparing the ordered VALUE sequences: equality here means "same total order
  // on the real values", which is exactly the equivalence the radix replacement must preserve.
  const keyIndex = viaIndex.map((r) => vals[r]! + 0);
  const keyComparator = viaComparator.map((r) => vals[r]! + 0);
  assert.deepEqual(keyIndex, keyComparator);
  // The values are globally non-decreasing.
  for (let i = 1; i < keyIndex.length; i++) assert.ok(keyIndex[i]! >= keyIndex[i - 1]!);
});

test('radix-sorted index ORDER BY + range results match a plain (unindexed) table', () => {
  const rng = lcg(303);
  const N = 3000;
  const t = new Table([{ name: 'v', type: 'f64' }]);
  const plain = new Table([{ name: 'v', type: 'f64' }]);
  t.createSortedIndex('v');
  const vals: number[] = [];
  for (let i = 0; i < N; i++) {
    const v = rng() * 4000 - 2000 + (rng() < 0.5 ? 0.5 : 0);
    vals.push(v);
    t.insert({ v });
    plain.insert({ v });
  }
  // ORDER BY asc/desc, paginated, equals sorting the brute-force list.
  for (const dir of ['asc', 'desc'] as const) {
    const got = t.query({ sort: [{ field: 'v', dir }], offset: 17, limit: 40 });
    const oracle = vals.map((_, i) => i);
    oracle.sort((a, b) => (dir === 'asc' ? vals[a]! - vals[b]! : vals[b]! - vals[a]!) || a - b);
    // Compare by value sequence (ties among equal values may pick a different stable row id
    // between the two sort engines, but the visible ordered VALUES must be identical).
    assert.deepEqual(got.map((r) => vals[r]!), oracle.slice(17, 57).map((r) => vals[r]!), `order ${dir}`);
  }
  // A range filter must equal the unindexed scan exactly (row ids, not just values).
  for (const [op, value] of [['gt', 0], ['gte', -500], ['lt', 1000], ['lte', 250]] as const) {
    const a = t.scan([{ field: 'v', op, value }]).toArray();
    const b = plain.scan([{ field: 'v', op, value }]).toArray();
    assert.deepEqual(a, b, `range ${op} ${value}`);
  }
});

// --- Selectivity-guard fallback ---------------------------------------------------------------

test('wide range: a >50% range returns identical rows via the indexed slice path', () => {
  // stock is i % 500, so a wide $between matches almost every row (>50%). The sorted-indexed
  // column ALWAYS takes the two-bound slice now (the old >50% scan guard was removed once the
  // slice was measured faster at every selectivity); assert it still equals both the unindexed
  // scan and the brute oracle, row id for row id.
  const N = 4000;
  const plain = build(N, false);
  const indexed = build(N, true);
  const wide: [string, number | [number, number]][] = [
    ['between', [0, 499]], // matches all => guard fires
    ['between', [10, 480]], // > 50%
    ['gte', 1], // nearly all
    ['lt', 480], // most rows
  ];
  for (const [op, value] of wide) {
    const oracle: number[] = [];
    for (let r = 0; r < N; r++) {
      const x = indexed.column('stock').at(r) as number;
      let hit = false;
      if (op === 'between') { const [lo, hi] = value as [number, number]; hit = x >= lo && x <= hi; }
      else if (op === 'gte') hit = x >= (value as number);
      else if (op === 'lt') hit = x < (value as number);
      if (hit) oracle.push(r);
    }
    const a = plain.scan([{ field: 'stock', op: op as 'between' | 'gte' | 'lt', value }]).toArray();
    const b = indexed.scan([{ field: 'stock', op: op as 'between' | 'gte' | 'lt', value }]).toArray();
    assert.deepEqual(a, oracle, `unindexed ${op} ${JSON.stringify(value)}`);
    assert.deepEqual(b, oracle, `indexed-guard ${op} ${JSON.stringify(value)}`);
    assert.deepEqual(b, a, `guard path == scan path for ${op}`);
  }
});

// --- IDENTICAL rows + ORDER through query() across every shape (the cardinal invariant) -------

// After dropping the >50% scan guard a sorted-indexed column ALWAYS slices; the produced row SET
// goes through the SAME query() order logic as the unindexed scan, so the visible rows+order must
// be byte-identical in every shape. The unindexed table is the oracle. We assert on row ids where
// the order is fully determined (no sort = ascending row-id; sort by the SAME col uses the index
// walk which is total here because values are distinct), and on VALUES where a sort by ANOTHER
// column has value ties whose stable tiebreak may differ between the two engines.
test('range/between return identical rows+order via query() WITH/WITHOUT sort, same/other col, NULLs', () => {
  const N = 6000;
  // Distinct, non-monotonic key so the slice is scattered in row-id space (the real defect shape),
  // a second sort column with ties, and a NULL every 997th row to exercise excludeNulls after fill.
  const rng = lcg(7);
  const perm: number[] = [];
  for (let i = 0; i < N; i++) perm.push(i);
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [perm[i], perm[j]] = [perm[j]!, perm[i]!]; }
  const FIELDS2: FieldDef[] = [{ name: 'k', type: 'i32' }, { name: 'g', type: 'i32' }];
  const indexed = new Table(FIELDS2);
  const plain = new Table(FIELDS2);
  indexed.createSortedIndex('k');
  const nullRows = new Set<number>(); // track null rows explicitly: an i32 null reads back as sentinel 0
  for (let i = 0; i < N; i++) {
    const isNull = i % 997 === 0;
    if (isNull) nullRows.add(i);
    const row = { k: isNull ? null : perm[i]!, g: i % 50 };
    indexed.insert(row);
    plain.insert(row);
  }
  indexed.warmIndexes();

  type Spec = { op: 'between' | 'gt' | 'gte' | 'lt' | 'lte'; value: number | [number, number] };
  const specs: Spec[] = [
    { op: 'between', value: [1000, 1010] },  // narrow
    { op: 'between', value: [10, 5800] },     // wide
    { op: 'between', value: [-100, 9999] },   // full
    { op: 'between', value: [42, 42] },       // single point (inclusive both ends)
    { op: 'between', value: [3000, 100] },    // reversed -> empty
    { op: 'gt', value: 5000 },
    { op: 'gte', value: 5000 },
    { op: 'lt', value: 800 },
    { op: 'lte', value: 800 },
  ];
  // Every order shape the mandate names: no sort (default row-id), sort SAME col asc/desc(+offset),
  // sort OTHER col asc/desc, with and without a limit/offset.
  const queryShapes = [
    { name: 'no-sort default' },
    { name: 'no-sort offset+limit', offset: 13, limit: 40 },
    { name: 'no-sort no-limit', limit: undefined },
    { name: 'sort k asc', sort: [{ field: 'k', dir: 'asc' as const }] },
    { name: 'sort k desc', sort: [{ field: 'k', dir: 'desc' as const }] },
    { name: 'sort k desc offset', sort: [{ field: 'k', dir: 'desc' as const }], offset: 7, limit: 25 },
    { name: 'sort g asc', sort: [{ field: 'g', dir: 'asc' as const }] },
    { name: 'sort g desc', sort: [{ field: 'g', dir: 'desc' as const }] },
  ];
  const kVal = (t: Table, r: number): number | null => t.column('k').at(r) as number | null;
  for (const spec of specs) {
    for (const shape of queryShapes) {
      const filters = [{ field: 'k', op: spec.op, value: spec.value }];
      const opts = { filters, sort: shape.sort, offset: shape.offset, limit: shape.limit };
      const a = indexed.query(opts);
      const b = plain.query(opts);
      const label = `${spec.op} ${JSON.stringify(spec.value)} | ${shape.name}`;
      // A sort by the OTHER column has value ties; assert on the visible VALUES (k then g), which
      // must be identical even if a tie's stable row pick differs. Everywhere else the order is
      // fully determined, so assert on row ids exactly.
      if (shape.sort?.[0]?.field === 'g') {
        assert.deepEqual(a.map((r) => [kVal(indexed, r), indexed.column('g').at(r)]),
          b.map((r) => [kVal(plain, r), plain.column('g').at(r)]), `values ${label}`);
      } else {
        assert.deepEqual(a, b, `rows ${label}`);
      }
      // Cross-check the row SET against an independent brute oracle (and confirm NULLs are excluded).
      const oracle: number[] = [];
      for (let r = 0; r < N; r++) {
        if (nullRows.has(r)) continue; // three-valued logic: a NULL never matches a range
        const x = kVal(plain, r) as number;
        let hit = false;
        if (spec.op === 'between') { const [lo, hi] = spec.value as [number, number]; hit = x >= lo && x <= hi; }
        else if (spec.op === 'gt') hit = x > (spec.value as number);
        else if (spec.op === 'gte') hit = x >= (spec.value as number);
        else if (spec.op === 'lt') hit = x < (spec.value as number);
        else hit = x <= (spec.value as number);
        if (hit) oracle.push(r);
      }
      // Only the unbounded no-sort default returns the full set in row-id order == oracle.
      if (shape.name === 'no-sort default') assert.deepEqual([...a].sort((x, y) => x - y), oracle, `set ${label}`);
    }
  }
});

// --- warmIndexes ------------------------------------------------------------------------------

test('warmIndexes clears all dirty indexes (sorted + eq); next query rebuilds nothing', () => {
  const t = build(2000, true);
  // Fresh inserts after index creation leave both kinds dirty (lazy rebuild).
  assert.equal(t.hasDirtyIndex(), true, 'dirty before warm');
  t.warmIndexes();
  assert.equal(t.hasDirtyIndex(), false, 'clean after warm');

  // A query now does zero rebuild — and still returns correct results vs a plain table.
  const plain = build(2000, false);
  const rangeIndexed = t.scan([{ field: 'price', op: 'between', value: [100, 400] }]).toArray();
  const rangePlain = plain.scan([{ field: 'price', op: 'between', value: [100, 400] }]).toArray();
  assert.deepEqual(rangeIndexed, rangePlain);
  const eqIndexed = t.scan([{ field: 'status', op: 'eq', value: 'published' }]).toArray();
  const eqPlain = plain.scan([{ field: 'status', op: 'eq', value: 'published' }]).toArray();
  assert.deepEqual(eqIndexed, eqPlain);
  // Querying did not re-dirty anything.
  assert.equal(t.hasDirtyIndex(), false, 'still clean after read');
});

test('warmIndexes re-warms after a later insert re-dirties the indexes', () => {
  const t = build(100, true);
  t.warmIndexes();
  assert.equal(t.hasDirtyIndex(), false);
  t.insert({ price: 42, stock: 7, status: 'draft', active: true });
  assert.equal(t.hasDirtyIndex(), true, 'insert re-dirties');
  t.warmIndexes();
  assert.equal(t.hasDirtyIndex(), false, 'warm again clears it');
});

// --- Capacity growth past INITIAL_CAPACITY (1024) ---------------------------------------------

test('$between + radix index stay correct past INITIAL_CAPACITY (1024 rows)', () => {
  const N = 5000; // forces several column grows and a large radix sort
  const t = new Table([{ name: 'n', type: 'i32' }]);
  const plain = new Table([{ name: 'n', type: 'i32' }]);
  t.createSortedIndex('n');
  const rng = lcg(404);
  const vals: number[] = [];
  for (let i = 0; i < N; i++) {
    const v = Math.floor(rng() * 10000) - 5000;
    vals.push(v);
    t.insert({ n: v });
    plain.insert({ n: v });
  }
  t.warmIndexes();
  assert.equal(t.hasDirtyIndex(), false);
  for (const [lo, hi] of [[-5000, 5000], [-100, 100], [0, 0], [4990, 5000], [3000, -3000]] as [number, number][]) {
    const oracle: number[] = [];
    for (let r = 0; r < N; r++) if (vals[r]! >= lo && vals[r]! <= hi) oracle.push(r);
    const a = t.scan([{ field: 'n', op: 'between', value: [lo, hi] }]).toArray();
    const b = plain.scan([{ field: 'n', op: 'between', value: [lo, hi] }]).toArray();
    assert.deepEqual(a, oracle, `indexed between [${lo},${hi}] @${N}`);
    assert.deepEqual(b, oracle, `unindexed between [${lo},${hi}] @${N}`);
  }
  // Ordered walk is globally sorted across the grown table.
  const asc = t.query({ sort: [{ field: 'n', dir: 'asc' }], limit: N }).map((r) => vals[r]!);
  for (let i = 1; i < asc.length; i++) assert.ok(asc[i]! >= asc[i - 1]!);
});

// --- Word-boundary cases (rows at 31/32/63/64, count not a multiple of 32) ---------------------

test('$between is exact at bitset word boundaries (rowCount = 65)', () => {
  const N = 65; // crosses two word boundaries; not a multiple of 32
  const t = new Table([{ name: 'n', type: 'i32' }]);
  t.createSortedIndex('n');
  for (let i = 0; i < N; i++) t.insert({ n: i }); // value == row id, strictly increasing
  t.warmIndexes();
  for (const [lo, hi] of [[31, 32], [63, 64], [0, 0], [64, 64], [30, 33], [0, 64]] as [number, number][]) {
    const oracle: number[] = [];
    for (let r = 0; r < N; r++) if (r >= lo && r <= hi) oracle.push(r);
    const got = t.scan([{ field: 'n', op: 'between', value: [lo, hi] }]).toArray();
    assert.deepEqual(got, oracle, `between [${lo},${hi}] @65`);
  }
});
