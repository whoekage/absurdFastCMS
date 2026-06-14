import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bitset } from '../src/store/bitset.ts';
import { Table, type FieldDef, type FilterNode, type Predicate } from '../src/store/table.ts';

// Deterministic pseudo-randomness (seeded LCG) — no Math.random, mirrors btree precedent.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// --- Bitset.not -----------------------------------------------------------

test('Bitset.not: complement is correct and masks the tail past rowCount', () => {
  // rowCount = 70 is deliberately NOT a multiple of 32 to exercise tail masking.
  const N = 70;
  const set = [0, 1, 31, 32, 33, 63, 64, 69];
  const bs = new Bitset(N + 40); // over-allocate so phantom tail words exist to be masked
  for (const i of set) bs.set(i);
  bs.not(N);

  for (let i = 0; i < N; i++) {
    assert.equal(bs.get(i), !set.includes(i), `bit ${i}`);
  }
  // Everything at or beyond rowCount must be 0, including bits inside the boundary word.
  for (let i = N; i < bs.capacity; i++) {
    assert.equal(bs.get(i), false, `tail bit ${i} must stay 0`);
  }
  assert.equal(bs.count(), N - set.length);
});

test('Bitset.not: word-boundary rowCounts (31/32/63/64) and double-complement identity', () => {
  for (const N of [31, 32, 63, 64, 65, 96, 100]) {
    const orig = new Bitset(N);
    const rng = lcg(N + 7);
    for (let i = 0; i < N; i++) if (rng() < 0.5) orig.set(i);

    const comp = new Bitset(N);
    comp.words.set(orig.words);
    comp.not(N);
    // not is the exact complement over [0, N).
    for (let i = 0; i < N; i++) assert.equal(comp.get(i), !orig.get(i), `N=${N} bit ${i}`);
    // No bit set past N.
    for (let i = N; i < comp.capacity; i++) assert.equal(comp.get(i), false);

    // Double complement returns the original.
    comp.not(N);
    assert.deepEqual(comp.toArray(), orig.toArray(), `N=${N} double-not`);
  }
});

test('Bitset.not: empty and full inputs', () => {
  const N = 50;
  const empty = new Bitset(N);
  empty.not(N);
  assert.equal(empty.count(), N); // complement of nothing = everything in range

  const full = new Bitset(N);
  full.fill(N);
  full.not(N);
  assert.equal(full.count(), 0); // complement of everything = nothing
});

// --- scanTree AND/OR/NOT with brute-force oracle --------------------------

const FIELDS: FieldDef[] = [
  { name: 'price', type: 'f64' },
  { name: 'stock', type: 'i32' },
  { name: 'status', type: 'string' },
  { name: 'active', type: 'bool' },
];
const STATUSES = ['draft', 'published', 'archived'];

function buildTree(n: number, withIndexes: boolean): { table: Table; rows: Record<string, unknown>[] } {
  const t = new Table(FIELDS);
  if (withIndexes) {
    t.createHashIndex('status');
    t.createSortedIndex('price');
  }
  const rng = lcg(99);
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const row = {
      price: Math.floor(rng() * 1000),
      stock: Math.floor(rng() * 500),
      status: STATUSES[Math.floor(rng() * STATUSES.length)]!,
      active: rng() < 0.5,
    };
    rows.push(row);
    t.insert(row);
  }
  return { table: t, rows };
}

/** Evaluate a single predicate against a plain JS row (the oracle for leaves). */
function leafMatch(p: Predicate, row: Record<string, unknown>): boolean {
  const v = row[p.field] as number | string | boolean;
  const t = p.value as number | string | boolean;
  switch (p.op) {
    case 'eq': return v === t;
    case 'ne': return v !== t;
    case 'gt': return (v as number) > (t as number);
    case 'gte': return (v as number) >= (t as number);
    case 'lt': return (v as number) < (t as number);
    case 'lte': return (v as number) <= (t as number);
  }
}

/** Brute-force evaluate a whole tree against one row. */
function treeMatch(node: FilterNode, row: Record<string, unknown>): boolean {
  if ('leaf' in node) return leafMatch(node.leaf, row);
  if (node.op === 'not') return !treeMatch(node.children[0], row);
  if (node.op === 'or') {
    // empty OR = no rows
    return node.children.some((c) => treeMatch(c, row));
  }
  // and: empty = all rows
  return node.children.every((c) => treeMatch(c, row));
}

function oracle(rows: Record<string, unknown>[], node: FilterNode): number[] {
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) if (treeMatch(node, rows[i]!)) out.push(i);
  return out;
}

// A small grammar of randomized leaves so trees probe every column/operator.
function randomLeaf(rng: () => number): FilterNode {
  const choice = Math.floor(rng() * 6);
  switch (choice) {
    case 0: return { leaf: { field: 'status', op: rng() < 0.5 ? 'eq' : 'ne', value: STATUSES[Math.floor(rng() * STATUSES.length)]! } };
    case 1: return { leaf: { field: 'active', op: 'eq', value: rng() < 0.5 } };
    case 2: return { leaf: { field: 'price', op: 'gt', value: Math.floor(rng() * 1000) } };
    case 3: return { leaf: { field: 'price', op: 'lte', value: Math.floor(rng() * 1000) } };
    case 4: return { leaf: { field: 'stock', op: 'gte', value: Math.floor(rng() * 500) } };
    default: return { leaf: { field: 'stock', op: 'lt', value: Math.floor(rng() * 500) } };
  }
}

function randomTree(rng: () => number, depth: number): FilterNode {
  if (depth <= 0 || rng() < 0.45) return randomLeaf(rng);
  const r = rng();
  if (r < 0.25) return { op: 'not', children: [randomTree(rng, depth - 1)] };
  const op = r < 0.6 ? 'and' : 'or';
  const count = Math.floor(rng() * 3) + 1; // 1..3 children (sometimes a single-child group)
  const children: FilterNode[] = [];
  for (let i = 0; i < count; i++) children.push(randomTree(rng, depth - 1));
  return { op, children };
}

test('scanTree: randomized AND/OR/NOT trees match a brute-force oracle (no index)', () => {
  const { table, rows } = buildTree(1200, false);
  const rng = lcg(2024);
  for (let k = 0; k < 400; k++) {
    const tree = randomTree(rng, 4);
    assert.deepEqual(table.scanTree(tree).toArray(), oracle(rows, tree), `tree #${k}`);
  }
});

test('scanTree: randomized trees identical with indexes (selectivity reorder stays correct)', () => {
  const { table: plain, rows } = buildTree(1500, false);
  const { table: indexed } = buildTree(1500, true);
  const rng = lcg(7);
  for (let k = 0; k < 400; k++) {
    const tree = randomTree(rng, 4);
    const expected = oracle(rows, tree);
    assert.deepEqual(plain.scanTree(tree).toArray(), expected, `plain tree #${k}`);
    assert.deepEqual(indexed.scanTree(tree).toArray(), expected, `indexed tree #${k}`);
  }
});

test('scanTree: AND identity = all rows, OR identity = no rows', () => {
  const { table } = buildTree(100, false);
  assert.equal(table.scanTree({ op: 'and', children: [] }).count(), 100);
  assert.equal(table.scanTree({ op: 'or', children: [] }).count(), 0);
});

test('scanTree: NOT is a structural complement over [0, rowCount)', () => {
  const { table, rows } = buildTree(257, false); // 257 forces a partial tail word
  const leaf: FilterNode = { leaf: { field: 'status', op: 'eq', value: 'published' } };
  const positive = table.scanTree(leaf).toArray();
  const negated = table.scanTree({ op: 'not', children: [leaf] }).toArray();
  // Complement partitions the row space exactly.
  assert.equal(positive.length + negated.length, rows.length);
  const posSet = new Set(positive);
  for (const r of negated) assert.equal(posSet.has(r), false);
  assert.deepEqual(negated, oracle(rows, { op: 'not', children: [leaf] }));
});

test('scan(predicates) still equals the AND tree of those predicates', () => {
  const { table } = buildTree(500, true);
  const preds: Predicate[] = [
    { field: 'status', op: 'eq', value: 'published' },
    { field: 'price', op: 'gte', value: 400 },
  ];
  const viaScan = table.scan(preds).toArray();
  const viaTree = table.scanTree({ op: 'and', children: preds.map((p) => ({ leaf: p })) }).toArray();
  assert.deepEqual(viaScan, viaTree);
});

// --- null substrate -------------------------------------------------------

test('insert allows missing and explicit-null fields; null bit + materialize null', () => {
  const t = new Table([
    { name: 'price', type: 'f64' },
    { name: 'stock', type: 'i32' },
    { name: 'status', type: 'string' },
    { name: 'active', type: 'bool' },
  ]);

  // row 0: fully present, stock genuinely 0 (must NOT read as null)
  t.insert({ price: 10, stock: 0, status: 'draft', active: false });
  // row 1: explicit null on several fields
  t.insert({ price: null, stock: null, status: null, active: null });
  // row 2: missing fields entirely
  t.insert({ price: 5 }); // stock/status/active missing
  // row 3: explicit undefined
  t.insert({ price: undefined, stock: 7, status: 'live', active: true });

  // Row 0: nothing null. The numeric 0 is a real value, distinguishable from null.
  assert.equal(t.isNull('stock', 0), false);
  assert.deepEqual(t.materialize(0), { price: 10, stock: 0, status: 'draft', active: false });

  // Row 1: every field null.
  for (const f of ['price', 'stock', 'status', 'active']) assert.equal(t.isNull(f, 1), true);
  assert.deepEqual(t.materialize(1), { price: null, stock: null, status: null, active: null });

  // Row 2: only price present.
  assert.equal(t.isNull('price', 2), false);
  assert.equal(t.isNull('stock', 2), true);
  assert.deepEqual(t.materialize(2), { price: 5, stock: null, status: null, active: null });

  // Row 3: price undefined => null; the rest present.
  assert.equal(t.isNull('price', 3), true);
  assert.equal(t.isNull('stock', 3), false);
  assert.deepEqual(t.materialize(3), { price: null, stock: 7, status: 'live', active: true });
});

test('null substrate: numeric 0 is distinguishable from null across many rows', () => {
  const t = new Table([{ name: 'n', type: 'i32' }]);
  const rng = lcg(13);
  const expectNull: boolean[] = [];
  const N = 1100; // past INITIAL_CAPACITY and across several 32-bit word boundaries
  for (let i = 0; i < N; i++) {
    if (rng() < 0.5) {
      t.insert({ n: null });
      expectNull.push(true);
    } else {
      t.insert({ n: 0 }); // real zero, the value that collides with the sentinel
      expectNull.push(false);
    }
  }
  for (let i = 0; i < N; i++) {
    assert.equal(t.isNull('n', i), expectNull[i], `row ${i} null bit`);
    assert.equal(t.materialize(i).n, expectNull[i] ? null : 0, `row ${i} materialize`);
  }
});

test('nullBitset: matches isNull row-for-row, including word boundaries', () => {
  const t = new Table([{ name: 'n', type: 'i32' }]);
  const nullRows = [0, 31, 32, 33, 63, 64, 70, 99];
  for (let i = 0; i < 100; i++) t.insert({ n: nullRows.includes(i) ? null : i });
  const bs = t.nullBitset('n');
  assert.deepEqual(bs.toArray(), nullRows);
  for (let i = 0; i < 100; i++) assert.equal(bs.get(i), t.isNull('n', i), `row ${i}`);
});

test('null substrate: a column that never sees null reports no nulls', () => {
  const t = new Table([{ name: 'n', type: 'i32' }]);
  for (let i = 0; i < 64; i++) t.insert({ n: i });
  assert.equal(t.nullBitset('n').count(), 0);
  for (let i = 0; i < 64; i++) assert.equal(t.isNull('n', i), false);
});
