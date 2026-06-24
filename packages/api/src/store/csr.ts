/**
 * Build a CSR (compressed-sparse-row) grouping of `n` items by a small integer key in `[0, numKeys)`.
 * One O(n) counting sort: count into `offsets[k+1]`, prefix-sum, then scatter each item's value into
 * its key's slice (a per-key cursor keeps each group in input order). Returns two flat `Int32Array`s:
 *
 *   offsets : `Int32Array[numKeys + 1]` — key `k`'s values live in `[offsets[k], offsets[k+1])`.
 *   postings: `Int32Array[n]`           — the values, grouped by key, input-order within each group.
 *
 * The shared substrate behind {@link EqIndex} (value-code -> row ids) and {@link Relation} (owner ->
 * related rows): both are "group these N (key,value) pairs by key", a counting sort with two TypedArray
 * allocations, GC-exempt and cache-sequential. `keys`/`values` are `ArrayLike` so a `number[]` or an
 * `Int32Array` both work without copying.
 */
export function buildCsr(
  n: number,
  numKeys: number,
  keys: ArrayLike<number>,
  values: ArrayLike<number>,
): { offsets: Int32Array<ArrayBuffer>; postings: Int32Array<ArrayBuffer> } {
  const offsets = new Int32Array(numKeys + 1);
  for (let i = 0; i < n; i++) offsets[keys[i]! + 1]!++; // count: key k -> offsets[k+1]
  for (let k = 0; k < numKeys; k++) offsets[k + 1]! += offsets[k]!; // prefix-sum into group starts
  const postings = new Int32Array(n);
  const cursor = offsets.slice(0, numKeys); // mutable copy of each group's next slot
  for (let i = 0; i < n; i++) {
    const k = keys[i]!;
    postings[cursor[k]!++] = values[i]!;
  }
  return { offsets, postings };
}
