/**
 * PHASE 2 — property-based fuzz test for the RELATIONS (EXISTS) segment.
 *
 * Under test: `Relation.ownersMatching(related.scanTree(P))` — the EXISTS join that returns the
 * OWNER rows having AT LEAST ONE related row matching the related-table predicate tree P — both on
 * its own and COMPOSED with an owner-table predicate (the documented `ownerBitset.and(existsBitset)`
 * pattern). We assert the engine equals an INDEPENDENT brute-force EXISTS oracle on every query.
 *
 * Oracle independence: the matching of a related/owner FilterNode against a plain row reuses the
 * harness's engine-INDEPENDENT `oracleMatch` (a trivial O(n) loop re-implementing the documented
 * three-valued semantics — it never touches Table/Column/Bitset). The EXISTS layer added here is a
 * second independent O(edges) loop over the plain edge list; it never imports Relation/CSR code. A
 * circular oracle would be the worst bug, so the only engine symbols this file links at runtime are
 * Table + Relation (the things under test); everything else is `import type` (erased).
 *
 * Matrix covered (per the segment brief):
 *   - random owner+related tables, both with NULL-bearing fields;
 *   - random edge sets: ONE-TO-MANY (each related row attached to exactly one owner) AND
 *     MANY-TO-MANY (arbitrary edges, shared related rows, duplicate edges);
 *   - ownersMatching(related.scanTree(P)) vs the naive EXISTS oracle;
 *   - related predicate over null-bearing related fields (random FilterNode trees);
 *   - COMPOSED with owner-table predicates (owner predicate AND EXISTS);
 *   - owners with ZERO edges (always excluded), related rows SHARED by many owners (all match).
 *
 * Explicit EDGE cases (separate test): empty result, all-match, none-match, bitset word boundaries
 * (owners/related at indices 31/32/63/64), rowCount % 32 != 0, capacity growth past
 * INITIAL_CAPACITY (1024), null rows at boundaries, absent / never-seen predicate values.
 *
 * Large-N smoke (separate test): up to ~1,000,000 rows with a CHEAP count-only oracle to exercise
 * scale paths — NOT thousands of O(n) oracle queries at 1M (the brief forbids that).
 *
 * CHOSEN SIZES (logged here, never silently truncated):
 *   - Main randomized matrix: 2500 queries, owner/related rowCount in [2000, 8000]. The oracle is
 *     O(owners + edges) per query, so coverage comes from the query COUNT, not row count. (2500 was
 *     chosen over a larger count purely to keep the file's wall-clock well under the ~20s budget;
 *     the full legal (type, op) leaf surface + every combo class is still asserted covered below.)
 *   - Large-N smoke: 1 owner table + 1 related table at 1,000,000 related rows / 250,000 owners,
 *     8 cheap count-only checks.
 * Deterministic seed throughout; `runMatrix` prints SEED + minimal case on any mismatch.
 *
 * NO MOCKS. Run: `node --test test/fuzz/relation.fuzz.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef, type FilterNode } from '../../src/store/table.ts';
import { Relation } from '../../src/store/relation.ts';
import {
  Rng,
  Coverage,
  generateRows,
  randomTree,
  runMatrix,
  oracleNodeMatch,
  fieldTypeMap,
  allLeafPairs,
  type FieldSpec,
  type Row,
} from './harness.ts';

// ===========================================================================
// Schemas — both owner and related carry NULL-bearing fields of every type.
// ===========================================================================

const OWNER_FIELDS: FieldSpec[] = [
  { name: 'oScore', type: 'i32', nullRate: 0.15, cardinality: 'low' },
  { name: 'oRank', type: 'f64', nullRate: 0.1, cardinality: 'medium' },
  { name: 'oFlag', type: 'bool', nullRate: 0.1, cardinality: 'low' },
  { name: 'oName', type: 'string', nullRate: 0.15, cardinality: 'medium' },
  { name: 'oWhen', type: 'date', nullRate: 0.1, cardinality: 'medium' },
];

const RELATED_FIELDS: FieldSpec[] = [
  { name: 'rQty', type: 'i32', nullRate: 0.2, cardinality: 'low' },
  { name: 'rWeight', type: 'f64', nullRate: 0.15, cardinality: 'medium' },
  { name: 'rActive', type: 'bool', nullRate: 0.15, cardinality: 'low' },
  { name: 'rKind', type: 'string', nullRate: 0.2, cardinality: 'medium' },
  { name: 'rAt', type: 'date', nullRate: 0.15, cardinality: 'medium' },
];

const OWNER_TYPES = fieldTypeMap(OWNER_FIELDS);
const RELATED_TYPES = fieldTypeMap(RELATED_FIELDS);

function buildTable(fields: FieldSpec[], rows: Row[]): Table {
  const defs: FieldDef[] = fields.map((f) => ({ name: f.name, type: f.type }));
  const t = new Table(defs);
  for (const r of rows) t.insert(r);
  return t;
}

// ===========================================================================
// INDEPENDENT EXISTS oracle.
//
// Edges are a plain `[ownerRow, relatedRow][]` list — the SAME list fed to the Relation, but the
// oracle walks it with a trivial loop and never touches the CSR. An owner matches the EXISTS join
// iff SOME edge (o -> r) has the related row `r` satisfying the related predicate. Composed owner
// predicates are ANDed in afterward by a separate per-owner check.
// ===========================================================================

/** Owner ids (ascending) that have >= 1 related row matching `relatedNode`. Pure O(edges) loop. */
function oracleExistsOwners(
  ownerCount: number,
  edges: ReadonlyArray<readonly [number, number]>,
  relatedRows: Row[],
  relatedNode: FilterNode,
): number[] {
  // Cache the related-row match decision so we evaluate the predicate once per distinct related row.
  const relMatch = new Uint8Array(relatedRows.length);
  for (let r = 0; r < relatedRows.length; r++) {
    relMatch[r] = oracleNodeMatch(RELATED_TYPES, relatedNode, relatedRows[r]!) ? 1 : 0;
  }
  const hit = new Uint8Array(ownerCount);
  for (const [o, r] of edges) {
    if (relMatch[r] === 1) hit[o] = 1;
  }
  const out: number[] = [];
  for (let o = 0; o < ownerCount; o++) if (hit[o] === 1) out.push(o);
  return out;
}

/** Composed oracle: owners satisfying their OWN predicate AND the EXISTS join. */
function oracleComposed(
  ownerRows: Row[],
  edges: ReadonlyArray<readonly [number, number]>,
  relatedRows: Row[],
  ownerNode: FilterNode,
  relatedNode: FilterNode,
): number[] {
  const existsSet = new Set(oracleExistsOwners(ownerRows.length, edges, relatedRows, relatedNode));
  const out: number[] = [];
  for (let o = 0; o < ownerRows.length; o++) {
    if (existsSet.has(o) && oracleNodeMatch(OWNER_TYPES, ownerNode, ownerRows[o]!)) out.push(o);
  }
  return out;
}

// ===========================================================================
// Edge-set generators (deterministic in rng).
// ===========================================================================

/** ONE-TO-MANY: every related row is attached to exactly one (random) owner. */
function oneToManyEdges(rng: Rng, ownerCount: number, relatedCount: number): [number, number][] {
  const edges: [number, number][] = [];
  for (let r = 0; r < relatedCount; r++) edges.push([rng.int(ownerCount), r]);
  return edges;
}

/**
 * MANY-TO-MANY: a random number of edges, including SHARED related rows (one related row attached to
 * several owners), some owners with ZERO edges, and occasional DUPLICATE edges (harmless for EXISTS).
 */
function manyToManyEdges(rng: Rng, ownerCount: number, relatedCount: number): [number, number][] {
  const edges: [number, number][] = [];
  if (relatedCount === 0) return edges;
  // Average ~1.5 edges per related row, so most related rows are shared and some owners get none.
  const m = rng.intBetween(0, ownerCount + relatedCount * 2);
  for (let i = 0; i < m; i++) {
    edges.push([rng.int(ownerCount), rng.int(relatedCount)]);
  }
  return edges;
}

// ===========================================================================
// 1. Main randomized matrix.
//
// CHOSEN SIZES (see file header): 3000 queries; owner/related rowCount in [2000, 8000].
// ===========================================================================

test('relation EXISTS fuzz: ownersMatching == independent EXISTS oracle (2500 randomized queries)', () => {
  const cov = new Coverage();
  const QUERIES = 2500;

  for (let i = 0; i < QUERIES; i++) {
    const seed = 0x5e1ec7 + i * 2654435761;
    const rng = new Rng(seed);

    const ownerCount = rng.intBetween(2000, 8000);
    const relatedCount = rng.intBetween(2000, 8000);

    const ownerData = generateRows(rng, OWNER_FIELDS, ownerCount);
    const relatedData = generateRows(rng, RELATED_FIELDS, relatedCount);
    const owner = buildTable(OWNER_FIELDS, ownerData.rows);
    const related = buildTable(RELATED_FIELDS, relatedData.rows);

    // Alternate edge topology so both one-to-many and many-to-many are exercised heavily.
    const m2m = rng.chance(0.5);
    const edges = m2m
      ? manyToManyEdges(rng, ownerCount, relatedCount)
      : oneToManyEdges(rng, ownerCount, relatedCount);

    // Alternate edge ingestion: constructor batch vs incremental link() (both must yield identical CSR).
    let rel: Relation;
    if (rng.chance(0.5)) {
      rel = new Relation(owner, related, edges);
    } else {
      rel = new Relation(owner, related);
      for (const [o, r] of edges) rel.link(o, r);
    }
    if (rng.chance(0.5)) rel.warm(); // sometimes pre-build the CSR (publish-time warm path)

    // Random related predicate tree over the null-bearing related fields.
    const relatedNode = randomTree(rng, RELATED_FIELDS, { maxDepth: 3, maxBranch: 3, coverage: cov });

    const engine = rel.ownersMatching(related.scanTree(relatedNode)).toArray();
    const oracle = oracleExistsOwners(ownerCount, edges, relatedData.rows, relatedNode);
    runMatrix(engine, oracle, {
      seed,
      node: relatedNode,
      rows: relatedData.rows,
      label: `EXISTS ${m2m ? 'm2m' : '1:m'} iter ${i} (owners=${ownerCount}, related=${relatedCount}, edges=${edges.length})`,
    });

    // Every ~2nd query also checks the COMPOSED owner-predicate AND EXISTS path.
    if (rng.chance(0.5)) {
      const ownerNode = randomTree(rng, OWNER_FIELDS, { maxDepth: 2, maxBranch: 2, coverage: cov });
      const composedEngine = owner.scanTree(ownerNode).and(rel.ownersMatching(related.scanTree(relatedNode))).toArray();
      const composedOracle = oracleComposed(ownerData.rows, edges, relatedData.rows, ownerNode, relatedNode);
      runMatrix(composedEngine, composedOracle, {
        seed,
        node: ownerNode,
        rows: ownerData.rows,
        label: `COMPOSED iter ${i}`,
      });
    }
  }

  // The related predicate trees alone touch every legal (type, op) pair + every combo class; the
  // owner trees add more. Assert the full leaf surface was exercised so no operator silently rots.
  cov.assertCoverage(allLeafPairs(), ['and', 'or', 'not', 'emptyAnd', 'emptyOr']);
});

// ===========================================================================
// 2. Explicit EDGE cases.
// ===========================================================================

test('relation EXISTS fuzz: explicit edge cases (boundaries, empties, capacity growth, nulls)', () => {
  // --- empty result, all-match, none-match on a small fixed shape ---
  {
    const ownerRows: Row[] = [{ oScore: 1 }, { oScore: 2 }, { oScore: 3 }];
    const relatedRows: Row[] = [{ rQty: 10 }, { rQty: 20 }, { rQty: null }];
    const owner = buildTable(OWNER_FIELDS, ownerRows);
    const related = buildTable(RELATED_FIELDS, relatedRows);
    const edges: [number, number][] = [[0, 0], [1, 1], [2, 2]];
    const rel = new Relation(owner, related, edges);

    // none-match: a predicate no related row satisfies (rQty == 999).
    const none: FilterNode = { leaf: { field: 'rQty', op: 'eq', value: 999 } };
    assert.deepEqual(rel.ownersMatching(related.scanTree(none)).toArray(), []);
    assert.deepEqual(rel.ownersMatching(related.scanTree(none)).toArray(), oracleExistsOwners(3, edges, relatedRows, none));

    // all-match-of-edged: notNull matches related rows 0 and 1 (row 2 is null) -> owners 0,1.
    const nn: FilterNode = { leaf: { field: 'rQty', op: 'notNull', value: null } };
    assert.deepEqual(rel.ownersMatching(related.scanTree(nn)).toArray(), [0, 1]);

    // $null matches related row 2 -> owner 2 (a NULL related field still drives EXISTS via $null).
    const isNull: FilterNode = { leaf: { field: 'rQty', op: 'null', value: null } };
    assert.deepEqual(rel.ownersMatching(related.scanTree(isNull)).toArray(), [2]);
  }

  // --- owners with ZERO edges never match; shared related row makes ALL its owners match ---
  {
    const ownerRows: Row[] = [{ oScore: 1 }, { oScore: 2 }, { oScore: 3 }, { oScore: 4 }];
    const relatedRows: Row[] = [{ rQty: 5 }];
    const owner = buildTable(OWNER_FIELDS, ownerRows);
    const related = buildTable(RELATED_FIELDS, relatedRows);
    // Related row 0 shared by owners 0, 2, 3; owner 1 has zero edges.
    const edges: [number, number][] = [[0, 0], [2, 0], [3, 0]];
    const rel = new Relation(owner, related, edges);
    const p: FilterNode = { leaf: { field: 'rQty', op: 'eq', value: 5 } };
    assert.deepEqual(rel.ownersMatching(related.scanTree(p)).toArray(), [0, 2, 3]);
    assert.deepEqual(rel.ownersMatching(related.scanTree(p)).toArray(), oracleExistsOwners(4, edges, relatedRows, p));
  }

  // --- bitset word boundaries: owners/related at indices 31/32/63/64, and rowCount % 32 != 0 ---
  for (const owners of [31, 32, 33, 63, 64, 65, 100]) {
    const rng = new Rng(0xB0DA1 + owners);
    const relatedCount = 70; // % 32 != 0
    const ownerData = generateRows(rng, OWNER_FIELDS, owners);
    const relatedData = generateRows(rng, RELATED_FIELDS, relatedCount);
    const owner = buildTable(OWNER_FIELDS, ownerData.rows);
    const related = buildTable(RELATED_FIELDS, relatedData.rows);
    // One edge per related row to a boundary-spanning owner set (incl. owners 31/32/63/64 if present).
    const edges: [number, number][] = [];
    for (let r = 0; r < relatedCount; r++) edges.push([r % owners, r]);
    const rel = new Relation(owner, related, edges);
    for (let q = 0; q < 20; q++) {
      const node = randomTree(rng, RELATED_FIELDS, { maxDepth: 3, maxBranch: 3 });
      const engine = rel.ownersMatching(related.scanTree(node)).toArray();
      const oracle = oracleExistsOwners(owners, edges, relatedData.rows, node);
      runMatrix(engine, oracle, { seed: 0xB0DA1 + owners, node, rows: relatedData.rows, label: `boundary owners=${owners} q=${q}` });
    }
  }

  // --- null rows at boundaries: force related rows 31/32/63/64 to be NULL on a field ---
  {
    const relatedCount = 80;
    const rng = new Rng(0x4017);
    const relatedData = generateRows(rng, RELATED_FIELDS, relatedCount);
    for (const idx of [31, 32, 63, 64]) relatedData.rows[idx]!.rQty = null;
    const owners = 40;
    const ownerData = generateRows(rng, OWNER_FIELDS, owners);
    const owner = buildTable(OWNER_FIELDS, ownerData.rows);
    const related = buildTable(RELATED_FIELDS, relatedData.rows);
    const edges: [number, number][] = [];
    for (let r = 0; r < relatedCount; r++) edges.push([r % owners, r]);
    const rel = new Relation(owner, related, edges);
    for (const op of ['null', 'notNull', 'eq', 'ne'] as const) {
      const node: FilterNode = { leaf: { field: 'rQty', op, value: op === 'eq' || op === 'ne' ? 0 : null } };
      const engine = rel.ownersMatching(related.scanTree(node)).toArray();
      const oracle = oracleExistsOwners(owners, edges, relatedData.rows, node);
      runMatrix(engine, oracle, { seed: 0x4711, node, rows: relatedData.rows, label: `null-boundary op=${op}` });
    }
  }

  // --- absent / never-seen predicate value (a value no related row holds) ---
  {
    const relatedRows: Row[] = [{ rKind: 'apple' }, { rKind: 'banana' }, { rKind: null }];
    const ownerRows: Row[] = [{ oScore: 1 }, { oScore: 2 }, { oScore: 3 }];
    const owner = buildTable(OWNER_FIELDS, ownerRows);
    const related = buildTable(RELATED_FIELDS, relatedRows);
    const edges: [number, number][] = [[0, 0], [1, 1], [2, 2]];
    const rel = new Relation(owner, related, edges);
    const node: FilterNode = { leaf: { field: 'rKind', op: 'eq', value: 'durian' } }; // never seen
    assert.deepEqual(rel.ownersMatching(related.scanTree(node)).toArray(), []);
    assert.deepEqual(rel.ownersMatching(related.scanTree(node)).toArray(), oracleExistsOwners(3, edges, relatedRows, node));
  }

  // --- capacity growth past INITIAL_CAPACITY (1024) on BOTH tables, with incremental link() ---
  {
    const rng = new Rng(0xcafe);
    const ownerCount = 1500; // > 1024
    const relatedCount = 3000; // > 1024
    const ownerData = generateRows(rng, OWNER_FIELDS, ownerCount);
    const relatedData = generateRows(rng, RELATED_FIELDS, relatedCount);
    const owner = buildTable(OWNER_FIELDS, ownerData.rows);
    const related = buildTable(RELATED_FIELDS, relatedData.rows);
    const edges = manyToManyEdges(rng, ownerCount, relatedCount);
    const rel = new Relation(owner, related);
    for (const [o, r] of edges) rel.link(o, r);
    rel.warm();
    for (let q = 0; q < 30; q++) {
      const node = randomTree(rng, RELATED_FIELDS, { maxDepth: 3, maxBranch: 3 });
      const engine = rel.ownersMatching(related.scanTree(node)).toArray();
      const oracle = oracleExistsOwners(ownerCount, edges, relatedData.rows, node);
      runMatrix(engine, oracle, { seed: 0xcafe, node, rows: relatedData.rows, label: `capacity-growth q=${q}` });
    }
  }

  // --- zero related rows / zero owners degenerate shapes ---
  {
    const owner = buildTable(OWNER_FIELDS, [{ oScore: 1 }]);
    const related = buildTable(RELATED_FIELDS, []);
    const rel = new Relation(owner, related, []);
    const node: FilterNode = { leaf: { field: 'rQty', op: 'notNull', value: null } };
    assert.deepEqual(rel.ownersMatching(related.scanTree(node)).toArray(), []);
  }
});

// ===========================================================================
// 3. Large-N smoke — CHEAP count-only oracle (NOT thousands of O(n) queries).
//
// CHOSEN SIZES (see file header): 1,000,000 related rows, 250,000 owners, 8 count-only checks.
// We pick predicates with a closed-form expected count so the oracle is O(1)-per-row single-pass,
// never the full FilterNode oracle. We assert the EXISTS owner-count, and that owners with zero
// edges are excluded, at scale.
// ===========================================================================

test('relation EXISTS fuzz: large-N (1,000,000 related) smoke with a cheap count-only oracle', () => {
  const rng = new Rng(0x1a26e);
  const relatedCount = 1_000_000;
  const ownerCount = 250_000;

  // Build a related table with a single controlled i32 field whose value is r % 10 (no nulls), so
  // any threshold predicate has a closed-form matching-row set. Insert directly (skip the generator
  // for speed at 1M). A single string field is added too for a contains smoke check.
  const related = new Table([
    { name: 'rQty', type: 'i32' },
    { name: 'rKind', type: 'string' },
  ]);
  for (let r = 0; r < relatedCount; r++) {
    related.insert({ rQty: r % 10, rKind: r % 3 === 0 ? 'alpha' : 'beta' });
  }

  const owner = new Table([{ name: 'oScore', type: 'i32' }]);
  for (let o = 0; o < ownerCount; o++) owner.insert({ oScore: o });

  // ONE-TO-MANY: related row r -> owner (r % ownerCount). Every owner < relatedCount gets >=1 edge;
  // since relatedCount(1M) >> ownerCount(250k), ALL owners are edged here (no zero-edge owners), so
  // we ALSO build a second relation that deliberately leaves the upper half of owners edgeless.
  const edgesOwner = new Int32Array(relatedCount);
  const relFull = new Relation(owner, related);
  for (let r = 0; r < relatedCount; r++) {
    const o = r % ownerCount;
    edgesOwner[r] = o;
    relFull.link(o, r);
  }
  relFull.warm();

  // A second relation: edges only to owners in [0, ownerCount/2) so the upper half is edgeless.
  const halfOwners = ownerCount >>> 1;
  const relHalf = new Relation(owner, related);
  for (let r = 0; r < relatedCount; r++) relHalf.link(r % halfOwners, r);
  relHalf.warm();

  // Cheap closed-form oracle for "which owners are hit" given a related-row predicate function.
  // O(related + owners), single typed loop — NOT the FilterNode oracle.
  const cheapExistsCount = (
    rel: Relation,
    ownerOf: (r: number) => number,
    relPredHolds: (r: number) => boolean,
  ): { engineCount: number; oracleCount: number } => {
    const hit = new Uint8Array(ownerCount);
    for (let r = 0; r < relatedCount; r++) if (relPredHolds(r)) hit[ownerOf(r)] = 1;
    let oracleCount = 0;
    for (let o = 0; o < ownerCount; o++) oracleCount += hit[o]!;
    return { engineCount: -1, oracleCount }; // engineCount filled by caller
  };

  // 8 cheap checks across operator families, asserting EXISTS owner COUNT (not the full id list).
  const checks: Array<{ label: string; node: FilterNode; relPredHolds: (r: number) => boolean }> = [
    { label: 'eq 0', node: { leaf: { field: 'rQty', op: 'eq', value: 0 } }, relPredHolds: (r) => r % 10 === 0 },
    { label: 'ne 0', node: { leaf: { field: 'rQty', op: 'ne', value: 0 } }, relPredHolds: (r) => r % 10 !== 0 },
    { label: 'gte 5', node: { leaf: { field: 'rQty', op: 'gte', value: 5 } }, relPredHolds: (r) => r % 10 >= 5 },
    { label: 'lt 3', node: { leaf: { field: 'rQty', op: 'lt', value: 3 } }, relPredHolds: (r) => r % 10 < 3 },
    { label: 'between 2..4', node: { leaf: { field: 'rQty', op: 'between', value: [2, 4] } }, relPredHolds: (r) => r % 10 >= 2 && r % 10 <= 4 },
    { label: 'in {1,9}', node: { leaf: { field: 'rQty', op: 'in', value: [1, 9] } }, relPredHolds: (r) => r % 10 === 1 || r % 10 === 9 },
    { label: 'eq 999 (none)', node: { leaf: { field: 'rQty', op: 'eq', value: 999 } }, relPredHolds: () => false },
    { label: 'contains alph', node: { leaf: { field: 'rKind', op: 'contains', value: 'alph' } }, relPredHolds: (r) => r % 3 === 0 },
  ];

  for (const c of checks) {
    // relFull: all owners edged.
    const engineFull = relFull.ownersMatching(related.scanTree(c.node)).count();
    const oracleFull = cheapExistsCount(relFull, (r) => r % ownerCount, c.relPredHolds).oracleCount;
    assert.equal(engineFull, oracleFull, `large-N relFull [${c.label}]: engine=${engineFull} oracle=${oracleFull}`);

    // relHalf: upper half of owners is edgeless -> EXISTS count can never exceed halfOwners.
    const existsHalf = relHalf.ownersMatching(related.scanTree(c.node));
    const engineHalf = existsHalf.count();
    const oracleHalf = cheapExistsCount(relHalf, (r) => r % halfOwners, c.relPredHolds).oracleCount;
    assert.equal(engineHalf, oracleHalf, `large-N relHalf [${c.label}]: engine=${engineHalf} oracle=${oracleHalf}`);
    assert.ok(engineHalf <= halfOwners, `edgeless upper-half owners must never match [${c.label}]`);
    // Spot-check that no owner id >= halfOwners is set (zero-edge owners excluded at scale).
    for (const probe of [halfOwners, halfOwners + 1, ownerCount - 1]) {
      assert.equal(existsHalf.get(probe), false, `edgeless owner ${probe} must be unset [${c.label}]`);
    }
  }
});
