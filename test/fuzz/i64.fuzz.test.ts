/**
 * PHASE 2 — Property-based fuzz for the i64 segment (exact int64 via BigInt64Array).
 *
 * Mirrors numeric.fuzz.test.ts but over EXACT bigints: the oracle compares with native bigint
 * `===`/`<`/`>` (engine-independent, exact above 2^53), so a > 2^53 value, the ±2^63 boundaries, and
 * mixed-sign ordering are all asserted against the truth the engine must match — never an f64 that
 * would collapse adjacent large integers. No mocks; the real Table drives scanTree/query.
 *
 * Matrix: eq ne in notIn gt gte lt lte between null notNull; with/without sorted+eq indexes; null
 * rates 0 / 15 / 40%; values include 2^53, 2^53+1, ±2^63, and mixed sign.
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
  type FieldSpec,
  type Row,
} from './harness.ts';
import type { ScanOp } from '../../src/store/column.ts';

const I64_OPS: ScanOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'notIn', 'null', 'notNull'];

function buildTable(fields: FieldSpec[], rows: Row[]): Table {
  const defs: FieldDef[] = fields.map((f) => ({ name: f.name, type: f.type }));
  const t = new Table(defs);
  for (const r of rows) t.insert(r);
  return t;
}

type IndexConfig = 'none' | 'eq' | 'sorted' | 'both';

function applyIndexes(t: Table, fields: FieldSpec[], cfg: IndexConfig): void {
  if (cfg === 'none') return;
  for (const f of fields) {
    if (cfg === 'eq' || cfg === 'both') t.createEqIndex(f.name);
    if (cfg === 'sorted' || cfg === 'both') t.createSortedIndex(f.name);
  }
  t.warmIndexes();
}

test('i64 fuzz: scanTree matches the bigint oracle across the matrix', () => {
  const baseFields: FieldSpec[] = [
    { name: 'a', type: 'i64', nullRate: 0, cardinality: 'medium' },
    { name: 'b', type: 'i64', nullRate: 0, cardinality: 'low' },
  ];
  const cov = new Coverage();
  const configs: IndexConfig[] = ['none', 'eq', 'sorted', 'both'];
  const nullRates = [0, 0.15, 0.4];
  const PER = 120;

  let queryCount = 0;
  for (const cfg of configs) {
    for (const nr of nullRates) {
      const fields: FieldSpec[] = baseFields.map((f) => ({ ...f, nullRate: nr }));
      const types = fieldTypeMap(fields);
      for (let i = 0; i < PER; i++) {
        const seed = (0x16400000 ^ Math.imul(configs.indexOf(cfg) + 1, 0x9e3779b1) ^ Math.imul(Math.round(nr * 100) + 1, 0x85ebca77) ^ Math.imul(i + 1, 0xc2b2ae35)) >>> 0;
        const rng = new Rng(seed);
        const n = rng.intBetween(1000, 4000);
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

  const expected: Array<['i64', ScanOp]> = I64_OPS.map((op) => ['i64', op]);
  cov.assertCoverage(expected, ['and', 'or', 'not']);
  assert.ok(queryCount >= 1000, `ran ${queryCount} queries`);
});

test('i64 fuzz: every op in isolation agrees across index configs (with 2^53 / ±2^63 boundaries)', () => {
  const fields: FieldSpec[] = [{ name: 'a', type: 'i64', nullRate: 0.15, cardinality: 'medium' }];
  const types = fieldTypeMap(fields);
  const configs: IndexConfig[] = ['none', 'eq', 'sorted', 'both'];

  const I64_MAX = 2n ** 63n - 1n;
  const I64_MIN = -(2n ** 63n);
  const leafValueFor = (rng: Rng, op: ScanOp): unknown => {
    const edges: bigint[] = [0n, 1n, -1n, 9007199254740992n, 9007199254740993n, I64_MAX, I64_MIN];
    const pick = () => (rng.chance(0.4) ? rng.pick(edges) : BigInt(rng.intBetween(-1000, 1000)));
    if (op === 'null' || op === 'notNull') return null;
    if (op === 'in' || op === 'notIn') {
      const k = rng.int(4);
      const arr: bigint[] = [];
      for (let j = 0; j < k; j++) arr.push(pick());
      return arr;
    }
    if (op === 'between') {
      const a = pick();
      const b = pick();
      if (rng.chance(0.2)) return [b, a];
      return [a < b ? a : b, a < b ? b : a];
    }
    return pick();
  };

  let count = 0;
  for (let trial = 0; trial < 80; trial++) {
    const seed = (0x1a64_0000 ^ Math.imul(trial + 1, 0x27d4eb2f)) >>> 0;
    const rng = new Rng(seed);
    const n = rng.intBetween(1000, 4000);
    const { rows } = generateRows(rng, fields, n);
    const tables = configs.map((cfg) => { const tb = buildTable(fields, rows); applyIndexes(tb, fields, cfg); return tb; });
    for (const op of I64_OPS) {
      const value = leafValueFor(rng, op);
      const node: FilterNode = { leaf: { field: 'a', op, value } as Predicate };
      const oracle = oracleMatch(types, rows, node);
      for (let c = 0; c < configs.length; c++) {
        const engine = tables[c]!.scanTree(node).toArray();
        runMatrix(engine, oracle, { seed, node, rows, label: `op=${op} cfg=${configs[c]}` });
        count++;
      }
    }
  }
  assert.ok(count > 0);
});
