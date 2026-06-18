/**
 * PHASE 2 — Property-based fuzz for the NUMERIC segment (i32 + f64).
 *
 * Strategy
 * --------
 * The shared harness (./harness.ts) supplies: a seeded LCG RNG, per-schema row generators with a
 * configurable null-rate, a random-FilterNode generator that draws only legal (type, op) leaves,
 * the INDEPENDENT brute-force oracle, the `runMatrix` asserter (seed + minimal repro on mismatch),
 * and a coverage registry. We never mock; the engine drives the real `Table`/`scanTree`/`query`
 * and is asserted equal to the oracle on EVERY query.
 *
 * Matrix covered (i32 AND f64):
 *   eq ne in notIn gt gte lt lte between null notNull
 *   over negatives, zero, floats and -0.0; with/without a sorted index; with/without an eq index;
 *   null rates 0 / 15 / 40%.
 * (The harness's OPS_BY_TYPE for i32/f64 is exactly this op set — no eqi/nei/substring leaks in for
 *  numeric columns — so a numeric-only schema makes the generator produce only matrix ops.)
 *
 * Why query COUNT, not row COUNT, drives coverage: the oracle is O(n) per query, so we run a few
 * THOUSAND randomized queries at MODERATE N (2k–8k rows here) and a small set of explicit edge
 * cases, then a few large-N (up to 1,000,000) SMOKE checks that use a CHEAP count-only oracle so we
 * never run thousands of O(n) oracle passes at 1M.
 *
 * Chosen sizes (logged, never silently truncated):
 *   - Main matrix: 4 index-configs × 3 null-rates × ~260 queries each = ~3,120 randomized queries,
 *     each over N in [2000, 8000]. Index configs: {none, eq-only, sorted-only, eq+sorted}.
 *   - Edge cases: explicit constructions at boundary row counts (31/32/63/64/65/1023/1024/1025/2000).
 *   - Large-N smoke: N in {250k, 1_000_000}, count-only oracle, a handful of single-leaf predicates.
 * Total runtime target: well under 20s on Node 24 type-stripping.
 *
 * Erasable-TS only: string-literal unions, `.ts` import extensions, no enums/namespaces.
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
  oracleNodeMatch,
  fieldTypeMap,
  type FieldSpec,
  type Row,
} from './harness.ts';
import type { ScanOp } from '../../src/store/column.ts';

// The numeric matrix operator set (mirrors harness OPS_BY_TYPE for i32/f64).
const NUMERIC_OPS: ScanOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'notIn', 'null', 'notNull'];

function buildTable(fields: FieldSpec[], rows: Row[]): Table {
  const defs: FieldDef[] = fields.map((f) => ({ name: f.name, type: f.type }));
  const t = new Table(defs);
  for (const r of rows) t.insert(r);
  return t;
}

/** Index configuration applied to a freshly built table before scanning. */
type IndexConfig = 'none' | 'eq' | 'sorted' | 'both';

function applyIndexes(t: Table, fields: FieldSpec[], cfg: IndexConfig): void {
  if (cfg === 'none') return;
  for (const f of fields) {
    if (cfg === 'eq' || cfg === 'both') t.createEqIndex(f.name);
    if (cfg === 'sorted' || cfg === 'both') t.createSortedIndex(f.name);
  }
  t.warmIndexes();
}

// ===========================================================================
// 1. Main randomized matrix — engine == oracle on every query.
// ===========================================================================

test('numeric fuzz: i32+f64 scanTree matches the independent oracle across the matrix', () => {
  // Two numeric columns of differing cardinality so eq/in are non-trivial AND range ops have spread.
  // (Null rate is overridden per sub-run below.)
  const baseFields: FieldSpec[] = [
    { name: 'i', type: 'i32', nullRate: 0, cardinality: 'medium' },
    { name: 'f', type: 'f64', nullRate: 0, cardinality: 'medium' },
  ];

  const cov = new Coverage();
  const configs: IndexConfig[] = ['none', 'eq', 'sorted', 'both'];
  const nullRates = [0, 0.15, 0.4];
  const PER = 260; // queries per (config × nullRate) cell — ~3,120 total randomized queries.

  let queryCount = 0;
  for (const cfg of configs) {
    for (const nr of nullRates) {
      const fields: FieldSpec[] = baseFields.map((f) => ({ ...f, nullRate: nr }));
      const types = fieldTypeMap(fields);
      for (let i = 0; i < PER; i++) {
        const seed = (0x5eed_0000 ^ Math.imul(configs.indexOf(cfg) + 1, 0x9e3779b1) ^ Math.imul(Math.round(nr * 100) + 1, 0x85ebca77) ^ Math.imul(i + 1, 0xc2b2ae35)) >>> 0;
        const rng = new Rng(seed);
        const n = rng.intBetween(2000, 8000);
        const { rows } = generateRows(rng, fields, n);
        const table = buildTable(fields, rows);
        applyIndexes(table, fields, cfg);

        const tree = randomTree(rng, fields, { maxDepth: 3, maxBranch: 3, coverage: cov });
        const engine = table.scanTree(tree).toArray();
        const oracle = oracleMatch(types, rows, tree);
        runMatrix(engine, oracle, { seed, node: tree, rows, label: `cfg=${cfg} nr=${nr} iter ${i}` });
        queryCount++;
      }
    }
  }

  // Every numeric (type, op) in the matrix must have been exercised at least once.
  const expected: Array<['i32' | 'f64', ScanOp]> = [];
  for (const op of NUMERIC_OPS) {
    expected.push(['i32', op]);
    expected.push(['f64', op]);
  }
  cov.assertCoverage(expected, ['and', 'or', 'not', 'emptyAnd', 'emptyOr']);
  assert.ok(queryCount >= 3000, `expected a few thousand queries, ran ${queryCount}`);
});

// ===========================================================================
// 2. Single-leaf op sweep — every matrix op directly, across index configs.
//    Guarantees each operator is asserted in isolation (not just buried in a tree),
//    and that index-accelerated and scan paths agree byte-for-byte.
// ===========================================================================

test('numeric fuzz: every matrix op in isolation agrees across all index configs', () => {
  const fields: FieldSpec[] = [
    { name: 'i', type: 'i32', nullRate: 0.15, cardinality: 'medium' },
    { name: 'f', type: 'f64', nullRate: 0.15, cardinality: 'medium' },
  ];
  const types = fieldTypeMap(fields);
  const configs: IndexConfig[] = ['none', 'eq', 'sorted', 'both'];

  let count = 0;
  for (let trial = 0; trial < 120; trial++) {
    const seed = (0xa11_0000 ^ Math.imul(trial + 1, 0x27d4eb2f)) >>> 0;
    const rng = new Rng(seed);
    const n = rng.intBetween(2000, 6000);
    const { rows } = generateRows(rng, fields, n);

    // One value-set per trial; reuse across configs so all four index paths see identical data.
    const tables = configs.map((cfg) => {
      const tb = buildTable(fields, rows);
      applyIndexes(tb, fields, cfg);
      return tb;
    });

    for (const fname of ['i', 'f'] as const) {
      for (const op of NUMERIC_OPS) {
        // Pin field+op so the sweep is exhaustive rather than random over fields/ops; the value is
        // drawn from the row universe + edge values (0, empty-in, reversed/point between).
        const ftype = fname === 'i' ? 'i32' : 'f64';
        const value = leafValueFor(rng, ftype, op);
        const pred: Predicate = { field: fname, op, value };
        const node: FilterNode = { leaf: pred };

        const oracle = oracleMatch(types, rows, node);
        for (let c = 0; c < configs.length; c++) {
          const engine = tables[c]!.scanTree(node).toArray();
          runMatrix(engine, oracle, { seed, node, rows, label: `op=${op} field=${fname} cfg=${configs[c]}` });
          count++;
        }
      }
    }
  }
  assert.ok(count > 0);
});

/** Produce a predicate value for (numeric type, op) drawn from the row universe + edge values. */
function leafValueFor(rng: Rng, type: 'i32' | 'f64', op: ScanOp): unknown {
  const pickNum = () => (type === 'i32' ? rng.intBetween(-50, 50) : Math.round(rng.intBetween(-100, 100) * 10) / 10);
  if (op === 'null' || op === 'notNull') return null;
  if (op === 'in' || op === 'notIn') {
    const k = rng.int(4); // include empty 'in' => matches nothing.
    const arr: number[] = [];
    for (let j = 0; j < k; j++) arr.push(rng.chance(0.25) ? 0 : pickNum());
    return arr;
  }
  if (op === 'between') {
    const a = pickNum();
    const b = pickNum();
    if (rng.chance(0.2)) return [b, a]; // reversed => empty (lo>hi).
    if (rng.chance(0.15)) return [a, a]; // single point => equality (lo==hi).
    return [Math.min(a, b), Math.max(a, b)];
  }
  // Bias toward 0 sometimes so the "$eq 0 must not hit a NULL sentinel-0 row" corner is hit.
  return rng.chance(0.2) ? 0 : pickNum();
}

// ===========================================================================
// 3. Explicit EDGE cases — handcrafted rows, asserted against the oracle.
// ===========================================================================

test('numeric fuzz: explicit edge cases (empty/all/none, word boundaries, capacity growth, -0.0)', () => {
  const fields: FieldSpec[] = [
    { name: 'i', type: 'i32', nullRate: 0, cardinality: 'medium' },
    { name: 'f', type: 'f64', nullRate: 0, cardinality: 'medium' },
  ];
  const types = fieldTypeMap(fields);

  // Helper: build rows where 'i' = idx, 'f' = idx, then poke specific cells.
  const mkRows = (n: number): Row[] => {
    const rows: Row[] = [];
    for (let k = 0; k < n; k++) rows.push({ i: k % 100 === 0 ? 0 : k - n / 2 | 0, f: (k - n / 2) / 2 });
    return rows;
  };

  // Boundary row counts: rows exactly at/around bitset word edges (31/32/63/64/65) and capacity
  // edges (1023/1024/1025), plus a non-word-multiple count, and a mid-size count.
  const sizes = [1, 2, 31, 32, 33, 63, 64, 65, 127, 128, 129, 1000, 1023, 1024, 1025, 2000, 3001];
  for (const n of sizes) {
    const rows = mkRows(n);
    // Place NULLs precisely at boundary rows to exercise null-bit word edges.
    for (const b of [0, 30, 31, 32, 63, 64, n - 1]) {
      if (b >= 0 && b < n) rows[b]!.i = null;
    }
    const table = buildTable(fields, rows);
    const cases: FilterNode[] = [
      { leaf: { field: 'i', op: 'gte', value: -1_000_000 } }, // all i32-non-null match (all-match minus nulls).
      { leaf: { field: 'i', op: 'lt', value: -1_000_000 } }, // none-match.
      { leaf: { field: 'i', op: 'null', value: null } }, // exactly the null rows at boundaries.
      { leaf: { field: 'i', op: 'notNull', value: null } },
      { leaf: { field: 'i', op: 'eq', value: 0 } }, // must NOT match a NULL sentinel-0 row.
      { leaf: { field: 'i', op: 'ne', value: 0 } }, // excludes nulls AND the real-0 rows.
      { leaf: { field: 'i', op: 'in', value: [] } }, // empty in => nothing.
      { leaf: { field: 'i', op: 'notIn', value: [0] } }, // excludes nulls AND 0.
      { leaf: { field: 'i', op: 'between', value: [5, 1] } }, // reversed => empty.
      { op: 'and', children: [] }, // empty AND => all rows.
      { op: 'or', children: [] }, // empty OR => no rows.
    ];
    for (const cfg of ['none', 'eq', 'sorted', 'both'] as IndexConfig[]) {
      const t = cfg === 'none' ? table : (() => { const tt = buildTable(fields, rows); applyIndexes(tt, fields, cfg); return tt; })();
      for (const node of cases) {
        const engine = t.scanTree(node).toArray();
        const oracle = oracleMatch(types, rows, node);
        runMatrix(engine, oracle, { seed: n, node, rows, label: `edge n=${n} cfg=${cfg}` });
      }
    }
  }

  // -0.0 vs 0.0 and negative-zero equality on f64: JS `===` treats -0 === 0, and the oracle uses
  // `cell === value`, so the engine must agree (a row with -0.0 matches $eq 0 and vice-versa).
  {
    const rows: Row[] = [{ i: 1, f: -0 }, { i: 2, f: 0 }, { i: 3, f: 1.5 }, { i: 4, f: -1.5 }, { i: 5, f: null }];
    const table = buildTable(fields, rows);
    const cases: FilterNode[] = [
      { leaf: { field: 'f', op: 'eq', value: 0 } },
      { leaf: { field: 'f', op: 'eq', value: -0 } },
      { leaf: { field: 'f', op: 'in', value: [0] } },
      { leaf: { field: 'f', op: 'between', value: [-0, 0] } },
      { leaf: { field: 'f', op: 'gte', value: 0 } },
      { leaf: { field: 'f', op: 'lte', value: -0 } },
      { leaf: { field: 'f', op: 'ne', value: 0 } },
    ];
    for (const node of cases) {
      const engine = table.scanTree(node).toArray();
      const oracle = oracleMatch(types, rows, node);
      runMatrix(engine, oracle, { seed: 0xbeef, node, rows, label: 'neg-zero' });
    }
  }

  // Absent / never-seen values: a predicate value outside the entire value universe.
  {
    const rows = mkRows(500);
    const table = buildTable(fields, rows);
    const cases: FilterNode[] = [
      { leaf: { field: 'i', op: 'eq', value: 9_999_999 } }, // never seen => none.
      { leaf: { field: 'i', op: 'in', value: [9_999_999, -9_999_999] } }, // none.
      { leaf: { field: 'i', op: 'ne', value: 9_999_999 } }, // all non-null.
      { leaf: { field: 'i', op: 'notIn', value: [9_999_999] } }, // all non-null.
    ];
    for (const cfg of ['none', 'eq', 'sorted', 'both'] as IndexConfig[]) {
      const t = buildTable(fields, rows);
      applyIndexes(t, fields, cfg);
      for (const node of cases) {
        const engine = t.scanTree(node).toArray();
        const oracle = oracleMatch(types, rows, node);
        runMatrix(engine, oracle, { seed: 0xab5e7, node, rows, label: `absent cfg=${cfg}` });
      }
    }
  }
});

// ===========================================================================
// 4. Large-N SMOKE — CHEAP count-only oracle (single typed loop), no thousands of O(n) passes.
// ===========================================================================

test('numeric fuzz: large-N smoke with a cheap count-only oracle', () => {
  // Chosen sizes (logged): 250_000 and 1_000_000 rows. We run only a HANDFUL of single-leaf
  // predicates per size and compare engine RESULT-COUNT to a cheap typed-loop count (not a full
  // id-list oracle), so total work stays bounded even at 1M rows.
  const fields: FieldSpec[] = [
    { name: 'i', type: 'i32', nullRate: 0.15, cardinality: 'medium' },
    { name: 'f', type: 'f64', nullRate: 0.15, cardinality: 'medium' },
  ];

  for (const n of [250_000, 1_000_000]) {
    const seed = (0x1a860000 ^ n) >>> 0;
    const rng = new Rng(seed);
    const { rows } = generateRows(rng, fields, n);
    const table = buildTable(fields, rows);
    // Index one column to exercise an index-accelerated scale path; leave the other to full scan.
    table.createEqIndex('i');
    table.createSortedIndex('i');
    table.warmIndexes();

    // Cheap count-only oracle: a single typed loop per predicate, replicating three-valued logic.
    const countLeaf = (pred: Predicate): number => {
      let c = 0;
      const field = pred.field;
      for (let r = 0; r < n; r++) {
        const cell = rows[r]![field];
        const isNull = cell === null;
        if (pred.op === 'null') { if (isNull) c++; continue; }
        if (pred.op === 'notNull') { if (!isNull) c++; continue; }
        if (isNull) continue; // null matches no comparison.
        const x = cell as number;
        switch (pred.op) {
          case 'eq': if (x === pred.value) c++; break;
          case 'ne': if (x !== pred.value) c++; break;
          case 'gt': if (x > (pred.value as number)) c++; break;
          case 'gte': if (x >= (pred.value as number)) c++; break;
          case 'lt': if (x < (pred.value as number)) c++; break;
          case 'lte': if (x <= (pred.value as number)) c++; break;
          case 'between': { const [lo, hi] = pred.value as [number, number]; if (x >= lo && x <= hi) c++; break; }
          case 'in': if ((pred.value as number[]).includes(x)) c++; break;
          case 'notIn': if (!(pred.value as number[]).includes(x)) c++; break;
        }
      }
      return c;
    };

    const preds: Predicate[] = [
      { field: 'i', op: 'eq', value: 0 },
      { field: 'i', op: 'ne', value: 0 },
      { field: 'i', op: 'gte', value: 0 },
      { field: 'i', op: 'between', value: [-10, 10] },
      { field: 'i', op: 'in', value: [-50, 0, 50] },
      { field: 'i', op: 'notIn', value: [0] },
      { field: 'i', op: 'null', value: null },
      { field: 'i', op: 'notNull', value: null },
      { field: 'f', op: 'gt', value: 0 },
      { field: 'f', op: 'lte', value: 0 },
      { field: 'f', op: 'between', value: [-5, 5] },
    ];
    for (const pred of preds) {
      const node: FilterNode = { leaf: pred };
      const engineCount = table.scanTree(node).toArray().length;
      const oracleCount = countLeaf(pred);
      assert.equal(
        engineCount,
        oracleCount,
        `large-N smoke mismatch n=${n} pred=${JSON.stringify(pred)}: engine ${engineCount} vs oracle ${oracleCount} (SEED=${seed})`,
      );
    }
  }
});

// ===========================================================================
// 5. Sanity: the oracle's single-row evaluator agrees with its set evaluator (guards the harness).
// ===========================================================================

test('numeric fuzz: oracle set-match equals per-row node-match (harness self-consistency)', () => {
  const fields: FieldSpec[] = [
    { name: 'i', type: 'i32', nullRate: 0.4, cardinality: 'low' },
    { name: 'f', type: 'f64', nullRate: 0.4, cardinality: 'low' },
  ];
  const types = fieldTypeMap(fields);
  const rng = new Rng(0xfee1_900d);
  const { rows } = generateRows(rng, fields, 300);
  for (let t = 0; t < 50; t++) {
    const tree = randomTree(rng, fields, { maxDepth: 3, maxBranch: 3 });
    const viaSet = oracleMatch(types, rows, tree);
    const viaLoop: number[] = [];
    for (let r = 0; r < rows.length; r++) if (oracleNodeMatch(types, tree, rows[r]!)) viaLoop.push(r);
    assert.deepEqual(viaSet, viaLoop);
  }
});
