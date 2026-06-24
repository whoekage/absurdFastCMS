import { StringColumn, type Column } from '../column.ts';
import type { SortDir } from './sorted.index.ts';

/**
 * Stable LSD radix sort of `[0, n)` by a NON-NEGATIVE i32 key, returning the row-id permutation
 * (ascending by key). Byte-for-byte the same machinery as the numeric {@link SortedIndex}'s `i32`
 * path (sorted.index.ts:radixSortRows): the order-preserving key is `(x ^ 0x80000000) >>> 0`, the
 * counting sort is stable, and `src` is seeded `src[r] = r` in ascending row-id order — so equal
 * keys keep ASCENDING row-id order, the exact tie-break the numeric index (and V8's stable
 * Array.sort over an ascending-seeded input) gives. The rank we feed is always `0 <= rank < D <= n`,
 * so the sign-flip is a no-op on value order; we keep it verbatim from the numeric path so the two
 * sort engines are provably identical.
 */
function radixSortByRank(keys: Int32Array, n: number): Int32Array<ArrayBuffer> {
  const loKey = new Uint32Array(n);
  for (let r = 0; r < n; r++) loKey[r] = (keys[r]! ^ 0x80000000) >>> 0;

  let src = new Int32Array(n);
  for (let r = 0; r < n; r++) src[r] = r;
  let dst = new Int32Array(n);
  const counts = new Int32Array(257);

  for (let byte = 0; byte < 4; byte++) {
    const shift = byte << 3;
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[((loKey[src[i]!]! >>> shift) & 0xff) + 1]!++;
    for (let b = 0; b < 256; b++) counts[b + 1]! += counts[b]!;
    for (let i = 0; i < n; i++) {
      const r = src[i]!;
      const bucket = (loKey[r]! >>> shift) & 0xff;
      dst[counts[bucket]!++] = r;
    }
    const tmp = src;
    src = dst;
    dst = tmp;
  }
  return src;
}

/**
 * String sorted index (dict-rank-numeric-reuse) — makes ORDER BY a `string` column fast by reusing
 * the proven numeric sorted-index machinery, producing the BYTE-IDENTICAL row order the engine's
 * numeric sorted-index path produces today (which is the live oracle the existing sort tests pin).
 *
 * A {@link StringColumn} is `codes: Int32Array` over an off-heap dictionary of D distinct strings.
 * Rather than re-sort N strings every query (the brute O(n log n) comparator that measured 2169 ms
 * at 2M), we:
 *
 *  1. decode the D distinct values into a TRANSIENT `string[D]` (GC'd after build, never retained);
 *  2. sort the distinct codes by the EXACT brute comparator — plain JS `<`/`>` on the decoded string
 *     (UTF-16 code-unit order), identical to `Table.comparator` (table.ts) — and invert into an
 *     off-heap `rank: Int32Array(D)` where `rank[code]` is that value's sorted position;
 *  3. fill a per-row integer key `rank[codes[row]]` and run the SAME stable LSD radix the numeric
 *     index uses, yielding the `rows: Int32Array(N)` permutation (ascending by string).
 *
 * Only `rank` (length D) + `rows` (length N) are retained, both off-heap typed arrays — no N-sized
 * heap string array, so no GC pressure at scale. `forEachOrdered` is the verbatim reuse of the
 * numeric index's walk (ascending forward, descending reverse-walk), so the tie-break and DESC
 * semantics are identical to the numeric path the suite already trusts.
 *
 * NULL placement: a NULL row stores the reserved `''` sentinel code, so its sort key is
 * `rank[code('')]` — it sorts exactly where the empty string sorts under the brute comparator
 * (first ASC, last DESC, interleaved with genuine empty strings). This matches the OFFSET-path
 * comparator (which never consults the null bitset), NOT the keyset null rule — correct for the
 * OFFSET/LIMIT ORDER BY scope this index serves.
 *
 * Rebuilt lazily on dirty (a new distinct string shifts ranks), exactly like the numeric index;
 * inserts mark it dirty and the next query rebuilds once — fits the rare-write CMS profile.
 */
export class StringSortedIndex {
  /** off-heap: rank[code] = sorted position of that distinct value (length D). */
  private rank = new Int32Array(0);
  /** off-heap: row-id permutation, ascending by string (length N). */
  private rows = new Int32Array(0);
  private len = 0;
  private dirty = true;

  markDirty(): void {
    this.dirty = true;
  }

  isDirty(rowCount: number): boolean {
    return this.dirty || this.len !== rowCount;
  }

  ensureBuilt(column: Column, rowCount: number): void {
    if (this.dirty || this.len !== rowCount) this.rebuild(column, rowCount);
  }

  private rebuild(column: Column, rowCount: number): void {
    if (!(column instanceof StringColumn)) {
      // Defensive: the string sorted index is only ever registered for a StringColumn.
      throw new Error('StringSortedIndex requires a StringColumn');
    }
    const D = column.distinctCount();

    // (1) decode the D distinct values into a TRANSIENT string[] (GC'd after build).
    const dictStrings = new Array<string>(D);
    for (let c = 0; c < D; c++) dictStrings[c] = column.decodeCode(c);

    // (2) sort the distinct codes with the EXACT brute comparator (plain JS `<`/`>` on the decoded
    //     string = UTF-16 code-unit order, byte-identical to Table.comparator). Then invert into an
    //     off-heap rank: Int32Array(D) — rank[code] = sorted position. D-sized only, sorted ONCE per
    //     build (D << N for a low-card column; D ~ N for near-unique, still the distinct count).
    const ord = new Array<number>(D);
    for (let c = 0; c < D; c++) ord[c] = c;
    ord.sort((a, b) => {
      const da = dictStrings[a]!;
      const db = dictStrings[b]!;
      return da < db ? -1 : da > db ? 1 : 0;
    });
    const rank = new Int32Array(D);
    for (let pos = 0; pos < D; pos++) rank[ord[pos]!] = pos;

    // (3) per-row integer key = rank[code[row]], then the stable i32 radix -> rows permutation.
    const codes = column.rawCodes();
    const keys = new Int32Array(rowCount);
    for (let r = 0; r < rowCount; r++) keys[r] = rank[codes[r]!]!;

    this.rank = rank;
    this.rows = radixSortByRank(keys, rowCount);
    this.len = rowCount;
    this.dirty = false;
  }

  /**
   * Visit row ids in sorted order (asc or desc). `fn` returns false to stop early — that's what makes
   * ORDER BY + LIMIT cost the page size, not the full result set. Verbatim reuse of the numeric
   * index's walk (sorted.index.ts:forEachOrdered): DESC reverse-walks the ASC permutation, so equal
   * ranks emerge in descending row-id, matching the numeric sorted-index DESC semantics exactly.
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
