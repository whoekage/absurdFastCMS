/**
 * Dense bitset backed by a Uint32Array — one bit per row.
 *
 * Used as the result of a column scan: each set bit is a matching row index.
 * Combining predicates (Strapi-style `filters[a]&filters[b]`) becomes a word-wise
 * AND/OR over the backing array instead of per-row object checks.
 */
export class Bitset {
  /** Number of addressable bits (row capacity). */
  readonly capacity: number;
  readonly words: Uint32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.words = new Uint32Array((capacity + 31) >>> 5);
  }

  set(i: number): void {
    const w = i >>> 5;
    this.words[w] = this.words[w]! | (1 << (i & 31));
  }

  clear(i: number): void {
    const w = i >>> 5;
    this.words[w] = this.words[w]! & ~(1 << (i & 31));
  }

  get(i: number): boolean {
    return (this.words[i >>> 5]! & (1 << (i & 31))) !== 0;
  }

  /** Set the first `n` bits (the "all rows match" starting point for AND-chains). */
  fill(n: number): void {
    const fullWords = n >>> 5;
    this.words.fill(0xffffffff, 0, fullWords);
    const rem = n & 31;
    if (rem !== 0) this.words[fullWords] = (1 << rem) - 1;
  }

  /** In-place intersection: keep only bits set in both. */
  and(other: Bitset): this {
    const a = this.words;
    const b = other.words;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) a[i]! &= b[i]!;
    for (let i = len; i < a.length; i++) a[i] = 0;
    return this;
  }

  /** In-place union: set bits present in either. */
  or(other: Bitset): this {
    const a = this.words;
    const b = other.words;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) a[i]! |= b[i]!;
    return this;
  }

  /** In-place difference: clear bits that are set in `other`. */
  andNot(other: Bitset): this {
    const a = this.words;
    const b = other.words;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) a[i]! &= ~b[i]!;
    return this;
  }

  /**
   * In-place complement of bits [0, rowCount): every bit flips, then the tail past
   * `rowCount` is forced back to 0 so phantom bits never leak into a later count/AND.
   * This is the structural `$not` primitive — cheaper than `fill(n)+andNot` (one pass,
   * no second full buffer). Mask the partial tail word so bits >= rowCount stay 0.
   */
  not(rowCount: number): this {
    const w = this.words;
    const fullWords = rowCount >>> 5;
    for (let i = 0; i < fullWords; i++) w[i] = ~w[i]!;
    const rem = rowCount & 31;
    if (rem !== 0) {
      // Flip only the low `rem` bits of the boundary word; leave the rest cleared.
      const mask = (1 << rem) - 1;
      w[fullWords] = ~w[fullWords]! & mask;
    }
    // Any whole words entirely past rowCount must be zeroed (the complement set them).
    const tailStart = rem === 0 ? fullWords : fullWords + 1;
    for (let i = tailStart; i < w.length; i++) w[i] = 0;
    return this;
  }

  /** Population count via the parallel-bit-count (SWAR) trick. */
  count(): number {
    const w = this.words;
    let total = 0;
    for (let i = 0; i < w.length; i++) {
      let v = w[i]!;
      v = v - ((v >>> 1) & 0x55555555);
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
      v = (v + (v >>> 4)) & 0x0f0f0f0f;
      total += (v * 0x01010101) >>> 24;
    }
    return total;
  }

  /** Iterate set bit indices in ascending order, extracting the lowest set bit each step. */
  forEach(fn: (row: number) => void): void {
    const w = this.words;
    for (let wi = 0; wi < w.length; wi++) {
      let bits = w[wi]!;
      const base = wi << 5;
      while (bits !== 0) {
        const t = bits & -bits; // isolate lowest set bit
        const r = base + (31 - Math.clz32(t)); // its index within the word
        fn(r);
        bits ^= t; // clear it
      }
    }
  }

  toArray(): number[] {
    const out: number[] = [];
    this.forEach((r) => out.push(r));
    return out;
  }

  /**
   * Set bits in ascending order, skipping `offset` and taking at most `limit`.
   * Stops as soon as the page is filled — default-order pagination without sorting.
   */
  slice(offset: number, limit: number): number[] {
    const out: number[] = [];
    if (limit <= 0) return out;
    const w = this.words;
    let skipped = 0;
    for (let wi = 0; wi < w.length; wi++) {
      let bits = w[wi]!;
      const base = wi << 5;
      while (bits !== 0) {
        const t = bits & -bits;
        const r = base + (31 - Math.clz32(t));
        bits ^= t;
        if (skipped < offset) {
          skipped++;
          continue;
        }
        out.push(r);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}
