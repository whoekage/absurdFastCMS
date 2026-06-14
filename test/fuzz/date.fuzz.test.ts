/**
 * PHASE 2 — property-based fuzz for the `date` (epoch-ms) segment.
 *
 * Drives the REAL engine (Table / DateColumn / SortedIndex — no mocks) and asserts, on EVERY
 * randomized query, that `scanTree` agrees with the harness's INDEPENDENT O(n) oracle. The oracle
 * re-implements the documented date semantics directly (Date|ISO|number all collapse to epoch-ms,
 * three-valued logic: a NULL date matches no comparison except $null; $ne/$notIn exclude nulls;
 * $eq 0 must NOT match a NULL sentinel-0 row; between inclusive, lo>hi => empty).
 *
 * SHAPE INVARIANCE is the headline date property: the SAME instant fed as a Date, its ISO string,
 * and its epoch-ms number must produce byte-identical results both as stored cell values and as
 * predicate bounds. The harness generators already mix all three shapes; this file adds an explicit
 * shape-equivalence sweep so a regression there fails loudly and on its own.
 *
 * SIZES (logged here, never silently truncated):
 *  - Randomized matrix: ITER = 3000 queries at N drawn from [2_000, 12_000]. The oracle is O(n)/query
 *    so coverage is driven by QUERY COUNT, not row count; 3000 queries over a date-only schema keep
 *    the whole file comfortably under the ~20s budget.
 *  - Shape-equivalence sweep: 200 instants x {Date, ISO, number} x {eq,ne,gt,gte,lt,lte,between}.
 *  - Edge cases: hand-built tables for empty/all/none, word boundaries (31/32/63/64), rowCount%32!=0,
 *    capacity growth past INITIAL_CAPACITY (1024), null rows at boundaries, never-seen values.
 *  - Large-N smoke: ONE table at N = 1_000_000 with a COUNT-ONLY typed oracle (a single Float64 loop),
 *    a handful of bounds — NOT thousands of O(n) tree queries.
 *
 * Deterministic: every iteration derives its seed from a fixed base; on mismatch `runMatrix` throws
 * a FuzzMismatchError carrying SEED + the minimized failing predicate + a diverging sample row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef, type FilterNode, type Predicate } from '../../src/store/table.ts';
import {
  Rng,
  Coverage,
  generateRows,
  randomTree,
  runMatrix,
  oracleMatch,
  fieldTypeMap,
  oracleCoerceDate,
  type FieldSpec,
  type Row,
} from './harness.ts';

const DAY_MS = 86_400_000;

/** Date-only schema (plus a string sibling so AND/OR/NOT trees can still nest non-trivially). */
const FIELDS: FieldSpec[] = [
  { name: 'd', type: 'date', nullRate: 0.18, cardinality: 'medium' },
  { name: 'd2', type: 'date', nullRate: 0.1, cardinality: 'low' },
  { name: 's', type: 'string', nullRate: 0.1, cardinality: 'low' },
];

/** A date-ONLY field set used by the coverage assertion (we must hit every date op). */
const DATE_OPS: Array<Predicate['op']> = [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'notIn', 'null', 'notNull',
];

function buildTable(fields: FieldSpec[], rows: Row[], sortedFields: string[] = []): Table {
  const defs: FieldDef[] = fields.map((f) => ({ name: f.name, type: f.type }));
  const t = new Table(defs);
  for (const sf of sortedFields) t.createSortedIndex(sf);
  for (const r of rows) t.insert(r);
  t.warmIndexes();
  return t;
}

// ===========================================================================
// 1. The big randomized matrix — engine scanTree == independent oracle, every time.
// ===========================================================================

test('date fuzz: 3000 randomized FilterNode queries match the independent oracle', () => {
  const cov = new Coverage();
  const types = fieldTypeMap(FIELDS);
  const ITER = 3000; // query COUNT drives coverage; N is moderate (oracle is O(n)/query).
  for (let i = 0; i < ITER; i++) {
    const seed = 0xda7e0000 + i * 2654435761;
    const rng = new Rng(seed);
    const n = rng.intBetween(2_000, 12_000);
    const { rows } = generateRows(rng, FIELDS, n);
    // Half the runs carry a sorted index on `d` so the index range/early-term paths are fuzzed too,
    // and half use the raw column scan floor — both must equal the oracle identically.
    const sorted = rng.chance(0.5) ? ['d'] : [];
    const table = buildTable(FIELDS, rows, sorted);
    const tree = randomTree(rng, FIELDS, { maxDepth: 3, maxBranch: 3, coverage: cov });

    const engine = table.scanTree(tree).toArray();
    const oracle = oracleMatch(types, rows, tree);
    runMatrix(engine, oracle, { seed, node: tree, rows, label: `iter ${i} n=${n} sorted=${sorted.length > 0}` });
  }

  // Every legal date operator must have been exercised, plus each boolean-combination class.
  cov.assertCoverage(
    DATE_OPS.map((op) => ['date', op] as ['date', typeof op]),
    ['and', 'or', 'not', 'emptyAnd', 'emptyOr'],
  );
});

// ===========================================================================
// 2. Shape invariance — Date / ISO / number for the SAME instant agree exactly.
// ===========================================================================

test('date fuzz: same instant as Date|ISO|number yields identical results (cell AND predicate)', () => {
  const SWEEP = 200; // instants
  const fields: FieldSpec[] = [{ name: 'd', type: 'date', nullRate: 0.12, cardinality: 'medium' }];
  const types = fieldTypeMap(fields);
  for (let i = 0; i < SWEEP; i++) {
    const seed = 0x5ade0000 + i * 40503;
    const rng = new Rng(seed);
    const n = rng.intBetween(2_000, 6_000);

    // Pick a pool of base instants spanning pre-1970 through ~2030.
    const base = Date.UTC(1969, 0, 1);
    const span = (2030 - 1969) * 365;
    const instants: number[] = [];
    const m = rng.intBetween(8, 24);
    for (let k = 0; k < m; k++) instants.push(base + rng.int(span) * DAY_MS + rng.int(DAY_MS));

    // Build rows where each non-null cell is the SAME instant rendered in a RANDOM shape.
    const rows: Row[] = [];
    for (let r = 0; r < n; r++) {
      if (rng.chance(fields[0]!.nullRate)) {
        rows.push({ d: null });
        continue;
      }
      const ms = instants[rng.int(instants.length)]!;
      const shape = rng.int(3);
      const cell = shape === 0 ? ms : shape === 1 ? new Date(ms).toISOString() : (new Date(ms) as unknown as Row['d']);
      rows.push({ d: cell });
    }
    const table = buildTable(fields, rows, rng.chance(0.5) ? ['d'] : []);

    // Probe each operator with the bound expressed three ways; all three must equal the oracle.
    const probe = instants[rng.int(instants.length)]!;
    const ops: Array<Predicate['op']> = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'];
    for (const op of ops) {
      const shapes: unknown[] =
        op === 'between'
          ? [
              [probe, probe + 30 * DAY_MS],
              [new Date(probe), new Date(probe + 30 * DAY_MS)],
              [new Date(probe).toISOString(), new Date(probe + 30 * DAY_MS).toISOString()],
            ]
          : [probe, new Date(probe), new Date(probe).toISOString()];

      const node0: FilterNode = { leaf: { field: 'd', op, value: shapes[0] } };
      const oracle = oracleMatch(types, rows, node0);
      for (const v of shapes) {
        const node: FilterNode = { leaf: { field: 'd', op, value: v } };
        const engine = table.scanTree(node).toArray();
        runMatrix(engine, oracle, { seed, node, rows, label: `shape ${op} ${String(v)}` });
      }
    }
  }
});

// ===========================================================================
// 3. Pre-1970 (negative epoch) dates.
// ===========================================================================

test('date fuzz: pre-1970 negative-epoch instants compare and order correctly', () => {
  const fields: FieldSpec[] = [{ name: 'd', type: 'date', nullRate: 0.15, cardinality: 'medium' }];
  const types = fieldTypeMap(fields);
  for (let i = 0; i < 120; i++) {
    const seed = 0x19690000 + i * 2246822519;
    const rng = new Rng(seed);
    const n = rng.intBetween(2_000, 8_000);
    // Instants centered on the epoch so both signs appear: ~1955..~1985.
    const base = Date.UTC(1955, 0, 1);
    const rows: Row[] = [];
    for (let r = 0; r < n; r++) {
      if (rng.chance(fields[0]!.nullRate)) {
        rows.push({ d: null });
        continue;
      }
      const ms = base + rng.int(30 * 365) * DAY_MS;
      const shape = rng.int(3);
      rows.push({ d: shape === 0 ? ms : shape === 1 ? new Date(ms).toISOString() : (new Date(ms) as unknown as Row['d']) });
    }
    const table = buildTable(fields, rows, ['d']);

    // A bound straddling the epoch (1970-01-01T00:00:00Z == 0) must split correctly with negatives.
    const bounds = [0, Date.UTC(1969, 11, 31), Date.UTC(1970, 0, 2), base];
    for (const b of bounds) {
      for (const op of ['gt', 'gte', 'lt', 'lte'] as const) {
        const node: FilterNode = { leaf: { field: 'd', op, value: b } };
        const engine = table.scanTree(node).toArray();
        const oracle = oracleMatch(types, rows, node);
        runMatrix(engine, oracle, { seed, node, rows, label: `neg-epoch ${op}@${b}` });
      }
    }
    // between spanning negative..positive epoch.
    const btw: FilterNode = { leaf: { field: 'd', op: 'between', value: [Date.UTC(1960, 0, 1), Date.UTC(1980, 0, 1)] } };
    runMatrix(table.scanTree(btw).toArray(), oracleMatch(types, rows, btw), { seed, node: btw, rows, label: 'neg-epoch between' });
  }
});

// ===========================================================================
// 4. Explicit edge cases — boundaries, capacity growth, null placement, absent values.
// ===========================================================================

/** Build a table of exactly `n` rows, ms[r]=base+r*DAY (ascending), with NULL rows at `nullAt`. */
function laddered(n: number, base: number, nullAt: Set<number>): { table: Table; rows: Row[] } {
  const rows: Row[] = [];
  for (let r = 0; r < n; r++) {
    if (nullAt.has(r)) rows.push({ d: null });
    else {
      const ms = base + r * DAY_MS;
      const shape = r % 3;
      rows.push({ d: shape === 0 ? ms : shape === 1 ? new Date(ms).toISOString() : (new Date(ms) as unknown as Row['d']) });
    }
  }
  const table = buildTable([{ name: 'd', type: 'date', nullRate: 0, cardinality: 'nearUnique' }], rows, ['d']);
  return { table, rows };
}

test('date fuzz: edge cases — empty/all/none, word boundaries, %32, capacity growth, null placement, absent values', () => {
  const types = fieldTypeMap([{ name: 'd', type: 'date', nullRate: 0, cardinality: 'nearUnique' }]);
  const base = Date.UTC(2000, 0, 1);
  const seed = 0xed6e;

  // Row counts that exercise bitset word boundaries (31/32/63/64), %32!=0, and capacity growth.
  const counts = [1, 31, 32, 33, 63, 64, 65, 100, 1023, 1024, 1025, 2000, 3001];

  for (const n of counts) {
    // (a) no nulls.
    {
      const { table, rows } = laddered(n, base, new Set());
      const lastMs = base + (n - 1) * DAY_MS;

      // ALL-match: between [base, lastMs] inclusive selects every row.
      const all: FilterNode = { leaf: { field: 'd', op: 'between', value: [base, lastMs] } };
      runMatrix(table.scanTree(all).toArray(), oracleMatch(types, rows, all), { seed, node: all, rows, label: `all n=${n}` });

      // NONE-match: gt past the maximum selects nothing.
      const none: FilterNode = { leaf: { field: 'd', op: 'gt', value: lastMs } };
      runMatrix(table.scanTree(none).toArray(), oracleMatch(types, rows, none), { seed, node: none, rows, label: `none n=${n}` });

      // EMPTY 'in' => nothing; never-seen value => nothing.
      const emptyIn: FilterNode = { leaf: { field: 'd', op: 'in', value: [] } };
      runMatrix(table.scanTree(emptyIn).toArray(), oracleMatch(types, rows, emptyIn), { seed, node: emptyIn, rows, label: `emptyIn n=${n}` });
      const absent: FilterNode = { leaf: { field: 'd', op: 'eq', value: base + (n + 5000) * DAY_MS } };
      runMatrix(table.scanTree(absent).toArray(), oracleMatch(types, rows, absent), { seed, node: absent, rows, label: `absent n=${n}` });

      // Word-boundary slices: gte at the boundary row, lt at the boundary row.
      for (const bnd of [31, 32, 63, 64].filter((b) => b < n)) {
        const gteB: FilterNode = { leaf: { field: 'd', op: 'gte', value: base + bnd * DAY_MS } };
        runMatrix(table.scanTree(gteB).toArray(), oracleMatch(types, rows, gteB), { seed, node: gteB, rows, label: `gte@${bnd} n=${n}` });
        const ltB: FilterNode = { leaf: { field: 'd', op: 'lt', value: base + bnd * DAY_MS } };
        runMatrix(table.scanTree(ltB).toArray(), oracleMatch(types, rows, ltB), { seed, node: ltB, rows, label: `lt@${bnd} n=${n}` });
      }

      // reversed between => empty (lo>hi). Only strictly reversed when n>=2 (else lastMs==base => point).
      if (n >= 2) {
        const rev: FilterNode = { leaf: { field: 'd', op: 'between', value: [lastMs, base] } };
        assert.deepEqual(table.scanTree(rev).toArray(), [], `reversed between must be empty n=${n}`);
        assert.deepEqual(oracleMatch(types, rows, rev), [], `oracle reversed between must be empty n=${n}`);
      }
    }

    // (b) NULL rows placed exactly at the word boundaries and at the ends.
    if (n >= 2) {
      const nullAt = new Set<number>([0, n - 1]);
      for (const b of [31, 32, 63, 64]) if (b < n) nullAt.add(b);
      const { table, rows } = laddered(n, base, nullAt);

      // $null / $notNull surface exactly the placed nulls / the rest.
      const isN: FilterNode = { leaf: { field: 'd', op: 'null', value: null } };
      runMatrix(table.scanTree(isN).toArray(), oracleMatch(types, rows, isN), { seed, node: isN, rows, label: `isNull n=${n}` });
      const notN: FilterNode = { leaf: { field: 'd', op: 'notNull', value: null } };
      runMatrix(table.scanTree(notN).toArray(), oracleMatch(types, rows, notN), { seed, node: notN, rows, label: `notNull n=${n}` });

      // $eq 0 must NOT match the NULL sentinel-0 rows (and no real row sits at epoch 0 here).
      const eq0: FilterNode = { leaf: { field: 'd', op: 'eq', value: 0 } };
      assert.deepEqual(table.scanTree(eq0).toArray(), [], `eq 0 must not match null sentinels n=${n}`);
      runMatrix(table.scanTree(eq0).toArray(), oracleMatch(types, rows, eq0), { seed, node: eq0, rows, label: `eq0 n=${n}` });

      // $ne / $notIn must EXCLUDE the null rows.
      const lastReal = base + (n - 1) * DAY_MS;
      const ne: FilterNode = { leaf: { field: 'd', op: 'ne', value: lastReal } };
      const eng = table.scanTree(ne).toArray();
      runMatrix(eng, oracleMatch(types, rows, ne), { seed, node: ne, rows, label: `ne n=${n}` });
      for (const r of eng) assert.ok(!nullAt.has(r), `ne leaked null row ${r} n=${n}`);

      const notIn: FilterNode = { leaf: { field: 'd', op: 'notIn', value: [base + DAY_MS, base + 2 * DAY_MS] } };
      const engNI = table.scanTree(notIn).toArray();
      runMatrix(engNI, oracleMatch(types, rows, notIn), { seed, node: notIn, rows, label: `notIn n=${n}` });
      for (const r of engNI) assert.ok(!nullAt.has(r), `notIn leaked null row ${r} n=${n}`);
    }
  }
});

// ===========================================================================
// 5. Reject NaN / nanosecond-magnitude at the edge (insert + predicate).
// ===========================================================================

test('date fuzz: NaN and nanosecond-magnitude inputs are rejected at insert and at predicate', () => {
  const defs: FieldDef[] = [{ name: 'd', type: 'date' }];
  const t = new Table(defs);
  t.createSortedIndex('d');

  // Note: 2**53 +/- 1 round back to 2**53 as f64, so they are NOT out-of-range; use clearly-larger
  // magnitudes (nanosecond-scale epochs and 2**54) which exceed the exact-f64 epoch ceiling.
  const bad: unknown[] = [NaN, 'not-a-date', new Date('garbage'), Date.now() * 1_000_000, 2 ** 54, -(2 ** 54)];
  for (const v of bad) {
    assert.throws(() => t.insert({ d: v as never }), /did not parse|out of range/, `insert(${String(v)}) must throw`);
    // The independent oracle's coercion must reject the same inputs (keeps the gold reference honest).
    assert.throws(() => oracleCoerceDate(v), `oracleCoerceDate(${String(v)}) must throw`);
  }

  // A valid row, then a bad PREDICATE bound must throw when the predicate runs.
  t.insert({ d: Date.UTC(2026, 0, 1) });
  t.warmIndexes();
  for (const v of [NaN, 'nope', Date.now() * 1_000_000]) {
    assert.throws(() => t.scan([{ field: 'd', op: 'gt', value: v as never }]), /did not parse|out of range/, `predicate gt ${String(v)}`);
  }
  // Edge instants AT the safe boundary (+/- 2^53) are accepted (not rejected).
  assert.doesNotThrow(() => oracleCoerceDate(2 ** 53));
  assert.doesNotThrow(() => oracleCoerceDate(-(2 ** 53)));
  const ok = new Table(defs);
  assert.doesNotThrow(() => ok.insert({ d: 2 ** 53 }));
  assert.doesNotThrow(() => ok.insert({ d: -(2 ** 53) }));
});

// ===========================================================================
// 6. Large-N smoke — ONE 1M-row table, COUNT-ONLY typed oracle (no O(n) tree fuzzing at scale).
// ===========================================================================

test('date fuzz: 1,000,000-row scale smoke via a count-only typed oracle', () => {
  const N = 1_000_000;
  const defs: FieldDef[] = [{ name: 'd', type: 'date' }];
  const t = new Table(defs);
  t.createSortedIndex('d');

  const rng = new Rng(0x1a000000);
  const base = Date.UTC(1965, 0, 1); // start pre-1970 so negative-epoch rows are in the mix.
  const span = 80 * 365; // ~1965..2045
  const NULL_EVERY = 7;
  // Keep a plain typed array of stored ms (null => sentinel marker) for the cheap count oracle.
  const stored = new Float64Array(N);
  const isNull = new Uint8Array(N);
  for (let r = 0; r < N; r++) {
    if (r % NULL_EVERY === 0) {
      t.insert({ d: null });
      isNull[r] = 1;
      continue;
    }
    const ms = base + (rng.int(span) * DAY_MS) + rng.int(DAY_MS);
    // Mix shapes even at scale to exercise the coercion path on the hot insert loop.
    const shape = r % 3;
    t.insert({ d: shape === 0 ? ms : shape === 1 ? new Date(ms).toISOString() : (new Date(ms) as unknown as never) });
    stored[r] = ms;
  }
  t.warmIndexes();
  assert.equal(t.rowCount, N);

  /** Cheap COUNT-only oracle: a single typed loop, three-valued (nulls never match a comparison). */
  const countOp = (op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq', bound: number): number => {
    let c = 0;
    for (let r = 0; r < N; r++) {
      if (isNull[r]) continue;
      const v = stored[r]!;
      if (op === 'gt' ? v > bound : op === 'gte' ? v >= bound : op === 'lt' ? v < bound : op === 'lte' ? v <= bound : v === bound) c++;
    }
    return c;
  };
  const countBetween = (lo: number, hi: number): number => {
    if (lo > hi) return 0;
    let c = 0;
    for (let r = 0; r < N; r++) {
      if (isNull[r]) continue;
      const v = stored[r]!;
      if (v >= lo && v <= hi) c++;
    }
    return c;
  };

  const bounds = [0, base, Date.UTC(1990, 0, 1), Date.UTC(2010, 6, 15), base + span * DAY_MS];
  for (const b of bounds) {
    for (const op of ['gt', 'gte', 'lt', 'lte'] as const) {
      // Bound as a number AND as a Date — both must agree with the count-only oracle (shape invariance at scale).
      assert.equal(t.scan([{ field: 'd', op, value: b }]).count(), countOp(op, b), `${op}@${b} number`);
      assert.equal(t.scan([{ field: 'd', op, value: new Date(b) }]).count(), countOp(op, b), `${op}@${b} Date`);
    }
  }
  assert.equal(
    t.scan([{ field: 'd', op: 'between', value: [Date.UTC(1980, 0, 1), Date.UTC(2020, 0, 1)] }]).count(),
    countBetween(Date.UTC(1980, 0, 1), Date.UTC(2020, 0, 1)),
  );
  // reversed between at scale => empty.
  assert.equal(t.scan([{ field: 'd', op: 'between', value: [Date.UTC(2020, 0, 1), Date.UTC(1980, 0, 1)] }]).count(), 0);

  // $null / $notNull counts at scale.
  const nulls = Math.ceil(N / NULL_EVERY); // rows 0,7,14,... => indices divisible by 7.
  assert.equal(t.scan([{ field: 'd', op: 'null', value: null }]).count(), nulls);
  assert.equal(t.scan([{ field: 'd', op: 'notNull', value: null }]).count(), N - nulls);
  // $eq 0 must not match the NULL sentinels at scale (unless a real row happens to land on epoch 0).
  assert.equal(t.scan([{ field: 'd', op: 'eq', value: 0 }]).count(), countOp('eq', 0));
});
