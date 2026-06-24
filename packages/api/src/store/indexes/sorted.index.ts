import type { Bitset } from '../bitset.ts';
import { I64Column, type Column, type ColumnType, type ScanOp } from '../column.ts';

export type SortDir = 'asc' | 'desc';

// Scratch DataView used to read the raw IEEE-754 bits of an f64 (its hi/lo u32 words) for the
// order-preserving radix key. Module-level so it is allocated once, not per rebuild.
const KEY_BUF = new ArrayBuffer(8);
const KEY_F64 = new Float64Array(KEY_BUF);
const KEY_U32 = new Uint32Array(KEY_BUF); // [0]=low word, [1]=high word on little-endian hosts

/**
 * LSD radix sort of `[0, n)` by `vals`, returning the row-id permutation as a Uint32Array
 * (ascending by value). Replaces the boxed `Array<number>` + closure comparator `.sort()` to
 * cut GC on the publish path.
 *
 * Keying is an ORDER-PRESERVING unsigned 64-bit integer (two u32 words, radix-sorted over 8
 * bytes LSD), so the unsigned byte order equals the signed/float value order:
 *
 *   - i32: low word = `x ^ 0x80000000` (flip the sign bit so two's-complement negatives sort
 *     below non-negatives); high word = 0.
 *   - f64: the order-preserving map of the IEEE-754 bits — if the sign bit is set (negative),
 *     flip ALL 64 bits; otherwise flip only the sign bit. Every finite ordering then matches
 *     `<` on the real doubles, and NaN/Infinity order consistently. Note -0.0 (key
 *     0x7FFFFFFFFFFFFFFF) sorts immediately before +0.0 (key 0x8000000000000000) — harmless,
 *     since they compare equal under `<`, so either stable position is correct.
 *
 * The sort is stable (counting sort per byte), so equal keys keep ascending row-id order — the
 * same tie-break the old comparator's stable `Array.sort` gave on equal values.
 */
function radixSortRows(vals: Float64Array, n: number, type: ColumnType): Int32Array<ArrayBuffer> {
  const loKey = new Uint32Array(n);
  const hiKey = new Uint32Array(n);
  if (type === 'i32') {
    for (let r = 0; r < n; r++) loKey[r] = (vals[r]! ^ 0x80000000) >>> 0;
    // hiKey stays all-zero.
  } else {
    for (let r = 0; r < n; r++) {
      KEY_F64[0] = vals[r]!;
      const lo = KEY_U32[0]!;
      const hi = KEY_U32[1]!;
      if ((hi & 0x80000000) !== 0) {
        // Negative: flip all bits.
        loKey[r] = ~lo >>> 0;
        hiKey[r] = ~hi >>> 0;
      } else {
        // Non-negative: flip only the sign bit.
        loKey[r] = lo;
        hiKey[r] = (hi ^ 0x80000000) >>> 0;
      }
    }
  }

  let src = new Int32Array(n);
  for (let r = 0; r < n; r++) src[r] = r;
  let dst = new Int32Array(n);
  const counts = new Int32Array(257);

  // 8 byte-passes, least-significant first; bytes 0..3 read loKey, 4..7 read hiKey.
  for (let byte = 0; byte < 8; byte++) {
    const useHi = byte >= 4;
    const shift = (byte & 3) << 3;
    const key = useHi ? hiKey : loKey;
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[((key[src[i]!]! >>> shift) & 0xff) + 1]!++;
    for (let b = 0; b < 256; b++) counts[b + 1]! += counts[b]!;
    for (let i = 0; i < n; i++) {
      const r = src[i]!;
      const bucket = (key[r]! >>> shift) & 0xff;
      dst[counts[bucket]!++] = r;
    }
    const tmp = src;
    src = dst;
    dst = tmp;
  }
  return src;
}

/**
 * LSD radix sort for an int64 (`i64`/`decimal` mantissa) column. The key is the ORDER-PRESERVING
 * unsigned 64-bit map of the signed int64: `key = bits XOR 0x8000000000000000` — a SIGN-BIT FLIP ONLY
 * (NOT the f64 "flip-all-if-negative" rule). Two's-complement int64 is already monotonic under signed
 * compare, so flipping just the top bit maps `[-2^63, 2^63-1]` onto `[0, 2^64)` order-preservingly:
 * negatives (top bit 1 -> 0) sort below non-negatives, and within negatives `-1 > -2` is preserved.
 * The 8-byte LSD counting-sort loop is identical to {@link radixSortRows} (and stable), so equal keys
 * keep ascending row-id order.
 */
function radixSortRowsI64(vals: BigInt64Array, n: number): Int32Array<ArrayBuffer> {
  const loKey = new Uint32Array(n);
  const hiKey = new Uint32Array(n);
  const FLIP = 1n << 63n;
  for (let r = 0; r < n; r++) {
    const key = BigInt.asUintN(64, vals[r]! ^ FLIP);
    loKey[r] = Number(key & 0xffffffffn);
    hiKey[r] = Number((key >> 32n) & 0xffffffffn);
  }

  let src = new Int32Array(n);
  for (let r = 0; r < n; r++) src[r] = r;
  let dst = new Int32Array(n);
  const counts = new Int32Array(257);

  for (let byte = 0; byte < 8; byte++) {
    const useHi = byte >= 4;
    const shift = (byte & 3) << 3;
    const key = useHi ? hiKey : loKey;
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[((key[src[i]!]! >>> shift) & 0xff) + 1]!++;
    for (let b = 0; b < 256; b++) counts[b + 1]! += counts[b]!;
    for (let i = 0; i < n; i++) {
      const r = src[i]!;
      const bucket = (key[r]! >>> shift) & 0xff;
      dst[counts[bucket]!++] = r;
    }
    const tmp = src;
    src = dst;
    dst = tmp;
  }
  return src;
}

/**
 * Numeric sorted index: row ids ordered by their column value, stored as parallel
 * Float64Array (values) + Int32Array (rows). Powers two things:
 *
 *  - Range filters ($gt/$lt/...): binary-search the boundary, then the matching rows are a
 *    contiguous slice of the sorted arrays — no full scan.
 *  - ORDER BY with pagination: walk the sorted rows in order and stop as soon as the page
 *    is filled (early termination), so sorting N matches to show 20 costs ~the page size,
 *    not N log N.
 *
 * Rebuilt lazily: inserts mark it dirty (an in-place sorted insert would be O(n) shift),
 * and the next query that needs it rebuilds once. Fits the rare-write/frequent-read CMS
 * profile. A future incremental B-tree variant would remove even the rebuild.
 */
export class SortedIndex {
  private values = new Float64Array(0);
  /**
   * Parallel int64 values for an `i64`/`decimal` column — the EXACT mantissa, NOT the f64 `values`
   * (assigning a > 2^53 mantissa into a Float64Array would lose precision inside the index). Only one
   * of `values` / `valuesI64` is populated per index, selected by {@link isI64}.
   */
  private valuesI64 = new BigInt64Array(0);
  /** True when this index is over an int64 column (read `valuesI64`, compare with bigint). */
  private isI64 = false;
  private rows = new Int32Array(0);
  private len = 0;
  private dirty = true;

  markDirty(): void {
    this.dirty = true;
  }

  /**
   * True if the next read would trigger a rebuild — either an insert marked it dirty, or the
   * built length no longer matches the row count. `Table.warmIndexes()` uses this so a publish
   * batch can eagerly rebuild every index and a test can assert "no rebuild on the next reader".
   */
  isDirty(rowCount: number): boolean {
    return this.dirty || this.len !== rowCount;
  }

  ensureBuilt(column: Column, rowCount: number): void {
    if (this.dirty || this.len !== rowCount) this.rebuild(column, rowCount);
  }

  private rebuild(column: Column, rowCount: number): void {
    if (column instanceof I64Column) {
      // int64-exact path: read the column's BigInt64Array directly (NEVER `at() as number`), sort by
      // the sign-bit-flip key, and fill a parallel BigInt64Array so binary search compares bigints —
      // a mantissa above 2^53 keeps full precision throughout (an f64 `values` would corrupt it).
      const vals = new BigInt64Array(rowCount);
      const raw = column.rawData();
      for (let r = 0; r < rowCount; r++) vals[r] = raw[r]!;
      const rows = radixSortRowsI64(vals, rowCount);
      const valuesI64 = new BigInt64Array(rowCount);
      for (let i = 0; i < rowCount; i++) valuesI64[i] = vals[rows[i]!]!;
      this.valuesI64 = valuesI64;
      this.values = new Float64Array(0);
      this.isI64 = true;
      this.rows = rows;
      this.len = rowCount;
      this.dirty = false;
      return;
    }

    // Read column values once into a flat array, then sort row indices by referencing it.
    // Avoids a virtual `column.at()` call inside the hot comparator.
    const vals = new Float64Array(rowCount);
    for (let r = 0; r < rowCount; r++) vals[r] = column.at(r) as number;

    // Sort row ids by value with a stable LSD radix sort over a Uint32Array permutation — no
    // boxed `Array<number>` and no closure comparator (the biggest GC source on the publish
    // path). `radixSortRows` keys each value on an order-preserving unsigned 64-bit integer
    // (two u32 words) so unsigned byte order equals the signed/float value order; the exact
    // i32/f64 key derivation is documented on that function.
    const rows = radixSortRows(vals, rowCount, column.type);

    const values = new Float64Array(rowCount);
    for (let i = 0; i < rowCount; i++) values[i] = vals[rows[i]!]!;
    this.values = values;
    this.isI64 = false;
    this.rows = rows;
    this.len = rowCount;
    this.dirty = false;
  }

  /** First index with values[i] >= target. */
  private lowerBound(target: number): number {
    let lo = 0;
    let hi = this.len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.values[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** First index with values[i] > target. */
  private upperBound(target: number): number {
    let lo = 0;
    let hi = this.len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.values[mid]! <= target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Half-open [start, end) range of the sorted arrays matching `op value`. */
  private rangeSlice(op: ScanOp, value: number): [number, number] {
    switch (op) {
      case 'gt':  return [this.upperBound(value), this.len];
      case 'gte': return [this.lowerBound(value), this.len];
      case 'lt':  return [0, this.lowerBound(value)];
      case 'lte': return [0, this.upperBound(value)];
      case 'eq':  return [this.lowerBound(value), this.upperBound(value)];
      case 'ne':  return [0, 0]; // not range-shaped; caller falls back to a scan
      default: throw new Error(`rangeSlice: non-range op ${op}`); // only gt/gte/lt/lte/eq/ne reach here
    }
  }

  supportsRangeOp(op: ScanOp): boolean {
    return (
      op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte' || op === 'eq' || op === 'between'
    );
  }

  /**
   * Half-open [start, end) slice for an inclusive `$between [lo, hi]` from ONE probe pair —
   * `lowerBound(lo)` (first value >= lo) up to `upperBound(hi)` (first value > hi) — instead of
   * two separate range scans AND-ed together. A reversed range (lo > hi) yields start >= end, an
   * empty slice; a single point (lo == hi) is `[lowerBound(v), upperBound(v)]` like `$eq`.
   */
  private rangeSliceBetween(lo: number, hi: number): [number, number] {
    if (lo > hi) return [0, 0]; // reversed bounds: nothing satisfies lo <= x <= hi
    const start = this.lowerBound(lo);
    const end = this.upperBound(hi);
    return start <= end ? [start, end] : [0, 0];
  }

  /** Number of rows in an inclusive `$between [lo, hi]` — O(log n), just the slice width. */
  countRangeBetween(lo: number, hi: number): number {
    const [start, end] = this.rangeSliceBetween(lo, hi);
    return end - start;
  }

  /** Set bits for every row in an inclusive `$between [lo, hi]`, from the single sorted slice. */
  fillBitsetBetween(lo: number, hi: number, out: Bitset): void {
    const [start, end] = this.rangeSliceBetween(lo, hi);
    const rows = this.rows;
    for (let i = start; i < end; i++) out.set(rows[i]!);
  }

  /** Number of rows matching a range predicate — O(log n), just the slice width. */
  countRange(op: ScanOp, value: number): number {
    const [start, end] = this.rangeSlice(op, value);
    return end - start;
  }

  /** Collect row ids matching a range predicate, in ascending key order. */
  collectRange(op: ScanOp, value: number): number[] {
    const [start, end] = this.rangeSlice(op, value);
    const out = new Array<number>(end - start);
    for (let i = start; i < end; i++) out[i - start] = this.rows[i]!;
    return out;
  }

  /** Set bits for all rows matching a range predicate, using the sorted slice. */
  fillBitset(op: ScanOp, value: number, out: Bitset): void {
    const [start, end] = this.rangeSlice(op, value);
    const rows = this.rows;
    for (let i = start; i < end; i++) out.set(rows[i]!);
  }

  // --- int64-exact (i64 / decimal) overloads ---------------------------------------------------
  // These compare on `valuesI64` with bigint `<`/`<=` — a bound is NEVER coerced to Number, so a
  // mantissa above 2^53 keeps full precision. They mirror the f64 methods one-for-one.

  /** First index with valuesI64[i] >= target (bigint). */
  private lowerBoundI64(target: bigint): number {
    let lo = 0;
    let hi = this.len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.valuesI64[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** First index with valuesI64[i] > target (bigint). */
  private upperBoundI64(target: bigint): number {
    let lo = 0;
    let hi = this.len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.valuesI64[mid]! <= target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private rangeSliceI64(op: ScanOp, value: bigint): [number, number] {
    switch (op) {
      case 'gt':  return [this.upperBoundI64(value), this.len];
      case 'gte': return [this.lowerBoundI64(value), this.len];
      case 'lt':  return [0, this.lowerBoundI64(value)];
      case 'lte': return [0, this.upperBoundI64(value)];
      case 'eq':  return [this.lowerBoundI64(value), this.upperBoundI64(value)];
      case 'ne':  return [0, 0]; // not range-shaped; caller falls back to a scan
    }
    return [0, 0];
  }

  private rangeSliceBetweenI64(lo: bigint, hi: bigint): [number, number] {
    if (lo > hi) return [0, 0];
    const start = this.lowerBoundI64(lo);
    const end = this.upperBoundI64(hi);
    return start <= end ? [start, end] : [0, 0];
  }

  countRangeBetweenI64(lo: bigint, hi: bigint): number {
    const [start, end] = this.rangeSliceBetweenI64(lo, hi);
    return end - start;
  }

  fillBitsetBetweenI64(lo: bigint, hi: bigint, out: Bitset): void {
    const [start, end] = this.rangeSliceBetweenI64(lo, hi);
    const rows = this.rows;
    for (let i = start; i < end; i++) out.set(rows[i]!);
  }

  countRangeI64(op: ScanOp, value: bigint): number {
    const [start, end] = this.rangeSliceI64(op, value);
    return end - start;
  }

  fillBitsetI64(op: ScanOp, value: bigint, out: Bitset): void {
    const [start, end] = this.rangeSliceI64(op, value);
    const rows = this.rows;
    for (let i = start; i < end; i++) out.set(rows[i]!);
  }

  /**
   * Visit row ids in sorted order (asc or desc). `fn` returns false to stop early —
   * that's what makes ORDER BY + LIMIT cost the page size, not the full result set.
   */
  forEachOrdered(dir: SortDir, fn: (row: number) => boolean): void {
    const rows = this.rows;
    if (dir === 'asc') {
      for (let i = 0; i < this.len; i++) if (!fn(rows[i]!)) return;
    } else {
      for (let i = this.len - 1; i >= 0; i--) if (!fn(rows[i]!)) return;
    }
  }
}
