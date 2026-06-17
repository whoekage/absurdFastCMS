import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef, type FilterNode, type Predicate } from '../src/store/table.ts';
import { Relation } from '../src/store/relation.ts';

/**
 * Slice 9 — relation filtering (single-hop CSR owner->related adjacency, EXISTS semantics).
 *
 * Doctrine (non-negotiable): NO mocks. Everything is driven through the real Table / Relation.
 * Every expectation is computed by a trivial O(n) brute-force ORACLE over the inserted rows and
 * the explicit edge set — "owner rows with >= 1 related row matching predicate P" — and asserted
 * EQUAL to `Relation.ownersMatching(related.scanTree(P))`.
 *
 * Covered: one-to-many AND many-to-many edge sets; owner with zero related rows (never matches);
 * a related row shared by multiple owners (all those owners match); P matching no related rows
 * (no owners); P matching all related rows (exactly the owners with >= 1 edge); a P over a
 * NULL-bearing related field (three-valued logic preserved through the join); compose with an
 * owner predicate (AND) vs the combined oracle; capacity growth past INITIAL_CAPACITY (1024) for
 * both owner and related tables. Deterministic seeded LCG, no Math.random.
 */

// Deterministic pseudo-random source (seeded LCG) — no Math.random, per the testing doctrine.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904229) >>> 0;
    return s / 0x100000000;
  };
}

const OWNER_FIELDS: FieldDef[] = [
  { name: 'tier', type: 'string' },
  { name: 'score', type: 'i32' },
];

const RELATED_FIELDS: FieldDef[] = [
  { name: 'kind', type: 'string' },
  { name: 'qty', type: 'i32' },
];

/**
 * Brute-force EXISTS oracle: owner rows that have AT LEAST ONE edge whose related row is in
 * `relatedMatch` (the precomputed set of related rows satisfying the related predicate). Mirrors
 * the production EXISTS semantics with a trivial nested loop over the explicit edges.
 */
function ownersWithSomeMatchingRelated(
  ownerCount: number,
  edges: [number, number][],
  relatedMatch: Set<number>,
): number[] {
  const out: number[] = [];
  for (let o = 0; o < ownerCount; o++) {
    let hit = false;
    for (const [eo, er] of edges) {
      if (eo === o && relatedMatch.has(er)) {
        hit = true;
        break;
      }
    }
    if (hit) out.push(o);
  }
  return out;
}

/** Brute oracle: the set of related rows satisfying a single-field predicate, with 3-valued logic. */
function relatedMatchSet(relatedRows: (Record<string, unknown> | null)[], p: Predicate): Set<number> {
  const out = new Set<number>();
  for (let r = 0; r < relatedRows.length; r++) {
    const row = relatedRows[r];
    // A row missing the field, or with a null at it, is NULL => never matches a comparison op.
    if (row === null || !(p.field in row) || row[p.field] === null || row[p.field] === undefined) continue;
    const v = row[p.field];
    let hit = false;
    switch (p.op) {
      case 'eq': hit = v === p.value; break;
      case 'ne': hit = v !== p.value; break;
      case 'gt': hit = (v as number) > (p.value as number); break;
      case 'gte': hit = (v as number) >= (p.value as number); break;
      case 'lt': hit = (v as number) < (p.value as number); break;
      case 'lte': hit = (v as number) <= (p.value as number); break;
      default: throw new Error(`oracle does not handle op ${p.op}`);
    }
    if (hit) out.add(r);
  }
  return out;
}

/** Build a related table from row specs (null spec => insert an empty row, i.e. all-null). */
function buildRelated(rows: (Record<string, unknown> | null)[]): Table {
  const t = new Table(RELATED_FIELDS);
  for (const row of rows) t.insert(row === null ? {} : row);
  return t;
}

/** Build an owner table from row specs. */
function buildOwner(rows: Record<string, unknown>[]): Table {
  const t = new Table(OWNER_FIELDS);
  for (const row of rows) t.insert(row);
  return t;
}

test('one-to-many: ownersMatching equals the brute EXISTS oracle for varied predicates', () => {
  const rng = lcg(0x51ce9);
  const ownerCount = 60;
  const relatedCount = 200;

  const ownerRows = Array.from({ length: ownerCount }, (_v, i) => ({
    tier: ['gold', 'silver', 'bronze'][i % 3]!,
    score: Math.floor(rng() * 100),
  }));
  const relatedRows = Array.from({ length: relatedCount }, () => ({
    kind: ['a', 'b', 'c', 'd'][Math.floor(rng() * 4)]!,
    qty: Math.floor(rng() * 50),
  }));

  const owner = buildOwner(ownerRows);
  const related = buildRelated(relatedRows);

  // ONE-TO-MANY: each related row belongs to exactly one owner; an owner may own many.
  const edges: [number, number][] = [];
  for (let r = 0; r < relatedCount; r++) {
    const o = Math.floor(rng() * ownerCount);
    edges.push([o, r]);
  }

  const rel = new Relation(owner, related, edges);

  const predicates: Predicate[] = [
    { field: 'kind', op: 'eq', value: 'a' },
    { field: 'kind', op: 'ne', value: 'a' },
    { field: 'qty', op: 'gte', value: 25 },
    { field: 'qty', op: 'lt', value: 10 },
    { field: 'kind', op: 'eq', value: 'zzz' }, // matches no related rows
  ];

  for (const p of predicates) {
    const matchSet = relatedMatchSet(relatedRows, p);
    const expected = ownersWithSomeMatchingRelated(ownerCount, edges, matchSet);
    const got = rel.ownersMatching(related.scanTree({ leaf: p })).toArray();
    assert.deepEqual(got, expected, `predicate ${p.field} ${p.op} ${String(p.value)}`);
  }
});

test('many-to-many: shared related rows make all owning rows match', () => {
  const rng = lcg(0xb0b);
  const ownerCount = 40;
  const relatedCount = 80;

  const ownerRows = Array.from({ length: ownerCount }, (_v, i) => ({ tier: 't', score: i }));
  const relatedRows = Array.from({ length: relatedCount }, (_v, i) => ({
    kind: ['x', 'y'][i % 2]!,
    qty: Math.floor(rng() * 30),
  }));

  const owner = buildOwner(ownerRows);
  const related = buildRelated(relatedRows);

  // MANY-TO-MANY: each related row is linked to a RANDOM set of owners (1..4 of them), so a
  // related row is genuinely shared. Use a builder (link) instead of the constructor list.
  const edges: [number, number][] = [];
  const rel = new Relation(owner, related);
  for (let r = 0; r < relatedCount; r++) {
    const degree = 1 + Math.floor(rng() * 4);
    const owners = new Set<number>();
    while (owners.size < degree) owners.add(Math.floor(rng() * ownerCount));
    for (const o of owners) {
      edges.push([o, r]);
      rel.link(o, r);
    }
  }

  const predicates: Predicate[] = [
    { field: 'kind', op: 'eq', value: 'x' },
    { field: 'qty', op: 'gte', value: 15 },
    { field: 'qty', op: 'lt', value: 5 },
  ];

  for (const p of predicates) {
    const matchSet = relatedMatchSet(relatedRows, p);
    const expected = ownersWithSomeMatchingRelated(ownerCount, edges, matchSet);
    const got = rel.ownersMatching(related.scanTree({ leaf: p })).toArray();
    assert.deepEqual(got, expected, `m2m predicate ${p.field} ${p.op} ${String(p.value)}`);
  }
});

test('edge cases: zero-related owner, shared related, none-match, all-match', () => {
  const ownerRows = [
    { tier: 'a', score: 1 }, // owner 0: owns related 0,1
    { tier: 'a', score: 2 }, // owner 1: owns related 1,2  (related 1 shared with owner 0)
    { tier: 'a', score: 3 }, // owner 2: ZERO related rows
    { tier: 'a', score: 4 }, // owner 3: owns related 3
  ];
  const relatedRows = [
    { kind: 'p', qty: 10 }, // 0
    { kind: 'q', qty: 20 }, // 1 (shared 0 & 1)
    { kind: 'p', qty: 30 }, // 2
    { kind: 'r', qty: 40 }, // 3
  ];
  const edges: [number, number][] = [
    [0, 0], [0, 1],
    [1, 1], [1, 2],
    [3, 3],
  ];

  const owner = buildOwner(ownerRows);
  const related = buildRelated(relatedRows);
  const rel = new Relation(owner, related, edges);

  // Shared related row 1 (kind 'q'): owners 0 AND 1 both match.
  {
    const p: Predicate = { field: 'kind', op: 'eq', value: 'q' };
    const matchSet = relatedMatchSet(relatedRows, p);
    const expected = ownersWithSomeMatchingRelated(4, edges, matchSet);
    assert.deepEqual(rel.ownersMatching(related.scanTree({ leaf: p })).toArray(), expected);
    assert.deepEqual(expected, [0, 1]);
  }

  // Owner 2 has zero related rows => it can NEVER match, whatever P is.
  {
    const pAll: Predicate = { field: 'qty', op: 'gte', value: 0 }; // every related row matches
    const got = rel.ownersMatching(related.scanTree({ leaf: pAll })).toArray();
    assert.ok(!got.includes(2), 'owner with zero related rows must never match');
    // All-match P => exactly the owners that have >= 1 edge (0,1,3 — NOT 2).
    assert.deepEqual(got, [0, 1, 3]);
  }

  // P matching no related rows => no owners.
  {
    const pNone: Predicate = { field: 'kind', op: 'eq', value: 'absent' };
    assert.deepEqual(rel.ownersMatching(related.scanTree({ leaf: pNone })).toArray(), []);
  }
});

test('NULL-bearing related field: three-valued logic preserved through the join', () => {
  const ownerRows = [
    { tier: 'a', score: 1 }, // owner 0 -> related 0 (qty null), 1 (qty 5)
    { tier: 'a', score: 2 }, // owner 1 -> related 2 (qty null) ONLY
    { tier: 'a', score: 3 }, // owner 2 -> related 3 (qty 9)
  ];
  // related rows 0 and 2 are NULL at qty (missing field => null).
  const relatedRows: (Record<string, unknown> | null)[] = [
    { kind: 'k' }, //          0: qty is NULL
    { kind: 'k', qty: 5 }, //  1
    { kind: 'k' }, //          2: qty is NULL
    { kind: 'k', qty: 9 }, //  3
  ];
  const edges: [number, number][] = [[0, 0], [0, 1], [1, 2], [2, 3]];

  const owner = buildOwner(ownerRows);
  const related = buildRelated(relatedRows);
  const rel = new Relation(owner, related, edges);

  // qty >= 0 : NULL rows (0,2) are excluded by 3-valued logic in the related scanTree, so only
  // related 1 (owner 0) and 3 (owner 2) match. Owner 1's ONLY related row is NULL => excluded.
  for (const p of [
    { field: 'qty', op: 'gte', value: 0 } as Predicate,
    { field: 'qty', op: 'ne', value: 1000 } as Predicate, // ne must ALSO exclude nulls
  ]) {
    const matchSet = relatedMatchSet(relatedRows, p);
    const expected = ownersWithSomeMatchingRelated(3, edges, matchSet);
    const got = rel.ownersMatching(related.scanTree({ leaf: p })).toArray();
    assert.deepEqual(got, expected, `null-aware ${p.op}`);
    assert.ok(!got.includes(1), 'owner whose only related row is NULL must not match');
  }
});

test('compose: owner predicate AND related EXISTS equals the combined oracle', () => {
  const rng = lcg(0x2468);
  const ownerCount = 100;
  const relatedCount = 300;

  const ownerRows = Array.from({ length: ownerCount }, (_v, i) => ({
    tier: ['gold', 'silver', 'bronze'][i % 3]!,
    score: Math.floor(rng() * 1000),
  }));
  const relatedRows = Array.from({ length: relatedCount }, () => ({
    kind: ['a', 'b', 'c'][Math.floor(rng() * 3)]!,
    qty: Math.floor(rng() * 100),
  }));

  const owner = buildOwner(ownerRows);
  const related = buildRelated(relatedRows);

  const edges: [number, number][] = [];
  const rel = new Relation(owner, related);
  for (let r = 0; r < relatedCount; r++) {
    const o = Math.floor(rng() * ownerCount);
    edges.push([o, r]);
    rel.link(o, r);
  }

  const relatedPred: Predicate = { field: 'kind', op: 'eq', value: 'a' };
  const ownerPred: Predicate = { field: 'score', op: 'gte', value: 500 };

  // Engine: owner predicate bitset AND owners-matching-related EXISTS bitset.
  const ownerBitset = owner.scanTree({ leaf: ownerPred });
  const existsBitset = rel.ownersMatching(related.scanTree({ leaf: relatedPred }));
  const got = ownerBitset.and(existsBitset).toArray();

  // Combined oracle: owners whose own predicate holds AND that have >= 1 matching related row.
  const relMatch = relatedMatchSet(relatedRows, relatedPred);
  const existsOwners = new Set(ownersWithSomeMatchingRelated(ownerCount, edges, relMatch));
  const expected: number[] = [];
  for (let o = 0; o < ownerCount; o++) {
    const v = ownerRows[o]!.score as number;
    if (v >= 500 && existsOwners.has(o)) expected.push(o);
  }
  assert.deepEqual(got, expected);
});

test('capacity growth: owners and related both past INITIAL_CAPACITY (1024)', () => {
  const rng = lcg(0x9999);
  const ownerCount = 1500; // > 1024
  const relatedCount = 3000; // > 1024

  const ownerRows = Array.from({ length: ownerCount }, (_v, i) => ({
    tier: 't',
    score: Math.floor(rng() * 10000),
  }));
  const relatedRows = Array.from({ length: relatedCount }, () => ({
    kind: ['a', 'b', 'c', 'd', 'e'][Math.floor(rng() * 5)]!,
    qty: Math.floor(rng() * 200),
  }));

  const owner = buildOwner(ownerRows);
  const related = buildRelated(relatedRows);

  // Mixed one-to-many + many-to-many: every related row links to 1..3 owners.
  const edges: [number, number][] = [];
  const rel = new Relation(owner, related);
  for (let r = 0; r < relatedCount; r++) {
    const degree = 1 + Math.floor(rng() * 3);
    const owners = new Set<number>();
    while (owners.size < degree) owners.add(Math.floor(rng() * ownerCount));
    for (const o of owners) {
      edges.push([o, r]);
      rel.link(o, r);
    }
  }

  const predicates: Predicate[] = [
    { field: 'kind', op: 'eq', value: 'c' },
    { field: 'qty', op: 'gte', value: 100 },
    { field: 'qty', op: 'lt', value: 1 },
    { field: 'qty', op: 'gte', value: 0 }, // all related rows
  ];

  for (const p of predicates) {
    const matchSet = relatedMatchSet(relatedRows, p);
    const expected = ownersWithSomeMatchingRelated(ownerCount, edges, matchSet);
    const got = rel.ownersMatching(related.scanTree({ leaf: p })).toArray();
    assert.deepEqual(got, expected, `large predicate ${p.field} ${p.op} ${String(p.value)}`);
  }
});

test('link after build rebuilds the CSR (append-only maintenance)', () => {
  const owner = buildOwner([{ tier: 'a', score: 1 }, { tier: 'a', score: 2 }]);
  const related = buildRelated([{ kind: 'k', qty: 1 }, { kind: 'k', qty: 2 }]);
  const rel = new Relation(owner, related, [[0, 0]]);

  const p: Predicate = { field: 'kind', op: 'eq', value: 'k' };
  // Before: only owner 0 has an edge.
  assert.deepEqual(rel.ownersMatching(related.scanTree({ leaf: p })).toArray(), [0]);
  // Add an edge for owner 1; the dirty CSR must rebuild on the next query.
  rel.link(1, 1);
  assert.deepEqual(rel.ownersMatching(related.scanTree({ leaf: p })).toArray(), [0, 1]);
});

test('materializeRelated returns an owner\'s related objects (late materialization)', () => {
  const owner = buildOwner([{ tier: 'a', score: 1 }, { tier: 'a', score: 2 }]);
  const related = buildRelated([
    { kind: 'p', qty: 10 },
    { kind: 'q', qty: 20 },
    { kind: 'r', qty: 30 },
  ]);
  const rel = new Relation(owner, related, [[0, 0], [0, 2], [1, 1]]);

  const owner0 = rel.materializeRelated(0);
  assert.deepEqual(owner0, [
    { kind: 'p', qty: 10 },
    { kind: 'r', qty: 30 },
  ]);
  assert.deepEqual(rel.materializeRelated(1), [{ kind: 'q', qty: 20 }]);

  // Compose with a tree predicate over the related table: only related rows matching P, restricted
  // to a single owner's edges, materialized — proving the join + scanTree + materialize line up.
  const p: FilterNode = { leaf: { field: 'qty', op: 'gte', value: 25 } };
  const matched = related.scanTree(p);
  const owner0Matching = rel
    .materializeRelated(0)
    .filter((_o, i) => matched.get([0, 2][i]!));
  assert.deepEqual(owner0Matching, [{ kind: 'r', qty: 30 }]);
});
