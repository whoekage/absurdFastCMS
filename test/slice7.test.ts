import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef, type Predicate } from '../src/store/table.ts';

/**
 * Slice 7 — selectivity planner (opt-in tiny-lead probe).
 *
 * Doctrine: NO mocks. Every multi-predicate AND is checked THREE ways that must agree exactly:
 *   1. the probe path        (Table.probeEnabled = true, the §2.6 tiny-lead probe),
 *   2. the bitset-AND path   (Table.probeEnabled = false, the pure word-wise combiner),
 *   3. a trivial O(n) brute-force ORACLE over the inserted rows (three-valued logic by hand).
 * The probe is a transparent accelerator: it may change SPEED, never the matching rows. We also
 * assert (via `probeHits`) that the probe path actually FIRED for the selective queries, so the
 * equivalence isn't vacuously passing because everything silently fell back to the bitset path.
 */

// Deterministic pseudo-random source (seeded LCG) — no Math.random, per the testing doctrine.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904229) >>> 0;
    return s / 0x100000000;
  };
}

const FIELDS: FieldDef[] = [
  { name: 'status', type: 'string' }, // low-card dict, eq-indexed => can be a selective lead
  { name: 'tag', type: 'string' }, //    mid-card dict, eq-indexed (residual probe target)
  { name: 'stock', type: 'i32' }, //     numeric, sorted-indexed (range residual / lead)
  { name: 'price', type: 'f64' }, //     numeric, no index (forces scan-based residual bitset)
  { name: 'createdAt', type: 'date' }, // temporal, sorted-indexed
  { name: 'active', type: 'bool' }, //   boolean residual
];

const STATUSES = ['draft', 'published', 'archived', 'review', 'scheduled'];
const TAGS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const DAY = 86_400_000;
const BASE = Date.UTC(2026, 0, 1);

interface OracleRow {
  status: string | null;
  tag: string | null;
  stock: number | null;
  price: number | null;
  createdAt: number | null; // epoch-ms, or null
  active: boolean | null;
}

/**
 * Build a (plain, indexed, oracle) triple over the SAME deterministic rows. The `indexed` table
 * carries the eq/sorted indexes the planner reads for its cheap lead counts; the `plain` table
 * has none (so its AND always goes through the bitset path) — a third cross-check.
 *
 * `nullEvery` makes some fields NULL on a deterministic subset of rows so the three-valued-logic
 * masking is exercised on RESIDUAL columns (the whole point: a NULL residual must exclude a row
 * that the lead leaf admitted).
 */
function build(n: number, seed: number): { indexed: Table; plain: Table; oracle: OracleRow[] } {
  const rnd = lcg(seed);
  const indexed = new Table(FIELDS);
  const plain = new Table(FIELDS);
  indexed.createHashIndex('status');
  indexed.createHashIndex('tag');
  indexed.createSortedIndex('stock');
  indexed.createSortedIndex('createdAt');
  const oracle: OracleRow[] = [];

  for (let i = 0; i < n; i++) {
    // 'status' is heavily skewed so one value ('scheduled') is RARE (well under the ~1.5% gate)
    // — a tiny selective lead the probe path can latch onto.
    const statusRoll = rnd();
    const status =
      statusRoll < 0.008 ? 'scheduled' : STATUSES[Math.floor(rnd() * 4)]!; // 4 common + rare 5th
    const tag = TAGS[Math.floor(rnd() * TAGS.length)]!;
    const stock = Math.floor(rnd() * 1000);
    const price = Math.round(rnd() * 100000) / 100; // f64 with fractional part
    const createdAt = BASE + Math.floor(rnd() * 400) * DAY;
    const active = rnd() < 0.5;

    // NULL-bearing residuals: every ~7th row nulls 'tag', every ~11th nulls 'stock',
    // every ~13th nulls 'active', every ~17th nulls 'createdAt'. 'status' (the usual lead) is
    // never null so the lead leaf stays clean; nulls live on the residual fields under test.
    const row: Record<string, unknown> = { status, price };
    const tagNull = i % 7 === 0;
    const stockNull = i % 11 === 0;
    const activeNull = i % 13 === 0;
    const dateNull = i % 17 === 0;
    if (!tagNull) row.tag = tag;
    if (!stockNull) row.stock = stock;
    if (!activeNull) row.active = active;
    if (!dateNull) row.createdAt = createdAt;

    indexed.insert(row);
    plain.insert(row);
    oracle.push({
      status,
      tag: tagNull ? null : tag,
      stock: stockNull ? null : stock,
      price,
      createdAt: dateNull ? null : createdAt,
      active: activeNull ? null : active,
    });
  }
  indexed.warmIndexes();
  return { indexed, plain, oracle };
}

/** Brute-force three-valued-logic evaluation of ONE predicate against one oracle row. */
function oracleMatch(p: Predicate, row: OracleRow): boolean {
  const v = (row as Record<string, unknown>)[p.field] as unknown;
  if (p.op === 'null') return v === null;
  if (p.op === 'notNull') return v !== null;
  // Every comparison op: a NULL is "unknown" => never a match (both polarities).
  if (v === null) return false;
  switch (p.op) {
    case 'eq':
    case 'eqi':
      return v === p.value;
    case 'ne':
    case 'nei':
      return v !== p.value;
    case 'gt':
      return (v as number) > (p.value as number);
    case 'gte':
      return (v as number) >= (p.value as number);
    case 'lt':
      return (v as number) < (p.value as number);
    case 'lte':
      return (v as number) <= (p.value as number);
    case 'between': {
      const [lo, hi] = p.value as [number, number];
      return (v as number) >= lo && (v as number) <= hi;
    }
    case 'in':
      return (p.value as unknown[]).includes(v);
    case 'notIn':
      return !(p.value as unknown[]).includes(v);
    case 'contains':
      return (v as string).includes(p.value as string);
    case 'notContains':
      return !(v as string).includes(p.value as string);
    default:
      throw new Error(`oracle does not model op ${p.op}`);
  }
}

/** Brute-force the full AND conjunction over the oracle, returning matching row ids ascending. */
function oracleAnd(filters: Predicate[], oracle: OracleRow[]): number[] {
  const out: number[] = [];
  for (let r = 0; r < oracle.length; r++) {
    if (filters.every((p) => oracleMatch(p, oracle[r]!))) out.push(r);
  }
  return out;
}

/**
 * Assert the three views agree for a filter conjunction. Returns whether the probe path fired
 * on the indexed table, so a caller can assert "the probe actually ran" for selective cases.
 */
function assertEquivalent(
  indexed: Table,
  plain: Table,
  oracle: OracleRow[],
  filters: Predicate[],
  label: string,
): boolean {
  const expected = oracleAnd(filters, oracle);

  indexed.probeEnabled = true;
  indexed.probeHits = 0;
  const probeRows = indexed.scan(filters).toArray();
  const fired = indexed.probeHits > 0;

  indexed.probeEnabled = false;
  const bitsetRows = indexed.scan(filters).toArray();
  indexed.probeEnabled = true;

  const plainRows = plain.scan(filters).toArray();

  assert.deepEqual(probeRows, expected, `probe vs oracle: ${label}`);
  assert.deepEqual(bitsetRows, expected, `bitset vs oracle: ${label}`);
  assert.deepEqual(plainRows, expected, `plain vs oracle: ${label}`);
  return fired;
}

test('Slice7: selective eq lead + numeric/date/dict residuals (incl. null residuals) match brute force', () => {
  const { indexed, plain, oracle } = build(4000, 0xa17);
  // 'scheduled' is the rare lead (~2% of rows). Residuals span dict/numeric/date/bool, several
  // on NULL-bearing fields, so a NULL residual must drop a row the lead leaf admitted.
  const queries: Predicate[][] = [
    [
      { field: 'status', op: 'eq', value: 'scheduled' },
      { field: 'tag', op: 'in', value: ['a', 'b', 'c'] }, // tag is null-bearing
    ],
    [
      { field: 'status', op: 'eq', value: 'scheduled' },
      { field: 'stock', op: 'between', value: [100, 800] }, // stock is null-bearing
      { field: 'active', op: 'eq', value: true }, // active is null-bearing
    ],
    [
      { field: 'status', op: 'eq', value: 'scheduled' },
      { field: 'stock', op: 'gte', value: 500 },
      { field: 'price', op: 'lt', value: 50000 }, // price unindexed => residual bitset
    ],
    [
      { field: 'status', op: 'eq', value: 'scheduled' },
      { field: 'createdAt', op: 'between', value: [BASE + 50 * DAY, BASE + 300 * DAY] }, // null-bearing date
      { field: 'tag', op: 'ne', value: 'a' },
    ],
    [
      { field: 'status', op: 'eq', value: 'scheduled' },
      { field: 'tag', op: 'notIn', value: ['a', 'b'] },
      { field: 'stock', op: 'lte', value: 700 },
      { field: 'active', op: 'ne', value: false },
      { field: 'price', op: 'gte', value: 1000 },
    ],
  ];
  let firedAny = false;
  for (let q = 0; q < queries.length; q++) {
    if (assertEquivalent(indexed, plain, oracle, queries[q]!, `q${q}`)) firedAny = true;
  }
  // The rare 'scheduled' lead is well under the gate, so the probe path MUST have fired.
  assert.ok(firedAny, 'expected the probe path to fire on at least one selective query');
});

test('Slice7: a NULL residual on a surviving lead row excludes that row (three-valued logic)', () => {
  // Tight construction: the lead leaf matches a known set, and EXACTLY one of those rows is NULL
  // on the residual field. The probe must drop precisely that row, never spuriously keep it.
  const t = new Table(FIELDS);
  t.createHashIndex('status');
  const oracle: OracleRow[] = [];
  const push = (row: Record<string, unknown>, o: OracleRow) => {
    t.insert(row);
    oracle.push(o);
  };
  // Three 'scheduled' rows; the middle one has a NULL tag. Residual `tag = 'x'` must keep only
  // the two non-null rows whose tag is 'x', and the NULL-tag row must be excluded.
  push(
    { status: 'scheduled', tag: 'x', price: 1 },
    { status: 'scheduled', tag: 'x', stock: null, price: 1, createdAt: null, active: null },
  );
  push(
    { status: 'scheduled', price: 2 }, // tag missing => NULL
    { status: 'scheduled', tag: null, stock: null, price: 2, createdAt: null, active: null },
  );
  push(
    { status: 'scheduled', tag: 'x', price: 3 },
    { status: 'scheduled', tag: 'x', stock: null, price: 3, createdAt: null, active: null },
  );
  // Some non-lead noise so the lead is genuinely selective.
  for (let i = 0; i < 500; i++) {
    push(
      { status: 'draft', tag: 'x', price: 0 },
      { status: 'draft', tag: 'x', stock: null, price: 0, createdAt: null, active: null },
    );
  }
  t.warmIndexes();

  const filters: Predicate[] = [
    { field: 'status', op: 'eq', value: 'scheduled' },
    { field: 'tag', op: 'eq', value: 'x' },
  ];
  t.probeHits = 0;
  const probeRows = t.scan(filters).toArray();
  assert.ok(t.probeHits > 0, 'probe path should fire (lead is tiny)');
  assert.deepEqual(probeRows, [0, 2], 'NULL-tag row 1 must be excluded by the residual probe');

  // Same answer with the probe disabled (bitset path) and from the brute oracle.
  t.probeEnabled = false;
  assert.deepEqual(t.scan(filters).toArray(), [0, 2]);
  t.probeEnabled = true;
  assert.deepEqual(oracleAnd(filters, oracle), [0, 2]);
});

test('Slice7: a substring residual forces the bitset path for that residual but stays correct', () => {
  // `contains` is not probeable; the planner must build that residual's bitset and AND it,
  // while still using the tiny lead's row list. Result must match brute force exactly.
  const t = new Table(FIELDS);
  t.createHashIndex('status');
  const rnd = lcg(0x5b);
  const oracle: OracleRow[] = [];
  for (let i = 0; i < 4000; i++) {
    const status = rnd() < 0.008 ? 'scheduled' : 'draft';
    const tag = ['alpha', 'beta', 'gamma', 'delta'][Math.floor(rnd() * 4)]!;
    t.insert({ status, tag, price: i });
    oracle.push({ status, tag, stock: null, price: i, createdAt: null, active: null });
  }
  t.warmIndexes();
  const filters: Predicate[] = [
    { field: 'status', op: 'eq', value: 'scheduled' },
    { field: 'tag', op: 'contains', value: 'a' }, // matches alpha, gamma, delta (and beta has 'a')
  ];
  const expected = oracleAnd(filters, oracle);

  t.probeHits = 0;
  assert.deepEqual(t.scan(filters).toArray(), expected, 'probe(+substring bitset) vs oracle');
  // The lead is tiny and the OTHER residual is bitset-resolved, so the probe path still fires.
  assert.ok(t.probeHits > 0, 'probe path fires even with a non-probeable residual');

  t.probeEnabled = false;
  assert.deepEqual(t.scan(filters).toArray(), expected, 'bitset path vs oracle');
  t.probeEnabled = true;
});

test('Slice7: range lead with eq/ne residuals (numeric lead, date residual)', () => {
  const { indexed, plain, oracle } = build(3000, 0xc0ffee);
  // A very narrow stock range is the selective lead; residuals are dict + date + bool.
  const filters: Predicate[] = [
    { field: 'stock', op: 'between', value: [10, 20] }, // narrow numeric lead (and null-bearing)
    { field: 'status', op: 'ne', value: 'draft' },
    { field: 'createdAt', op: 'gte', value: BASE + 100 * DAY },
    { field: 'active', op: 'eq', value: true },
  ];
  assertEquivalent(indexed, plain, oracle, filters, 'range-lead');
});

test('Slice7: empty lead set => no rows, all paths agree', () => {
  const { indexed, plain, oracle } = build(1500, 0x11);
  // 'nonexistent' status was never inserted => lead leaf is empty => result empty.
  const filters: Predicate[] = [
    { field: 'status', op: 'eq', value: 'nonexistent' },
    { field: 'stock', op: 'gte', value: 0 },
  ];
  assert.equal(indexed.scan(filters).count(), 0);
  assertEquivalent(indexed, plain, oracle, filters, 'empty-lead');
});

test('Slice7: non-selective lead (all rows) keeps the bitset path, result unchanged', () => {
  const { indexed, plain, oracle } = build(2048, 0x22);
  // `stock >= 0` matches ~every non-null row — well above the tiny-lead gate, so no probe fires,
  // but the AND must still be correct. (status in {...all...} keeps it broad.)
  const filters: Predicate[] = [
    { field: 'stock', op: 'gte', value: 0 },
    { field: 'price', op: 'gte', value: 0 },
  ];
  indexed.probeHits = 0;
  const fired = assertEquivalent(indexed, plain, oracle, filters, 'non-selective');
  assert.equal(fired, false, 'a non-selective lead must NOT trigger the probe path');
});

test('Slice7: residual that is NULL on every surviving lead row => empty result', () => {
  // Construct rows where the lead matches a set whose residual field is NULL for ALL of them.
  const t = new Table(FIELDS);
  t.createHashIndex('status');
  const oracle: OracleRow[] = [];
  // 5 'scheduled' rows, every one with a NULL stock. Residual `stock between [0,1000]` is true
  // for any real value but UNKNOWN for null => no scheduled row survives.
  for (let i = 0; i < 5; i++) {
    t.insert({ status: 'scheduled', tag: 'a', price: i }); // stock missing => null
    oracle.push({ status: 'scheduled', tag: 'a', stock: null, price: i, createdAt: null, active: null });
  }
  for (let i = 0; i < 600; i++) {
    t.insert({ status: 'draft', tag: 'a', stock: 5, price: i });
    oracle.push({ status: 'draft', tag: 'a', stock: 5, price: i, createdAt: null, active: null });
  }
  t.warmIndexes();
  const filters: Predicate[] = [
    { field: 'status', op: 'eq', value: 'scheduled' },
    { field: 'stock', op: 'between', value: [0, 1000] },
  ];
  t.probeHits = 0;
  assert.deepEqual(t.scan(filters).toArray(), []);
  assert.ok(t.probeHits > 0, 'probe fires; every survivor is NULL on the residual => empty');
  assert.deepEqual(oracleAnd(filters, oracle), []);
});

test('Slice7: equivalence over MANY randomized multi-predicate queries past INITIAL_CAPACITY', () => {
  // Capacity growth past 1024 is built in (n = 5000). Generate randomized conjunctions and
  // require probe == bitset == oracle for every one. Mix of selective and broad leads, all
  // operator families, null-bearing residuals, deterministic (seeded LCG, no Math.random).
  const { indexed, plain, oracle } = build(5000, 0xdecafbad);
  const rnd = lcg(0xf00d);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;

  let probeFired = 0;
  for (let iter = 0; iter < 400; iter++) {
    const filters: Predicate[] = [];
    const k = 2 + Math.floor(rnd() * 3); // 2..4 predicates
    for (let j = 0; j < k; j++) {
      const which = Math.floor(rnd() * 7);
      switch (which) {
        case 0:
          // Often the rare 'scheduled' (selective lead), sometimes a common status.
          filters.push({
            field: 'status',
            op: 'eq',
            value: rnd() < 0.5 ? 'scheduled' : pick(STATUSES),
          });
          break;
        case 1:
          filters.push({ field: 'tag', op: rnd() < 0.5 ? 'eq' : 'ne', value: pick(TAGS) });
          break;
        case 2: {
          const lo = Math.floor(rnd() * 1000);
          const hi = lo + Math.floor(rnd() * 200); // sometimes narrow (selective lead)
          filters.push({ field: 'stock', op: 'between', value: [lo, hi] });
          break;
        }
        case 3:
          filters.push({
            field: 'stock',
            op: pick(['gt', 'gte', 'lt', 'lte']),
            value: Math.floor(rnd() * 1000),
          });
          break;
        case 4:
          filters.push({
            field: 'price',
            op: pick(['gt', 'gte', 'lt', 'lte']),
            value: Math.round(rnd() * 100000) / 100,
          });
          break;
        case 5: {
          const lo = BASE + Math.floor(rnd() * 400) * DAY;
          const hi = lo + Math.floor(rnd() * 100) * DAY;
          filters.push({ field: 'createdAt', op: 'between', value: [lo, hi] });
          break;
        }
        case 6:
          filters.push({
            field: 'active',
            op: rnd() < 0.5 ? 'eq' : 'ne',
            value: rnd() < 0.5,
          });
          break;
      }
    }
    if (assertEquivalent(indexed, plain, oracle, filters, `rand#${iter}`)) probeFired++;
  }
  // Over 400 mixed queries, the probe path must have fired a non-trivial number of times,
  // proving the equivalence isn't passing only because everything fell back to bitsets.
  assert.ok(probeFired > 20, `probe path fired too rarely (${probeFired}/400)`);
});

test('Slice7: word-boundary row counts (lead/residual hits at 31/32/63/64, rowCount % 32 != 0)', () => {
  // Place lead matches and residual nulls precisely at bitset word boundaries; rowCount is not a
  // multiple of 32 so the partial tail word is exercised. probe == bitset == oracle.
  const t = new Table(FIELDS);
  t.createHashIndex('status');
  const oracle: OracleRow[] = [];
  // N is NOT a multiple of 32 (2000 % 32 = 16), so the partial tail word is exercised. The 8
  // lead rows sit exactly at word boundaries (31/32/63/64) and at the very last row (1999), and
  // 8/2000 = 0.4% keeps the lead under the tiny-lead gate so the probe path fires.
  const N = 2000;
  const leadRows = new Set([0, 31, 32, 33, 63, 64, 65, 1999]);
  const nullTagRows = new Set([31, 64]); // some lead rows are NULL on the residual
  for (let i = 0; i < N; i++) {
    const isLead = leadRows.has(i);
    const status = isLead ? 'scheduled' : 'draft';
    const tagNull = nullTagRows.has(i);
    const row: Record<string, unknown> = { status, price: i };
    if (!tagNull) row.tag = 'x';
    t.insert(row);
    oracle.push({
      status,
      tag: tagNull ? null : 'x',
      stock: null,
      price: i,
      createdAt: null,
      active: null,
    });
  }
  t.warmIndexes();
  const filters: Predicate[] = [
    { field: 'status', op: 'eq', value: 'scheduled' },
    { field: 'tag', op: 'eq', value: 'x' },
  ];
  const expected = oracleAnd(filters, oracle);
  // Lead rows {0,31,32,33,63,64,65,1999}, minus the NULL-tag rows {31,64}.
  assert.deepEqual(expected, [0, 32, 33, 63, 65, 1999]);

  t.probeHits = 0;
  assert.deepEqual(t.scan(filters).toArray(), expected, 'probe at word boundaries');
  assert.ok(t.probeHits > 0);
  t.probeEnabled = false;
  assert.deepEqual(t.scan(filters).toArray(), expected, 'bitset at word boundaries');
  t.probeEnabled = true;
});
