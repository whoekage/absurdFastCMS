/**
 * PHASE 2 — Property-based fuzz for the decimal segment (scaled-int64 mantissa via BigInt64Array).
 *
 * A `decimal` value is its scaled int64 MANTISSA — a bigint — so at a fixed scale the mantissa order
 * EQUALS the value order and decimal reuses the i64 ordering/eq path exactly. The fuzz therefore
 * compares against the SAME engine-independent bigint oracle as i64 (scale affects only the
 * materialized string, never filtering). Rows hold bigint mantissas inserted verbatim; the column
 * stores them as-is. No mocks; the real Table drives scanTree across index configs and null rates.
 *
 * Matrix: eq ne in notIn gt gte lt lte between null notNull; with/without sorted+eq indexes; null
 * rates 0 / 15 / 40%; scales 0 and 2; values include ±2^63 boundaries and the > 2^53 region.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef, type FilterNode, type Predicate } from '../../src/store/table.ts';
import { Engine } from '../../src/store/engine.ts';
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
import { coerceDecimal, formatDecimal, type ScanOp } from '../../src/store/column.ts';

const DEC_OPS: ScanOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'notIn', 'null', 'notNull'];

function buildTable(fields: FieldSpec[], rows: Row[]): Table {
  const defs: FieldDef[] = fields.map((f) => ({ name: f.name, type: f.type, scale: f.scale }));
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

test('decimal fuzz: scanTree matches the bigint-mantissa oracle across the matrix', () => {
  const cov = new Coverage();
  const configs: IndexConfig[] = ['none', 'eq', 'sorted', 'both'];
  const nullRates = [0, 0.15, 0.4];
  const scales = [0, 2];
  const PER = 70;

  let queryCount = 0;
  for (const scale of scales) {
    for (const cfg of configs) {
      for (const nr of nullRates) {
        const fields: FieldSpec[] = [
          { name: 'a', type: 'decimal', scale, nullRate: nr, cardinality: 'medium' },
          { name: 'b', type: 'decimal', scale, nullRate: nr, cardinality: 'low' },
        ];
        const types = fieldTypeMap(fields);
        for (let i = 0; i < PER; i++) {
          const seed = (0xdec00000 ^ Math.imul(scale + 1, 0x9e3779b1) ^ Math.imul(configs.indexOf(cfg) + 1, 0x85ebca77) ^ Math.imul(Math.round(nr * 100) + 1, 0x27d4eb2f) ^ Math.imul(i + 1, 0xc2b2ae35)) >>> 0;
          const rng = new Rng(seed);
          const n = rng.intBetween(1000, 4000);
          const { rows } = generateRows(rng, fields, n);
          const table = buildTable(fields, rows);
          applyIndexes(table, fields, cfg);

          const tree = randomTree(rng, fields, { maxDepth: 3, maxBranch: 3, coverage: cov });
          const engine = table.scanTree(tree).toArray();
          const oracle = oracleMatch(types, rows, tree);
          runMatrix(engine, oracle, { seed, node: tree, rows, label: `scale=${scale} cfg=${cfg} nr=${nr} iter ${i}` });
          queryCount++;
        }
      }
    }
  }

  const expected: Array<['decimal', ScanOp]> = DEC_OPS.map((op) => ['decimal', op]);
  cov.assertCoverage(expected, ['and', 'or', 'not']);
  assert.ok(queryCount >= 1000, `ran ${queryCount} queries`);
});

test('decimal fuzz: materialized strings round-trip exactly (formatDecimal ∘ coerce = id)', () => {
  // A REAL round-trip: every stored mantissa renders to a fixed-point string whose re-coercion is the
  // SAME mantissa (formatDecimal's documented inverse, column.ts), AND a true Engine.insert -> respondOne
  // emits that exact string in the response bytes. Across scale 0 and 2 with negative/zero/fractional/
  // > 10^17 mantissas — a low-digit corruption in formatDecimal/coerceDecimal would now fail here.
  for (const scale of [0, 2]) {
    const fields: FieldSpec[] = [{ name: 'a', type: 'decimal', scale, nullRate: 0, cardinality: 'medium' }];
    const rng = new Rng((0xd0_face ^ Math.imul(scale + 1, 0x9e3779b1)) >>> 0);
    const { rows } = generateRows(rng, fields, 500);
    const t = buildTable(fields, rows);
    const eng = new Engine();
    eng.define(`d${scale}`, fields.map((f) => ({ name: f.name, type: f.type, scale: f.scale })));
    let sawNeg = false;
    let sawBig = false;
    for (let r = 0; r < t.rowCount; r++) {
      const m = t.column('a').at(r) as bigint;
      assert.equal(typeof m, 'bigint');
      const s = formatDecimal(m, scale);
      // formatDecimal ∘ coerceDecimal = id (no precision loss in the render).
      assert.equal(coerceDecimal(s, scale), m, `round-trip mantissa ${m} @scale${scale}`);
      // End-to-end: the engine serializes that exact decimal string (quoted) into the response.
      const rowId = eng.insert(`d${scale}`, { a: m });
      const bytes = eng.respondOne(`d${scale}`, rowId);
      // decimal always serializes as a QUOTED string (matching the Postgres `numeric` representation),
      // regardless of scale — JSON.stringify quotes the formatDecimal string.
      const expected = `"a":"${s}"`;
      assert.ok(bytes.includes(Buffer.from(expected)), `respondOne emits ${expected}`);
      if (m < 0n) sawNeg = true;
      if (m > 10n ** 17n || m < -(10n ** 17n)) sawBig = true;
    }
    assert.ok(sawNeg, `scale ${scale}: exercised a negative mantissa`);
    assert.ok(sawBig, `scale ${scale}: exercised a > 10^17 mantissa`);
  }
});

test('decimal fuzz: fractional STRING inserts exercise coerceDecimal decomposition vs an independent mantissa oracle', () => {
  // The matrix test above inserts pre-scaled mantissa bigints (identical to i64 — no decimal-specific
  // code runs). HERE we insert decimal VALUES as fractional numeric STRINGS at the field's scale,
  // forcing I64Column.push -> coerceDecimal's string decomposition / scale padding. The oracle coerces
  // the SAME string to a mantissa with an INDEPENDENT computation (no engine import) and compares the
  // engine's matched rows leaf-by-leaf. eq/ne/in/notIn/gt/gte/lt/lte/between/null/notNull all covered.
  const SCALE = 2;
  const POW = 10n ** BigInt(SCALE);

  // Independent string -> scaled mantissa (mirrors coerceDecimal by hand, NO engine import).
  const oracleMantissa = (s: string): bigint => {
    const neg = s.startsWith('-');
    const u = neg ? s.slice(1) : s;
    const dot = u.indexOf('.');
    const ip = dot === -1 ? u : u.slice(0, dot);
    const fp = dot === -1 ? '' : u.slice(dot + 1);
    const frac = (fp + '0'.repeat(SCALE)).slice(0, SCALE);
    const m = BigInt((ip === '' ? '0' : ip) + frac);
    return neg ? -m : m;
  };

  // Render a random mantissa back to a fractional string at SCALE (the wire form a client sends).
  const toDecString = (m: bigint): string => {
    const neg = m < 0n;
    const a = neg ? -m : m;
    const ip = a / POW;
    const fp = (a % POW).toString().padStart(SCALE, '0');
    return (neg ? '-' : '') + ip.toString() + '.' + fp;
  };

  let queryCount = 0;
  for (let trial = 0; trial < 60; trial++) {
    const seed = (0xdec5_a1e0 ^ Math.imul(trial + 1, 0x27d4eb2f)) >>> 0;
    const rng = new Rng(seed);
    const n = rng.intBetween(400, 1200);

    // Build a small pool of distinct mantissas (mixed sign, fractional + > 10^17), render each as a
    // decimal STRING the row will carry. The oracle re-derives the mantissa from that same string.
    const poolSize = rng.intBetween(4, 40);
    const mantissas: bigint[] = [0n, 100n, -100n, 150n, -150n, 5n, 99999999999999999n];
    while (mantissas.length < poolSize) {
      const m = rng.chance(0.3)
        ? BigInt(rng.intBetween(-900, 900)) * 1_000_000_000n + BigInt(rng.intBetween(-99, 99))
        : BigInt(rng.intBetween(-5000, 5000));
      mantissas.push(m);
    }

    const fields: FieldSpec[] = [{ name: 'a', type: 'decimal', scale: SCALE, nullRate: 0.15, cardinality: 'medium' }];
    const types = fieldTypeMap(fields);

    // Generate rows holding decimal STRINGS (or null). For the oracle, the canonical cell is the
    // independently-coerced mantissa (or null) — that is what the engine stores and compares on.
    const rows: Row[] = [];
    const oracleRows: Row[] = [];
    for (let r = 0; r < n; r++) {
      if (rng.chance(fields[0]!.nullRate)) {
        rows.push({ a: null });
        oracleRows.push({ a: null });
      } else {
        const m = mantissas[rng.int(mantissas.length)]!;
        const s = toDecString(m);
        rows.push({ a: s }); // the engine coerces the STRING via coerceDecimal.
        oracleRows.push({ a: oracleMantissa(s) }); // independent mantissa for the oracle.
      }
    }

    const defs: FieldDef[] = fields.map((f) => ({ name: f.name, type: f.type, scale: f.scale }));
    for (const cfg of ['none', 'both'] as const) {
      const t = new Table(defs);
      for (const row of rows) t.insert(row);
      if (cfg === 'both') {
        t.createEqIndex('a');
        t.createSortedIndex('a');
        t.warmIndexes();
      }

      // One leaf per op. The decimal-specific coverage comes from the INSERT side (strings -> mantissa
      // via coerceDecimal's decomposition above); predicate values are the PRE-COERCED mantissa bigints
      // the parser actually emits (the parser coerces a wire decimal string to a mantissa before it ever
      // reaches the engine — see query-parser.ts coerceDecimal). So the oracle uses the same mantissas.
      const ops: ScanOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'notIn', 'null', 'notNull'];
      for (const op of ops) {
        let value: unknown;
        if (op === 'null' || op === 'notNull') value = null;
        else if (op === 'between') {
          value = [mantissas[rng.int(mantissas.length)]!, mantissas[rng.int(mantissas.length)]!];
        } else if (op === 'in' || op === 'notIn') {
          const k = rng.int(4);
          const arr: bigint[] = [];
          for (let j = 0; j < k; j++) arr.push(mantissas[rng.int(mantissas.length)]!);
          value = arr;
        } else {
          value = mantissas[rng.int(mantissas.length)]!;
        }
        const node: FilterNode = { leaf: { field: 'a', op, value } as Predicate };
        const oracle = oracleMatch(types, oracleRows, node);
        const engine = t.scanTree(node).toArray();
        runMatrix(engine, oracle, { seed, node, rows, label: `string-decomp op=${op} cfg=${cfg} trial ${trial}` });
        queryCount++;
      }
    }
  }
  assert.ok(queryCount >= 1000, `ran ${queryCount} queries`);
});
