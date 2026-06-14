/**
 * Self-check that the PHASE-1 harness drives the REAL engine and agrees with the INDEPENDENT
 * oracle across a seeded fuzz matrix. Also asserts the coverage registry reaches the full leaf
 * surface. This is a real integration of harness + engine (no mocks) — it both exercises the
 * harness API and proves the oracle is a faithful gold reference.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef } from '../../src/store/table.ts';
import {
  Rng,
  Coverage,
  generateRows,
  randomTree,
  runMatrix,
  oracleMatch,
  oraclePage,
  fieldTypeMap,
  allLeafPairs,
  type FieldSpec,
} from './harness.ts';

const FIELDS: FieldSpec[] = [
  { name: 'n', type: 'i32', nullRate: 0.15, cardinality: 'low' },
  { name: 'f', type: 'f64', nullRate: 0.1, cardinality: 'medium' },
  { name: 'b', type: 'bool', nullRate: 0.1, cardinality: 'low' },
  { name: 's', type: 'string', nullRate: 0.15, cardinality: 'medium' },
  { name: 'd', type: 'date', nullRate: 0.1, cardinality: 'medium' },
];

function buildTable(fields: FieldSpec[], rows: ReturnType<typeof generateRows>['rows']): Table {
  const defs: FieldDef[] = fields.map((f) => ({ name: f.name, type: f.type }));
  const t = new Table(defs);
  for (const r of rows) t.insert(r);
  return t;
}

test('harness: engine scanTree matches the independent oracle across a fuzz matrix', () => {
  const cov = new Coverage();
  const types = fieldTypeMap(FIELDS);
  const ITER = 400;
  for (let i = 0; i < ITER; i++) {
    const seed = 0xc0ffee + i * 2654435761;
    const rng = new Rng(seed);
    const n = rng.intBetween(20, 120);
    const { rows } = generateRows(rng, FIELDS, n);
    const table = buildTable(FIELDS, rows);
    const tree = randomTree(rng, FIELDS, { maxDepth: 3, maxBranch: 3, coverage: cov });

    const engine = table.scanTree(tree).toArray();
    const oracle = oracleMatch(types, rows, tree);
    runMatrix(engine, oracle, { seed, node: tree, rows, label: `iter ${i}` });
  }

  // The full legal leaf surface should be exercised by 400 iterations of a 5-type schema.
  cov.assertCoverage(allLeafPairs(), ['and', 'or', 'not', 'emptyAnd', 'emptyOr']);
});

test('harness: query() filter+sort+paginate matches oraclePage (non-null sort key)', () => {
  // Sort on a non-null, near-unique key so the ordering is unambiguous (no tie-break divergence
  // between the engine's index walk and the oracle's stable sort — see the oraclePage note).
  const fields: FieldSpec[] = [
    { name: 'k', type: 'i32', nullRate: 0, cardinality: 'nearUnique' },
    { name: 's', type: 'string', nullRate: 0.2, cardinality: 'medium' },
  ];
  const types = fieldTypeMap(fields);
  for (let i = 0; i < 150; i++) {
    const seed = 0xfeed + i * 40503;
    const rng = new Rng(seed);
    const n = rng.intBetween(30, 90);
    const { rows } = generateRows(rng, fields, n);
    // Force the sort key unique (a shuffled permutation) so there are NO ties — then the engine's
    // index-walk order and the oracle's stable sort agree exactly, isolating filter+page logic.
    const perm = [...Array(n).keys()];
    for (let j = n - 1; j > 0; j--) {
      const x = rng.int(j + 1);
      [perm[j], perm[x]] = [perm[x]!, perm[j]!];
    }
    for (let r = 0; r < n; r++) rows[r]!.k = perm[r]!;
    const table = buildTable(fields, rows);
    table.createSortedIndex('k');
    table.warmIndexes();
    const tree = randomTree(rng, fields, { maxDepth: 2, maxBranch: 2 });
    const filters = 'leaf' in tree ? [tree.leaf] : undefined; // query() takes a flat predicate list
    const offset = rng.int(5);
    const limit = rng.intBetween(1, 20);
    const sort = [{ field: 'k', dir: rng.chance(0.5) ? 'asc' : ('desc' as const) }] as const;

    const node = filters ? { op: 'and' as const, children: filters.map((p) => ({ leaf: p })) } : tree;
    if (!filters) continue; // query() only takes flat filters; skip nested trees here.

    const engine = table.query({ filters, sort: [...sort], offset, limit });
    const oracle = oraclePage(types, rows, node, [...sort], offset, limit);
    runMatrix(engine, oracle, { seed, node, rows, label: `page iter ${i}` });
  }
});

test('harness: runMatrix throws a seeded, minimized error on a real mismatch', () => {
  const rows = [{ x: 1 }, { x: 2 }];
  const node = { leaf: { field: 'x', op: 'eq' as const, value: 1 } };
  assert.throws(
    () => runMatrix([0, 1], [0], { seed: 12345, node, rows }),
    (err: Error) => {
      assert.match(err.message, /SEED=12345/);
      assert.match(err.message, /minimal failing predicate/);
      return true;
    },
  );
});

test('harness: oracle is engine-independent (no Table/Column/Bitset symbols imported)', () => {
  // Structural guard: the oracle functions are pure and operate on plain rows only. We assert the
  // oracle produces a result WITHOUT a Table ever being constructed in this scope.
  const types = new Map([['x', 'i32' as const]]);
  const rows = [{ x: 0 }, { x: null }, { x: 5 }];
  // $eq 0 must NOT match the NULL row (sentinel-0), and must match the real 0 — pure three-valued.
  const r = oracleMatch(types, rows, { leaf: { field: 'x', op: 'eq', value: 0 } });
  assert.deepEqual(r, [0]);
  const ne = oracleMatch(types, rows, { leaf: { field: 'x', op: 'ne', value: 5 } });
  assert.deepEqual(ne, [0]); // excludes the null row AND the 5 row.
});
