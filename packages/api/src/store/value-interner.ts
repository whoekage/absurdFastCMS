/**
 * OFF-HEAP value->code interners for {@link EqIndex} — the replacement for its overflowing
 * `Map<unknown, number>` (eq.index.ts rebuild). The old Map interned every distinct value to a
 * dense code; on a HIGH-cardinality column (the unique `id` primary key = N distinct) it overflowed
 * V8's effective Map ceiling (~8.4M / 2^23) and `createEqIndex('id')` THREW a RangeError at >~8.4M
 * rows (engine-ops bench Finding A). These structures hold the same value->code dictionary entirely
 * in ArrayBuffer-backed typed arrays (off the object heap), so a dictionary of any size is a handful
 * of large buffers the GC never re-traces.
 *
 * EqIndex is generic over the value type it receives from `Column.at(row)`:
 *   - `number`  — i32 (id), f64, date          → {@link DenseIntInterner}
 *   - `bigint`  — i64, decimal                  → {@link DenseIntInterner}
 *   - `string`  — string                        → {@link StringValueInterner} (OffHeapStringInterner verbatim)
 *   - `boolean` — bool                          → {@link BoolInterner}
 *
 * The interner is chosen ONCE per column at construction (by the column's `ColumnType`), so the hot
 * lookup path is MONOMORPHIC — no per-value `typeof` branch. All three implement {@link ValueInterner}
 * so EqIndex's four call sites (intern at rebuild; codeOf at rows/fillEq/fillIn) swap 1:1.
 *
 * CONTRACT (identical to the old Map's get-or-insert):
 *   - `intern(v)`  — get-or-assign a dense code; first-seen values get ascending codes.
 *   - `codeOf(v)`  — resolve to an existing code, or `undefined` if `v` was never interned.
 *   - `size()`     — distinct count = the next code to assign (the EqIndex cardinality `c`).
 *
 * CODE NUMBERING NOTE (byte-identical query results preserved): the old Map assigned codes in
 * first-SEEN order; {@link DenseIntInterner}'s dense fast path assigns codes in VALUE-ascending order.
 * This is invisible to eq/ne/in/notIn results — every query resolves through `codeOf`, the CSR groups
 * row ids ascending within each code REGARDLESS of how codes are numbered, and the cardinality gate
 * keys off `size()` (the distinct COUNT, unchanged). The full test suite is the oracle.
 */

import { OffHeapStringInterner } from './string-interner.ts';

/**
 * Monomorphic value->code dictionary, off-heap. Mirrors the {@link OffHeapStringInterner} surface so
 * EqIndex's call sites are interner-agnostic (it never branches on the concrete value type).
 */
export interface ValueInterner {
  /**
   * COLLECT `v` into the dictionary. For the immediate interners (string/bool) this also returns its
   * final dense code; for the two-phase {@link DenseIntInterner} it only collects (the code is decided
   * in {@link ValueInterner.finalize}), so callers MUST NOT rely on the return value — re-derive every
   * row's code via {@link ValueInterner.codeOf} AFTER {@link ValueInterner.finalize}.
   */
  intern(v: unknown): number;
  /**
   * Seal the dictionary after the collect pass. Required before any {@link ValueInterner.codeOf} /
   * {@link ValueInterner.size}. No-op (idempotent) for interners that decide codes eagerly in `intern`.
   */
  finalize(): void;
  /** Resolve `v` to its existing code, or `undefined` if never interned. */
  codeOf(v: unknown): number | undefined;
  /** Distinct interned values = the next code to assign (EqIndex cardinality `c`). */
  size(): number;
}

/** Initial generic-hash slot capacity (power of two; probe is `hash & (cap-1)`). Small on purpose. */
const INITIAL_SLOTS = 256;
const SLOT_EMPTY = 0;

/** Smallest power of two >= n (n >= 1). */
function ceilPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Mix a 64-bit-ish numeric key into a 32-bit hash (Murmur-style finalizer over the low/high words).
 * Used by {@link GenericNumericInterner} for the sparse/low-card/non-dense numeric backstop.
 */
function hashNum(lo: number, hi: number): number {
  let h = (lo ^ hi) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * GENERIC open-addressing numeric interner (the per-column monomorphic backstop, `generic-openaddr`):
 * a `Float64Array` key lane + an `Int32Array` slot table (open addressing, linear probe). Handles the
 * cases {@link DenseIntInterner}'s direct-addressing fast path declines — low-card enums, sparse keys,
 * non-i32-safe bigints — at ~103ns/232ns p50/p99 (measured). Keys are stored as f64 (every i32/f64/date
 * fits exactly; a bigint key is its i32-safe-or-not range value, but this lane only sees bigints that
 * ALSO survive the `Number()` round-trip exactly — DenseIntInterner gates that and keeps non-safe
 * bigints on the dense path's own arena-free comparison). Off-heap: arrayBuffers only, no JS Map.
 */
class GenericNumericInterner {
  private slots: Int32Array; // slot -> code+1 (>=1 occupied) or SLOT_EMPTY
  private slotMask: number;
  private keys: Float64Array; // code -> key value
  private keyCap: number;
  private count = 0;

  constructor() {
    const cap = INITIAL_SLOTS;
    this.slots = new Int32Array(cap);
    this.slotMask = cap - 1;
    this.keyCap = INITIAL_SLOTS;
    this.keys = new Float64Array(this.keyCap);
  }

  size(): number {
    return this.count;
  }

  intern(key: number): number {
    if ((this.count + 1) * 10 >= this.slots.length * 7) this.growSlots();
    const lo = key | 0;
    const hi = (key / 0x100000000) | 0;
    let i = hashNum(lo, hi) & this.slotMask;
    for (;;) {
      const slot = this.slots[i]!;
      if (slot === SLOT_EMPTY) {
        const code = this.append(key);
        this.slots[i] = code + 1;
        return code;
      }
      if (this.keys[slot - 1] === key) return slot - 1;
      i = (i + 1) & this.slotMask;
    }
  }

  codeOf(key: number): number | undefined {
    const lo = key | 0;
    const hi = (key / 0x100000000) | 0;
    let i = hashNum(lo, hi) & this.slotMask;
    for (;;) {
      const slot = this.slots[i]!;
      if (slot === SLOT_EMPTY) return undefined;
      if (this.keys[slot - 1] === key) return slot - 1;
      i = (i + 1) & this.slotMask;
    }
  }

  private append(key: number): number {
    const code = this.count;
    if (code >= this.keyCap) {
      const next = this.keyCap * 2;
      const nk = new Float64Array(next);
      nk.set(this.keys);
      this.keys = nk;
      this.keyCap = next;
    }
    this.keys[code] = key;
    this.count = code + 1;
    return code;
  }

  private growSlots(): void {
    const cap = this.slots.length * 2;
    const slots = new Int32Array(cap);
    const mask = cap - 1;
    for (let code = 0; code < this.count; code++) {
      const key = this.keys[code]!;
      const lo = key | 0;
      const hi = (key / 0x100000000) | 0;
      let i = hashNum(lo, hi) & mask;
      while (slots[i] !== SLOT_EMPTY) i = (i + 1) & mask;
      slots[i] = code + 1;
    }
    this.slots = slots;
    this.slotMask = mask;
  }
}

/**
 * Maximum span a dense direct-addressing presence map will allocate. The dense fast path materializes a
 * `present` byte per integer in `[min, max]`; we only take it when the span is bounded relative to the
 * distinct count (a tight integer range like the unique `id` 1..N). A sparse/huge-span key set (random
 * 64-bit ids) would blow this up, so it falls back to {@link GenericNumericInterner}. 1<<28 ≈ 268M bytes
 * is the hard ceiling on the presence buffer; the density ratio gate trips far sooner in practice.
 */
const DENSE_MAX_SPAN = 1 << 28;
/** Dense path requires span <= distinct * this — a near-contiguous range, not a sparse scatter. */
const DENSE_SPAN_RATIO = 4;

/**
 * DENSE-INT-DIRECT-ELISION numeric interner (the winning numeric fast path). For an integer-valued
 * column whose distinct values form a near-contiguous range (the unique `id` PK 1..N is the worst case
 * this exists for — 10M+ unique keys that overflow the old Map), the code IS arithmetic: `code =
 * value - min`, resolved against a one-byte-per-value `present` map. No hash, no probe — `intern` is a
 * subtract + a byte write; `codeOf` is a subtract + a byte read. This is the structure that "clearly
 * wins the unique-integer worst case" (32x lookup / 7x build over the next numeric structure).
 *
 * Two phases, because `min`/`max` aren't known until every value is seen:
 *   1. COLLECT (during the EqIndex rebuild pass): each `intern(v)` records the raw value into a growable
 *      lane and tracks running min/max. It returns a PROVISIONAL first-seen code (the collect index) so
 *      the rebuild's `codeForRow[i] = intern(values[i])` call still compiles — but EqIndex re-derives
 *      `codeForRow` from `codeOf` after {@link finalize} (see EqIndex.rebuild). [Not used: EqIndex calls
 *      {@link finalize} then reads `codeOf`, so the provisional return is never consumed.]
 *   2. FINALIZE: with min/max + distinct count known, DECIDE density. If the integer span is bounded
 *      (`span <= distinct * DENSE_SPAN_RATIO` and `span <= DENSE_MAX_SPAN` and all values were integral
 *      and safe-integer), build the dense `present` byte map + a compaction prefix that maps each present
 *      integer to a dense code in `[0, c)` in VALUE-ascending order. Otherwise, replay the collected
 *      values into a {@link GenericNumericInterner} (low-card enum / sparse / out-of-range fallback).
 *
 * VALUE TYPE: this interner is the `number`-valued backstop (i32 / f64 / date). The `bigint`-valued
 * columns (i64 / decimal) get their OWN exact-64-bit {@link BigIntInterner} — they NEVER route here, so
 * there is no lossy `Number(bigint)` projection in the dictionary (which would conflate >2^53 values).
 */
class DenseIntInterner implements ValueInterner {
  // ── collect phase ────────────────────────────────────────────────────────────────────────────
  private collected: Float64Array = new Float64Array(1024);
  private collectCount = 0;
  private min = Number.POSITIVE_INFINITY;
  private max = Number.NEGATIVE_INFINITY;
  private allIntegral = true;

  // ── finalized dense state (when the density gate passes) ───────────────────────────────────────
  private dense = false;
  private base = 0; // = min; code = (value - base)-th present slot
  private present: Uint8Array | null = null; // 1 byte per integer in [min, max]
  private prefix: Int32Array | null = null; // exclusive prefix sum of `present` -> dense code
  private denseCount = 0; // distinct count when dense (the [0,c) compaction size)
  private finalized = false;

  // ── generic fallback (low-card / sparse / non-dense) ───────────────────────────────────────────
  private generic: GenericNumericInterner | null = null;

  /** COLLECT a raw numeric value (i32 / f64 / date — always a JS `number`). */
  intern(v: unknown): number {
    const num = v as number;
    if (this.collectCount === this.collected.length) {
      const next = new Float64Array(this.collected.length * 2);
      next.set(this.collected);
      this.collected = next;
    }
    this.collected[this.collectCount++] = num;
    if (num < this.min) this.min = num;
    if (num > this.max) this.max = num;
    if (this.allIntegral && !Number.isInteger(num)) this.allIntegral = false;
    return 0; // provisional; EqIndex re-derives codeForRow via codeOf after finalize()
  }

  /**
   * Decide dense-vs-generic from the collected values, then build the chosen structure. MUST be called
   * exactly once after the collect pass and before any {@link codeOf}/{@link size}. Idempotent.
   */
  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    const n = this.collectCount;
    if (n === 0) {
      this.dense = false;
      this.generic = new GenericNumericInterner();
      return;
    }
    const span = this.max - this.min + 1;
    const distinctUpperBound = n; // distinct <= n
    const dense =
      this.allIntegral &&
      Number.isSafeInteger(this.min) &&
      Number.isSafeInteger(this.max) &&
      span <= DENSE_MAX_SPAN &&
      span <= distinctUpperBound * DENSE_SPAN_RATIO;

    if (dense) {
      this.dense = true;
      this.base = this.min;
      const present = new Uint8Array(span);
      for (let i = 0; i < n; i++) present[this.collected[i]! - this.base] = 1;
      // Exclusive prefix sum -> dense code in [0, c) in value-ascending order.
      const prefix = new Int32Array(span);
      let c = 0;
      for (let s = 0; s < span; s++) {
        prefix[s] = c;
        if (present[s] === 1) c++;
      }
      this.present = present;
      this.prefix = prefix;
      this.denseCount = c;
    } else {
      this.dense = false;
      const g = new GenericNumericInterner();
      for (let i = 0; i < n; i++) g.intern(this.collected[i]!);
      this.generic = g;
    }
    // Release the collect buffer (its job is done).
    this.collected = new Float64Array(0);
  }

  size(): number {
    if (!this.finalized) this.finalize();
    return this.dense ? this.denseCount : this.generic!.size();
  }

  codeOf(v: unknown): number | undefined {
    if (!this.finalized) this.finalize();
    const num = v as number;
    if (this.dense) {
      // Reject non-integral / out-of-range query values (never present).
      if (!Number.isInteger(num)) return undefined;
      const s = num - this.base;
      if (s < 0 || s >= this.present!.length) return undefined;
      if (this.present![s] !== 1) return undefined;
      return this.prefix![s]!;
    }
    return this.generic!.codeOf(num);
  }
}

/**
 * EXACT off-heap BIGINT interner for i64/decimal columns. The dense numeric fast path keys on the f64
 * projection of a value (`Number(v)`), which is LOSSY above 2^53: two distinct 64-bit mantissas can
 * collapse to the same double (`Number(9_007_199_254_740_993n) === Number(9_007_199_254_740_992n)`),
 * which would CONFLATE distinct values into one code — a byte-different query result. i64 and decimal
 * mantissas are both range-checked into `[-2^63, 2^63-1]` (column.ts coerceI64/coerceDecimal), so we
 * key on the EXACT 64-bit value in a `BigInt64Array` lane, hashed by its lo/hi 32-bit words (no float
 * round-trip anywhere). Open-addressing + linear probe over an `Int32Array` slot table, off the object
 * heap — the same discipline as {@link OffHeapStringInterner}, specialized to a fixed-width 64-bit key.
 *
 * Codes are assigned in first-seen order (matching the old `Map<unknown,number>` exactly). This is the
 * monomorphic interner for the `i64` and `decimal` column types; it never touches the f64 dense path.
 */
class BigIntInterner implements ValueInterner {
  private slots: Int32Array; // slot -> code+1 (>=1 occupied) or SLOT_EMPTY
  private slotMask: number;
  private keys: BigInt64Array; // code -> exact 64-bit value
  private keyCap: number;
  private count = 0;

  constructor() {
    const cap = INITIAL_SLOTS;
    this.slots = new Int32Array(cap);
    this.slotMask = cap - 1;
    this.keyCap = INITIAL_SLOTS;
    this.keys = new BigInt64Array(this.keyCap);
  }

  finalize(): void {
    /* codes decided eagerly in intern */
  }

  size(): number {
    return this.count;
  }

  /** Hash the exact 64-bit value via its low/high 32-bit words (BigInt asUintN, no f64 round-trip). */
  private static hash(v: bigint): number {
    const u = BigInt.asUintN(64, v);
    const lo = Number(u & 0xffffffffn) | 0;
    const hi = Number((u >> 32n) & 0xffffffffn) | 0;
    return hashNum(lo, hi);
  }

  intern(v: unknown): number {
    const key = v as bigint;
    if ((this.count + 1) * 10 >= this.slots.length * 7) this.growSlots();
    let i = BigIntInterner.hash(key) & this.slotMask;
    for (;;) {
      const slot = this.slots[i]!;
      if (slot === SLOT_EMPTY) {
        const code = this.append(key);
        this.slots[i] = code + 1;
        return code;
      }
      if (this.keys[slot - 1] === key) return slot - 1;
      i = (i + 1) & this.slotMask;
    }
  }

  codeOf(v: unknown): number | undefined {
    if (typeof v !== 'bigint') return undefined;
    let i = BigIntInterner.hash(v) & this.slotMask;
    for (;;) {
      const slot = this.slots[i]!;
      if (slot === SLOT_EMPTY) return undefined;
      if (this.keys[slot - 1] === v) return slot - 1;
      i = (i + 1) & this.slotMask;
    }
  }

  private append(key: bigint): number {
    const code = this.count;
    if (code >= this.keyCap) {
      const next = this.keyCap * 2;
      const nk = new BigInt64Array(next);
      nk.set(this.keys);
      this.keys = nk;
      this.keyCap = next;
    }
    this.keys[code] = key;
    this.count = code + 1;
    return code;
  }

  private growSlots(): void {
    const cap = this.slots.length * 2;
    const slots = new Int32Array(cap);
    const mask = cap - 1;
    for (let code = 0; code < this.count; code++) {
      let i = BigIntInterner.hash(this.keys[code]!) & mask;
      while (slots[i] !== SLOT_EMPTY) i = (i + 1) & mask;
      slots[i] = code + 1;
    }
    this.slots = slots;
    this.slotMask = mask;
  }
}

/**
 * STRING interner — {@link OffHeapStringInterner} reused VERBATIM (be-22's proven off-heap string dict).
 * It already implements `intern`/`codeOf`/`size` with the exact ValueInterner contract; this wrapper
 * only narrows the `unknown` value to `string` at the boundary (EqIndex's string column only ever feeds
 * strings — including the '' null sentinel, which interns to a real code, never confused with NULL).
 */
class StringValueInterner implements ValueInterner {
  private readonly inner = new OffHeapStringInterner();
  intern(v: unknown): number {
    return this.inner.intern(v as string);
  }
  finalize(): void {
    /* codes decided eagerly in intern */
  }
  codeOf(v: unknown): number | undefined {
    return this.inner.codeOf(v as string);
  }
  size(): number {
    return this.inner.size();
  }
}

/**
 * BOOL interner — the trivial `false→0 / true→1` dictionary. A bool column is always the dense-plane
 * tier (cardinality <= 2), so there is zero memory pressure; codes are assigned in first-seen order to
 * match the old Map exactly. `size()` reports the distinct count actually seen (0, 1, or 2).
 */
class BoolInterner implements ValueInterner {
  private sawFalse = false;
  private sawTrue = false;
  private codeFalse = -1;
  private codeTrue = -1;
  private count = 0;

  intern(v: unknown): number {
    if (v === false) {
      if (!this.sawFalse) {
        this.sawFalse = true;
        this.codeFalse = this.count++;
      }
      return this.codeFalse;
    }
    if (!this.sawTrue) {
      this.sawTrue = true;
      this.codeTrue = this.count++;
    }
    return this.codeTrue;
  }

  finalize(): void {
    /* codes decided eagerly in intern */
  }

  codeOf(v: unknown): number | undefined {
    if (v === false) return this.sawFalse ? this.codeFalse : undefined;
    if (v === true) return this.sawTrue ? this.codeTrue : undefined;
    return undefined;
  }

  size(): number {
    return this.count;
  }
}

/** Choose the monomorphic interner for a column's value type (called ONCE per column at EqIndex ctor). */
export function internerForType(type: string): ValueInterner {
  switch (type) {
    case 'bool':
      return new BoolInterner();
    case 'string':
    case 'text':
      return new StringValueInterner();
    case 'i64':
    case 'decimal':
      return new BigIntInterner();
    default:
      // i32, f64, date — number-valued.
      return new DenseIntInterner();
  }
}
