import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Relation } from '../src/store/relation.ts';
import { Table, type FieldDef } from '../src/store/table.ts';
import { Bitset } from '../src/store/bitset.ts';

/**
 * RELATIONS SLICE 1 — the single-hop CSR adjacency `Relation` (owner -> related), the load-bearing
 * substrate for relational EXISTS filtering and (later) populate. Mock-free, PURE data structure (no
 * Postgres): two real Tables, random edge sets, asserted against brute-force oracles.
 *
 * Proves: ownersMatching == "owners with >=1 related row in the set" (EXISTS), relatedRows ==
 * each owner's exact related multiset (CSR/insertion order), the fromEdges re-derivation factory,
 * rebuild-after-grow (link after a build), and the empty/out-of-range/shared-related edge cases.
 */

const FIELDS: FieldDef[] = [{ name: 'id', type: 'i32' }];

/** A Table of `n` rows (id = row index); the relation only needs row counts + ids. */
function tableOf(n: number): Table {
  const t = new Table(FIELDS);
  for (let i = 0; i < n; i++) t.insert({ id: i });
  return t;
}

/** Deterministic LCG so a failure reproduces. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A Bitset over `relatedCount` rows with the given members set. */
function relatedSet(relatedCount: number, members: Iterable<number>): Bitset {
  const b = new Bitset(relatedCount);
  for (const r of members) b.set(r);
  return b;
}

test('ownersMatching + relatedRows match a brute-force oracle over random edge sets', () => {
  const rng = lcg(7);
  for (let trial = 0; trial < 200; trial++) {
    const ownerCount = 1 + ((rng() * 20) | 0);
    const relatedCount = 1 + ((rng() * 20) | 0);
    const edgeCount = (rng() * 40) | 0;

    // Build the edge set + a brute-force adjacency oracle.
    const edges: [number, number][] = [];
    const adj: Set<number>[] = Array.from({ length: ownerCount }, () => new Set<number>());
    const adjList: number[][] = Array.from({ length: ownerCount }, () => []);
    for (let i = 0; i < edgeCount; i++) {
      const o = (rng() * ownerCount) | 0;
      const r = (rng() * relatedCount) | 0;
      edges.push([o, r]);
      adj[o]!.add(r);
      adjList[o]!.push(r);
    }

    const rel = Relation.fromEdges(tableOf(ownerCount), tableOf(relatedCount), edges);

    // relatedRows(o): same MULTISET as the inserted edges for o (CSR keeps every edge, incl. dups).
    for (let o = 0; o < ownerCount; o++) {
      const got = rel.relatedRows(o).slice().sort((a, b) => a - b);
      const want = adjList[o]!.slice().sort((a, b) => a - b);
      assert.deepEqual(got, want, `relatedRows(${o}) trial ${trial}`);
    }
    assert.deepEqual(rel.relatedRows(-1), [], 'out-of-range owner -> empty');
    assert.deepEqual(rel.relatedRows(ownerCount), [], 'out-of-range owner -> empty');

    // ownersMatching(S): owners with >=1 related row in S, vs the oracle.
    for (let probe = 0; probe < 5; probe++) {
      const members: number[] = [];
      for (let r = 0; r < relatedCount; r++) if (rng() < 0.4) members.push(r);
      const set = new Set(members);
      const got = rel.ownersMatching(relatedSet(relatedCount, members)).toArray();
      const want: number[] = [];
      for (let o = 0; o < ownerCount; o++) {
        if ([...adj[o]!].some((r) => set.has(r))) want.push(o);
      }
      assert.deepEqual(got, want, `ownersMatching trial ${trial} probe ${probe}`);
    }
  }
});

test('rebuild-after-grow: link() after a build is reflected on the next query', () => {
  const owner = tableOf(3);
  const related = tableOf(3);
  const rel = new Relation(owner, related, [[0, 0]]);
  rel.warm(); // force a build
  assert.deepEqual(rel.relatedRows(0), [0]);
  assert.deepEqual(rel.relatedRows(1), []);

  rel.link(1, 2); // append after the build -> dirty -> next query rebuilds
  assert.ok(rel.isDirty());
  assert.deepEqual(rel.relatedRows(1), [2]);
  assert.deepEqual(rel.ownersMatching(relatedSet(3, [2])).toArray(), [1]);
});

test('a related row shared by several owners makes ALL of them match', () => {
  const rel = Relation.fromEdges(tableOf(3), tableOf(2), [[0, 1], [1, 1], [2, 0]]);
  assert.deepEqual(rel.ownersMatching(relatedSet(2, [1])).toArray(), [0, 1]);
  assert.deepEqual(rel.ownersMatching(relatedSet(2, [0])).toArray(), [2]);
  assert.deepEqual(rel.ownersMatching(relatedSet(2, [])).toArray(), []);
});

test('an owner with no edges never matches and has empty relatedRows', () => {
  const rel = Relation.fromEdges(tableOf(2), tableOf(2), [[0, 0]]);
  assert.deepEqual(rel.relatedRows(1), []);
  // owner 1 is absent from EVERY ownersMatching result regardless of the related set.
  assert.ok(!rel.ownersMatching(relatedSet(2, [0, 1])).get(1));
});
