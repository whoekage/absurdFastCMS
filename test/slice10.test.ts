import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef } from '../src/store/table.ts';
import { StringColumn } from '../src/store/column.ts';

/**
 * Slice 10 — benchmark-correctness guards.
 *
 * The bench (bench/scan.bench.ts) TIMES three fast paths and asserts they match their disabled
 * counterparts inline. These tests pin that correctness DOWN as assertions on a moderate, fully
 * deterministic dataset so a regression fails CI, not just a manual bench read.
 *
 * Doctrine (non-negotiable): NO mocks. Everything is driven through the real Table / StringColumn /
 * EqIndex. Expectations come from trivial O(n) brute-force oracles over the inserted rows, and the
 * fast paths must return BYTE-IDENTICAL rows to their slow counterparts:
 *
 *  (1) the high-card slug column yields correct $eq results AND eqStrategy(slug) !== 'plane' (the
 *      memory gate the bench proves — no 500k per-value planes), while a low-card column IS 'plane';
 *  (2) the trigram-accelerated $contains == brute $contains (== an independent oracle); and
 *  (3) the probe-enabled AND == the probe-disabled bitset-AND (== an independent oracle).
 *
 * Data is deterministic (a seeded LCG, no Math.random), and covers capacity growth past
 * INITIAL_CAPACITY (1024) and word-boundary rows (31/32/63/64) where relevant.
 */

/** Seeded LCG so the dataset — and thus every assertion — is deterministic (no Math.random). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904229) >>> 0;
    return s / 0x100000000;
  };
}

// ── (1) cardinality-gate memory proof: high-card slug is NOT a plane, low-card status IS ───────

const GATE_FIELDS: FieldDef[] = [
  { name: 'slug', type: 'string' }, // ≈ n distinct => near-unique => 'dict' (NEVER planes)
  { name: 'status', type: 'string' }, // 3 distinct => low-card => 'plane'
];
const STATUSES = ['draft', 'published', 'archived'];

test('high-card slug: eqStrategy !== plane (memory gate) AND $eq is correct; low-card status IS plane', () => {
  // 5000 rows: forces growth past INITIAL_CAPACITY (1024), not a multiple of 32, AND clears the
  // low-card plane gate for status (c=3, 3*1000 < 5000 => plane); a smaller N would leave status CSR.
  const N = 5000;
  const plain = new Table(GATE_FIELDS);
  const indexed = new Table(GATE_FIELDS);
  indexed.createEqIndex('slug');
  indexed.createEqIndex('status');

  const slugs: string[] = [];
  const statuses: string[] = [];
  for (let i = 0; i < N; i++) {
    const slug = `slug-${i}`; // unique per row => near-unique tier
    const status = STATUSES[i % 3]!; // 3 distinct => low-card plane tier
    slugs.push(slug);
    statuses.push(status);
    plain.insert({ slug, status });
    indexed.insert({ slug, status });
  }
  indexed.warmIndexes();

  // The memory gate: a ≈n-distinct column must NOT materialize a dense plane per value (that is the
  // 60 GB OOM the report rejects). It lands on 'dict'; a low-card column lands on 'plane'.
  assert.notEqual(indexed.eqStrategy('slug'), 'plane', 'high-card slug must NOT be the plane tier');
  assert.equal(indexed.eqStrategy('slug'), 'dict', 'high-card slug is the near-unique dict tier');
  assert.equal(indexed.eqStrategy('status'), 'plane', 'low-card status IS the dense-plane tier');

  // Correctness despite no planes: $eq on the slug column == brute oracle == plain (no-index) scan,
  // including word-boundary rows and an absent value. The dict tier still returns exact rows.
  for (const probeRow of [0, 31, 32, 63, 64, 1023, 1024, 2047, 2048, 2599]) {
    const slug = slugs[probeRow]!;
    const oracle = slugs.map((s, i) => (s === slug ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(indexed.scan([{ field: 'slug', op: 'eq', value: slug }]).toArray(), oracle, `slug=${slug} index`);
    assert.deepEqual(plain.scan([{ field: 'slug', op: 'eq', value: slug }]).toArray(), oracle, `slug=${slug} plain`);
  }
  // An absent slug matches nothing on the dict tier.
  assert.deepEqual(indexed.scan([{ field: 'slug', op: 'eq', value: 'slug-missing' }]).toArray(), []);

  // And the low-card plane tier stays correct too (cross-check the other side of the gate).
  for (const v of STATUSES) {
    const oracle = statuses.map((s, i) => (s === v ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(indexed.scan([{ field: 'status', op: 'eq', value: v }]).toArray(), oracle, `status=${v}`);
  }
});

// ── (2) trigram-accelerated $contains == brute $contains == oracle ─────────────────────────────

const S_FIELDS: FieldDef[] = [{ name: 's', type: 'string' }];

/** Build a single-string-column table; `accel` opts `s` into the trigram accelerator. */
function buildStrings(rows: (string | null)[], accel: boolean): Table {
  const t = new Table(S_FIELDS);
  if (accel) t.enableSubstringIndex('s');
  for (const v of rows) t.insert(v === null ? {} : { s: v });
  return t;
}

/** Independent per-row $contains oracle (NULL rows never match). */
function containsOracle(rows: (string | null)[], needle: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i];
    if (v !== null && v.includes(needle)) out.push(i);
  }
  return out;
}

test('trigram-accelerated $contains returns identical rows to brute (== oracle), accelerator fires', () => {
  // A large-distinct, contains-heavy column so the trigram path actually engages (>50 trigrams),
  // and crosses INITIAL_CAPACITY (1500 > 1024) with NULL holes and word-boundary rows.
  const rng = lcg(0xC0FFEE);
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  const rows: (string | null)[] = [];
  for (let i = 0; i < 1500; i++) {
    if (i % 37 === 0) {
      rows.push(null); // NULL holes — must never survive on either path
      continue;
    }
    const a = words[(rng() * words.length) | 0]!;
    const b = words[(rng() * words.length) | 0]!;
    rows.push(`${a}-${i}-${b}-${(rng() * 9999) | 0}`);
  }
  const accel = buildStrings(rows, true);
  const brute = buildStrings(rows, false);
  const col = accel.column('s') as StringColumn;

  // REAL needles drawn from inserted values: every trigram exists => the accel path MUST fire.
  const realNeedles: string[] = [];
  for (let k = 0; k < 12; k++) {
    let v: string | null = null;
    while (v === null) v = rows[(rng() * rows.length) | 0]!;
    const start = (rng() * Math.max(1, v.length - 6)) | 0;
    realNeedles.push(v.slice(start, start + 3 + ((rng() * 4) | 0)));
  }
  // EDGE needles that must NOT fire the accel (a <3-char needle, and a ≥3 needle whose trigram is
  // absent) — they defer to the brute floor, so they exercise correctness but never the trigram path.
  const edgeNeedles = ['al', 'zzzz'];

  const before = col.substringAccelHits;
  for (const needle of [...realNeedles, ...edgeNeedles]) {
    const a = accel.scan([{ field: 's', op: 'contains', value: needle }]).toArray();
    const b = brute.scan([{ field: 's', op: 'contains', value: needle }]).toArray();
    const o = containsOracle(rows, needle);
    assert.deepEqual(b, o, `brute floor contains ${JSON.stringify(needle)}`);
    assert.deepEqual(a, b, `accel == brute contains ${JSON.stringify(needle)}`);
    // A NULL row must never survive contains on either path.
    for (const r of a) assert.ok(!accel.isNull('s', r), `row ${r} must not be null`);
  }
  // Every real-data needle has present trigrams, so the accelerator fired for each (and the edge
  // needles deferred) — proving the timed bench path is the same code these assertions exercise.
  assert.equal(col.substringAccelHits, before + realNeedles.length, 'trigram path fired for every real-data needle');
  assert.ok(col.rawTrigramCount() > 50, 'a real, non-trivial trigram index was built (not a stub)');
});

// ── (3) probe-enabled AND == probe-disabled bitset-AND == oracle ───────────────────────────────

const AND_FIELDS: FieldDef[] = [
  { name: 'price', type: 'f64' },
  { name: 'stock', type: 'i32' },
  { name: 'status', type: 'string' },
  { name: 'active', type: 'bool' },
];

interface AndRow {
  price: number;
  stock: number;
  status: string;
  active: boolean;
}

test('selective-lead AND: probe path == bitset-AND path == oracle (byte-identical, probe fires)', () => {
  const N = 4000; // > INITIAL_CAPACITY (1024), not a multiple of 32.
  const rng = lcg(0x5EED1234);
  const t = new Table(AND_FIELDS);
  t.createEqIndex('stock'); // gives the tiny eq lead a cheap exact count for the probe gate
  t.createEqIndex('status');
  t.createSortedIndex('price');

  const rows: AndRow[] = [];
  for (let i = 0; i < N; i++) {
    const r: AndRow = {
      price: (rng() * 1000) | 0,
      stock: (rng() * 500) | 0, // ~500 distinct => a stock eq lead is ~0.2% (tiny => probe gate fires)
      status: STATUSES[(rng() * STATUSES.length) | 0]!,
      active: rng() < 0.5,
    };
    rows.push(r);
    t.insert(r);
  }
  t.warmIndexes(); // so the probe's leadCount is available (index not dirty) and timing is fair.

  // A selective-lead conjunction: a tiny stock eq lead plus residual range + eq predicates — the
  // exact shape the bench times. The lead is ~0.2% of rows, well under the probe's tiny-lead gate.
  const filters = [
    { field: 'stock', op: 'eq' as const, value: 250 },
    { field: 'price', op: 'gte' as const, value: 100 },
    { field: 'active', op: 'eq' as const, value: true },
  ];

  const oracle = rows
    .map((r, i) => (r.stock === 250 && r.price >= 100 && r.active === true ? i : -1))
    .filter((i) => i >= 0);

  t.probeEnabled = true;
  t.probeHits = 0;
  const probed = t.scan(filters).toArray();
  assert.ok(t.probeHits > 0, 'the selectivity probe path actually fired (lead is tiny)');

  t.probeEnabled = false;
  const bitset = t.scan(filters).toArray();
  t.probeEnabled = true;

  assert.deepEqual(bitset, oracle, 'bitset-AND combiner matches the brute oracle');
  assert.deepEqual(probed, bitset, 'probe path is byte-identical to the bitset-AND path');
  assert.deepEqual(probed, oracle, 'probe path matches the brute oracle');
});
