/**
 * PHASE 2 — property-based fuzz for the BOOLEAN COMBINATION TREE segment.
 *
 * What this file proves (all against the INDEPENDENT O(n) oracle in ./harness.ts — NO mocks,
 * NO engine import inside the oracle):
 *
 *  1. THOUSANDS of random nested and/or/not FilterNode trees (depth up to ~4) mixing predicates
 *     across i32/f64/string/bool/date columns with null-bearing fields. For EVERY tree:
 *       - the engine's scanTree(tree) row-id list == the oracle's, AND
 *       - probeEnabled=true and probeEnabled=false produce BYTE-IDENTICAL engine results
 *         (the §2.6 tiny-lead AND probe is a pure optimization and must never change the answer),
 *         AND eq/sorted/substring indexes (warmed) must not change the answer either.
 *     A coverage registry asserts the full legal (type, op) leaf surface + every combination class
 *     (and / or / not / emptyAnd / emptyOr) was actually exercised — a generator that stops
 *     producing some operator fails the build instead of silently rotting.
 *
 *  2. SORT (asc/desc) over an INDEXED and an UNINDEXED key, plus offset/limit pagination, on a
 *     UNIQUE sort key (no ties => the engine's index-walk order and the oracle's stable sort agree
 *     exactly), matched against oraclePage. Filters here are flat predicate lists (query() takes a
 *     flat list), generated as a conjunction of random leaves so the page is non-trivial.
 *
 *  3. EXPLICIT EDGE cases: empty result, all-match, none-match; bitset word boundaries with rows at
 *     31/32/63/64; rowCount % 32 != 0; capacity growth past INITIAL_CAPACITY (1024); NULL rows at
 *     word boundaries; absent / never-seen predicate values.
 *
 *  4. A FEW large-N smoke checks (up to 1,000,000 rows) with a CHEAP count-only oracle (a single
 *     typed loop, NOT the O(n) tree oracle run thousands of times) so the scale paths (capacity
 *     growth, multi-word bitsets, index builds at size) are exercised without blowing the runtime.
 *
 * RUNTIME BUDGET (logged here, never silently truncated):
 *   - TREE_ITERS = 2000 random trees at N in [2000, 6000]  (oracle is O(n)/query; coverage comes
 *     from query COUNT, not N — see CLAUDE.md). Each tree is checked under probe on + probe off +
 *     warmed indexes => ~6000 engine scans + 2000 oracle scans. (2000 trees of a 5-type schema
 *     reliably saturates the full legal leaf surface; assertCoverage fails the build otherwise.)
 *   - PAGE_ITERS  = 500 sort+paginate iterations at N in [200, 1200], indexed AND unindexed key.
 *   - Large-N smoke: a handful of single-tree count-only checks at 250k / 1,000,000 rows.
 *   Measured wall time on the dev box is comfortably under the ~20s target; if a slower machine
 *   needs it, lower TREE_ITERS / the smoke N first — both are named constants below.
 *
 * Deterministic: every iteration derives its seed from a fixed base, so a failure prints SEED=…
 * and re-running reproduces the exact rows + tree (runMatrix embeds the minimized case).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef, type FilterNode, type Predicate, type SortKey } from '../../src/store/table.ts';
import {
  Rng,
  Coverage,
  generateRows,
  randomTree,
  runMatrix,
  oracleMatch,
  oraclePage,
  oracleNodeMatch,
  fieldTypeMap,
  allLeafPairs,
  type FieldSpec,
  type Row,
} from './harness.ts';

// ===========================================================================
// Schema + table builder.
// ===========================================================================

/** Five columns, one per type, all null-bearing — the full leaf surface lives here. */
const FIELDS: FieldSpec[] = [
  { name: 'n', type: 'i32', nullRate: 0.15, cardinality: 'low' },
  { name: 'f', type: 'f64', nullRate: 0.1, cardinality: 'medium' },
  { name: 'b', type: 'bool', nullRate: 0.1, cardinality: 'low' },
  { name: 's', type: 'string', nullRate: 0.15, cardinality: 'medium' },
  { name: 'd', type: 'date', nullRate: 0.1, cardinality: 'medium' },
];

const TYPES = fieldTypeMap(FIELDS);

function buildTable(fields: FieldSpec[], rows: Row[]): Table {
  const defs: FieldDef[] = fields.map((f) => ({ name: f.name, type: f.type }));
  const t = new Table(defs);
  for (const r of rows) t.insert(r);
  return t;
}

/** scanTree result as a plain ascending row-id array. */
function scanIds(t: Table, tree: FilterNode): number[] {
  return t.scanTree(tree).toArray();
}

// ===========================================================================
// 1. Main fuzz matrix — thousands of trees; probe on/off + warmed indexes must all agree.
// ===========================================================================

// Runtime knobs (logged, never silently truncated — see header).
const TREE_ITERS = 2000;
const TREE_N_LO = 2000;
const TREE_N_HI = 6000;

test('combination: scanTree matches oracle; probe on/off + warmed indexes are byte-identical (thousands of trees)', () => {
  const cov = new Coverage();

  for (let i = 0; i < TREE_ITERS; i++) {
    const seed = (0xb001 + i * 2654435761) >>> 0;
    const rng = new Rng(seed);
    const n = rng.intBetween(TREE_N_LO, TREE_N_HI);
    const { rows } = generateRows(rng, FIELDS, n);
    const tree = randomTree(rng, FIELDS, { maxDepth: 4, maxBranch: 3, coverage: cov });

    const oracle = oracleMatch(TYPES, rows, tree);

    // (a) plain table, probe ENABLED (default).
    const tProbe = buildTable(FIELDS, rows);
    tProbe.probeEnabled = true;
    const resProbe = scanIds(tProbe, tree);
    runMatrix(resProbe, oracle, { seed, node: tree, rows, label: `tree iter ${i} (probe on)` });

    // (b) same table, probe DISABLED — must be byte-identical to (a) and to the oracle.
    const tNoProbe = buildTable(FIELDS, rows);
    tNoProbe.probeEnabled = false;
    const resNoProbe = scanIds(tNoProbe, tree);
    runMatrix(resNoProbe, oracle, { seed, node: tree, rows, label: `tree iter ${i} (probe off)` });
    assert.deepEqual(
      resNoProbe,
      resProbe,
      `probe on/off diverged at iter ${i} (SEED=${seed}) — the §2.6 probe must be a pure optimization`,
    );

    // (c) every index warmed (eq + sorted + substring): index-accelerated paths must also agree.
    const tIdx = buildTable(FIELDS, rows);
    tIdx.createEqIndex('n');
    tIdx.createEqIndex('s');
    tIdx.createEqIndex('b');
    tIdx.createSortedIndex('f');
    tIdx.createSortedIndex('d');
    tIdx.enableSubstringIndex('s');
    tIdx.warmIndexes();
    const resIdx = scanIds(tIdx, tree);
    runMatrix(resIdx, oracle, { seed, node: tree, rows, label: `tree iter ${i} (warmed indexes)` });
  }

  // The full legal leaf surface + every combination class must have been hit.
  cov.assertCoverage(allLeafPairs(), ['and', 'or', 'not', 'emptyAnd', 'emptyOr']);
});

// ===========================================================================
// 2. Sort + pagination over indexed AND unindexed keys (unique key => unambiguous order).
// ===========================================================================

const PAGE_ITERS = 500;

test('combination: query() filter+sort+paginate matches oraclePage on a unique key (indexed & unindexed)', () => {
  // A unique i32 sort key `k` (forced to a shuffled permutation => no ties) plus the usual
  // null-bearing payload columns. With no ties, the engine's sorted-index walk and its fallback
  // Array.sort both produce the same order the oracle's stable sort does.
  const fields: FieldSpec[] = [
    { name: 'k', type: 'i32', nullRate: 0, cardinality: 'nearUnique' },
    { name: 'n', type: 'i32', nullRate: 0.15, cardinality: 'low' },
    { name: 's', type: 'string', nullRate: 0.15, cardinality: 'medium' },
    { name: 'b', type: 'bool', nullRate: 0.1, cardinality: 'low' },
    { name: 'd', type: 'date', nullRate: 0.1, cardinality: 'medium' },
  ];
  const types = fieldTypeMap(fields);

  for (let i = 0; i < PAGE_ITERS; i++) {
    const seed = (0x9a93 + i * 40503) >>> 0;
    const rng = new Rng(seed);
    const n = rng.intBetween(200, 1200);
    const { rows } = generateRows(rng, fields, n);

    // Force `k` into a shuffled 0..n-1 permutation — unique, so the page order is unambiguous.
    const perm = [...Array(n).keys()];
    for (let j = n - 1; j > 0; j--) {
      const x = rng.int(j + 1);
      [perm[j], perm[x]] = [perm[x]!, perm[j]!];
    }
    for (let r = 0; r < n; r++) rows[r]!.k = perm[r]!;

    // Filters: query() takes a FLAT predicate list (implicit AND). Build a small conjunction of
    // random leaves over the payload columns so the page is a non-trivial subset.
    const filterFields = fields.filter((f) => f.name !== 'k');
    const nFilters = rng.int(3); // 0..2 leaves
    const filters: Predicate[] = [];
    for (let j = 0; j < nFilters; j++) {
      const leafNode = randomTree(rng, filterFields, { maxDepth: 0, maxBranch: 1 });
      if ('leaf' in leafNode) filters.push(leafNode.leaf);
    }
    // The equivalent FilterNode for the oracle is the AND of those leaves (empty AND = all rows).
    const node: FilterNode = { op: 'and', children: filters.map((p) => ({ leaf: p })) };

    const dir = rng.chance(0.5) ? ('asc' as const) : ('desc' as const);
    const sort: SortKey[] = [{ field: 'k', dir }];
    const offset = rng.int(8);
    const limit = rng.intBetween(1, 30);

    // (a) UNINDEXED sort key — exercises the Array.sort fallback (comparator reads columns).
    const tPlain = buildTable(fields, rows);
    const enginePlain = tPlain.query({ filters, sort, offset, limit });
    const oracle = oraclePage(types, rows, node, sort, offset, limit);
    runMatrix(enginePlain, oracle, { seed, node, rows, label: `page iter ${i} (unindexed sort)` });

    // (b) INDEXED sort key — exercises the sorted-index ordered-walk with early termination.
    const tIdx = buildTable(fields, rows);
    tIdx.createSortedIndex('k');
    tIdx.warmIndexes();
    const engineIdx = tIdx.query({ filters, sort, offset, limit });
    runMatrix(engineIdx, oracle, { seed, node, rows, label: `page iter ${i} (indexed sort)` });
    assert.deepEqual(
      engineIdx,
      enginePlain,
      `indexed vs unindexed sort diverged at iter ${i} (SEED=${seed})`,
    );
  }
});

// ===========================================================================
// 3. Explicit EDGE cases.
// ===========================================================================

/** Convenience: a leaf node. */
function leaf(field: string, op: Predicate['op'], value: unknown): FilterNode {
  return { leaf: { field, op, value } };
}

test('combination edge: empty-result, all-match, none-match trees', () => {
  const seed = 0xed6e;
  const rng = new Rng(seed);
  const n = 500;
  const { rows } = generateRows(rng, FIELDS, n);
  const t = buildTable(FIELDS, rows);

  // ALL-match: empty AND is the identity (matches every row).
  const allMatch: FilterNode = { op: 'and', children: [] };
  runMatrix(scanIds(t, allMatch), oracleMatch(TYPES, rows, allMatch), { seed, node: allMatch, rows, label: 'all-match (empty AND)' });
  assert.equal(scanIds(t, allMatch).length, n);

  // NONE-match: empty OR is the identity (matches nothing).
  const noneMatch: FilterNode = { op: 'or', children: [] };
  runMatrix(scanIds(t, noneMatch), oracleMatch(TYPES, rows, noneMatch), { seed, node: noneMatch, rows, label: 'none-match (empty OR)' });
  assert.equal(scanIds(t, noneMatch).length, 0);

  // A contradiction: (n eq 7) AND (n ne 7) — impossible, must be empty.
  const contradiction: FilterNode = { op: 'and', children: [leaf('n', 'eq', 7), leaf('n', 'ne', 7)] };
  runMatrix(scanIds(t, contradiction), oracleMatch(TYPES, rows, contradiction), { seed, node: contradiction, rows, label: 'contradiction' });
  assert.equal(scanIds(t, contradiction).length, 0);

  // A tautology over a non-null column condition: notNull OR null on `b` = every row.
  const taut: FilterNode = { op: 'or', children: [leaf('b', 'null', null), leaf('b', 'notNull', null)] };
  runMatrix(scanIds(t, taut), oracleMatch(TYPES, rows, taut), { seed, node: taut, rows, label: 'tautology null|notNull' });
  assert.equal(scanIds(t, taut).length, n);
});

test('combination edge: bitset word boundaries (rows at 31/32/63/64) and rowCount % 32 != 0', () => {
  // Build a table where exactly one column is true at specific boundary rows, everything else false.
  for (const rowCount of [31, 32, 33, 63, 64, 65, 100]) {
    const fields: FieldSpec[] = [{ name: 'b', type: 'bool', nullRate: 0, cardinality: 'low' }];
    const types = fieldTypeMap(fields);
    const rows: Row[] = [];
    const trueAt = new Set([0, 31, 32, 63, 64].filter((x) => x < rowCount));
    for (let i = 0; i < rowCount; i++) rows.push({ b: trueAt.has(i) });
    const t = buildTable(fields, rows);

    const node = leaf('b', 'eq', true);
    const oracle = oracleMatch(types, rows, node);
    runMatrix(scanIds(t, node), oracle, { seed: rowCount, node, rows, label: `boundary eq true @ rowCount=${rowCount}` });

    // The complement (NOT) must cover exactly the other rows — exercises structural complement at
    // the final partial word (rowCount % 32 != 0 for 31/33/63/65/100).
    const notNode: FilterNode = { op: 'not', children: [node] };
    const oracleNot = oracleMatch(types, rows, notNode);
    runMatrix(scanIds(t, notNode), oracleNot, { seed: rowCount, node: notNode, rows, label: `boundary NOT @ rowCount=${rowCount}` });
    assert.equal(oracle.length + oracleNot.length, rowCount, 'eq + NOT(eq) must partition all rows');
  }
});

test('combination edge: NULL rows at word boundaries are excluded by comparisons, kept by $null', () => {
  for (const rowCount of [32, 64, 65]) {
    const fields: FieldSpec[] = [{ name: 'n', type: 'i32', nullRate: 0, cardinality: 'low' }];
    const types = fieldTypeMap(fields);
    const rows: Row[] = [];
    const nullAt = new Set([0, 31, 32, 63, 64].filter((x) => x < rowCount));
    // Non-null rows all hold the value 0 — so a NULL sentinel-0 row must NOT match $eq 0.
    for (let i = 0; i < rowCount; i++) rows.push({ n: nullAt.has(i) ? null : 0 });
    const t = buildTable(fields, rows);

    // $eq 0 matches the non-null zeros only (sentinel-0 NULL rows excluded — three-valued logic).
    const eq0 = leaf('n', 'eq', 0);
    runMatrix(scanIds(t, eq0), oracleMatch(types, rows, eq0), { seed: rowCount, node: eq0, rows, label: `eq0 vs null sentinel @ ${rowCount}` });
    assert.equal(scanIds(t, eq0).length, rowCount - nullAt.size);

    // $null matches exactly the boundary null rows.
    const isNull = leaf('n', 'null', null);
    runMatrix(scanIds(t, isNull), oracleMatch(types, rows, isNull), { seed: rowCount, node: isNull, rows, label: `null @ ${rowCount}` });
    assert.deepEqual(scanIds(t, isNull), [...nullAt].sort((a, b) => a - b));

    // $ne 1 must ALSO exclude nulls (three-valued): equals the non-null rows.
    const ne1 = leaf('n', 'ne', 1);
    runMatrix(scanIds(t, ne1), oracleMatch(types, rows, ne1), { seed: rowCount, node: ne1, rows, label: `ne1 excludes null @ ${rowCount}` });
  }
});

test('combination edge: capacity growth past INITIAL_CAPACITY (1024)', () => {
  // 5000 rows forces several geometric grows of every typed-array column past the 1024 initial cap.
  const seed = 0xca9a;
  const rng = new Rng(seed);
  const n = 5000;
  const { rows } = generateRows(rng, FIELDS, n);
  const t = buildTable(FIELDS, rows);
  assert.equal(t.rowCount, n);

  // A mixed tree across all five columns over the grown arrays.
  const tree: FilterNode = {
    op: 'or',
    children: [
      { op: 'and', children: [leaf('n', 'gte', 0), leaf('s', 'containsi', 'app')] },
      { op: 'not', children: [leaf('b', 'eq', true)] },
      leaf('d', 'notNull', null),
    ],
  };
  runMatrix(scanIds(t, tree), oracleMatch(TYPES, rows, tree), { seed, node: tree, rows, label: 'capacity growth tree' });
});

test('combination edge: absent / never-seen predicate values match nothing', () => {
  const seed = 0xab5e;
  const rng = new Rng(seed);
  const n = 800;
  const { rows } = generateRows(rng, FIELDS, n);
  const t = buildTable(FIELDS, rows);

  // i32 range is [-50, 50]; 9999 is never present.
  const neverInt = leaf('n', 'eq', 9999);
  runMatrix(scanIds(t, neverInt), oracleMatch(TYPES, rows, neverInt), { seed, node: neverInt, rows, label: 'never-seen i32' });
  assert.equal(scanIds(t, neverInt).length, 0);

  // A string never interned in the dictionary.
  const neverStr = leaf('s', 'eq', ' no-such-value ');
  runMatrix(scanIds(t, neverStr), oracleMatch(TYPES, rows, neverStr), { seed, node: neverStr, rows, label: 'never-seen string eq' });
  assert.equal(scanIds(t, neverStr).length, 0);

  // contains on a needle that never occurs.
  const neverContains = leaf('s', 'contains', 'qzx-not-a-substring');
  runMatrix(scanIds(t, neverContains), oracleMatch(TYPES, rows, neverContains), { seed, node: neverContains, rows, label: 'never-seen contains' });
  assert.equal(scanIds(t, neverContains).length, 0);

  // notIn over a set that contains NO present value => excludes only nulls (three-valued notIn).
  const notInNever = leaf('n', 'notIn', [9998, 9999]);
  runMatrix(scanIds(t, notInNever), oracleMatch(TYPES, rows, notInNever), { seed, node: notInNever, rows, label: 'notIn never-seen excludes nulls' });
});

// ===========================================================================
// 4. Large-N smoke checks — CHEAP count-only oracle (single typed loop), NOT the O(n) tree oracle
//    run thousands of times. A handful of single-tree checks at scale to exercise the size paths.
// ===========================================================================

/** Count-only cheap oracle: a single typed loop over the rows for ONE tree (run once, not thousands). */
function cheapCount(rows: Row[], node: FilterNode): number {
  let c = 0;
  for (let i = 0; i < rows.length; i++) if (oracleNodeMatch(TYPES, node, rows[i]!)) c++;
  return c;
}

test('combination smoke: large-N single-tree checks (up to 1,000,000 rows, count-only oracle)', () => {
  for (const n of [250_000, 1_000_000]) {
    const seed = (0x5afe + n) >>> 0;
    const rng = new Rng(seed);
    const { rows } = generateRows(rng, FIELDS, n);
    const t = buildTable(FIELDS, rows);
    assert.equal(t.rowCount, n);

    // One representative mixed tree (and/or/not, all five types, null-aware leaves).
    const tree: FilterNode = {
      op: 'and',
      children: [
        { op: 'or', children: [leaf('n', 'between', [-10, 10]), leaf('f', 'lt', 0)] },
        { op: 'not', children: [leaf('s', 'startsWithi', 'app')] },
        leaf('b', 'notNull', null),
      ],
    };

    // ONE engine scan, ONE cheap count-only oracle pass (a single typed loop) — not thousands.
    const ids = scanIds(t, tree);
    const expected = cheapCount(rows, tree);
    assert.equal(ids.length, expected, `large-N count mismatch at N=${n} (SEED=${seed})`);

    // Spot-check the ids are sorted, in range, and a sampled membership agrees with the oracle.
    for (let i = 1; i < ids.length; i++) assert.ok(ids[i]! > ids[i - 1]!, 'scanTree ids must be ascending');
    const sampleStep = Math.max(1, Math.floor(n / 50));
    for (let r = 0; r < n; r += sampleStep) {
      const inEngine = ids.length > 0 && binIncludes(ids, r);
      assert.equal(inEngine, oracleNodeMatch(TYPES, tree, rows[r]!), `membership mismatch at row ${r}, N=${n} (SEED=${seed})`);
    }
  }
});

/** Binary-search membership in an ascending id list (avoids an O(n) Set build per sample). */
function binIncludes(sorted: number[], x: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = sorted[mid]!;
    if (v === x) return true;
    if (v < x) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}
