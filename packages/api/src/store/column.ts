import { Bitset } from './bitset.ts';
import { buildCsr } from './csr.ts';
import { SubstringIndex } from './indexes/substring.index.ts';
import { OffHeapStringInterner, OffHeapStringArena } from './string-interner.ts';
import { DECIMAL_MAX_SAFE_PRECISION } from './decimal.const.ts';

export type ColumnType =
  | 'i32'
  | 'f64'
  | 'bool'
  | 'string'
  | 'date'
  | 'text'
  | 'i64'
  | 'decimal'
  | 'json';

/**
 * Comparison operators, mapped from Strapi-style `$eq`, `$gt`, ... at the API edge.
 *
 * Full Strapi leaf surface. Implemented status by slice:
 *  - Slice 1 (here): `eq ne gt gte lt lte in notIn null notNull` — value/range/set + null.
 *  - Slice 2: `eqi nei` (case-insensitive equality via the folded dictionary).
 *  - Slice 3: `contains containsi notContains notContainsi startsWith startsWithi endsWith endsWithi`
 *    (substring/affix over the deduped dictionary; the `not*` variants are the complement
 *    of the contains mask, with NULL rows excluded at the Table boundary).
 *
 * Operators not yet natively implemented in a column resolve through a documented
 * brute-force fallback (`scanBrute`) so `scan` never throws — the engine stays correct
 * (just O(n)) until the dedicated structure lands in its slice.
 *
 * NOTE on null semantics: `null`/`notNull` are NOT column operators — they are resolved
 * at the Table level off the per-column null bitset (a column has no idea which of its
 * dense sentinels are NULL). They appear in this union only so the API edge can carry them
 * as predicates; `Column.scan` treats them as unreachable.
 */
export type ScanOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'in'
  | 'notIn'
  | 'null'
  | 'notNull'
  | 'eqi'
  | 'nei'
  | 'contains'
  | 'containsi'
  | 'notContains'
  | 'notContainsi'
  | 'startsWith'
  | 'startsWithi'
  | 'endsWith'
  | 'endsWithi';

/** Operators whose value is a set (array) rather than a scalar. */
export function isSetOp(op: ScanOp): boolean {
  return op === 'in' || op === 'notIn';
}

/**
 * A monomorphic, row-at-a-time predicate closure: `probe(row)` is true iff the row's RAW
 * value matches the (op, value) the probe was built from. Each closure captures ONE concrete
 * column's backing TypedArray (and a value pre-resolved to its raw form — a dict code, an
 * epoch-ms number, a number set) so the hot loop reads a single TypedArray and compares ints,
 * NEVER going through the megamorphic `Column.at()` facade (a virtual dispatch that boxes the
 * result and double-indirects for strings). The selectivity planner (§2.6) uses these to probe
 * residual predicates directly against a tiny lead row-id list.
 *
 * NULL is NOT this closure's concern — it sees only the dense sentinel like every column scan.
 * Three-valued logic stays at the Table boundary: the planner AND-checks the residual field's
 * null bit per row so a NULL residual excludes the row, exactly as `excludeNulls` does on the
 * bitset path.
 */
export type RowProbe = (row: number) => boolean;

export interface Column {
  readonly type: ColumnType;
  readonly length: number;
  /** Append a raw value; returns the row index it landed at. */
  push(value: unknown): number;
  /** Read back a value at a row index (used when materializing output rows). */
  at(row: number): unknown;
  /** Set bits in `out` for every row matching `op value`, over the first `length` rows. */
  scan(op: ScanOp, value: unknown, out: Bitset): void;
  /**
   * Resolve (op, value) into a monomorphic {@link RowProbe} over this column's raw TypedArray,
   * or `null` when the op cannot be probed cleanly row-at-a-time (substring/affix/`-i` and
   * string ordering — those must build a bitset and AND). The value is resolved to its raw form
   * ONCE here (dict code, epoch-ms, number set), so the returned closure does only int compares.
   * Probing the closure is byte-identical to `scan` for that op, MINUS the null masking the
   * Table applies (the planner adds it). Returns `null` for `null`/`notNull` (Table-resolved).
   */
  makeProbe(op: ScanOp, value: unknown): RowProbe | null;
}

const INITIAL_CAPACITY = 1024;

/**
 * Numeric column backed by a single growable TypedArray (Int32Array or Float64Array).
 * Scans are specialized per operator so the comparison branch lives *outside* the row loop.
 */
export class NumericColumn implements Column {
  readonly type: 'i32' | 'f64';
  private data: Int32Array | Float64Array;
  length = 0;

  constructor(type: 'i32' | 'f64') {
    this.type = type;
    this.data = type === 'i32' ? new Int32Array(INITIAL_CAPACITY) : new Float64Array(INITIAL_CAPACITY);
  }

  private grow(): void {
    const next = this.type === 'i32' ? new Int32Array(this.data.length * 2) : new Float64Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
  }

  push(value: unknown): number {
    if (this.length === this.data.length) this.grow();
    const i = this.length++;
    this.data[i] = value as number;
    return i;
  }

  at(row: number): number {
    return this.data[row]!;
  }

  scan(op: ScanOp, value: unknown, out: Bitset): void {
    const d = this.data;
    const n = this.length;
    const v = value as number;
    switch (op) {
      case 'gt':  for (let i = 0; i < n; i++) if (d[i]! >  v) out.set(i); break;
      case 'gte': for (let i = 0; i < n; i++) if (d[i]! >= v) out.set(i); break;
      case 'lt':  for (let i = 0; i < n; i++) if (d[i]! <  v) out.set(i); break;
      case 'lte': for (let i = 0; i < n; i++) if (d[i]! <= v) out.set(i); break;
      case 'between': {
        // Inclusive [lo, hi] in one branch-predictable pass; a reversed range (lo > hi) is
        // empty (no x satisfies lo <= x <= hi), a single point (lo == hi) is plain equality.
        // This is the unindexed floor; the sorted index does the same with one probe pair.
        const [lo, hi] = value as [number, number];
        for (let i = 0; i < n; i++) { const x = d[i]!; if (x >= lo && x <= hi) out.set(i); }
        break;
      }
      // For a numeric column case-insensitive equality is plain equality.
      case 'eq':
      case 'eqi': for (let i = 0; i < n; i++) if (d[i]! === v) out.set(i); break;
      case 'ne':
      case 'nei': for (let i = 0; i < n; i++) if (d[i]! !== v) out.set(i); break;
      case 'in': {
        // Membership test against a small numeric set; a Set keeps it O(n) regardless of |set|.
        const set = toNumberSet(value);
        for (let i = 0; i < n; i++) if (set.has(d[i]!)) out.set(i);
        break;
      }
      case 'notIn': {
        const set = toNumberSet(value);
        for (let i = 0; i < n; i++) if (!set.has(d[i]!)) out.set(i);
        break;
      }
      // Substring/affix operators are string-only; on a numeric column they match nothing.
      // null/notNull are resolved at the Table level off the null bitset, never here.
      case 'contains':
      case 'containsi':
      case 'notContains':
      case 'notContainsi':
      case 'startsWith':
      case 'startsWithi':
      case 'endsWith':
      case 'endsWithi':
      case 'null':
      case 'notNull':
        break;
    }
  }

  /**
   * Monomorphic probe over the raw Int32Array/Float64Array. Every comparison/set op reads one
   * TypedArray slot and compares numbers; substring/affix/null ops are not numeric (null).
   */
  makeProbe(op: ScanOp, value: unknown): RowProbe | null {
    const d = this.data;
    const v = value as number;
    switch (op) {
      case 'gt':  return (row) => d[row]! >  v;
      case 'gte': return (row) => d[row]! >= v;
      case 'lt':  return (row) => d[row]! <  v;
      case 'lte': return (row) => d[row]! <= v;
      case 'eq':
      case 'eqi': return (row) => d[row]! === v;
      case 'ne':
      case 'nei': return (row) => d[row]! !== v;
      case 'between': {
        const [lo, hi] = value as [number, number];
        return (row) => { const x = d[row]!; return x >= lo && x <= hi; };
      }
      case 'in': {
        const set = toNumberSet(value);
        return (row) => set.has(d[row]!);
      }
      case 'notIn': {
        const set = toNumberSet(value);
        return (row) => !set.has(d[row]!);
      }
      default:
        return null; // substring/affix/null are not numeric column ops.
    }
  }
}

/** Coerce a predicate value into a Set of numbers for `$in`/`$notIn` membership tests. */
function toNumberSet(value: unknown): Set<number> {
  const arr = Array.isArray(value) ? value : [value];
  const set = new Set<number>();
  for (const v of arr) set.add(v as number);
  return set;
}

/** Boolean column packed one byte per row (0/1). Only eq/ne are meaningful. */
export class BoolColumn implements Column {
  readonly type = 'bool';
  private data = new Uint8Array(INITIAL_CAPACITY);
  length = 0;

  private grow(): void {
    const next = new Uint8Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
  }

  push(value: unknown): number {
    if (this.length === this.data.length) this.grow();
    const i = this.length++;
    this.data[i] = value ? 1 : 0;
    return i;
  }

  at(row: number): boolean {
    return this.data[row] === 1;
  }

  scan(op: ScanOp, value: unknown, out: Bitset): void {
    const d = this.data;
    const n = this.length;
    switch (op) {
      case 'eq':
      case 'eqi': {
        const v = value ? 1 : 0;
        for (let i = 0; i < n; i++) if (d[i] === v) out.set(i);
        break;
      }
      case 'ne':
      case 'nei': {
        const v = value ? 1 : 0;
        for (let i = 0; i < n; i++) if (d[i] !== v) out.set(i);
        break;
      }
      case 'in':
      case 'notIn': {
        // A bool $in is just membership over {true,false}; collapse the set to which
        // truth values it admits, then it degenerates to eq / all / none.
        const arr = Array.isArray(value) ? value : [value];
        let admitsTrue = false;
        let admitsFalse = false;
        for (const x of arr) (x ? (admitsTrue = true) : (admitsFalse = true));
        const wantTrue = op === 'in' ? admitsTrue : !admitsTrue;
        const wantFalse = op === 'in' ? admitsFalse : !admitsFalse;
        for (let i = 0; i < n; i++) {
          const isTrue = d[i] === 1;
          if (isTrue ? wantTrue : wantFalse) out.set(i);
        }
        break;
      }
      // Substring/affix and null/notNull are not boolean operators — no-op (match nothing);
      // null/notNull are resolved at the Table level off the null bitset.
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
      case 'between':
      case 'contains':
      case 'containsi':
      case 'notContains':
      case 'notContainsi':
      case 'startsWith':
      case 'startsWithi':
      case 'endsWith':
      case 'endsWithi':
      case 'null':
      case 'notNull':
        break;
    }
  }

  /**
   * Monomorphic probe over the raw Uint8Array (0/1). Mirrors `scan`: eq/ne against one truth
   * value, in/notIn collapsed to which truth values they admit. Everything else is null.
   */
  makeProbe(op: ScanOp, value: unknown): RowProbe | null {
    const d = this.data;
    switch (op) {
      case 'eq':
      case 'eqi': {
        const v = value ? 1 : 0;
        return (row) => d[row] === v;
      }
      case 'ne':
      case 'nei': {
        const v = value ? 1 : 0;
        return (row) => d[row] !== v;
      }
      case 'in':
      case 'notIn': {
        const arr = Array.isArray(value) ? value : [value];
        let admitsTrue = false;
        let admitsFalse = false;
        for (const x of arr) (x ? (admitsTrue = true) : (admitsFalse = true));
        const wantTrue = op === 'in' ? admitsTrue : !admitsTrue;
        const wantFalse = op === 'in' ? admitsFalse : !admitsFalse;
        return (row) => (d[row] === 1 ? wantTrue : wantFalse);
      }
      default:
        return null; // ordering/substring/affix/null are not boolean ops.
    }
  }
}

/**
 * Largest integer an f64 represents exactly: 2^53. Beyond it consecutive integers collapse
 * to the same double, so an epoch encoded above this loses precision. Millisecond epochs
 * (~1.78e12 today) and even microsecond epochs (~1.78e15) stay well under it; only NANOSECOND
 * epochs (~1.78e18) overflow — which is exactly why we reject ns magnitudes at validation.
 */
const MAX_SAFE_EPOCH = 2 ** 53; // 9_007_199_254_740_992

/**
 * Coerce a temporal predicate/insert value into a single canonical form: epoch MILLISECONDS as
 * an f64 number. Accepts the three shapes a CMS edge sees and folds them to UTC ms so they all
 * agree with how the data was stored:
 *
 *   - `Date`           -> `date.getTime()` (already UTC ms).
 *   - ISO-8601 string  -> `Date.parse(s)` (timezone/DST folded to UTC; a bare 'YYYY-MM-DD' is
 *                         interpreted as UTC midnight per the ES spec, so `$between` on a calendar
 *                         day never silently mis-includes rows near a local midnight).
 *   - number           -> taken to ALREADY be epoch ms (the unit we store), passed through.
 *
 * The SAME helper runs at the insert edge and on predicate values, so filtering by an ISO string,
 * a Date, or a raw ms number all coerce to the identical stored ms and compare equal.
 *
 * Validation (throws, never silently stores a bad key):
 *   - NaN (an unparseable string, an Invalid Date, or a NaN number) — NaN would corrupt the
 *     comparator/binary-search and the radix key, so it is rejected outright rather than stored.
 *   - A magnitude `> 2^53` — a nanosecond-scale epoch that f64 cannot represent exactly; reject
 *     it so a caller who passes ns by mistake gets a loud error, not silent precision loss.
 *
 * NULL/missing is NOT this function's job: the Table never calls `coerceDate` for a null row (it
 * pushes the f64 sentinel 0 and sets the null bit instead), so NULL stays off the value array.
 */
export function coerceDate(value: unknown): number {
  let ms: number;
  if (value instanceof Date) {
    ms = value.getTime(); // NaN for an Invalid Date — caught below.
  } else if (typeof value === 'string') {
    ms = Date.parse(value); // NaN for an unparseable string — caught below.
  } else if (typeof value === 'number') {
    ms = value;
  } else {
    throw new Error(`date value must be a Date, ISO-8601 string, or epoch-ms number, got ${typeof value}`);
  }
  if (Number.isNaN(ms)) {
    throw new Error(`invalid date value: ${String(value)} did not parse to a valid instant`);
  }
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_SAFE_EPOCH) {
    // Reject nanosecond magnitudes (and ±Infinity): f64 cannot represent them exactly, which
    // would silently corrupt ordering and equality. Milliseconds always fit.
    throw new Error(`date epoch out of range: ${String(value)} exceeds the exact f64 range (use milliseconds, not nanoseconds)`);
  }
  return ms;
}

/**
 * Temporal column: a dictionary-free f64 column storing epoch MILLISECONDS, with a distinct
 * `'date'` type tag and `coerceDate` applied at the push edge. Mechanically it IS a `NumericColumn`
 * of doubles — range filters and the sorted index reuse the numeric machinery unchanged — but the
 * tag lets the Table coerce predicate values the same way and lets `materialize` round-trip a row
 * back to a stable ISO-8601 string (NULL rows surface as null at the Table boundary, not here).
 *
 * NULLs are driven off the Table's per-column null bitset, NOT a NaN-in-array sentinel: NaN would
 * make `vals[a]-vals[b]` return NaN (an inconsistent comparator that corrupts the sorted order) and
 * poison the radix key. A NULL row stores the dense sentinel 0 (a real instant, harmless because the
 * null bit excludes it from every comparison result) and its bit is set in the Table's null plane.
 */
export class DateColumn implements Column {
  readonly type = 'date';
  private data = new Float64Array(INITIAL_CAPACITY);
  length = 0;

  private grow(): void {
    const next = new Float64Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
  }

  push(value: unknown): number {
    if (this.length === this.data.length) this.grow();
    const i = this.length++;
    // Always coerce — Date / ISO / number all land as the identical canonical epoch-ms, and a
    // bad value (NaN / Invalid Date / ns magnitude) throws here rather than being stored. The
    // Table's null sentinel is the number 0, which coerces to 0 for free.
    this.data[i] = coerceDate(value);
    return i;
  }

  /** Read back the stored epoch-ms (used by the sorted index and the fallback comparator). */
  at(row: number): number {
    return this.data[row]!;
  }

  scan(op: ScanOp, value: unknown, out: Bitset): void {
    const d = this.data;
    const n = this.length;
    switch (op) {
      case 'between': {
        // Coerce BOTH bounds the same way values were stored so a [Date, Date] / [ISO, ISO] /
        // [ms, ms] range all agree; inclusive [lo, hi], reversed range is empty.
        const raw = value as [unknown, unknown];
        const lo = coerceDate(raw[0]);
        const hi = coerceDate(raw[1]);
        for (let i = 0; i < n; i++) { const x = d[i]!; if (x >= lo && x <= hi) out.set(i); }
        return;
      }
      case 'in':
      case 'notIn': {
        const arr = Array.isArray(value) ? value : [value];
        const set = new Set<number>();
        for (const v of arr) set.add(coerceDate(v));
        if (op === 'in') {
          for (let i = 0; i < n; i++) if (set.has(d[i]!)) out.set(i);
        } else {
          for (let i = 0; i < n; i++) if (!set.has(d[i]!)) out.set(i);
        }
        return;
      }
      // null/notNull are resolved at the Table level off the null bitset, never here.
      case 'null':
      case 'notNull':
        return;
      // Substring/affix operators are string-only; on a date column they match nothing.
      case 'contains':
      case 'containsi':
      case 'notContains':
      case 'notContainsi':
      case 'startsWith':
      case 'startsWithi':
      case 'endsWith':
      case 'endsWithi':
        return;
      // Scalar comparisons: coerce the single bound once, then a branch-predictable O(n) pass.
      default: {
        const v = coerceDate(value);
        switch (op) {
          case 'gt':  for (let i = 0; i < n; i++) if (d[i]! >  v) out.set(i); break;
          case 'gte': for (let i = 0; i < n; i++) if (d[i]! >= v) out.set(i); break;
          case 'lt':  for (let i = 0; i < n; i++) if (d[i]! <  v) out.set(i); break;
          case 'lte': for (let i = 0; i < n; i++) if (d[i]! <= v) out.set(i); break;
          case 'eq':
          case 'eqi': for (let i = 0; i < n; i++) if (d[i]! === v) out.set(i); break;
          case 'ne':
          case 'nei': for (let i = 0; i < n; i++) if (d[i]! !== v) out.set(i); break;
        }
        return;
      }
    }
  }

  /**
   * Monomorphic probe over the raw epoch-ms Float64Array. The bound(s) are coerced ONCE here
   * (Date / ISO / number -> the same canonical ms the column stored), so the closure does only
   * f64 compares. Substring/affix/null ops are not temporal (null).
   */
  makeProbe(op: ScanOp, value: unknown): RowProbe | null {
    const d = this.data;
    switch (op) {
      case 'between': {
        const raw = value as [unknown, unknown];
        const lo = coerceDate(raw[0]);
        const hi = coerceDate(raw[1]);
        return (row) => { const x = d[row]!; return x >= lo && x <= hi; };
      }
      case 'in': {
        const set = new Set<number>();
        for (const x of Array.isArray(value) ? value : [value]) set.add(coerceDate(x));
        return (row) => set.has(d[row]!);
      }
      case 'notIn': {
        const set = new Set<number>();
        for (const x of Array.isArray(value) ? value : [value]) set.add(coerceDate(x));
        return (row) => !set.has(d[row]!);
      }
      case 'gt':  { const v = coerceDate(value); return (row) => d[row]! >  v; }
      case 'gte': { const v = coerceDate(value); return (row) => d[row]! >= v; }
      case 'lt':  { const v = coerceDate(value); return (row) => d[row]! <  v; }
      case 'lte': { const v = coerceDate(value); return (row) => d[row]! <= v; }
      case 'eq':
      case 'eqi': { const v = coerceDate(value); return (row) => d[row]! === v; }
      case 'ne':
      case 'nei': { const v = coerceDate(value); return (row) => d[row]! !== v; }
      default:
        return null; // substring/affix/null are not temporal ops.
    }
  }
}

// --- exact 64-bit integer / fixed-point decimal substrate -----------------------------------

/** Inclusive int64 range. A BigInt64Array SILENTLY WRAPS out-of-range values, so we range-check. */
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/**
 * Coerce an `i64` predicate/insert value to an exact `bigint` in the int64 range. Accepts the three
 * shapes the engine sees and rejects anything that would silently lose precision or wrap:
 *
 *   - `bigint`           -> taken verbatim (the canonical form);
 *   - integer `number`   -> only when `Number.isSafeInteger` (2^53 boundary), so a float / NaN /
 *                           Infinity / unsafe-large Number is rejected rather than rounded;
 *   - digit `string`     -> `/^-?\d+$/` (rejects ''/' '/'+1'/'0x1f'/'1.0'/'1e3'/'abc'), then `BigInt`.
 *
 * The result is range-checked to `[-2^63, 2^63-1]`: a BigInt64Array assignment WRAPS modulo 2^64, so
 * an out-of-range value must throw here, never store a wrapped (wrong) mantissa. Mirrors `coerceDate`'s
 * reject-don't-store discipline; the SAME helper runs at the push edge and on predicate values so a
 * query by string / Number / bigint all coerce to the identical bigint and compare equal.
 */
export function coerceI64(value: unknown): bigint {
  let v: bigint;
  if (typeof value === 'bigint') {
    v = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`i64 value ${value} is not a safe integer (use a bigint or a digit string for |x| > 2^53)`);
    }
    v = BigInt(value);
  } else if (typeof value === 'string') {
    const s = value.trim();
    if (!/^-?\d+$/.test(s)) throw new Error(`i64 value "${value}" is not an integer string`);
    v = BigInt(s); // the regex already rejected '' / signs-only / non-digits.
  } else {
    throw new Error(`i64 value must be a bigint, an integer Number, or a digit string, got ${typeof value}`);
  }
  if (v < I64_MIN || v > I64_MAX) throw new Error(`i64 value ${v} out of int64 range [${I64_MIN}, ${I64_MAX}]`);
  return v;
}

/**
 * Coerce a `decimal` value to its SCALED INT64 MANTISSA (`round(value * 10^scale)`, computed by
 * STRING DECOMPOSITION — never a float multiply, which would corrupt the low digits). This is Apache
 * Arrow's Decimal128 approach at 64 bits: a fixed per-column `scale`, the mantissa an exact `bigint`.
 * Mirrors `ddl.ts:240-247` so the RAM engine and Postgres agree byte-for-byte.
 *
 *   - `bigint`  -> treated as an INTEGER value (fraction 0), scaled up by `10^scale`. NOTE: this arm is
 *     DEAD in production — every live bigint into a decimal column is intercepted BEFORE coerceDecimal by
 *     `I64Column.push`/`resolve` and `Table.i64Bound`, which store/compare it VERBATIM as an already-scaled
 *     mantissa (the parser only ever passes the wire `raw` string here). The contradiction is intentional:
 *     no caller reaches this branch, so a future direct `coerceDecimal(mantissaBigInt, scale)` would be the
 *     one place a bigint is interpreted as an unscaled integer — route bigints through push/resolve instead.
 *   - `number`  -> must be finite and stringify WITHOUT an exponent (so `1e21` is rejected); then the
 *                  string path. A non-finite Number throws.
 *   - `string`  -> strict shape gate `/^-?\d+(\.\d+)?$/` (rejects NaN/Infinity/`1e3`/''/'abc').
 *
 * Decomposition: split on `.`; `frac.length > scale` THROWS (no silent rounding); the fraction is
 * right-padded with `'0'` to exactly `scale`. Leading zeros of the integer part are stripped before
 * counting; with a known `precision`, `intDigits > precision - scale` THROWS (mirrors ddl.ts). The
 * mantissa is `BigInt(sign + intDigits + paddedFrac)`, asserted within int64 range. `-0`/`-0.00` -> `0n`
 * (BigInt has no negative zero — the canonical form).
 */
export function coerceDecimal(value: unknown, scale: number, precision?: number): bigint {
  let text: string;
  if (typeof value === 'bigint') {
    // An integer value: scale it up by 10^scale exactly (no string round-trip needed).
    const m = value * 10n ** BigInt(scale);
    if (m < I64_MIN || m > I64_MAX) throw new Error(`decimal mantissa ${m} out of int64 range`);
    return m;
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`decimal value ${value} is not finite`);
    text = String(value);
    if (text.includes('e') || text.includes('E')) {
      throw new Error(`decimal value ${value} stringifies with an exponent; pass a digit string instead`);
    }
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new Error(`decimal value must be a bigint, a finite Number, or a numeric string, got ${typeof value}`);
  }

  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new Error(`decimal value "${text}" is not a valid fixed-point number`);
  }
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const dot = unsigned.indexOf('.');
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracPart = dot === -1 ? '' : unsigned.slice(dot + 1);
  if (fracPart.length > scale) {
    throw new Error(`decimal value "${text}" has ${fracPart.length} fraction digits, exceeding scale ${scale}`);
  }
  const paddedFrac = fracPart.padEnd(scale, '0');
  const intDigits = intPart.replace(/^0+(?=\d)/, '');
  if (precision !== undefined && intDigits.length > precision - scale) {
    throw new Error(`decimal value "${text}" exceeds precision ${precision} (max ${precision - scale} integer digits)`);
  }
  const mantissa = BigInt((negative ? '-' : '') + intDigits + paddedFrac);
  // -0 / -0.00 collapse to 0n (BigInt has no negative zero); range-check defensively (precision <= 18
  // guarantees the fit, but a bigint input scaled above could not reach here without the cap).
  if (mantissa < I64_MIN || mantissa > I64_MAX) throw new Error(`decimal mantissa ${mantissa} out of int64 range`);
  return mantissa;
}

/**
 * Render a scaled-int64 `mantissa` back to its exact fixed-point decimal STRING at `scale` — no float.
 *
 *   - scale 0          -> the bare integer (`'123'`, no point).
 *   - mantissa 5  @s2  -> `'0.05'`; 100 @s2 -> `'1.00'` (trailing zeros KEPT — fixed scale).
 *   - mantissa 0  @s2  -> `'0.00'` (never `'-0.00'`; the sign is attached only when mantissa < 0n).
 *
 * The whole-string is `(sign?) intDigits '.' fracDigits`, the digit run left-padded to `scale+1` so an
 * all-fraction value (|v| < 1) still renders a leading `'0'`. This is `coerceDecimal`'s inverse:
 * `coerceDecimal(formatDecimal(m, s), s) === m`.
 */
export function formatDecimal(mantissa: bigint, scale: number): string {
  if (scale === 0) return mantissa.toString();
  const negative = mantissa < 0n;
  const digits = (negative ? -mantissa : mantissa).toString().padStart(scale + 1, '0');
  const cut = digits.length - scale;
  return (negative ? '-' : '') + digits.slice(0, cut) + '.' + digits.slice(cut);
}

/**
 * Output marker for the type-aware row serializer (engine.ts). `materialize` returns a {@link RawJson}
 * so the serializer SPLICES a `json` field's raw bytes verbatim — nested integers > 2^53 and object key
 * order survive byte-exact, never re-parsed/re-stringified. (i64 and decimal need no marker: they
 * materialize as plain STRINGS that `JSON.stringify` quotes — the interoperable wire form.)
 */
export class RawJson {
  readonly raw: string;
  constructor(raw: string) {
    this.raw = raw;
  }
}

/**
 * Exact 64-bit integer column, backed by a growable `BigInt64Array` — the SAME backing store powers
 * both `i64` (scale 0) and `decimal` (the value's scaled int64 mantissa + a fixed per-column `scale`).
 * The 2^53 Number limit does NOT apply: native BigInt is exact int64, so a nested-or-large key never
 * loses precision the way an f64 would. At a fixed scale the mantissa order EQUALS the value order, so
 * decimal reuses the i64 ordering/sorted-index path unchanged.
 *
 * NULLs are driven off the Table's per-column null bitset (a NULL row stores the dense sentinel `0n`,
 * harmless because the null bit excludes it). The sorted index reads {@link rawData} (the BigInt64Array)
 * directly so it NEVER coerces a mantissa to f64.
 */
export class I64Column implements Column {
  readonly type: 'i64' | 'decimal';
  /** Fixed scale for `decimal` (0 for `i64`). The column stores the already-scaled mantissa. */
  readonly scale: number;
  /**
   * Total significant digits for `decimal` (the integer-part cap is `precision - scale`); `undefined`
   * means "enforce only the int64 range" (the engine's pre-precision-threading behaviour). When set,
   * an out-of-precision value throws at push exactly as Postgres rejects `numeric(p,s)` overflow.
   */
  readonly precision: number | undefined;
  private data: BigInt64Array;
  length = 0;

  constructor(type: 'i64' | 'decimal', scale: number, precision?: number) {
    if (type === 'decimal') {
      if (!Number.isInteger(scale) || scale < 0 || scale > DECIMAL_MAX_SAFE_PRECISION) {
        throw new Error(`decimal scale must be an integer in [0, ${DECIMAL_MAX_SAFE_PRECISION}], got ${scale}`);
      }
    }
    this.type = type;
    this.scale = scale;
    this.precision = precision;
    this.data = new BigInt64Array(INITIAL_CAPACITY);
  }

  private grow(): void {
    const next = new BigInt64Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
  }

  /**
   * Append a raw value. For `i64` it is coerced to an exact bigint; for `decimal` to its scaled
   * mantissa. The Table pushes the `0n` sentinel for NULL rows (a bigint, stored directly).
   */
  push(value: unknown): number {
    if (this.length === this.data.length) this.grow();
    const i = this.length++;
    let v: bigint;
    if (typeof value === 'bigint') v = value; // sentinel 0n, or a pre-coerced mantissa.
    else if (this.type === 'i64') v = coerceI64(value);
    else v = coerceDecimal(value, this.scale, this.precision);
    this.data[i] = v;
    return i;
  }

  at(row: number): bigint {
    return this.data[row]!;
  }

  /** The raw BigInt64Array (a view over the live rows) — the sorted index reads this, never `at`. */
  rawData(): BigInt64Array {
    return this.data.subarray(0, this.length);
  }

  /**
   * Resolve a predicate value to the column's canonical bigint ONCE: for `i64` via `coerceI64`; for
   * `decimal` accept a pre-coerced mantissa bigint (the parser already scaled it) else `coerceDecimal`.
   */
  private resolve(value: unknown): bigint {
    if (this.type === 'i64') return coerceI64(value);
    if (typeof value === 'bigint') return value;
    return coerceDecimal(value, this.scale, this.precision);
  }

  scan(op: ScanOp, value: unknown, out: Bitset): void {
    const d = this.data;
    const n = this.length;
    switch (op) {
      case 'between': {
        const raw = value as [unknown, unknown];
        const lo = this.resolve(raw[0]);
        const hi = this.resolve(raw[1]);
        for (let i = 0; i < n; i++) { const x = d[i]!; if (x >= lo && x <= hi) out.set(i); }
        return;
      }
      case 'in':
      case 'notIn': {
        const set = this.toBigIntSet(value);
        if (op === 'in') {
          for (let i = 0; i < n; i++) if (set.has(d[i]!)) out.set(i);
        } else {
          for (let i = 0; i < n; i++) if (!set.has(d[i]!)) out.set(i);
        }
        return;
      }
      // null/notNull are resolved at the Table level off the null bitset, never here.
      case 'null':
      case 'notNull':
        return;
      // Substring/affix operators are string-only; on a numeric column they match nothing.
      case 'contains':
      case 'containsi':
      case 'notContains':
      case 'notContainsi':
      case 'startsWith':
      case 'startsWithi':
      case 'endsWith':
      case 'endsWithi':
        return;
      default: {
        const v = this.resolve(value);
        switch (op) {
          case 'gt':  for (let i = 0; i < n; i++) if (d[i]! >  v) out.set(i); break;
          case 'gte': for (let i = 0; i < n; i++) if (d[i]! >= v) out.set(i); break;
          case 'lt':  for (let i = 0; i < n; i++) if (d[i]! <  v) out.set(i); break;
          case 'lte': for (let i = 0; i < n; i++) if (d[i]! <= v) out.set(i); break;
          case 'eq':
          case 'eqi': for (let i = 0; i < n; i++) if (d[i]! === v) out.set(i); break;
          case 'ne':
          case 'nei': for (let i = 0; i < n; i++) if (d[i]! !== v) out.set(i); break;
        }
        return;
      }
    }
  }

  /** Coerce a predicate set to a `Set<bigint>` for `$in`/`$notIn` (every element to the canonical bigint). */
  private toBigIntSet(value: unknown): Set<bigint> {
    const arr = Array.isArray(value) ? value : [value];
    const set = new Set<bigint>();
    for (const v of arr) set.add(this.resolve(v));
    return set;
  }

  /**
   * Monomorphic probe over the raw BigInt64Array. The bound(s) are resolved to bigint ONCE here, so
   * the closure does only bigint compares. Substring/affix/null ops are not numeric (null).
   */
  makeProbe(op: ScanOp, value: unknown): RowProbe | null {
    const d = this.data;
    switch (op) {
      case 'between': {
        const raw = value as [unknown, unknown];
        const lo = this.resolve(raw[0]);
        const hi = this.resolve(raw[1]);
        return (row) => { const x = d[row]!; return x >= lo && x <= hi; };
      }
      case 'in': {
        const set = this.toBigIntSet(value);
        return (row) => set.has(d[row]!);
      }
      case 'notIn': {
        const set = this.toBigIntSet(value);
        return (row) => !set.has(d[row]!);
      }
      case 'gt':  { const v = this.resolve(value); return (row) => d[row]! >  v; }
      case 'gte': { const v = this.resolve(value); return (row) => d[row]! >= v; }
      case 'lt':  { const v = this.resolve(value); return (row) => d[row]! <  v; }
      case 'lte': { const v = this.resolve(value); return (row) => d[row]! <= v; }
      case 'eq':
      case 'eqi': { const v = this.resolve(value); return (row) => d[row]! === v; }
      case 'ne':
      case 'nei': { const v = this.resolve(value); return (row) => d[row]! !== v; }
      default:
        return null; // substring/affix/null are not numeric column ops.
    }
  }
}

/**
 * JSON column: stores each row's RAW jsonb text verbatim (UTF-8 bytes in a single growable arena +
 * an `Int32Array` of offsets, mirroring {@link TextColumn} — json bodies are near-unique and long, so
 * a dictionary buys no dedup; the 2^31-byte arena cap is documented there too).
 *
 * CRITICAL precision point: the value is NEVER round-tripped through `JSON.parse` -> materialize ->
 * `JSON.stringify` (that loses nested integers > 2^53 and reorders object keys). At push we `JSON.parse`
 * ONLY as a validity GATE (the result is discarded) and store the verbatim bytes; `materialize` emits
 * them as a {@link RawJson} fragment so nested big integers and key order survive byte-exact.
 *
 * JSON is NOT filterable (the query parser rejects any op on a json field, and no sorted/eq index is
 * built), so `scan` throws defensively (unreachable in normal flow) and `makeProbe` returns null.
 */
export class JsonColumn implements Column {
  readonly type = 'json';
  private bytes = new Uint8Array(INITIAL_CAPACITY);
  private used = 0;
  private offsets = new Int32Array(INITIAL_CAPACITY + 1);
  length = 0;

  private static readonly encoder = new TextEncoder();
  private static readonly decoder = new TextDecoder();

  private ensureBytes(need: number): void {
    if (this.used + need <= this.bytes.length) return;
    let cap = this.bytes.length;
    while (cap < this.used + need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.bytes);
    this.bytes = next;
  }

  private ensureOffsets(): void {
    if (this.length + 1 < this.offsets.length) return;
    const next = new Int32Array(this.offsets.length * 2);
    next.set(this.offsets);
    this.offsets = next;
  }

  /**
   * Append a row's JSON. A string is the RAW jsonb text (used verbatim — the only shape that preserves
   * big ints / key order off the wire); any other in-process value is `JSON.stringify`d. The value is
   * VALIDATED by `JSON.parse` (a gate; the parse result is discarded) so invalid JSON / empty /
   * whitespace-only is REJECTED before any byte is stored (reject-don't-store, like `coerceDate`).
   */
  push(value: unknown): number {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    if (typeof raw !== 'string') throw new Error('json field: value is not serializable to JSON');
    // Validity gate: JSON.parse throws on '' / whitespace-only / malformed. We discard the result and
    // store the verbatim bytes — NEVER the re-stringified parse (which would lose big ints / key order).
    JSON.parse(raw);
    // Well-formed-UTF-16 gate (reject-don't-store): JSON.parse ACCEPTS a string carrying a lone/unpaired
    // surrogate (e.g. a literal \uD800 code unit), but TextEncoder.encode would silently replace it with
    // U+FFFD — corrupting the verbatim bytes and breaking the "nested bytes survive exactly" contract.
    // A value that cannot be stored byte-exact must fail loudly at insert, like the JSON.parse gate.
    if (raw.isWellFormed !== undefined && !raw.isWellFormed()) {
      throw new Error('json field: value contains an unpaired surrogate (not well-formed UTF-16)');
    }
    const encoded = JsonColumn.encoder.encode(raw);
    this.ensureBytes(encoded.length);
    this.ensureOffsets();
    const i = this.length;
    this.offsets[i] = this.used;
    this.bytes.set(encoded, this.used);
    this.used += encoded.length;
    this.offsets[i + 1] = this.used;
    this.length = i + 1;
    return i;
  }

  /** Decode row r's verbatim JSON text. */
  at(row: number): string {
    const start = this.offsets[row]!;
    const end = this.offsets[row + 1]!;
    return JsonColumn.decoder.decode(this.bytes.subarray(start, end));
  }

  /** json is not filterable — the parser blocks every op upstream; throw defensively if reached. */
  scan(_op: ScanOp, _value: unknown, _out: Bitset): void {
    throw new Error('json column is not filterable');
  }

  makeProbe(_op: ScanOp, _value: unknown): RowProbe | null {
    return null;
  }
}

/**
 * Case-folding used for the `-i` (case-insensitive) operators.
 *
 * `fold(s) = casefold(NFKC(s))`, applied exactly ONCE per distinct dictionary string
 * at intern time — never per row, never per query-per-row.
 *
 *  - `normalize('NFKC')` first: Unicode compatibility composition, so canonically- or
 *    compatibility-equivalent spellings collapse to one form (e.g. the ligature 'ﬀ' → 'ff',
 *    fullwidth 'Ａ' → 'A', composed vs decomposed accents 'é' agree). This MUST run before
 *    folding so the two query/value spellings can never diverge below the fold.
 *  - `toLocaleLowerCase()`/`toLowerCase()` is JS's Default Case Conversion. We use the
 *    locale-independent `toLowerCase()` (Unicode Default Case Folding's simple lower-mapping)
 *    so the result is deterministic across hosts/locales — the project's determinism mandate.
 *    This is the closest erasable-TS, dependency-free approximation of Unicode casefold; it
 *    handles the cases this engine cares about, including the German 'ß' (which NFKC leaves
 *    intact and lowercasing keeps as 'ß', so 'STRASSE'.toLowerCase() === 'strasse' only after
 *    the eszett is already written as "ss" — both 'STRASSE' and 'strasse' fold to 'strasse').
 *
 * Folding NFKC-first then lower means 'STRASSE', 'Strasse', 'strasse' all share one folded
 * key, and accented 'CAFÉ'/'café'/decomposed 'café' all collapse together.
 */
function fold(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

/**
 * Dictionary-encoded string column: each distinct string is interned to an int code,
 * and the column stores codes in an Int32Array. Equality scans compare ints, not strings,
 * and low-cardinality fields (status, locale, type) cost ~4 bytes/row regardless of text length.
 *
 * OFF-HEAP DICTIONARY (be-22): the intern table + code->string dictionary are an
 * {@link OffHeapStringInterner} (open-addressing hash over an `Int32Array` + a UTF-8 byte arena),
 * NOT a `Map<string, number>` + `string[]`. The Map version threw `RangeError: Map maximum size
 * exceeded` at V8's 2^24 (~16.7M) entry ceiling on a near-unique column (title/slug) and pinned N
 * long-lived heap strings; the interner has neither limit (a handful of large buffers off the
 * object heap). `intern(s)` at push, `at(row) = interner.decode(codes[row])`, and a query value is
 * resolved to a code via `interner.codeOf(s)` — the operator surface is byte-identical, only the
 * dictionary STORAGE changed. The interner round-trips byte-exact (UTF-8 encode at intern, decode at
 * read), so a response is byte-for-byte what the Map dictionary returned. The interner's distinct-COUNT
 * ceiling rises from the Map's 2^24 to ~2^31 (the Int32 slot table); its one residual is a ~2 GiB arena
 * byte ceiling (the Int32 offset lane), enforced as a LOUD, NAMED throw — never a silent byte-corrupting
 * wrap — and documented in {@link OffHeapStringInterner}. Only a column whose distinct TEXT totals
 * >2 GiB (e.g. ~17M near-unique ~130-byte titles) reaches it, and it fails loud like the old Map did.
 *
 * For case-insensitive equality (`$eqi`/`$nei`) a PARALLEL folded dictionary is kept:
 * `foldedRaw.decode(code) === fold(dict[code])` aligned by raw code (one folded entry appended per
 * distinct raw string, in code order), so the `foldedDict` string[] pin is gone too — it is also an
 * {@link OffHeapStringInterner}. Plus an OFF-HEAP folded-key -> raw-codes grouping (be-22f): a
 * second {@link OffHeapStringInterner} (folded bytes -> dense `foldedId`) + a {@link buildCsr} CSR
 * (`foldedId -> the raw codes that fold to it`) — NO residual Map at any cardinality. Both build
 * lazily on the first `-i` query and are reused (rebuilt-on-grow) thereafter; `$eqi value` resolves
 * `fold(value)` through `foldedKeys.codeOf` (lookup-only) to a `foldedId`, slices the CSR postings to
 * a small `Int32Array` of raw codes, then runs the existing `$in` row-expansion machinery. The fold
 * is paid once per distinct string, never per row.
 *
 * NO RESIDUAL MAP CEILING (be-22f): the folded-key grouping is an off-heap interner (~2^31 ceiling)
 * + flat `Int32Array` CSR, so a column with >16.7M near-unique values hit with `$eqi`/`$nei` BUILDS +
 * SERVES instead of overflowing the old `Map<string, number[]>` at V8's ~8.4M (2^23) ceiling. The
 * same off-heap discipline applies to an explicitly eq-indexed high-card column — see {@link EqIndex}.
 */
export class StringColumn implements Column {
  readonly type = 'string';
  /** Off-heap intern table + code->string dictionary (replaces the `Map` + `string[]`). */
  private interner = new OffHeapStringInterner();
  private codes = new Int32Array(INITIAL_CAPACITY);
  length = 0;

  /**
   * Folded mirror of the dictionary, aligned by raw code: `foldedRaw.decode(code) === fold(dict[code])`.
   * An off-heap, NON-deduping code-aligned arena (NOT a `string[]` — and NOT an interner, because two
   * distinct raw strings can fold to the same key yet must each keep their own code-aligned slot),
   * appended one entry per distinct raw string in code order, so it is addressable by raw code exactly
   * like the old parallel array. Built lazily (and kept in sync as more strings are interned) so a
   * column that never sees a `-i` query pays nothing.
   */
  private foldedRaw = new OffHeapStringArena();
  /**
   * OFF-HEAP folded-key -> raw codes grouping (be-22f) — the off-heap replacement for the old
   * `Map<string, number[]>` (folded key -> raw codes) that overflowed V8's ~8.4M Map ceiling on a
   * high-card column. Two structures, reusing the be-22/be-22b primitives VERBATIM:
   *
   *   - `foldedKeys`: an {@link OffHeapStringInterner} keyed on the UTF-8 bytes of the ALREADY-folded
   *     string (`foldedRaw.decode(code)`, NOT `interner.decode(code)`) -> a dense `foldedId`. `codeOf`
   *     (lookup-only, no insert) on `fold(value)` reproduces the old `Map.get` miss-signal EXACTLY
   *     (`undefined` iff the folded key was never seen).
   *   - `foldedOffsets` / `foldedPostings`: the CSR (the {@link buildCsr} counting sort, the be-22b
   *     `EqIndex` postings pattern) mapping `foldedId -> the raw codes that fold to it`. The slice
   *     `foldedPostings[foldedOffsets[id] .. foldedOffsets[id+1])` is an `Int32Array` view of those
   *     raw codes, ASCENDING in code (counting-sort over the ascending input `0..D-1`) — byte-identical
   *     to the old `bucket.push(code)` ascending order. NO Map at any cardinality.
   */
  private foldedKeys = new OffHeapStringInterner();
  private foldedOffsets = new Int32Array(0);
  private foldedPostings = new Int32Array(0);
  /** Dict size the folded-key CSR grouping was last built at (rebuild-on-grow watermark; -1 = never). */
  private foldedGroupBuilt = -1;
  /** Number of dict entries already mirrored into the folded structures. */
  private foldedBuilt = 0;

  /**
   * Opt-in trigram substring accelerator (report §2.5 / Slice 8). OFF by default: an unflagged
   * column always uses the deduped-dictionary brute scan. A contains-heavy / large-distinct
   * column opts in via {@link enableSubstringIndex}; the index then builds on-publish (lazily,
   * on the first `$contains*` query) over the dict CODES and is rebuilt whenever new strings are
   * interned, so it always covers the full dictionary before it is consulted.
   *
   * Two indexes are kept: a RAW-dict index for `$contains`/`$notContains`, and a FOLDED-dict
   * index for `$containsi`/`$notContainsi` (built over the folded dictionary, exactly the space
   * the brute `-i` path scans). Either may be null until its first relevant query builds it. Both
   * build via {@link SubstringIndex.over}, decoding each code's text FROM THE OFF-HEAP dictionary
   * (the interner for raw, `foldedRaw` for folded) — no heap `string[]` is materialized.
   */
  private substringEnabled = false;
  private rawTrigrams: SubstringIndex | null = null;
  private foldedTrigrams: SubstringIndex | null = null;
  /** dict length the raw/folded trigram index was last built at (rebuild when the dict grows). */
  private rawTrigramsBuilt = -1;
  private foldedTrigramsBuilt = -1;

  /**
   * Test/bench seam: how many `$contains*` scans actually took the trigram-accelerated path
   * (intersect + verify) instead of the brute dictionary scan. A real counter on real built
   * state — NOT a mock — so a test can assert the accelerator truly fired while still proving
   * the rows match the brute oracle. Incremented only when the trigram path produced the mask.
   */
  substringAccelHits = 0;

  /**
   * Opt this column into the trigram substring accelerator (gating per report §2.5: build only
   * for columns flagged contains-heavy / large distinct count). Idempotent; the actual index is
   * built lazily on the first `$contains*` query and (re)built to cover newly interned strings.
   */
  enableSubstringIndex(): void {
    this.substringEnabled = true;
  }

  /** Test seam: distinct trigram count of the raw (case-sensitive) index, building it if needed. */
  rawTrigramCount(): number {
    this.ensureRawTrigrams();
    return this.rawTrigrams === null ? 0 : this.rawTrigrams.trigramCount;
  }

  /**
   * (Re)build the raw-dict trigram index if enabled and the dictionary has grown since. Postings
   * are dict CODES; each code's text is decoded FROM THE OFF-HEAP interner during the build pass
   * (transient strings, GC'd) — no persistent heap `string[]`.
   */
  private ensureRawTrigrams(): void {
    if (!this.substringEnabled) return;
    const d = this.interner.size();
    if (this.rawTrigramsBuilt !== d) {
      this.rawTrigrams = SubstringIndex.over(d, (code) => this.interner.decode(code));
      this.rawTrigramsBuilt = d;
    }
  }

  /** (Re)build the folded-dict trigram index if enabled and the dictionary has grown since. */
  private ensureFoldedTrigrams(): void {
    if (!this.substringEnabled) return;
    this.ensureFolded();
    const d = this.foldedRaw.size();
    if (this.foldedTrigramsBuilt !== d) {
      this.foldedTrigrams = SubstringIndex.over(d, (code) => this.foldedRaw.decode(code));
      this.foldedTrigramsBuilt = d;
    }
  }

  private intern(s: string): number {
    return this.interner.intern(s);
  }

  /**
   * Lazily extend the folded dictionary to cover every interned code. Idempotent and
   * incremental: only codes added since the last call are folded, so the fold runs exactly
   * once per distinct string over the column's lifetime regardless of how many `-i` queries
   * (or interleaved inserts) follow. `foldedRaw` is appended in raw-code order (one slot per raw
   * code, NO dedup) so `foldedRaw.decode(code) === fold(dict[code])`.
   *
   * After the incremental fold, REBUILD-ON-GROW the off-heap folded-key -> raw-codes grouping
   * (be-22f), mirroring {@link EqIndex.rebuild} 1:1: if the dict grew since the last build, intern
   * each raw code's ALREADY-folded bytes (`foldedRaw.decode(code)`, never `interner.decode(code)`)
   * into a FRESH {@link OffHeapStringInterner} (append-only — the rebuild is the reset, exactly as
   * `EqIndex` allocates a fresh interner per rebuild), deriving a dense `foldedId` per raw code, then
   * {@link buildCsr} over the raw codes `0..D-1` to group them by `foldedId`. `buildCsr`'s counting
   * sort keeps each group ascending in raw code (input is the ascending `0..D-1`), byte-identical to
   * the old `bucket.push(code)` ascending order.
   */
  private ensureFolded(): void {
    const d = this.interner.size();
    for (let code = this.foldedBuilt; code < d; code++) {
      this.foldedRaw.push(fold(this.interner.decode(code)));
    }
    this.foldedBuilt = d;
    if (this.foldedGroupBuilt === d) return;
    // Rebuild the off-heap folded-key grouping over the full folded dictionary (fresh interner =
    // the reset). `foldedIdForRawCode[code]` is the dense id of `fold(dict[code])`; the raw codes
    // `0..D-1` are then grouped by that id into the CSR postings.
    const keys = new OffHeapStringInterner();
    const foldedIdForRawCode = new Int32Array(d);
    for (let code = 0; code < d; code++) {
      foldedIdForRawCode[code] = keys.intern(this.foldedRaw.decode(code));
    }
    const rawCodes = new Int32Array(d);
    for (let code = 0; code < d; code++) rawCodes[code] = code;
    const { offsets, postings } = buildCsr(d, keys.size(), foldedIdForRawCode, rawCodes);
    this.foldedKeys = keys;
    this.foldedOffsets = offsets;
    this.foldedPostings = postings;
    this.foldedGroupBuilt = d;
  }

  /** Test seam / invariant check: the folded dictionary is aligned 1:1 with the dict by code. */
  foldedDictLength(): number {
    this.ensureFolded();
    return this.foldedRaw.size();
  }

  /**
   * Test/sizing seam (a real measurement, NOT a mock): the EXACT off-heap byte footprint of the raw
   * dictionary (the interner's slot table + code lanes + UTF-8 arena). A low-card enum/locale/status
   * column must read in the low KiBs here — the proof the small-minimum-allocation policy holds and a
   * 3-value column did not regress into megabytes.
   */
  dictionaryMemoryBytes(): number {
    return this.interner.memoryBytes().total;
  }

  private grow(): void {
    const next = new Int32Array(this.codes.length * 2);
    next.set(this.codes);
    this.codes = next;
  }

  push(value: unknown): number {
    if (this.length === this.codes.length) this.grow();
    const i = this.length++;
    this.codes[i] = this.intern(value as string);
    return i;
  }

  at(row: number): string {
    return this.interner.decode(this.codes[row]!);
  }

  /**
   * The raw per-row dictionary codes (a view over the live rows) — the STRING sorted index reads this
   * to build its per-row integer sort key `rank[code[row]]`, never `at()`. Mirrors `I64Column.rawData`.
   */
  rawCodes(): Int32Array {
    return this.codes.subarray(0, this.length);
  }

  /** Distinct interned strings (D, the dictionary size) — the string sorted index ranks these. */
  distinctCount(): number {
    return this.interner.size();
  }

  /**
   * Decode dictionary `code` to its exact stored string. The string sorted index walks `0..D-1` once
   * per build to rank the distinct values; this is a transient decode (no retained heap `string[]`),
   * the same shape as `ensureRawTrigrams` / the brute scan use.
   */
  decodeCode(code: number): string {
    return this.interner.decode(code);
  }

  scan(op: ScanOp, value: unknown, out: Bitset): void {
    const codes = this.codes;
    const n = this.length;
    switch (op) {
      case 'eq': {
        // Resolve the target to a code once; if never interned, eq matches nothing.
        const code = this.interner.codeOf(value as string);
        if (code === undefined) return;
        for (let i = 0; i < n; i++) if (codes[i] === code) out.set(i);
        return;
      }
      case 'ne': {
        const code = this.interner.codeOf(value as string);
        // Unknown value => every row differs from it. Null-awareness (excluding NULL rows
        // whose sentinel '' would otherwise count) is applied once at the Table boundary.
        if (code === undefined) {
          out.fill(n);
          return;
        }
        for (let i = 0; i < n; i++) if (codes[i] !== code) out.set(i);
        return;
      }
      case 'in':
      case 'notIn': {
        // Resolve the value set to a Set of codes once (deduped dictionary => |codes| small),
        // then a single O(n) pass scatters matches. Values absent from the dictionary simply
        // contribute no code, so an empty/all-absent set makes `in` match nothing.
        const wanted = new Set<number>();
        const arr = Array.isArray(value) ? value : [value];
        for (const s of arr) {
          const c = this.interner.codeOf(s as string);
          if (c !== undefined) wanted.add(c);
        }
        if (op === 'in') {
          for (let i = 0; i < n; i++) if (wanted.has(codes[i]!)) out.set(i);
        } else {
          for (let i = 0; i < n; i++) if (!wanted.has(codes[i]!)) out.set(i);
        }
        return;
      }
      case 'eqi':
      case 'nei': {
        // Case-insensitive equality via the parallel folded dictionary (Slice 2):
        // fold the query value ONCE, look up the set of raw codes that share that folded
        // key, then run the exact `$in`/`$notIn` row-expansion machinery. No per-row fold.
        // `ensureFolded` builds (and rebuilds-on-grow) the off-heap folded-key -> codes grouping;
        // `codeOf` is lookup-only (never interns), so `id === undefined` IS the exact old
        // `Map.get === undefined` miss-signal. `wanted` is then an `Int32Array` VIEW of the raw
        // codes that fold to the query, ascending in code — byte-identical to the old `number[]`.
        this.ensureFolded();
        const id = this.foldedKeys.codeOf(fold(value as string));
        const wanted =
          id === undefined
            ? undefined
            : this.foldedPostings.subarray(this.foldedOffsets[id]!, this.foldedOffsets[id + 1]!);
        if (op === 'eqi') {
          // Unknown folded value => matches nothing.
          if (wanted === undefined) return;
          if (wanted.length === 1) {
            const code = wanted[0]!;
            for (let i = 0; i < n; i++) if (codes[i] === code) out.set(i);
          } else {
            const set = new Set(wanted);
            for (let i = 0; i < n; i++) if (set.has(codes[i]!)) out.set(i);
          }
        } else {
          // `$nei`: every row whose folded value differs. Unknown folded value => all rows
          // differ. Null-awareness (excluding NULL rows) is applied at the Table boundary.
          if (wanted === undefined) {
            out.fill(n);
            return;
          }
          const set = wanted.length === 1 ? undefined : new Set(wanted);
          const only = wanted[0]!;
          for (let i = 0; i < n; i++) {
            const c = codes[i]!;
            const match = set === undefined ? c === only : set.has(c);
            if (!match) out.set(i);
          }
        }
        return;
      }
      // String ordering and the substring / affix operators are resolved by brute-forcing
      // the *deduped* dictionary into a code mask, then one O(n) pass over `codes`
      // (D << N, so the dictionary scan is cheap). Slice 3 will swap the dedicated
      // structures (trigram, sorted permutation) in behind this exact same shape; for now
      // the brute path keeps every operator correct, never throwing.
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
      case 'contains':
      case 'containsi':
      case 'notContains':
      case 'notContainsi':
      case 'startsWith':
      case 'startsWithi':
      case 'endsWith':
      case 'endsWithi':
        this.scanBrute(op, value as string, out);
        return;
      // null/notNull never reach a column — resolved at the Table level off the null bitset.
      // between is numeric-only; on a string column it matches nothing.
      case 'between':
      case 'null':
      case 'notNull':
        return;
    }
  }

  /**
   * Monomorphic probe over the raw dictionary `codes` Int32Array. The eq target / `$in` set is
   * resolved to dict CODE(S) ONCE here (a value absent from the dictionary contributes no code),
   * so the closure does only int compares against `codes[row]` — never `dict[codes[row]]`.
   *
   * Only the integer-comparable ops are probeable: `eq`/`ne`/`in`/`notIn`. The `-i` ops need the
   * folded dictionary, and string ordering / substring / affix need the brute dictionary scan;
   * all of those return `null`, so the planner builds their bitset and ANDs (never row-at-a-time).
   *
   * `ne`/`notIn` semantics match `scan`: an unknown value/all-absent set makes EVERY row differ
   * (and the Table boundary still masks NULL rows out). For `eq`/`in`, an unknown value/empty set
   * matches NOTHING (an always-false probe), identical to the scan.
   */
  makeProbe(op: ScanOp, value: unknown): RowProbe | null {
    const codes = this.codes;
    switch (op) {
      case 'eq': {
        const code = this.interner.codeOf(value as string);
        if (code === undefined) return () => false; // never interned => matches nothing.
        return (row) => codes[row] === code;
      }
      case 'ne': {
        const code = this.interner.codeOf(value as string);
        if (code === undefined) return () => true; // unknown value => every row differs.
        return (row) => codes[row] !== code;
      }
      case 'in':
      case 'notIn': {
        const wanted = new Set<number>();
        for (const s of Array.isArray(value) ? value : [value]) {
          const c = this.interner.codeOf(s as string);
          if (c !== undefined) wanted.add(c);
        }
        if (op === 'in') return (row) => wanted.has(codes[row]!);
        return (row) => !wanted.has(codes[row]!);
      }
      default:
        // eqi/nei (folded dict) and ordering/substring/affix are NOT clean code compares.
        return null;
    }
  }

  /**
   * Brute-force evaluation of the ordering and substring/affix operators: test the predicate
   * against each distinct dictionary string once (building a `Uint8Array` code mask of length D),
   * then a single O(N) pass over `codes` expands the mask to rows. `D << N`, so the dictionary
   * scan is cheap; later slices swap the trigram/sorted accelerators in behind this same shape.
   *
   * Case-insensitivity (`-i` variants) is identical to `$eqi`/`$nei`: it scans the parallel
   * `foldedDict` (`foldedDict[code] === fold(dict[code])`, aligned by code) and folds the needle
   * with the SAME `fold = casefold(NFKC)` helper — NOT a plain `toLowerCase()`. That guarantees a
   * fullwidth/ligature/accented needle normalizes exactly the way `$eqi` does (e.g. the needle
   * 'ﬀ' folds to 'ff' and matches a value containing 'ff').
   *
   * `notContains`/`notContainsi` are the complement of the contains mask: we build the contains
   * bitset then `fill(N).andNot(contains)`. NULL rows are excluded once at the Table boundary
   * (the same three-valued-logic masking `$ne`/`$notIn` rely on), so a NULL whose dense sentinel
   * is '' never spuriously survives a `notContains`.
   */
  private scanBrute(op: ScanOp, value: string, out: Bitset): void {
    const insensitive =
      op === 'containsi' || op === 'notContainsi' || op === 'startsWithi' || op === 'endsWithi';
    // For `-i` ops the search space is the folded dictionary and the needle is folded the same
    // way; for case-sensitive ops it is the raw dictionary and the raw needle. Either space is the
    // OFF-HEAP dictionary, addressed by code via a `decode(code)` accessor — D distinct strings are
    // decoded from the arena (D << N), NEVER pinned in a heap `string[]`.
    let decode: (code: number) => string;
    let count: number;
    let needle: string;
    if (insensitive) {
      this.ensureFolded();
      decode = (code) => this.foldedRaw.decode(code);
      count = this.foldedRaw.size();
      needle = fold(value);
    } else {
      decode = (code) => this.interner.decode(code);
      count = this.interner.size();
      needle = value;
    }
    const isContains =
      op === 'contains' || op === 'containsi' || op === 'notContains' || op === 'notContainsi';

    // The CONTAINS mask is the only op the trigram accelerator can compute; ordering and affix
    // ops always brute-scan the dictionary. When the column opted into the accelerator and the
    // needle is acceleratable (>= 3 units, all trigrams present), the trigram path computes the
    // mask, otherwise we fall back to the full dictionary `includes()` scan — the same FLOOR that
    // also runs whenever the index isn't built. Either way the mask is then expanded identically.
    const mask =
      isContains && this.substringEnabled
        ? this.containsMaskAccel(decode, count, needle, insensitive)
        : this.bruteMask(op, decode, count, needle);

    const codes = this.codes;
    const n = this.length;
    if (op === 'notContains' || op === 'notContainsi') {
      // Complement of the contains mask over [0, N); NULL rows are removed at the Table boundary.
      out.fill(n);
      const contains = new Bitset(n);
      for (let i = 0; i < n; i++) if (mask[codes[i]!] === 1) contains.set(i);
      out.andNot(contains);
      return;
    }
    for (let i = 0; i < n; i++) if (mask[codes[i]!] === 1) out.set(i);
  }

  /**
   * The brute FLOOR: test the predicate against every distinct dictionary string once, returning
   * a `Uint8Array` code mask (mask[code] === 1 iff that string matches). `D << N`, so this is the
   * cheap dictionary-side pass; the caller expands the mask to rows. Also the mandatory fallback
   * whenever the trigram accelerator can't apply (short needle / absent trigram / column unflagged).
   */
  private bruteMask(op: ScanOp, decode: (code: number) => string, count: number, needle: string): Uint8Array {
    const d = count;
    const mask = new Uint8Array(d);
    for (let c = 0; c < d; c++) {
      const s = decode(c);
      let hit = false;
      switch (op) {
        case 'gt':  hit = s >  needle; break;
        case 'gte': hit = s >= needle; break;
        case 'lt':  hit = s <  needle; break;
        case 'lte': hit = s <= needle; break;
        // eqi/nei are handled by the folded dictionary in scan(), never routed here.
        case 'contains':
        case 'containsi':
        case 'notContains':
        case 'notContainsi': hit = s.includes(needle); break;
        case 'startsWith':
        case 'startsWithi':  hit = s.startsWith(needle); break;
        case 'endsWith':
        case 'endsWithi':    hit = s.endsWith(needle); break;
      }
      if (hit) mask[c] = 1;
    }
    return mask;
  }

  /**
   * Trigram-accelerated CONTAINS mask (report §2.5). Asks the trigram index for candidate codes;
   * if it returns `null` (needle < 3 units, or a trigram absent from the index) we fall straight
   * back to {@link bruteMask} — the brute floor, byte-identical result. Otherwise we VERIFY each
   * candidate with the SAME `includes()` the brute path uses (the trigram intersection over-
   * generates, so verification is what kills false positives and guarantees correctness regardless
   * of trigram granularity), setting the mask only for verified codes.
   *
   * `decode`/`needle` are already RAW (for `$contains`) or FOLDED (for `$containsi`); the matching
   * trigram index (`rawTrigrams` / `foldedTrigrams`) is consulted accordingly, so case-sensitive
   * and case-insensitive each verify with their own off-heap dictionary, exactly like the brute path.
   */
  private containsMaskAccel(
    decode: (code: number) => string,
    count: number,
    needle: string,
    insensitive: boolean,
  ): Uint8Array {
    if (insensitive) this.ensureFoldedTrigrams();
    else this.ensureRawTrigrams();
    const index = insensitive ? this.foldedTrigrams : this.rawTrigrams;

    const candidates = index === null ? null : index.candidateCodes(needle);
    if (candidates === null) {
      // Not acceleratable for this needle — the brute dictionary scan is the mandatory floor.
      return this.bruteMask('contains', decode, count, needle);
    }

    // Acceleration fired: build the mask only from VERIFIED candidates. This is what makes the
    // accelerator return BYTE-IDENTICAL rows to brute — the trigram set is a superset, includes()
    // removes every false positive (a value whose trigrams cover the needle but not contiguously).
    this.substringAccelHits++;
    const mask = new Uint8Array(count);
    for (let k = 0; k < candidates.length; k++) {
      const code = candidates[k]!;
      if (decode(code).includes(needle)) mask[code] = 1;
    }
    return mask;
  }
}

/**
 * Off-heap text column for long, near-unique searchable bodies (article content, descriptions).
 *
 * Unlike {@link StringColumn} this is NOT dictionary-encoded: bodies are effectively unique, so a
 * dict buys no dedup while pinning every distinct UTF-16 string in the V8 heap (millions of long
 * strings = GC pressure + retained heap). Instead each value is encoded to UTF-8 ONCE at push and
 * appended to a single growable byte arena, with an Int32Array of offsets — `bytes[off[r]..off[r+1]]`
 * is row r's UTF-8. `at(row)` decodes that slice back to a string on demand. The arena lives outside
 * the object heap (one Uint8Array), so a million bodies cost one buffer + one offset array, not a
 * million string objects.
 *
 * NULL is driven off the Table's per-column null bitset (the source of truth), exactly like every
 * other column: a NULL row stores an EMPTY slice (`off[r] === off[r+1]`) — indistinguishable at the
 * byte level from a genuine empty string `''`, which is fine because the null bit, not the bytes,
 * decides. `materialize` returns null for a NULL row; `at` always returns the decoded string ('' for
 * both a null sentinel and a real empty string — the caller consults the null bit to tell them apart).
 *
 * No eq-index, no sorted index — bodies are unique and long, so those structures are pointless.
 * Operators are a BRUTE per-row scan that decodes each row's text from the arena and runs JS
 * includes/startsWith/endsWith (folding both sides with the SAME `fold` = NFKC+toLowerCase as
 * StringColumn for the `-i` variants), plus eq/ne. `notContains*`/`ne` exclude NULL rows at the
 * Table boundary (three-valued logic via `excludeNulls`), identical to every other negative op.
 *
 * ── Trigram acceleration over the arena (AV4, opt-in via {@link enableSubstringIndex}) ─────────
 * A 'text' column has NO dictionary (bodies are near-unique), so unlike StringColumn its trigram
 * postings are over ROW IDs directly, and VERIFICATION decodes the candidate row's text FROM THE
 * ARENA and runs `includes()` — the body is never duplicated as a heap string. The index builds
 * lazily on the first `$contains*` query and rebuilds as the arena grows (rebuilt when row count
 * changes). Build transiently decodes each row (one pass, strings GC'd); only the trigram maps +
 * Int32Arrays persist. Brute stays the floor + verifier: short needle (<3 units) or any absent
 * trigram => the full arena brute scan. `-i` builds over FOLDED trigrams and folds the decoded
 * candidate + needle at verification, so case/Unicode variants are never under-generated.
 * Affix ops (startsWith / endsWith and their -i forms) and the not-contains complements are NOT
 * trigram-accelerated here (only `contains`/`containsi` are); the rest keep the brute arena scan.
 */
export class TextColumn implements Column {
  readonly type = 'text';
  /** UTF-8 bytes of every row's text, concatenated. Grows by doubling. */
  private bytes = new Uint8Array(INITIAL_CAPACITY);
  /** Number of bytes used in `bytes` (the write cursor / total encoded length). */
  private used = 0;
  /**
   * Row offsets: `offsets[r]` is the start byte of row r, `offsets[r+1]` its end (exclusive), so a
   * row's slice is `bytes[offsets[r] .. offsets[r+1]]`. One longer than `length` (the terminal
   * cursor lives at `offsets[length]`), so `at` never special-cases the last row.
   */
  private offsets = new Int32Array(INITIAL_CAPACITY + 1);
  length = 0;

  private static readonly encoder = new TextEncoder();
  private static readonly decoder = new TextDecoder();

  /**
   * Opt-in trigram substring accelerator. OFF by default (brute arena scan). When enabled, the raw
   * index serves `$contains`, the folded index serves `$containsi`; each builds lazily on its first
   * relevant query and rebuilds when the row count changes (the arena grew). Postings are ROW IDS.
   */
  private substringEnabled = false;
  private rawTrigrams: SubstringIndex | null = null;
  private foldedTrigrams: SubstringIndex | null = null;
  /** Row count the raw/folded trigram index was last built at (rebuild when the arena grows). */
  private rawTrigramsBuilt = -1;
  private foldedTrigramsBuilt = -1;

  /**
   * Test/bench seams (real counters on real built state, NOT mocks): how many `$contains*` scans
   * took the trigram-accelerated path, and how many candidate rows were decoded FROM THE ARENA for
   * verification. A nonzero `arenaVerifyReads` with a correct result proves verification read the
   * body from the off-heap arena rather than any heap dictionary (a text column has none).
   */
  substringAccelHits = 0;
  arenaVerifyReads = 0;

  /**
   * Cost-guard threshold (fraction of N). If the rarest needle-trigram posting length exceeds
   * `costGuardF * length`, the candidate set is too large a fraction of N for the index to beat the
   * brute arena scan, so `containsAccel` defers to brute (the floor). Bench-swept lever: at 2M the
   * common needle's rarest posting approaches N, so any F < 1 routes it to brute and the gate
   * `body contains [TRIGRAM] <= [arena brute]` holds by tying the floor; selective needles whose
   * rarest posting is a small slice still take the indexed (memmem-verified) fast path.
   */
  static costGuardF = 0.05;

  /**
   * Absolute row-count floor below which the cost guard NEVER engages. The guard exists to keep the
   * common-needle case off the slow accel path on LARGE columns; at tiny N (the unit-test fixtures,
   * hundreds of rows) the accel path is already faster than brute and the firing-counter contracts
   * (`substringAccelHits`/`arenaVerifyReads`) require it to fire, so we only arm the guard once the
   * column is big enough for a near-N candidate set to actually cost more than the brute scan.
   */
  static costGuardMinRows = 100_000;

  /** Opt this column into the trigram substring accelerator. Idempotent; index builds lazily. */
  enableSubstringIndex(): void {
    this.substringEnabled = true;
  }

  /** Test seam: distinct trigram count of the raw (case-sensitive) index, building it if needed. */
  rawTrigramCount(): number {
    this.ensureRawTrigrams();
    return this.rawTrigrams === null ? 0 : this.rawTrigrams.trigramCount;
  }

  /** (Re)build the raw row-id trigram index if enabled and the arena has grown since. */
  private ensureRawTrigrams(): void {
    if (!this.substringEnabled) return;
    if (this.rawTrigramsBuilt !== this.length) {
      this.rawTrigrams = SubstringIndex.over(this.length, (row) => this.at(row));
      this.rawTrigramsBuilt = this.length;
    }
  }

  /** (Re)build the folded row-id trigram index if enabled and the arena has grown since. */
  private ensureFoldedTrigrams(): void {
    if (!this.substringEnabled) return;
    if (this.foldedTrigramsBuilt !== this.length) {
      this.foldedTrigrams = SubstringIndex.over(this.length, (row) => fold(this.at(row)));
      this.foldedTrigramsBuilt = this.length;
    }
  }

  /** Grow the byte arena to fit at least `need` more bytes (double until it fits). */
  private ensureBytes(need: number): void {
    if (this.used + need <= this.bytes.length) return;
    let cap = this.bytes.length;
    while (cap < this.used + need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.bytes);
    this.bytes = next;
  }

  /** Grow the offsets array so `offsets[length + 1]` is addressable. */
  private ensureOffsets(): void {
    if (this.length + 1 < this.offsets.length) return;
    const next = new Int32Array(this.offsets.length * 2);
    next.set(this.offsets);
    this.offsets = next;
  }

  push(value: unknown): number {
    const s = value as string;
    const encoded = TextColumn.encoder.encode(s);
    this.ensureBytes(encoded.length);
    this.ensureOffsets();
    const i = this.length;
    // offsets[i] is already the current cursor (set as the previous row's terminal). Append bytes,
    // advance the cursor, record the new terminal at offsets[i+1].
    this.offsets[i] = this.used;
    this.bytes.set(encoded, this.used);
    this.used += encoded.length;
    this.offsets[i + 1] = this.used;
    this.length = i + 1;
    return i;
  }

  /** Decode row r's UTF-8 slice back to a string ('' for an empty/null-sentinel slice). */
  at(row: number): string {
    const start = this.offsets[row]!;
    const end = this.offsets[row + 1]!;
    if (start === end) return '';
    return TextColumn.decoder.decode(this.bytes.subarray(start, end));
  }

  scan(op: ScanOp, value: unknown, out: Bitset): void {
    const n = this.length;
    const dec = TextColumn.decoder;
    const bytes = this.bytes;
    const offsets = this.offsets;
    const v = value as string;

    switch (op) {
      // Equality compares the decoded string. NULL rows carry an empty slice; the Table boundary
      // (excludeNulls) removes them, so a real '' eq '' matches while a null '' is filtered out.
      case 'eq':
        for (let i = 0; i < n; i++) if (dec.decode(bytes.subarray(offsets[i]!, offsets[i + 1]!)) === v) out.set(i);
        return;
      case 'ne':
        for (let i = 0; i < n; i++) if (dec.decode(bytes.subarray(offsets[i]!, offsets[i + 1]!)) !== v) out.set(i);
        return;
      // Case-insensitive equality: fold BOTH sides with the same NFKC+lower as StringColumn/$eqi.
      case 'eqi': {
        const fv = fold(v);
        for (let i = 0; i < n; i++) if (fold(dec.decode(bytes.subarray(offsets[i]!, offsets[i + 1]!))) === fv) out.set(i);
        return;
      }
      case 'nei': {
        const fv = fold(v);
        for (let i = 0; i < n; i++) if (fold(dec.decode(bytes.subarray(offsets[i]!, offsets[i + 1]!))) !== fv) out.set(i);
        return;
      }
      // Substring / affix. Case-sensitive variants compare the raw decoded text; `-i` variants fold
      // the row text and the needle identically. notContains*/ne exclude NULLs at the Table boundary.
      case 'contains':
        if (this.containsAccel(v, false, out)) return;
        for (let i = 0; i < n; i++) if (dec.decode(bytes.subarray(offsets[i]!, offsets[i + 1]!)).includes(v)) out.set(i);
        return;
      case 'notContains':
        for (let i = 0; i < n; i++) if (!dec.decode(bytes.subarray(offsets[i]!, offsets[i + 1]!)).includes(v)) out.set(i);
        return;
      case 'startsWith':
        for (let i = 0; i < n; i++) if (dec.decode(bytes.subarray(offsets[i]!, offsets[i + 1]!)).startsWith(v)) out.set(i);
        return;
      case 'endsWith':
        for (let i = 0; i < n; i++) if (dec.decode(bytes.subarray(offsets[i]!, offsets[i + 1]!)).endsWith(v)) out.set(i);
        return;
      case 'containsi': {
        const fv = fold(v);
        if (this.containsAccel(v, true, out)) return;
        for (let i = 0; i < n; i++) if (fold(dec.decode(bytes.subarray(offsets[i]!, offsets[i + 1]!))).includes(fv)) out.set(i);
        return;
      }
      case 'notContainsi': {
        const fv = fold(v);
        for (let i = 0; i < n; i++) if (!fold(dec.decode(bytes.subarray(offsets[i]!, offsets[i + 1]!))).includes(fv)) out.set(i);
        return;
      }
      case 'startsWithi': {
        const fv = fold(v);
        for (let i = 0; i < n; i++) if (fold(dec.decode(bytes.subarray(offsets[i]!, offsets[i + 1]!))).startsWith(fv)) out.set(i);
        return;
      }
      case 'endsWithi': {
        const fv = fold(v);
        for (let i = 0; i < n; i++) if (fold(dec.decode(bytes.subarray(offsets[i]!, offsets[i + 1]!))).endsWith(fv)) out.set(i);
        return;
      }
      // Ordering is not a text operator (bodies aren't sorted); between is numeric-only;
      // null/notNull are resolved at the Table level off the null bitset. All no-ops here.
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
      case 'between':
      case 'in':
      case 'notIn':
      case 'null':
      case 'notNull':
        return;
    }
  }

  /**
   * Trigram-accelerated CONTAINS over the arena. Returns `true` and fills `out` with verified rows
   * when the accelerator fired; returns `false` (leaving `out` untouched) to signal "fall back to
   * the brute arena scan" (column unflagged, index empty, needle < 3 units, or an absent trigram).
   *
   * `insensitive` selects the FOLDED row-id index and folds both the decoded candidate and the
   * needle at verification, byte-identical to the `-i` brute path. Verification decodes each
   * candidate row's body FROM THE ARENA via `at(row)` (counted in `arenaVerifyReads`) and runs the
   * SAME `includes()` the brute path uses — the trigram set is a superset, so verification removes
   * every false positive (a body whose needle-trigrams co-occur but not contiguously).
   */
  private containsAccel(value: string, insensitive: boolean, out: Bitset): boolean {
    if (!this.substringEnabled) return false;
    if (insensitive) this.ensureFoldedTrigrams();
    else this.ensureRawTrigrams();
    const index = insensitive ? this.foldedTrigrams : this.rawTrigrams;
    if (index === null) return false;

    const needle = insensitive ? fold(value) : value;

    // COST/SELECTIVITY GUARD (large columns only): the rarest constituent trigram's posting length is
    // a TIGHT UPPER BOUND on the post-intersection candidate count (intersection only shrinks vs the
    // smallest list). If that bound already exceeds F*N, the candidate set is a large fraction of N and
    // even the cheap byte-level memmem verify over ~N rows cannot beat the brute arena scan, so route
    // to brute (return false) WITHOUT bumping substringAccelHits or touching `out`. This is what holds
    // the common-needle gate (`body contains [TRIGRAM] <= [arena brute]`): the worst case ties the
    // floor rather than paying the accel premium. minPostingLen returns null on the SAME short/absent-
    // trigram conditions candidates() does, so a null also correctly defers to brute. The guard is
    // armed only past costGuardMinRows so tiny test fixtures keep firing the accel path (their
    // firing-counter contracts) and never hit this bail.
    if (this.length >= TextColumn.costGuardMinRows) {
      const est = index.minPostingLen(needle);
      if (est === null) return false;
      if (est > TextColumn.costGuardF * this.length) return false;
    }

    const candidates = index.candidates(needle);
    if (candidates === null) return false; // not acceleratable — defer to the brute floor.

    this.substringAccelHits++;

    // VERIFY. The trigram candidate set is a SUPERSET of the true matches, so each candidate is
    // re-checked with the EXACT same predicate the brute path uses — that is what keeps the accel
    // path byte-identical to the brute floor.
    if (insensitive) {
      // `-i`: fold is NFKC + lower (NOT a byte-level transform), so it must run on the decoded
      // string. Keep the decode + fold + includes verbatim — identical to the `containsi` brute loop.
      for (let k = 0; k < candidates.length; k++) {
        const row = candidates[k]!;
        this.arenaVerifyReads++;
        const text = this.at(row); // off-heap arena decode — NO heap dictionary of bodies.
        if (fold(text).includes(needle)) out.set(row);
      }
      return true;
    }

    // Case-sensitive: verify directly against the off-heap UTF-8 arena bytes — a bounded byte memmem
    // over `bytes[offsets[row], offsets[row+1])` — instead of decode-to-string + String.includes.
    // A valid UTF-8 substring is contiguous in the arena bytes IFF it is contiguous in the decoded
    // string, so this is exactly equivalent to `this.at(row).includes(needle)` while eliminating the
    // per-row TextDecoder allocation — which is what makes the common-needle verify cheaper than the
    // brute decode-and-includes floor. Edge cases match includes() precisely: empty needle -> match
    // (includes('') is true), needle longer than the row -> no window fits -> no match; the search is
    // bounded to the row end so a match window NEVER spills across rows.
    //
    // EXCEPTION — unpaired surrogate in the needle: TextEncoder lossily maps a lone surrogate to the
    // U+FFFD replacement bytes (EF BF BD), which never equals the original code unit a String.includes
    // would match against the (validly decoded) body. So byte memmem is NOT equivalent for such a
    // needle. This only ever happens for a malformed needle (a real substring of a body is always
    // well-formed); for that case we keep the EXACT decode + includes the brute path uses, preserving
    // byte-identical results. The hot prod workload has no lone surrogates, so it always takes memmem.
    if (TextColumn.hasUnpairedSurrogate(needle)) {
      for (let k = 0; k < candidates.length; k++) {
        const row = candidates[k]!;
        this.arenaVerifyReads++;
        if (this.at(row).includes(needle)) out.set(row);
      }
      return true;
    }

    const needleBytes = TextColumn.encoder.encode(needle);
    const bytes = this.bytes;
    const offsets = this.offsets;
    const nlen = needleBytes.length;
    for (let k = 0; k < candidates.length; k++) {
      const row = candidates[k]!;
      this.arenaVerifyReads++; // a verified arena read (byte-level), same firing contract as before.
      const start = offsets[row]!;
      const end = offsets[row + 1]!;
      if (TextColumn.arenaContains(bytes, start, end, needleBytes, nlen)) out.set(row);
    }
    return true;
  }

  /**
   * Does `s` contain an UNPAIRED UTF-16 surrogate (a high surrogate not followed by a low, or a low
   * surrogate not preceded by a high)? Such a string is not well-formed UTF-16, so `TextEncoder`
   * encodes the lone unit as U+FFFD — making a byte memmem over UTF-8 arena bytes diverge from
   * `String.includes`. Detecting it lets the case-sensitive verify fall back to decode+includes so the
   * result stays byte-identical to brute. O(s.length); only runs ONCE per query, off the per-row loop.
   */
  private static hasUnpairedSurrogate(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        // High surrogate: must be followed by a low surrogate.
        const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
        if (next < 0xdc00 || next > 0xdfff) return true;
        i++; // consume the valid pair
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        return true; // low surrogate with no preceding high -> unpaired
      }
    }
    return false;
  }

  /**
   * Bounded byte memmem: does `bytes[start, end)` contain `needleBytes[0, nlen)` as a contiguous run?
   * Native first-byte scan (`Uint8Array.prototype.indexOf`) advances the window within `[start, end)`,
   * then a tail compare of the remaining needle bytes; a match window is never allowed to cross `end`,
   * so there is NO cross-row spill. Byte-for-byte equivalent to `decode(bytes[start,end)).includes` for
   * UTF-8 (a valid substring is contiguous in bytes iff contiguous in the decoded string). Empty needle
   * (`nlen === 0`) returns true (mirrors `includes('')`); a needle longer than the slice returns false.
   */
  private static arenaContains(
    bytes: Uint8Array,
    start: number,
    end: number,
    needleBytes: Uint8Array,
    nlen: number,
  ): boolean {
    if (nlen === 0) return true; // includes('') === true
    const last = end - nlen; // last index where a full needle window still fits inside [start, end)
    if (last < start) return false; // needle longer than the row slice -> no window fits
    const first = needleBytes[0]!;
    let pos = start;
    while (pos <= last) {
      const hit = bytes.indexOf(first, pos); // native scan for the first byte
      if (hit === -1 || hit > last) return false; // no first-byte left within the fitting window
      let j = 1;
      while (j < nlen && bytes[hit + j] === needleBytes[j]) j++;
      if (j === nlen) return true; // full needle matched, entirely inside [start, end)
      pos = hit + 1;
    }
    return false;
  }

  /**
   * Text ops are a brute arena decode-and-match, never a clean row-at-a-time int probe, so the
   * selectivity planner always builds a bitset and ANDs (returns null here — the documented
   * non-probeable path, like StringColumn's substring/affix ops).
   */
  makeProbe(_op: ScanOp, _value: unknown): RowProbe | null {
    return null;
  }
}

export function createColumn(type: ColumnType, scale?: number, precision?: number): Column {
  switch (type) {
    case 'i32':
    case 'f64':
      return new NumericColumn(type);
    case 'bool':
      return new BoolColumn();
    case 'string':
      return new StringColumn();
    case 'date':
      return new DateColumn();
    case 'text':
      return new TextColumn();
    case 'i64':
      return new I64Column('i64', 0);
    case 'decimal':
      if (scale === undefined) throw new Error('decimal column requires a scale');
      return new I64Column('decimal', scale, precision);
    case 'json':
      return new JsonColumn();
  }
}
