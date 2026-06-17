import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCsr } from '../src/store/csr.ts';

/**
 * buildCsr — the shared counting-sort CSR grouping behind EqIndex (value-code -> rows) and Relation
 * (owner -> related). Pure; asserted against a brute-force grouping oracle over random (key,value) sets,
 * plus the structural invariants (offsets monotone, group input-order preserved, empties handled).
 */

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000);
}

test('buildCsr groups (key,value) pairs by key, input-order within each group, vs an oracle', () => {
  const rng = lcg(11);
  for (let trial = 0; trial < 300; trial++) {
    const numKeys = 1 + ((rng() * 12) | 0);
    const n = (rng() * 30) | 0;
    const keys: number[] = [];
    const values: number[] = [];
    const oracle: number[][] = Array.from({ length: numKeys }, () => []);
    for (let i = 0; i < n; i++) {
      const k = (rng() * numKeys) | 0;
      const v = (rng() * 1000) | 0;
      keys.push(k);
      values.push(v);
      oracle[k]!.push(v); // input order preserved per key
    }

    const { offsets, postings } = buildCsr(n, numKeys, keys, values);

    assert.equal(offsets.length, numKeys + 1);
    assert.equal(postings.length, n);
    assert.equal(offsets[0], 0);
    assert.equal(offsets[numKeys], n, 'last offset = total');
    for (let k = 0; k < numKeys; k++) {
      assert.ok(offsets[k + 1]! >= offsets[k]!, 'offsets monotone non-decreasing');
      const slice = Array.from(postings.subarray(offsets[k]!, offsets[k + 1]!));
      assert.deepEqual(slice, oracle[k]!, `group ${k} (trial ${trial}) matches input-order oracle`);
    }
  }
});

test('buildCsr: empty input + a key with no items', () => {
  const empty = buildCsr(0, 3, [], []);
  assert.deepEqual(Array.from(empty.offsets), [0, 0, 0, 0]);
  assert.equal(empty.postings.length, 0);

  // key 1 gets nothing; 0 and 2 do.
  const { offsets, postings } = buildCsr(2, 3, [0, 2], [7, 9]);
  assert.equal(offsets[1]! - offsets[0]!, 1); // key 0 -> one item
  assert.equal(offsets[2]! - offsets[1]!, 0); // key 1 -> none
  assert.equal(offsets[3]! - offsets[2]!, 1); // key 2 -> one item
  assert.deepEqual(Array.from(postings.subarray(offsets[0]!, offsets[1]!)), [7]);
  assert.deepEqual(Array.from(postings.subarray(offsets[2]!, offsets[3]!)), [9]);
});

test('buildCsr accepts an Int32Array key source (EqIndex codeForRow path)', () => {
  const keys = Int32Array.from([2, 0, 2, 1]);
  const values = [20, 0, 22, 11];
  const { offsets, postings } = buildCsr(4, 3, keys, values);
  assert.deepEqual(Array.from(postings.subarray(offsets[2]!, offsets[3]!)), [20, 22]); // key 2, in order
});
