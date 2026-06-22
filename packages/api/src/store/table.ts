import { Bitset } from './bitset.ts';
import {
  coerceDate,
  coerceDecimal,
  coerceI64,
  createColumn,
  formatDecimal,
  I64Column,
  RawJson,
  StringColumn,
  TextColumn,
  type Column,
  type ColumnType,
  type RowProbe,
  type ScanOp,
} from './column.ts';
import { EqIndex } from './indexes/eq.index.ts';
import { SortedIndex, type SortDir } from './indexes/sorted.index.ts';
import { StringSortedIndex } from './indexes/string-sorted.index.ts';
import {
  CompositeSortedIndex,
  type Boundary,
  type BoundaryValue,
  type ResolvedSortKey,
} from './indexes/composite-sorted.index.ts';
import type { CursorPayload } from './cursor.codec.ts';

export interface FieldDef {
  name: string;
  type: ColumnType;
  /** Fixed scale for a `decimal` field (the column stores `round(value * 10^scale)`). Ignored otherwise. */
  scale?: number;
  /**
   * Total significant digits for a `decimal` field (the integer-part cap is `precision - scale`).
   * Threaded so the RAM engine rejects an out-of-precision value exactly as Postgres (22003) does —
   * without it the only backstop is the int64 range, which permits up to 18 digits regardless of the
   * declared `numeric(p,s)`. Ignored for non-decimal fields.
   */
  precision?: number;
}

export interface Predicate {
  field: string;
  op: ScanOp;
  value: unknown;
}

export interface SortKey {
  field: string;
  dir: SortDir;
}

/**
 * The opt-in KEYSET (seek) pagination request. Mutually exclusive with `offset`/`limit` (the
 * parser enforces this). Exactly one of `cursor`/`before` may be set; both unset = the FIRST page
 * (head walk). `cursor` = forward (rows after the boundary); `before` = backward (rows before it).
 */
export interface KeysetOptions {
  cursor?: CursorPayload;
  before?: CursorPayload;
  pageSize: number;
  withCount: boolean;
}

export interface QueryOptions {
  filters?: Predicate[];
  /**
   * A nested boolean filter TREE ({@link FilterNode}), the richer alternative to the flat
   * implicit-AND `filters` list. When BOTH are present the tree wins (the flat list is the legacy
   * surface); when only `filters` is present it AND-combines exactly as before. This is the seam
   * the Strapi query parser (AV2) targets: nested `$and`/`$or`/`$not` parse straight to a tree.
   */
  where?: FilterNode;
  sort?: SortKey[];
  offset?: number;
  limit?: number;
  /**
   * Opt-in keyset (seek) pagination, with DECODED cursor payloads. Set by the Engine after it
   * decodes/verifies the raw {@link RawKeysetOptions} tokens. When present, {@link Table.queryKeyset}
   * is used instead of the offset/limit walk; `offset`/`limit` are untouched and ignored.
   */
  keyset?: KeysetOptions;
  /**
   * The RAW keyset request as produced by the query parser: opaque cursor/before TOKENS (not yet
   * decoded — the Engine owns the codec) + pageSize + withCount. The Engine decodes these into
   * {@link keyset} before calling {@link Table.queryKeyset}; the cache key is built from this raw
   * shape so two different cursors never collide.
   */
  keysetRaw?: RawKeysetOptions;
}

/** The parser-produced keyset request: opaque tokens (decoded later by the Engine) + page knobs. */
export interface RawKeysetOptions {
  cursorToken?: string;
  beforeToken?: string;
  pageSize: number;
  withCount: boolean;
}

/** The result of a keyset seek: the page's row ids + the boundaries to mint next/prev cursors. */
export interface KeysetResult {
  rowIds: number[];
  /** The page's FIRST row boundary (mints prevCursor). Undefined when the page is empty. */
  firstBoundary?: Boundary;
  /** The page's LAST row boundary (mints nextCursor). Undefined when the page is empty. */
  lastBoundary?: Boundary;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/** A typed error for a keyset request the table can't seek (no `id` field, or a json sort key). */
export class KeysetUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeysetUnsupportedError';
  }
}

/**
 * A predicate combination tree. Leaves resolve one column predicate into a Bitset;
 * internal nodes combine children with boolean algebra over the dense bitsets.
 *
 *  - `and`: intersect children (empty children = all rows — the AND identity)
 *  - `or` : union children (empty children = no rows — the OR identity)
 *  - `not`: structural complement of its single child over [0, rowCount)
 *
 * NOTE (Slice 0): `not` is a *pure structural* complement here. Null-aware SQL
 * semantics (e.g. `$ne` excluding nulls) arrive in Slice 1 at the leaf operators.
 *
 * The 4th arm (Relations Slice 4) is a RELATION leaf — `{ relation, sub }` — an EXISTS join: owner
 * rows that have AT LEAST ONE related row matching the `sub` tree (evaluated on the TARGET table).
 * It is structurally disjoint from the other arms (no `leaf`, no `op`). The Table is standalone and
 * cannot reach the target Table / Relation store itself, so {@link scanTree} resolves this arm via an
 * Engine-supplied {@link RelationResolver}; without one a relation leaf is a programming error (throw).
 */
export type FilterNode =
  | { leaf: Predicate }
  | { op: 'and' | 'or'; children: FilterNode[] }
  | { op: 'not'; children: [FilterNode] }
  | { relation: string; sub: FilterNode };

/**
 * The cross-table seam for a relation leaf, supplied by the Engine (which owns every Table + the
 * relation store). Given a relation FIELD on the current owner type and the `sub` tree to evaluate on
 * the TARGET type, it returns an OWNER-sized Bitset of owners with >=1 matching related row (EXISTS).
 * The owner apiId is NOT a parameter — the Engine binds it in the closure, keeping the Table ignorant
 * of api_ids. The Table only ever invokes (never constructs) this.
 */
export type RelationResolver = (relField: string, sub: FilterNode) => Bitset;

function isRangeOp(op: ScanOp): boolean {
  return op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte';
}

/**
 * Selectivity-planner gate (report §2.6): the row-at-a-time probe only pays off when the lead
 * leaf is TINY. Above this fraction of rows the per-row probe-and-null-check loop loses to the
 * word-wise bitset AND, so we keep the bitset path. 1/64 (~1.5%) sits in the report's "<~1–2%".
 */
const PROBE_LEAD_NUM = 1;
const PROBE_LEAD_DENOM = 64;

/** Hard cap on distinct composite-index specs kept per table (client-driven DoS guard). */
const MAX_COMPOSITE_INDEXES = 32;

/**
 * One content-type, stored column-by-column. Rows are dense (row index 0..rowCount).
 *
 * The query engine half of the store. Filtering goes through indexes where available
 * (hash index for `$eq`, sorted index for ranges) and falls back to a full typed-array
 * scan otherwise. Sorting + pagination ride the sorted index with early termination.
 */
export class Table {
  readonly fields: readonly FieldDef[];
  private readonly columns: Map<string, Column>;
  private readonly eqIndexes = new Map<string, EqIndex>();
  private readonly sortedIndexes = new Map<string, SortedIndex>();
  /**
   * Sorted indexes over `string` columns — the dict-rank structure that makes ORDER BY a string
   * column fast (be-22c). Kept in a SEPARATE map from the numeric `sortedIndexes` because a string
   * index only serves the OFFSET/LIMIT ORDER BY path (`ensureBuilt`/`forEachOrdered`), NEVER the
   * numeric range/between/count slices — so the numeric range path stays byte-identical and a string
   * index can never be pulled into a range scan. The `query()` sort fast-path consults BOTH maps.
   */
  private readonly stringSortedIndexes = new Map<string, StringSortedIndex>();
  /**
   * Lazily-built MULTI-KEY seekable indexes, keyed by the canonical resolved-sort spec string.
   * Client-driven, so an LRU cap bounds the count (a DoS guard against unbounded distinct specs).
   * An insert marks every built composite index dirty (see {@link insert}).
   */
  private readonly compositeIndexes = new Map<string, CompositeSortedIndex>();
  /**
   * Per-column null planes: word `w` holds the null bits for rows [w*32, w*32+32).
   * Stored as growable Uint32Array (parallel to the dense columns) and only allocated
   * for a field once it actually sees a null/missing value — most columns stay non-null.
   */
  private readonly nullWords = new Map<string, Uint32Array>();
  rowCount = 0;

  /**
   * Test/bench seam for the selectivity planner. `probeEnabled` toggles the §2.6 tiny-lead
   * probe path off so a test can compare it against the pure bitset-AND combiner on the SAME
   * data (they must be byte-identical). `probeHits` counts how many AND nodes actually took the
   * probe path, letting a test assert the path really fired rather than silently falling back.
   * Neither affects `query()` results — only whether the probe or the bitset path produced them.
   */
  probeEnabled = true;
  probeHits = 0;

  constructor(fields: FieldDef[]) {
    this.fields = fields;
    this.columns = new Map();
    for (const f of fields) this.columns.set(f.name, createColumn(f.type, f.scale, f.precision));
  }

  column(name: string): Column {
    const col = this.columns.get(name);
    if (col === undefined) throw new Error(`unknown field "${name}"`);
    return col;
  }

  // --- index registration -------------------------------------------------

  /**
   * Equality index for `$eq`/`$in` on a field. Backed by the flat CSR/plane `EqIndex`
   * (counting-sort build + cardinality gate): low-card fields get dense planes, mid-card a
   * CSR, near-unique the dict Map — chosen automatically at build (see `EqIndex`).
   *
   * `createEqIndex` is the descriptive name; `createHashIndex` is preserved as the original
   * public alias so pre-refactor callers keep working with identical semantics.
   */
  createEqIndex(field: string): void {
    const col = this.column(field);
    if (col.type === 'json') throw new Error(`json fields are not eq-indexable, "${field}" is json`);
    const idx = new EqIndex(col.type);
    for (let r = 0; r < this.rowCount; r++) idx.add(col.at(r), r);
    this.eqIndexes.set(field, idx);
  }

  /** Backward-compatible alias for {@link createEqIndex} (original public API name). */
  createHashIndex(field: string): void {
    this.createEqIndex(field);
  }

  /** Test/planning introspection: which equality structure the gate chose for `field`. */
  eqStrategy(field: string): 'plane' | 'csr' | 'dict' {
    const idx = this.eqIndexes.get(field);
    if (idx === undefined) throw new Error(`no eq index on field "${field}"`);
    return idx.strategy();
  }

  /**
   * Resolve the dense row id holding `value` in an eq-indexed field, or `undefined` if no row does.
   * Built for a UNIQUE key (the `id` primary key): the first posting is returned, so a non-unique
   * field would silently pick its lowest row id. Requires an eq index on `field`.
   */
  rowIdByEq(field: string, value: unknown): number | undefined {
    const idx = this.eqIndexes.get(field);
    if (idx === undefined) throw new Error(`no eq index on field "${field}"`);
    const rows = idx.rows(value);
    return rows === undefined || rows.length === 0 ? undefined : rows[0];
  }

  /**
   * Opt a string field into the trigram substring accelerator (report §2.5 / Slice 8). Gated and
   * opt-in: only flag columns that are contains-heavy / large distinct count; unflagged string
   * columns keep the deduped-dictionary brute scan as the default. The trigram index builds on the
   * first `$contains*` query (and rebuilds to cover newly interned strings), then intersect+verify
   * candidates — returning rows byte-identical to brute, just faster. No-op on non-string fields.
   */
  enableSubstringIndex(field: string): void {
    const col = this.column(field);
    if (col instanceof StringColumn || col instanceof TextColumn) col.enableSubstringIndex();
    else throw new Error(`substring index requires a string field or text field, "${field}" is ${col.type}`);
  }

  /**
   * Sorted index for numeric/temporal range filters and ORDER BY. Numeric ('i32'/'f64'), 'date',
   * 'i64' or 'decimal' fields only — a date column is an f64 epoch-ms column under the hood (the f64
   * radix key handles it); i64/decimal use an int64-exact key path (the BigInt64Array, sign-bit-flip
   * key) so a mantissa above 2^53 is never coerced to f64. json/string/text/bool stay rejected.
   */
  createSortedIndex(field: string): void {
    const col = this.column(field);
    // ADDITIVE: a `string` column gets the dict-rank StringSortedIndex (be-22c) — registered in the
    // separate `stringSortedIndexes` map so the numeric/date branch below stays byte-identical. It
    // produces the IDENTICAL row order the numeric sorted-index path produces (the engine's live
    // ORDER BY oracle), just fast. (`text`/arena columns have no dictionary to rank — follow-up.)
    if (col.type === 'string') {
      this.stringSortedIndexes.set(field, new StringSortedIndex());
      return;
    }
    if (
      col.type !== 'i32' &&
      col.type !== 'f64' &&
      col.type !== 'date' &&
      col.type !== 'i64' &&
      col.type !== 'decimal'
    ) {
      throw new Error(`sorted index requires a numeric, date, i64, decimal, or string field, "${field}" is ${col.type}`);
    }
    this.sortedIndexes.set(field, new SortedIndex());
  }

  // --- writes -------------------------------------------------------------

  /**
   * Append a row. A missing field or an explicit `null`/`undefined` is allowed: a type
   * sentinel (0 / reserved string code) is pushed to keep the column dense, and the
   * field's null bit is set so `materialize` and (later) `$null`/`$ne` see it as NULL.
   * A real value of 0 is therefore distinguishable from NULL — only the null bit says NULL.
   */
  insert(row: Record<string, unknown>): number {
    const rowId = this.rowCount;
    for (const f of this.fields) {
      const present = f.name in row;
      const raw = present ? row[f.name] : undefined;
      const isNull = !present || raw === null || raw === undefined;
      const value = isNull ? this.sentinel(f.type) : raw;
      const col = this.columns.get(f.name)!;
      const at = col.push(value);
      if (isNull) this.setNull(f.name, rowId);
      const eq = this.eqIndexes.get(f.name);
      // Index the column's CANONICAL stored value, not the raw input: a decimal '1.50' / '1.5' /
      // Number 1.5 all push to the same mantissa, and the query side probes by that mantissa. Feeding
      // the raw value would bucket by its string/Number identity and silently disagree with the scan
      // (and with the createEqIndex backfill, which also reads col.at(r)). For a NULL row this re-reads
      // the sentinel the column stored (0n / '' / 0); the null bit still excludes it from results.
      if (eq !== undefined) eq.add(col.at(at), rowId);
      const sorted = this.sortedIndexes.get(f.name);
      if (sorted !== undefined) sorted.markDirty();
      // A new distinct string shifts the dict ranks, so the string sorted index must rebuild on the
      // next query — same lazy dirty policy as the numeric index above.
      const strSorted = this.stringSortedIndexes.get(f.name);
      if (strSorted !== undefined) strSorted.markDirty();
    }
    // A new row invalidates every built composite (multi-key) index; they rebuild lazily on the
    // next keyset query. (isDirty also catches len !== rowCount, so this is belt-and-suspenders.)
    for (const idx of this.compositeIndexes.values()) idx.markDirty();
    this.rowCount = rowId + 1;
    return rowId;
  }

  /** Reserved dense placeholder so a NULL row still occupies one slot in the column. */
  private sentinel(type: ColumnType): unknown {
    switch (type) {
      case 'i32':
      case 'f64':
      case 'date':
        // A date stores epoch-ms as f64; the sentinel is the real instant 0 (1970-01-01T00:00Z).
        // It is harmless: the null bit excludes the row from every comparison and surfaces it as
        // null in materialize, and 0 keeps the value array NaN-free so the comparator/radix stay total.
        return 0;
      case 'bool':
        return false;
      case 'string':
        return ''; // interns to a reserved code; the null bit is what marks it NULL
      case 'text':
        return ''; // stores an empty UTF-8 slice; the null bit is what marks it NULL
      case 'i64':
      case 'decimal':
        // A BigInt64Array stores the exact mantissa; the sentinel is the bigint 0n (a real value 0),
        // harmless because the null bit — not the bytes — excludes the row from every comparison.
        return 0n;
      case 'json':
        // A valid JSON literal so the validity gate passes; the null bit (not these bytes) marks NULL,
        // and materialize surfaces the row as `null` regardless. (SQL NULL vs the JSON literal `null`
        // are disambiguated by the null bit: a real JSON `null` value has its bit clear.)
        return 'null';
    }
  }

  /** Mark row `rowId` as NULL for `field`, growing the null plane to fit. */
  private setNull(field: string, rowId: number): void {
    const wordIdx = rowId >>> 5;
    let words = this.nullWords.get(field);
    if (words === undefined) {
      words = new Uint32Array(wordIdx + 1);
      this.nullWords.set(field, words);
    } else if (wordIdx >= words.length) {
      const next = new Uint32Array(wordIdx + 1);
      next.set(words);
      this.nullWords.set(field, next);
      words = next;
    }
    words[wordIdx] |= 1 << (rowId & 31);
  }

  /** True if `field` carries a NULL/missing value at `row`. */
  isNull(field: string, row: number): boolean {
    const words = this.nullWords.get(field);
    if (words === undefined) return false;
    const wordIdx = row >>> 5;
    if (wordIdx >= words.length) return false;
    return (words[wordIdx]! & (1 << (row & 31))) !== 0;
  }

  /**
   * A fresh Bitset (sized to `rowCount`) with a bit set for every NULL row of `field`.
   * The per-column null substrate that `$null`/`$notNull`/`$ne` build on in Slice 1.
   */
  nullBitset(field: string): Bitset {
    this.column(field); // validate the field exists
    const out = new Bitset(this.rowCount);
    const words = this.nullWords.get(field);
    if (words !== undefined) {
      const len = Math.min(words.length, out.words.length);
      for (let i = 0; i < len; i++) out.words[i] = words[i]!;
    }
    return out;
  }

  /**
   * Eagerly rebuild EVERY dirty index — both the sorted indexes and the lazily-rebuilt eq
   * indexes — so a rebuild never lands on the unlucky first reader after a publish batch (the
   * p99.9 latency cliff the report's §2.3 warns about). Call this once at the end of a publish.
   * After it returns, no index is dirty, so the next query does zero rebuild.
   */
  warmIndexes(): void {
    for (const [field, idx] of this.sortedIndexes) {
      idx.ensureBuilt(this.column(field), this.rowCount);
    }
    for (const [field, idx] of this.stringSortedIndexes) {
      idx.ensureBuilt(this.column(field), this.rowCount);
    }
    for (const idx of this.eqIndexes.values()) idx.warm();
  }

  /** Test/introspection: true if any index on the table would rebuild on the next read. */
  hasDirtyIndex(): boolean {
    for (const idx of this.sortedIndexes.values()) {
      if (idx.isDirty(this.rowCount)) return true;
    }
    for (const idx of this.stringSortedIndexes.values()) {
      if (idx.isDirty(this.rowCount)) return true;
    }
    for (const idx of this.eqIndexes.values()) {
      if (idx.isDirty()) return true;
    }
    return false;
  }

  // --- reads --------------------------------------------------------------

  /**
   * Resolve a single predicate into `out`, preferring an index over a scan.
   *
   * NULL semantics — three-valued logic, applied ONCE here so every current and future leaf
   * operator inherits it for free:
   *
   *  - `$null`    => exactly the field's null rows (the only op that *wants* nulls).
   *  - `$notNull` => everything except the null rows.
   *  - Every other (comparison) op: a NULL row carries a dense sentinel (0 / '' / false), so a
   *    naive column scan would wrongly match it. Any comparison against NULL is "unknown", never
   *    a match — so after resolving the op we ANDNOT the field's null rows out of the result.
   *    This is correct for BOTH polarities: a positive op like `$eq 0` must not match a NULL
   *    numeric whose sentinel is 0, and a negative op like `$ne 5` / `$notIn` must ALSO exclude
   *    NULLs (NULL != 5 is unknown, not true).
   */
  private fillPredicate(p: Predicate, out: Bitset): void {
    // $null / $notNull are resolved purely from the null bitset — never touch the column.
    if (p.op === 'null') {
      out.or(this.nullBitset(p.field));
      return;
    }
    if (p.op === 'notNull') {
      out.fill(this.rowCount);
      out.andNot(this.nullBitset(p.field));
      return;
    }

    // Resolve the comparison op, preferring an index over a full scan. `$eq`/`$in` route to
    // the CSR/plane equality index: plane-OR for low-card columns, CSR slice scatter otherwise.
    if (p.op === 'eq') {
      const eq = this.eqIndexes.get(p.field);
      if (eq !== undefined) {
        eq.fillEq(p.value, out);
        this.excludeNulls(p.field, out);
        return;
      }
    }
    if (p.op === 'in') {
      const eq = this.eqIndexes.get(p.field);
      if (eq !== undefined) {
        eq.fillIn(Array.isArray(p.value) ? p.value : [p.value], out);
        this.excludeNulls(p.field, out);
        return;
      }
    }
    if (p.op === 'between') {
      const sorted = this.sortedIndexes.get(p.field);
      if (sorted !== undefined) {
        const col = this.column(p.field);
        const rawPair = p.value as [unknown, unknown];
        sorted.ensureBuilt(col, this.rowCount);
        // A sorted-indexed column ALWAYS takes the two-bound slice: `lowerBound(lo)..upperBound(hi)`
        // is O(log n) to locate + O(k) to fill, and measured faster than the O(n) column scan at
        // EVERY selectivity (incl. 100%). The ORDER of the result is decided downstream in query()
        // independently of which fill ran, so the slice is byte-identical to the scan.
        if (col instanceof I64Column) {
          // int64-exact: coerce both bounds to the column's bigint mantissa, compare on bigint.
          const lo = this.i64Bound(col, rawPair[0]);
          const hi = this.i64Bound(col, rawPair[1]);
          sorted.fillBitsetBetweenI64(lo, hi, out);
        } else {
          // For a date column the bounds may be Date / ISO / number — coerce them to the same
          // canonical epoch-ms the column stored, so the binary search compares like with like.
          const isDate = col.type === 'date';
          const lo = isDate ? coerceDate(rawPair[0]) : (rawPair[0] as number);
          const hi = isDate ? coerceDate(rawPair[1]) : (rawPair[1] as number);
          sorted.fillBitsetBetween(lo, hi, out);
        }
        this.excludeNulls(p.field, out);
        return;
      }
      // No sorted index: one-pass column scan checking lo <= x <= hi.
      this.column(p.field).scan('between', p.value, out);
      this.excludeNulls(p.field, out);
      return;
    }
    if (isRangeOp(p.op)) {
      const sorted = this.sortedIndexes.get(p.field);
      if (sorted !== undefined) {
        const col = this.column(p.field);
        sorted.ensureBuilt(col, this.rowCount);
        // Same single-bound slice as $between: gt = upperBound(v)..len, gte = lowerBound(v)..len,
        // lt = 0..lowerBound(v), lte = 0..upperBound(v) — always taken on a sorted-indexed column,
        // measured faster than the O(n) scan at every selectivity. Order is restored downstream.
        if (col instanceof I64Column) {
          const bound = this.i64Bound(col, p.value);
          sorted.fillBitsetI64(p.op, bound, out);
        } else {
          // A date column stores epoch-ms; coerce a Date / ISO / number bound to the same ms so the
          // sorted-index probe and the scan-fallback compare against the identical canonical value.
          const isDate = col.type === 'date';
          const bound = isDate ? coerceDate(p.value) : (p.value as number);
          sorted.fillBitset(p.op, bound, out);
        }
        this.excludeNulls(p.field, out);
        return;
      }
    }
    this.column(p.field).scan(p.op, p.value, out);
    this.excludeNulls(p.field, out);
  }

  /**
   * Resolve a range/between bound to an `I64Column`'s canonical bigint mantissa, matching exactly what
   * the column's own scan resolves (the SAME `coerceI64`/`coerceDecimal` the parser uses), so the
   * sorted-index binary search and the scan fallback agree byte-for-byte. A `decimal` predicate value
   * is usually a pre-coerced mantissa bigint (from the parser) — accepted verbatim; otherwise coerced.
   */
  private i64Bound(col: I64Column, value: unknown): bigint {
    if (col.type === 'i64') return coerceI64(value);
    if (typeof value === 'bigint') return value;
    return coerceDecimal(value, col.scale, col.precision);
  }

  /**
   * Clear any NULL rows of `field` from `out` (three-valued-logic null masking). A no-op for
   * columns that never saw a null, so non-null fields pay nothing.
   */
  private excludeNulls(field: string, out: Bitset): void {
    const words = this.nullWords.get(field);
    if (words === undefined) return;
    const a = out.words;
    const len = Math.min(a.length, words.length);
    for (let i = 0; i < len; i++) a[i]! &= ~words[i]!;
  }

  /**
   * AND a list of predicates into a Bitset of matching rows. Empty list = all rows.
   * Preserved verbatim as the public surface; internally it is just an AND group fed
   * to the tree combiner, so existing callers keep working unchanged.
   */
  scan(predicates: Predicate[]): Bitset {
    return this.scanTree({ op: 'and', children: predicates.map((p) => ({ leaf: p })) });
  }

  /**
   * Evaluate a predicate tree into a Bitset of matching rows.
   *
   *  - leaf : resolve the predicate into a fresh bitset (index-preferring `fillPredicate`).
   *  - and  : evaluate children, intersect cheapest-first when counts are known; the empty
   *           AND is the identity (all rows).
   *  - or   : union all children into one accumulator; the empty OR is the identity (no rows).
   *  - not  : evaluate the child, then structurally complement over [0, rowCount).
   */
  scanTree(node: FilterNode, resolve?: RelationResolver): Bitset {
    // RELATION leaf (checked first; the arm is structurally disjoint so order is safe). The Engine
    // supplies the resolver — already OWNER-sized (EXISTS over the target). A standalone Table with
    // no resolver is a programming error: NEVER silently match-all (a leak) or match-none (a dropped
    // filter), throw instead. The Engine ALWAYS supplies one on the read path.
    if ('relation' in node) {
      if (resolve === undefined) {
        throw new Error(
          `relation leaf "${node.relation}" requires a RelationResolver (Table is standalone; the Engine supplies it)`,
        );
      }
      return resolve(node.relation, node.sub);
    }

    if ('leaf' in node) {
      const out = new Bitset(this.rowCount);
      this.fillPredicate(node.leaf, out);
      return out;
    }

    if (node.op === 'not') {
      return this.scanTree(node.children[0], resolve).not(this.rowCount);
    }

    if (node.op === 'or') {
      const acc = new Bitset(this.rowCount); // empty OR = no rows
      for (const child of node.children) acc.or(this.scanTree(child, resolve));
      return acc;
    }

    // AND. Empty = all rows.
    if (node.children.length === 0) {
      const all = new Bitset(this.rowCount);
      all.fill(this.rowCount);
      return all;
    }

    // Opt-in selectivity probe (report §2.6): when the most selective leaf is TINY and every
    // residual is a directly-probeable comparison on a numeric/date/dict column, iterate the
    // lead row-id list and probe residuals against raw TypedArrays — skipping the residual
    // bitset builds and word-wise ANDs entirely. Returns null (and we fall through to the
    // bitset combiner) whenever the gate doesn't apply, so this is a fast path, not a phase.
    if (this.probeEnabled) {
      const probed = this.tryProbeAnd(node.children);
      if (probed !== null) {
        this.probeHits++;
        return probed;
      }
    }

    // Bitset combiner: evaluate every child, then intersect cheapest-first (smallest count
    // narrows the accumulator fastest). Identical results to the probe path above. A relation child
    // is non-leaf, so tryProbeAnd bails on it (above) and it is resolved here via `resolve`.
    const evaluated = node.children.map((c) => this.scanTree(c, resolve));
    evaluated.sort((a, b) => a.count() - b.count());
    const acc = evaluated[0]!;
    for (let i = 1; i < evaluated.length; i++) acc.and(evaluated[i]!);
    return acc;
  }

  /**
   * The selectivity planner's tiny-lead probe path, or `null` to defer to the bitset combiner.
   *
   * Eligibility (all must hold, else `null`):
   *  - every child is a LEAF (a conjunction of column predicates, the common filter shape);
   *  - there is a usable LEAD: a leaf whose EXACT match count is known cheaply from an index
   *    (`EqIndex` posting length, `SortedIndex.countRange`) AND is below the tiny-lead gate;
   *  - the lead is NOT itself a substring/`-i`/ordering op (those have no cheap exact count and
   *    aren't a clean probe — they always go through a bitset).
   *
   * Mechanism: evaluate ONLY the lead leaf to a bitset (so it is already null-masked and exact),
   * then split the residual leaves into two buckets:
   *  - PROBEABLE (eq/ne/range/between/in/notIn on numeric/date/dict): a monomorphic `RowProbe`
   *    over the raw TypedArray, plus the residual field's null plane (a NULL residual must
   *    exclude the row — three-valued logic identical to `excludeNulls`).
   *  - NON-PROBEABLE (substring/`-i`/ordering/`null`/`notNull`): resolve to a bitset ONCE via
   *    `fillPredicate` (so its own null masking is applied) and test membership per row. This is
   *    the report's "if any residual is a substring/`-i` op, build its bitset and AND instead".
   *
   * Then iterate the lead's set rows; a row survives iff every probeable residual is non-null
   * AND matches, and every non-probeable residual's bitset has the bit. Short-circuits on the
   * first miss. The result is byte-identical to the bitset-AND path (proven by the tests).
   */
  private tryProbeAnd(children: FilterNode[]): Bitset | null {
    // All children must be leaves; a nested group has no cheap count and no probe.
    const leaves: Predicate[] = [];
    for (const child of children) {
      if (!('leaf' in child)) return null;
      leaves.push(child.leaf);
    }

    // Pick the lead: the leaf with the smallest cheap EXACT count under the tiny-lead gate.
    let leadIdx = -1;
    let leadCount = Infinity;
    for (let i = 0; i < leaves.length; i++) {
      const est = this.leadCount(leaves[i]!);
      if (est !== null && est < leadCount) {
        leadCount = est;
        leadIdx = i;
      }
    }
    if (leadIdx === -1) return null;
    // Tiny-lead gate: lead * DENOM <= rowCount * NUM  <=>  lead/rowCount <= NUM/DENOM.
    if (leadCount * PROBE_LEAD_DENOM > this.rowCount * PROBE_LEAD_NUM) return null;

    // Build the residual probes. A residual that can't be probed (substring/`-i`/ordering/null)
    // resolves to a bitset ONCE (with its own null masking) and is membership-tested per row.
    const probes: RowProbe[] = [];
    const probeNullFields: string[] = [];
    const residualBitsets: Bitset[] = [];
    for (let i = 0; i < leaves.length; i++) {
      if (i === leadIdx) continue;
      const p = leaves[i]!;
      const probe =
        p.op === 'null' || p.op === 'notNull'
          ? null
          : this.column(p.field).makeProbe(p.op, p.value);
      if (probe !== null) {
        probes.push(probe);
        probeNullFields.push(p.field);
      } else {
        const bs = new Bitset(this.rowCount);
        this.fillPredicate(p, bs);
        residualBitsets.push(bs);
      }
    }

    // Evaluate the lead leaf to a bitset (already exact + null-masked), then iterate its rows.
    const lead = new Bitset(this.rowCount);
    this.fillPredicate(leaves[leadIdx]!, lead);
    const out = new Bitset(this.rowCount);
    const np = probes.length;
    const nb = residualBitsets.length;
    lead.forEach((row) => {
      for (let j = 0; j < np; j++) {
        // Three-valued logic: a NULL at this residual field is NOT a match (mirrors excludeNulls).
        if (this.isNull(probeNullFields[j]!, row)) return;
        if (!probes[j]!(row)) return;
      }
      for (let j = 0; j < nb; j++) if (!residualBitsets[j]!.get(row)) return;
      out.set(row);
    });
    return out;
  }

  /**
   * A cheap EXACT match count for a leaf when an index makes it O(1)/O(log n), else `null`
   * (unknown — the leaf can't be a probe lead). Used only to pick the most selective lead;
   * gated behind "index already built (not dirty)" so estimating never triggers a rebuild.
   *
   * The count may slightly OVER-count by including NULL sentinel rows (the index groups every
   * row), but that only affects which leaf is chosen as the lead — never the final result, which
   * always re-derives membership from `fillPredicate` + the per-row null check. So an over-count
   * is harmless for correctness; it can at worst skip the probe path (a speed, not a result, knob).
   */
  private leadCount(p: Predicate): number | null {
    if (p.op === 'eq') {
      const eq = this.eqIndexes.get(p.field);
      if (eq === undefined || eq.isDirty()) return null;
      const rows = eq.rows(p.value);
      return rows === undefined ? 0 : rows.length;
    }
    if (p.op === 'in') {
      const eq = this.eqIndexes.get(p.field);
      if (eq === undefined || eq.isDirty()) return null;
      const arr = Array.isArray(p.value) ? p.value : [p.value];
      let total = 0;
      for (const v of arr) {
        const rows = eq.rows(v);
        if (rows !== undefined) total += rows.length;
      }
      return total;
    }
    if (p.op === 'between') {
      const sorted = this.sortedIndexes.get(p.field);
      if (sorted === undefined || sorted.isDirty(this.rowCount)) return null;
      const col = this.column(p.field);
      const raw = p.value as [unknown, unknown];
      if (col instanceof I64Column) {
        return sorted.countRangeBetweenI64(this.i64Bound(col, raw[0]), this.i64Bound(col, raw[1]));
      }
      const isDate = col.type === 'date';
      const lo = isDate ? coerceDate(raw[0]) : (raw[0] as number);
      const hi = isDate ? coerceDate(raw[1]) : (raw[1] as number);
      return sorted.countRangeBetween(lo, hi);
    }
    if (isRangeOp(p.op)) {
      const sorted = this.sortedIndexes.get(p.field);
      if (sorted === undefined || sorted.isDirty(this.rowCount)) return null;
      const col = this.column(p.field);
      if (col instanceof I64Column) {
        return sorted.countRangeI64(p.op, this.i64Bound(col, p.value));
      }
      const isDate = col.type === 'date';
      const bound = isDate ? coerceDate(p.value) : (p.value as number);
      return sorted.countRange(p.op, bound);
    }
    return null;
  }

  /**
   * The CMS read primitive: filter → sort → paginate, returning ordered row ids.
   *
   * Fast path: a single sort key backed by a sorted index walks the index in order and
   * stops once `offset + limit` matches are collected (early termination).
   * Fallback: materialize matching rows and sort them with a column-reading comparator.
   * No sort key: default insertion order, paginated straight off the bitset.
   */
  /**
   * Resolve a query's row-match set, preferring the nested {@link QueryOptions.where} TREE over the
   * flat implicit-AND `filters` list. This is the single place tree-vs-flat is decided, so `query`
   * and the Engine's `total` count stay consistent.
   */
  matchSet(opts: QueryOptions, resolve?: RelationResolver): Bitset {
    if (opts.where !== undefined) return this.scanTree(opts.where, resolve);
    return this.scan(opts.filters ?? []);
  }

  query(opts: QueryOptions = {}, resolve?: RelationResolver): number[] {
    const matches = this.matchSet(opts, resolve);
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? Infinity;
    const sort = opts.sort ?? [];

    if (sort.length === 1) {
      const key = sort[0]!;
      // A single-key ORDER BY uses a sorted index if one exists — numeric/date via `sortedIndexes`,
      // or `string` via `stringSortedIndexes` (be-22c). Both expose the identical ensureBuilt +
      // forEachOrdered surface and the early-termination walk, so the string case is byte-identical
      // in behavior to the numeric case here; only the structure that produces the permutation differs.
      const idx = this.sortedIndexes.get(key.field) ?? this.stringSortedIndexes.get(key.field);
      if (idx !== undefined) {
        idx.ensureBuilt(this.column(key.field), this.rowCount);
        const out: number[] = [];
        let skipped = 0;
        idx.forEachOrdered(key.dir, (row) => {
          if (!matches.get(row)) return true;
          if (skipped < offset) {
            skipped++;
            return true;
          }
          out.push(row);
          return out.length < limit;
        });
        return out;
      }
    }

    if (sort.length > 0) {
      const rows = matches.toArray();
      rows.sort(this.comparator(sort));
      const end = limit === Infinity ? rows.length : offset + limit;
      return rows.slice(offset, end);
    }

    return matches.slice(offset, limit);
  }

  // --- keyset (seek) pagination ------------------------------------------------

  /**
   * The default NULL rule for a sort direction, matching SQL/GitLab keyset convention: NULLs sort
   * FIRST for a DESC key and LAST for an ASC key. (`nullsFirst` means a NULL is the SMALLER value.)
   * Pinning the rule here keeps the composite-index build, the seek, and the cursor sig consistent.
   */
  private nullsFirstFor(dir: SortDir): boolean {
    return dir === 'desc';
  }

  /**
   * Resolve a client sort spec into the full {@link ResolvedSortKey} list for the keyset path:
   * each client key with its sign + null rule, then the appended unique `{ id, asc, nullsLast }`
   * final key (a total order, so the boundary is EXACT). Throws {@link KeysetUnsupportedError} for
   * a missing `id` field or a `json` sort key (never seekable).
   */
  resolveSortKeys(sort: SortKey[]): ResolvedSortKey[] {
    if (!this.columns.has('id')) {
      throw new KeysetUnsupportedError('keyset pagination requires an "id" field for the total-order tie-break');
    }
    // The keyset path treats `id` as a non-null, unique i32 PK throughout (cursor `id` is a JS number;
    // the seek skips the null rule on the id branch). Enforce that invariant so a non-i32 id surfaces
    // as a clean KeysetUnsupportedError (-> 400) rather than a silent mis-seek / mis-serialize.
    if (this.column('id').type !== 'i32') {
      throw new KeysetUnsupportedError('keyset pagination requires an i32 "id" field');
    }
    const out: ResolvedSortKey[] = [];
    for (const s of sort) {
      const col = this.column(s.field); // validates existence
      if (col.type === 'json') {
        throw new KeysetUnsupportedError(`keyset pagination cannot sort on json field "${s.field}"`);
      }
      out.push({ field: s.field, sign: s.dir === 'desc' ? -1 : 1, nullsFirst: this.nullsFirstFor(s.dir) });
    }
    // Append the mandatory unique final tie-break key `id:asc` (nullsLast). If the caller ALREADY
    // sorts by `id`, the appended key is redundant (a second compare on an equal id never changes the
    // order) but is kept so `boundaryOf` always emits exactly `sort.length` sortValues (one per client
    // key) and the cursor `fieldTypes` (also derived from `sort`) stay length-aligned — the appended
    // id is NOT a sortValues slot. A client `id` key is now seeked with its own sign (see
    // CompositeSortedIndex.cmpToBoundary), so the duplicate is harmless, not a correctness hazard.
    out.push({ field: 'id', sign: 1, nullsFirst: false });
    return out;
  }

  /** A stable canonical key for a resolved sort spec (composite-index map key + cursor sig material). */
  static canonicalSortSpec(keys: ResolvedSortKey[]): string {
    return keys.map((k) => `${k.field}:${k.sign === 1 ? 'a' : 'd'}:${k.nullsFirst ? 'nf' : 'nl'}`).join(',');
  }

  /** Capture a row's boundary: its per-client-key sort VALUES (null-aware) + the stable PK id. */
  boundaryOf(row: number, keys: ResolvedSortKey[]): Boundary {
    const sortValues: BoundaryValue[] = [];
    // The last key is the appended id; the client keys are keys[0..n-1].
    for (let k = 0; k < keys.length - 1; k++) {
      const key = keys[k]!;
      if (this.isNull(key.field, row)) {
        sortValues.push(null);
      } else {
        sortValues.push(this.column(key.field).at(row) as BoundaryValue);
      }
    }
    const id = this.column('id').at(row) as number;
    return { sortValues, id };
  }

  /** Fetch (or lazily build, with an LRU cap) the composite index for a resolved sort spec. */
  private compositeIndexFor(keys: ResolvedSortKey[]): CompositeSortedIndex {
    const specKey = Table.canonicalSortSpec(keys);
    let idx = this.compositeIndexes.get(specKey);
    if (idx === undefined) {
      idx = new CompositeSortedIndex();
      // LRU cap: evict the oldest (first-inserted) spec when over the bound.
      if (this.compositeIndexes.size >= MAX_COMPOSITE_INDEXES) {
        const oldest = this.compositeIndexes.keys().next();
        if (!oldest.done) this.compositeIndexes.delete(oldest.value);
      }
      this.compositeIndexes.set(specKey, idx);
    } else {
      // Bump recency (Map insertion order = LRU order).
      this.compositeIndexes.delete(specKey);
      this.compositeIndexes.set(specKey, idx);
    }
    idx.ensureBuilt(this, keys, this.rowCount);
    return idx;
  }

  /**
   * Keyset (seek) pagination: filter -> matchSet, then seek the composite index past the cursor
   * boundary and walk forward (cursor) / backward (before) applying bitset membership with early
   * termination. Returns the page's ordered row ids (ALWAYS ascending sort-presentation order) +
   * the first/last boundaries + has{Next,Previous}Page. Offset/limit are ignored in this mode.
   */
  queryKeyset(opts: QueryOptions, resolve?: RelationResolver): KeysetResult {
    const ks = opts.keyset!;
    const keys = this.resolveSortKeys(opts.sort ?? []);
    const matches = this.matchSet(opts, resolve);
    const idx = this.compositeIndexFor(keys);

    const forward = ks.before === undefined; // `before` => backward; else (cursor or first page) => forward
    const boundary = forward ? (ks.cursor ?? null) : (ks.before ?? null);
    const cursorBoundary: Boundary | null = boundary === null ? null : { sortValues: boundary.sortValues, id: boundary.id };

    const collected: number[] = [];
    const { hasMore } = idx.walk(this, keys, matches, cursorBoundary, forward, ks.pageSize, (row) => {
      collected.push(row);
    });

    // Backward walk collected rows in DESCENDING order; reverse to ascending presentation order.
    const rowIds = forward ? collected : collected.slice().reverse();

    const result: KeysetResult = {
      rowIds,
      hasNextPage: false,
      hasPreviousPage: false,
    };
    if (rowIds.length > 0) {
      result.firstBoundary = this.boundaryOf(rowIds[0]!, keys);
      result.lastBoundary = this.boundaryOf(rowIds[rowIds.length - 1]!, keys);
    }

    if (forward) {
      result.hasNextPage = hasMore;
      // You came from somewhere iff a cursor was supplied (the first page has no predecessor).
      result.hasPreviousPage = ks.cursor !== undefined;
    } else {
      result.hasPreviousPage = hasMore;
      // A `before` request implies a following page existed (you walked back from it).
      result.hasNextPage = true;
    }
    return result;
  }

  /** Build a multi-key comparator that reads column values directly (fallback sort path). */
  private comparator(sort: SortKey[]): (a: number, b: number) => number {
    const keys = sort.map((k) => ({ col: this.column(k.field), sign: k.dir === 'desc' ? -1 : 1 }));
    return (a, b) => {
      for (const k of keys) {
        // bigint widens the cast for an i64/decimal lead key; BigInt `<`/`>` order is exact. (A json
        // column is never sortable — the parser rejects it — so it never reaches the comparator.)
        const va = k.col.at(a) as number | string | boolean | bigint;
        const vb = k.col.at(b) as number | string | boolean | bigint;
        if (va < vb) return -k.sign;
        if (va > vb) return k.sign;
      }
      return 0;
    };
  }

  /**
   * Reconstruct a full row object from its columns (output-side materialization).
   * A field whose null bit is set materializes as `null`, overriding the dense sentinel
   * — so a stored numeric 0 stays 0 while a NULL-marked 0 surfaces as null.
   */
  materialize(row: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of this.fields) {
      if (this.isNull(f.name, row)) {
        out[f.name] = null;
        continue;
      }
      const col = this.columns.get(f.name)!;
      // Type-aware rendering. The serializer (engine.ts) recognizes the RawJson marker and splices its
      // bytes verbatim; every other value (incl. the i64/decimal STRINGS) goes through JSON.stringify.
      switch (col.type) {
        case 'date':
          // epoch-ms -> a stable ISO-8601 UTC string (the form `coerceDate` accepts: materialize ∘ coerce = id).
          out[f.name] = new Date(col.at(row) as number).toISOString();
          break;
        case 'i64':
          // A QUOTED decimal STRING. JSON numbers are only interoperable within ±2^53 (RFC 8259), so a
          // bigint emitted as an unquoted JSON number silently loses precision in a naive client's
          // JSON.parse -> Number. Industry standard (Strapi biginteger, protobuf int64 JSON mapping,
          // Twitter id_str) is a string; JSON.stringify quotes it and `coerceI64` reads it back exactly.
          out[f.name] = (col.at(row) as bigint).toString();
          break;
        case 'decimal':
          // A quoted decimal STRING (formatDecimal, exact), matching the Postgres source-of-truth
          // representation (postgres.js surfaces `numeric` as a string) — JSON.stringify quotes it.
          out[f.name] = formatDecimal(col.at(row) as bigint, (col as I64Column).scale);
          break;
        case 'json':
          // The verbatim raw JSON fragment — spliced unchanged so nested integers > 2^53 and object key
          // order survive byte-exact (NEVER re-parsed/re-stringified).
          out[f.name] = new RawJson(col.at(row) as string);
          break;
        default:
          out[f.name] = col.at(row);
      }
    }
    return out;
  }
}
