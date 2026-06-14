/**
 * PHASE 2 — Property-based fuzz test for the BOOLEAN segment.
 *
 * Drives the REAL engine (Table + the two-plane boolean EqIndex) against the INDEPENDENT brute
 * oracle from harness.ts, over MANY randomized queries, asserting engine == oracle every time.
 * No mocks. Deterministic seed: every iteration's seed is derived from a fixed base, so a failing
 * case prints (via runMatrix) the seed + the minimized predicate + a diverging row, and re-running
 * with that seed reproduces the exact rows + tree.
 *
 * Boolean operator matrix covered (asserted via the Coverage registry at the end):
 *   eq, ne, in, notIn, null, notNull   — with the two-plane eq index present.
 * `in`/`notIn` sets exercised: {true}, {false}, {true,false}, {} — see BOOL_IN_SETS below; the
 * Coverage assertion only proves each (type, op) pair fired, so we ALSO assert each in-set class
 * was used at least once (inSetsSeen) so the four set-shapes can't silently rot.
 *
 * Three-valued logic for bool (replicated by the oracle, asserted by us):
 *   - a NULL bool matches NO comparison op; only $null matches it, $notNull excludes it.
 *   - $ne true / $notIn [...] therefore EXCLUDE null rows.
 *   - the dense sentinel for a NULL bool is `false`; $eq false must NOT match a NULL row.
 *
 * SIZING (logged here so coverage is never silently truncated):
 *   - Main randomized pass: QUERIES = 4000 queries, each over a table of N in [2000, 20000] rows
 *     (re-using a small pool of tables keyed by row count to avoid rebuilding 4000 tables). The
 *     oracle is O(n)/query so coverage comes from query COUNT, not row count.
 *   - Edge pass: a handful of hand-built tables hitting bitset word boundaries (31/32/63/64),
 *     rowCount % 32 != 0, capacity growth past INITIAL_CAPACITY (1024), null rows at boundaries,
 *     and never-seen / absent values — each checked against the oracle for all 6 ops.
 *   - Large-N smoke: 3 tables up to 1_000_000 rows, checked with a CHEAP COUNT-ONLY oracle (a
 *     single typed loop per op), NOT the O(n) list oracle, and only a few ops — so we exercise the
 *     scale paths without running thousands of O(n) queries at 1M.
 * Target total runtime: well under ~20s.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef, type FilterNode, type Predicate } from '../../src/store/table.ts';
import {
  Rng,
  Coverage,
  generateRows,
  runMatrix,
  oracleMatch,
  oracleLeafMatch,
  fieldTypeMap,
  type FieldSpec,
  type Row,
} from './harness.ts';

// --- schema: a focused boolean segment. Two bool fields with different null rates so $null/$notNull
// and the three-valued $ne/$notIn paths get real null rows; a low-card i32 companion so nested
// and/or/not trees combine bool leaves with a second column (still asserts the bool leaves). ---
const FIELDS: FieldSpec[] = [
  { name: 'flag', type: 'bool', nullRate: 0.2, cardinality: 'low' },
  { name: 'active', type: 'bool', nullRate: 0.05, cardinality: 'low' },
  { name: 'n', type: 'i32', nullRate: 0.1, cardinality: 'low' },
];

const BOOL_OPS = ['eq', 'ne', 'in', 'notIn', 'null', 'notNull'] as const;
type BoolOp = (typeof BOOL_OPS)[number];

// The four in/notIn set shapes the matrix must cover.
const BOOL_IN_SETS: readonly boolean[][] = [[true], [false], [true, false], []];

function buildTable(fields: FieldSpec[], rows: Row[]): Table {
  const defs: FieldDef[] = fields.map((f) => ({ name: f.name, type: f.type }));
  const t = new Table(defs);
  for (const r of rows) t.insert(r);
  return t;
}

/** Build a table for the bool segment with the two-plane eq index on both bool fields, warmed. */
function buildIndexedTable(fields: FieldSpec[], rows: Row[]): Table {
  const t = buildTable(fields, rows);
  for (const f of fields) if (f.type === 'bool') t.createEqIndex(f.name);
  t.warmIndexes();
  return t;
}

/** A random boolean leaf, recording coverage + which in-set shape fired. */
function randomBoolLeaf(
  rng: Rng,
  fields: FieldSpec[],
  cov: Coverage,
  inSetsSeen: Set<string>,
): FilterNode {
  const boolFields = fields.filter((f) => f.type === 'bool');
  const f = rng.pick(boolFields);
  const op = rng.pick(BOOL_OPS) as BoolOp;
  let value: unknown = null;
  if (op === 'in' || op === 'notIn') {
    const set = rng.pick(BOOL_IN_SETS);
    value = set;
    inSetsSeen.add(JSON.stringify([...set].sort()));
  } else if (op === 'eq' || op === 'ne') {
    value = rng.chance(0.5);
  }
  cov.recordLeaf('bool', op);
  return { leaf: { field: f.name, op, value } };
}

/** A random small tree whose leaves are all bool (with occasional i32 leaves for combination). */
function randomBoolTree(
  rng: Rng,
  fields: FieldSpec[],
  cov: Coverage,
  inSetsSeen: Set<string>,
): FilterNode {
  const build = (depth: number): FilterNode => {
    if (depth <= 0 || rng.chance(0.45)) {
      // Mostly bool leaves; sometimes an i32 eq leaf to combine across columns.
      if (rng.chance(0.2)) {
        return { leaf: { field: 'n', op: 'eq', value: rng.intBetween(-50, 50) } };
      }
      return randomBoolLeaf(rng, fields, cov, inSetsSeen);
    }
    const kind = rng.int(3);
    if (kind === 2) {
      cov.recordCombo('not');
      return { op: 'not', children: [build(depth - 1)] };
    }
    const op: 'and' | 'or' = kind === 0 ? 'and' : 'or';
    const count = rng.intBetween(0, 3);
    const children: FilterNode[] = [];
    for (let i = 0; i < count; i++) children.push(build(depth - 1));
    cov.recordCombo(op);
    if (children.length === 0) cov.recordCombo(op === 'and' ? 'emptyAnd' : 'emptyOr');
    return { op, children };
  };
  return build(3);
}

// ===========================================================================
// Main randomized pass.
// ===========================================================================

test('bool fuzz: 4000 randomized queries vs the independent oracle (two-plane eq index)', () => {
  const cov = new Coverage();
  const inSetsSeen = new Set<string>();
  const types = fieldTypeMap(FIELDS);

  // Pre-build a small pool of indexed tables at varied row counts in [2000, 20000]. Each is reused
  // for ~QUERIES/pool queries; the oracle re-runs its O(n) loop per query against the same rows.
  const ROW_SIZES = [2000, 3137, 8192, 12000, 20000]; // includes %32!=0 (3137) and exact powers.
  const QUERIES = 4000;
  const tables: { table: Table; rows: Row[] }[] = [];
  for (let i = 0; i < ROW_SIZES.length; i++) {
    const seed = 0xb00100 + i * 2654435761;
    const rng = new Rng(seed);
    const { rows } = generateRows(rng, FIELDS, ROW_SIZES[i]!);
    tables.push({ table: buildIndexedTable(FIELDS, rows), rows });
  }

  // Sanity: the bool eq index chose the two-plane strategy (cardinality <= 2).
  for (const { table } of tables) {
    assert.equal(table.eqStrategy('flag'), 'plane', 'bool eq index must be the two-plane strategy');
    assert.equal(table.eqStrategy('active'), 'plane');
  }

  for (let q = 0; q < QUERIES; q++) {
    const seed = 0xfa57b001 ^ (q * 2246822519);
    const rng = new Rng(seed >>> 0);
    const sel = tables[q % tables.length]!;
    const tree = randomBoolTree(rng, FIELDS, cov, inSetsSeen);

    const engine = sel.table.scanTree(tree).toArray();
    const oracle = oracleMatch(types, sel.rows, tree);
    runMatrix(engine, oracle, { seed: seed >>> 0, node: tree, rows: sel.rows, label: `query ${q}` });
  }

  // Coverage: every bool (type, op) must have fired, and every in-set shape.
  cov.assertCoverage(
    BOOL_OPS.map((op) => ['bool', op] as ['bool', BoolOp]),
    ['and', 'or', 'not', 'emptyAnd', 'emptyOr'],
  );
  for (const set of BOOL_IN_SETS) {
    const key = JSON.stringify([...set].sort());
    assert.ok(inSetsSeen.has(key), `in/notIn set ${key} was never exercised`);
  }
});

// ===========================================================================
// Explicit edge cases — checked against the oracle for ALL six bool ops.
// ===========================================================================

/** Run all 6 bool ops (with both polarities / all in-sets) on a field and assert engine==oracle. */
function assertAllBoolOps(table: Table, rows: Row[], field: string, label: string): void {
  const types = fieldTypeMap(FIELDS);
  const preds: Predicate[] = [
    { field, op: 'eq', value: true },
    { field, op: 'eq', value: false },
    { field, op: 'ne', value: true },
    { field, op: 'ne', value: false },
    { field, op: 'null', value: null },
    { field, op: 'notNull', value: null },
    ...BOOL_IN_SETS.map((s) => ({ field, op: 'in' as const, value: s })),
    ...BOOL_IN_SETS.map((s) => ({ field, op: 'notIn' as const, value: s })),
  ];
  for (const p of preds) {
    const node: FilterNode = { leaf: p };
    const engine = table.scanTree(node).toArray();
    const oracle = oracleMatch(types, rows, node);
    runMatrix(engine, oracle, { seed: 0, node, rows, label: `${label} ${p.op}=${JSON.stringify(p.value)}` });
  }
}

test('bool fuzz: edge cases — boundaries, null placement, absent values, capacity growth', () => {
  // 1. Bitset word boundaries: tables sized exactly at and around 32 and 64 (31/32/33/63/64/65),
  //    each with a deliberate null at the boundary row and an all-true / all-false neighbour.
  for (const size of [31, 32, 33, 63, 64, 65, 1023, 1024, 1025]) {
    const rows: Row[] = [];
    for (let i = 0; i < size; i++) {
      // Place a null exactly at the last word-boundary index, alternate true/false elsewhere.
      let flag: boolean | null;
      if (i === size - 1 || i === 31 || i === 32 || i === 63 || i === 64) flag = null;
      else flag = i % 2 === 0;
      rows.push({ flag, active: i % 3 === 0, n: i % 7 });
    }
    const table = buildIndexedTable(FIELDS, rows);
    assertAllBoolOps(table, rows, 'flag', `boundary size=${size}`);
    assertAllBoolOps(table, rows, 'active', `boundary size=${size} active`);
  }

  // 2. All-match / none-match / empty-result degenerates.
  //    a) all flags true: $eq true => all, $eq false => none, $null => none, $notNull => all.
  const allTrue: Row[] = Array.from({ length: 100 }, () => ({ flag: true, active: true, n: 1 }));
  assertAllBoolOps(buildIndexedTable(FIELDS, allTrue), allTrue, 'flag', 'all-true');
  //    b) all null: only $null matches; $eq/$ne/$in/$notIn all empty.
  const allNull: Row[] = Array.from({ length: 100 }, () => ({ flag: null, active: null, n: null }));
  assertAllBoolOps(buildIndexedTable(FIELDS, allNull), allNull, 'flag', 'all-null');
  //    c) all false: $eq false => all (must NOT be confused with null sentinel-false).
  const allFalse: Row[] = Array.from({ length: 100 }, () => ({ flag: false, active: false, n: 0 }));
  assertAllBoolOps(buildIndexedTable(FIELDS, allFalse), allFalse, 'flag', 'all-false');

  // 3. Sentinel collision: a NULL bool stores the dense sentinel `false`. $eq false must NOT match
  //    the null rows, only the real-false rows. Interleave real-false and null rows.
  const sentinel: Row[] = [];
  for (let i = 0; i < 200; i++) sentinel.push({ flag: i % 2 === 0 ? false : null, active: true, n: 0 });
  const sentinelTable = buildIndexedTable(FIELDS, sentinel);
  {
    const types = fieldTypeMap(FIELDS);
    const eqFalse: FilterNode = { leaf: { field: 'flag', op: 'eq', value: false } };
    const eng = sentinelTable.scanTree(eqFalse).toArray();
    const ora = oracleMatch(types, sentinel, eqFalse);
    runMatrix(eng, ora, { seed: 0, node: eqFalse, rows: sentinel, label: 'sentinel $eq false' });
    // Direct invariant: exactly the 100 even rows match, none of the null rows.
    assert.equal(eng.length, 100, '$eq false must match only real-false rows, not null sentinels');
  }
  assertAllBoolOps(sentinelTable, sentinel, 'flag', 'sentinel');

  // 4. Capacity growth well past INITIAL_CAPACITY (1024): forces the column to re-grow its backing
  //    typed array several times; nulls scattered including at the new-capacity boundary.
  {
    const size = 5000;
    const rows: Row[] = [];
    for (let i = 0; i < size; i++) {
      rows.push({ flag: i % 5 === 0 ? null : i % 2 === 0, active: i % 4 === 0 ? null : true, n: i % 3 });
    }
    const table = buildIndexedTable(FIELDS, rows);
    assertAllBoolOps(table, rows, 'flag', 'growth flag');
    assertAllBoolOps(table, rows, 'active', 'growth active');
  }

  // 5. Absent / never-seen value: a column where EVERY row is the same value, then query the OTHER.
  //    $eq true on an all-false column => empty; $in {true} => empty; $notIn {false} => empty.
  {
    const rows: Row[] = Array.from({ length: 500 }, () => ({ flag: false, active: true, n: 0 }));
    const table = buildIndexedTable(FIELDS, rows);
    const types = fieldTypeMap(FIELDS);
    for (const p of [
      { field: 'flag', op: 'eq' as const, value: true },
      { field: 'flag', op: 'in' as const, value: [true] },
      { field: 'flag', op: 'notIn' as const, value: [false] },
    ]) {
      const node: FilterNode = { leaf: p };
      const eng = table.scanTree(node).toArray();
      const ora = oracleMatch(types, rows, node);
      runMatrix(eng, ora, { seed: 0, node, rows, label: `absent ${p.op}` });
      assert.equal(eng.length, 0, `never-seen value ${p.op} must be empty`);
    }
  }

  // 6. Missing-field insert (undefined => null bit set). Some rows omit `flag` entirely.
  {
    const rows: Row[] = [];
    for (let i = 0; i < 300; i++) {
      const r: Row = { active: true, n: i % 2 };
      if (i % 3 !== 0) r.flag = i % 2 === 0; // 1/3 of rows OMIT flag => NULL
      else r.flag = null;
      rows.push(r);
    }
    const table = buildIndexedTable(FIELDS, rows);
    assertAllBoolOps(table, rows, 'flag', 'missing-field');
  }
});

// ===========================================================================
// Large-N smoke — CHEAP count-only oracle, a few ops only. Do NOT run O(n) list oracle here.
// ===========================================================================

/** Count rows where bool field == target (non-null only) — a single typed loop, the cheap oracle. */
function countEq(rows: Row[], field: string, target: boolean): number {
  let c = 0;
  for (let i = 0; i < rows.length; i++) if (rows[i]![field] === target) c++;
  return c;
}
function countNull(rows: Row[], field: string): number {
  let c = 0;
  for (let i = 0; i < rows.length; i++) if (rows[i]![field] === null) c++;
  return c;
}

test('bool fuzz: large-N smoke (up to 1M rows, count-only cheap oracle)', () => {
  for (const size of [200_000, 500_000, 1_000_000]) {
    const seed = 0x5ca1e + size;
    const rng = new Rng(seed);
    const { rows } = generateRows(rng, FIELDS, size);
    const table = buildIndexedTable(FIELDS, rows);
    assert.equal(table.eqStrategy('flag'), 'plane');

    const nTrue = countEq(rows, 'flag', true);
    const nFalse = countEq(rows, 'flag', false);
    const nNull = countNull(rows, 'flag');
    const total = size;

    // $eq true / $eq false / $null counts (count-only — compare cardinality, not row lists).
    assert.equal(table.scanTree({ leaf: { field: 'flag', op: 'eq', value: true } }).count(), nTrue, `eq true @${size}`);
    assert.equal(table.scanTree({ leaf: { field: 'flag', op: 'eq', value: false } }).count(), nFalse, `eq false @${size}`);
    assert.equal(table.scanTree({ leaf: { field: 'flag', op: 'null', value: null } }).count(), nNull, `null @${size}`);
    // $notNull = total - null; $ne true = non-null AND not true = nFalse (three-valued: nulls excluded).
    assert.equal(table.scanTree({ leaf: { field: 'flag', op: 'notNull', value: null } }).count(), total - nNull, `notNull @${size}`);
    assert.equal(table.scanTree({ leaf: { field: 'flag', op: 'ne', value: true } }).count(), nFalse, `ne true @${size}`);
    // $in {true,false} = all non-null; $notIn {} = all non-null (null excluded by three-valued logic).
    assert.equal(table.scanTree({ leaf: { field: 'flag', op: 'in', value: [true, false] } }).count(), total - nNull, `in{t,f} @${size}`);
    assert.equal(table.scanTree({ leaf: { field: 'flag', op: 'notIn', value: [] } }).count(), total - nNull, `notIn{} @${size}`);
  }
});

// ===========================================================================
// Tiny direct three-valued invariants (belt-and-suspenders against the oracle itself).
// ===========================================================================

test('bool fuzz: three-valued leaf invariants match the oracle on a known table', () => {
  const types = fieldTypeMap(FIELDS);
  const rows: Row[] = [{ flag: true }, { flag: false }, { flag: null }];
  // $eq false matches only row 1; $ne true matches only row 1 (NOT the null); $null only row 2.
  assert.equal(oracleLeafMatch('bool', { field: 'flag', op: 'eq', value: false }, rows[2]!), false);
  const table = buildIndexedTable(FIELDS, rows);
  assert.deepEqual(table.scanTree({ leaf: { field: 'flag', op: 'eq', value: false } }).toArray(), [1]);
  assert.deepEqual(table.scanTree({ leaf: { field: 'flag', op: 'ne', value: true } }).toArray(), [1]);
  assert.deepEqual(table.scanTree({ leaf: { field: 'flag', op: 'null', value: null } }).toArray(), [2]);
  assert.deepEqual(table.scanTree({ leaf: { field: 'flag', op: 'notNull', value: null } }).toArray(), [0, 1]);
  assert.deepEqual(table.scanTree({ leaf: { field: 'flag', op: 'notIn', value: [true, false] } }).toArray(), []);
  assert.deepEqual(table.scanTree({ leaf: { field: 'flag', op: 'in', value: [] } }).toArray(), []);
});
