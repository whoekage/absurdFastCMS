import { Bitset } from '../bitset.ts';
import { buildCsr } from '../csr.ts';
import { internerForType, type ValueInterner } from '../value-interner.ts';

/**
 * Flat equality index: value -> row ids, built as a CSR (compressed-sparse-row) posting
 * structure instead of a `Map<value, number[]>` of growable JS arrays.
 *
 * Layout (per build): every distinct value is interned to a dense code `[0, c)`. Two flat
 * TypedArrays then group every row id by its code:
 *
 *   offsets : Int32Array[c + 1]  — postings for code `k` live in [offsets[k], offsets[k+1])
 *   postings: Int32Array[n]      — row ids, grouped by code, ascending within each group
 *
 * Build is an O(n) counting sort: count per code -> prefix-sum into `offsets` -> scatter row
 * ids into `postings`. Two allocations total, GC-exempt, cache-sequential — the report's
 * §2.1 "never `Map<value, number[]>`" mandate. `rows(value)` returns a subarray *view* over
 * `postings` (no copy).
 *
 * Cardinality gate (report §2.1): the equality payload is tiered by c/n measured at build:
 *
 *   - 'plane' (LOW, c <= 256 && c/n < 1/1000): also materialize one dense `Uint32Array`
 *     bitset plane per code, so `$eq`/`$in` compose with and()/or()/andNot() at zero scatter
 *     cost. This is the ONLY tier where dense planes are admissible (a plane per value on a
 *     mid/high-card column is a memory blowup — 500 distinct * 125 KB @1M = 62 MB of zeros).
 *   - 'csr' (MEDIUM/HIGH): CSR only; `$eq` is a slice scatter, `$in` is k slice scatters.
 *   - 'dict' (NEAR-UNIQUE, c/n > 0.5): the off-heap intern dictionary *is* the index; values are
 *     ~1 row each so the CSR slice is ~1 wide. Still backed by the same CSR (no separate code path),
 *     the strategy label just records that no plane/bucket structure would pay for itself here. The
 *     dictionary is an off-heap {@link ValueInterner} (a numeric dense direct-address fast path / an
 *     open-addressing string interner / a trivial bool map), NOT a JS `Map` — so a high-cardinality
 *     column (the unique `id` PK) no longer overflows V8's ~8.4M Map ceiling at build.
 *
 * Booleans are the textbook low-card tier: cardinality <= 2, always 'plane' (two planes).
 *
 * Maintenance: rebuilt lazily. `add(value, row)` appends to a pending buffer and marks dirty
 * (mirroring `SortedIndex`); the next query that needs postings rebuilds once. This preserves
 * the old `HashIndex` contract — create the index, then keep inserting — while keeping the CSR
 * a single build-once counting sort rather than an append-per-row structure.
 *
 * NULL: the index is built over the dense values the Table pushes, INCLUDING the null sentinel
 * ('' / 0 / false). It does NOT special-case nulls — three-valued logic stays at the Table
 * boundary (`excludeNulls`), so `$eq`/`$in` results get their NULL rows masked out there. The
 * index just faithfully groups every row, sentinel rows included.
 */

export type EqStrategy = 'plane' | 'csr' | 'dict';

/** Low-card gate: dense planes only when distinct count is tiny AND a small fraction of rows. */
const PLANE_MAX_CARD = 256;
/** c/n < 1/1000, written as the integer `c * 1000 < n` to avoid float-boundary fragility. */
const PLANE_RATIO_DENOM = 1000;
/** Near-unique gate: c/n > 1/2, i.e. more distinct values than half the rows => dict Map index. */
const DICT_RATIO_NUM = 2;

export class EqIndex {
  /** Hint from the Table: a 2-value boolean column is always the dense-plane tier. */
  private readonly isBool: boolean;
  /** The column's value type — selects the monomorphic off-heap interner ONCE (never per-value). */
  private readonly colType: string;

  // Pending appends (value, row) accumulated since the last build.
  private readonly pendingValues: unknown[] = [];
  private readonly pendingRows: number[] = [];
  private dirty = true;

  // Built CSR state.
  private offsets = new Int32Array(0);
  private postings = new Int32Array(0);
  /**
   * value -> dense code, the OFF-HEAP intern dictionary (also the near-unique tier's "index"). Replaces
   * the old `Map<unknown, number>` that overflowed V8's ~8.4M (2^23) Map ceiling on a high-cardinality
   * column (`createEqIndex('id')` THREW). A monomorphic structure chosen once per column by value type
   * (numeric dense fast path / string interner / bool), all behind the {@link ValueInterner} contract.
   */
  private interner: ValueInterner;
  private codeCount = 0;
  private rowCount = 0;
  private strat: EqStrategy = 'csr';
  /** Dense planes parallel to codes, only present when `strat === 'plane'`. */
  private planes: Uint32Array[] | null = null;

  constructor(colType: string) {
    this.colType = colType;
    this.isBool = colType === 'bool';
    this.interner = internerForType(colType);
  }

  /** Append a (value, row) pair. Buffered; the CSR rebuilds lazily on the next query. */
  add(value: unknown, row: number): void {
    this.pendingValues.push(value);
    this.pendingRows.push(row);
    this.dirty = true;
  }

  /** Distinct value count (post-build). Useful for selectivity-ordered planning. */
  get cardinality(): number {
    this.ensureBuilt();
    return this.codeCount;
  }

  /** True if a pending append since the last build means the next query would rebuild. */
  isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Eagerly rebuild now (publish-time warm) so the rebuild never lands on the unlucky first
   * reader after a publish batch. After this, {@link isDirty} is false until the next `add`.
   */
  warm(): void {
    this.ensureBuilt();
  }

  /**
   * Which structure the cardinality gate chose for this column. Real introspection of real
   * built state (NOT a mock) — a test asserts planes appear only for the low-card tier.
   */
  strategy(): EqStrategy {
    this.ensureBuilt();
    return this.strat;
  }

  private ensureBuilt(): void {
    if (this.dirty) this.rebuild();
  }

  private rebuild(): void {
    const values = this.pendingValues;
    const rowsBuf = this.pendingRows;
    const n = values.length;

    // 1. Intern every value to a dense code via the OFF-HEAP interner. Two phases: COLLECT every value
    //    (the numeric dense path needs min/max before it can number codes), then FINALIZE to seal the
    //    dictionary, then re-derive each row's code via `codeOf`. (For the string/bool interners codes
    //    are decided eagerly in `intern` and `finalize` is a no-op — the re-derive is still correct, an
    //    O(n) dictionary lookup.) A FRESH interner per rebuild — append-only, the rebuild is the reset.
    const interner = internerForType(this.colType);
    for (let i = 0; i < n; i++) interner.intern(values[i]);
    interner.finalize();
    const codeForRow = new Int32Array(n);
    for (let i = 0; i < n; i++) codeForRow[i] = interner.codeOf(values[i])!;
    const c = interner.size();

    // 2. Group row ids by code into the CSR (the shared counting sort). Walking inserts in order keeps
    //    each code's group ascending in row id for free.
    const { offsets, postings } = buildCsr(n, c, codeForRow, rowsBuf);

    this.offsets = offsets;
    this.postings = postings;
    this.interner = interner;
    this.codeCount = c;
    this.rowCount = n;

    // 4. Cardinality gate: pick the strategy, building dense planes only for the low-card tier.
    this.strat = this.chooseStrategy(c, n);
    this.planes = this.strat === 'plane' ? this.buildPlanes(c, n, codeForRow, rowsBuf) : null;

    this.dirty = false;
  }

  private chooseStrategy(c: number, n: number): EqStrategy {
    // A boolean column (c <= 2) is the textbook dense-plane tier regardless of n.
    if (this.isBool) return 'plane';
    if (n === 0) return 'csr';
    // c/n < 1/1000  <=>  c * 1000 < n   (low-card, dense planes admissible).
    if (c <= PLANE_MAX_CARD && c * PLANE_RATIO_DENOM < n) return 'plane';
    // c/n > 1/2  <=>  c * 2 > n   (near-unique, the dict Map is the index).
    if (c * DICT_RATIO_NUM > n) return 'dict';
    return 'csr';
  }

  /** One dense `Uint32Array` plane per code: plane[k] has bit r set iff row r holds code k. */
  private buildPlanes(c: number, n: number, codeForRow: Int32Array, rowsBuf: number[]): Uint32Array[] {
    const wordsPerPlane = (n + 31) >>> 5;
    const planes: Uint32Array[] = new Array(c);
    for (let k = 0; k < c; k++) planes[k] = new Uint32Array(wordsPerPlane);
    for (let i = 0; i < n; i++) {
      const row = rowsBuf[i]!;
      planes[codeForRow[i]!]![row >>> 5] |= 1 << (row & 31);
    }
    return planes;
  }

  /**
   * Row ids holding exactly `value`, or `undefined` if the value was never seen. A subarray
   * VIEW over `postings` (no copy) — matches the old `HashIndex.rows` contract.
   */
  rows(value: unknown): Int32Array | undefined {
    this.ensureBuilt();
    const code = this.interner.codeOf(value);
    if (code === undefined) return undefined;
    return this.postings.subarray(this.offsets[code]!, this.offsets[code + 1]!);
  }

  /**
   * OR the rows holding `value` into `out`. Routes by strategy: a low-card column copies the
   * dense plane word-wise (plane-OR, zero scatter); otherwise it scatters the CSR slice.
   */
  fillEq(value: unknown, out: Bitset): void {
    this.ensureBuilt();
    const code = this.interner.codeOf(value);
    if (code === undefined) return;
    this.orCode(code, out);
  }

  /**
   * OR the rows holding ANY of `values` ($in) into `out`. k plane-ORs or k CSR slice scatters.
   * Values absent from the dictionary contribute nothing (an all-absent `$in` matches nothing).
   */
  fillIn(values: unknown[], out: Bitset): void {
    this.ensureBuilt();
    for (let j = 0; j < values.length; j++) {
      const code = this.interner.codeOf(values[j]);
      if (code !== undefined) this.orCode(code, out);
    }
  }

  private orCode(code: number, out: Bitset): void {
    if (this.planes !== null) {
      // Plane-OR: word-wise union of the dense plane, no per-row scatter.
      const plane = this.planes[code]!;
      const w = out.words;
      const len = Math.min(plane.length, w.length);
      for (let i = 0; i < len; i++) w[i]! |= plane[i]!;
      return;
    }
    // CSR slice scatter.
    const start = this.offsets[code]!;
    const end = this.offsets[code + 1]!;
    const p = this.postings;
    for (let i = start; i < end; i++) out.set(p[i]!);
  }
}
