import { Bitset } from './bitset.ts';
import {
  coerceDate,
  createColumn,
  StringColumn,
  TextColumn,
  type Column,
  type ColumnType,
  type RowProbe,
  type ScanOp,
} from './column.ts';
import { EqIndex } from './eq-index.ts';
import { SortedIndex, type SortDir } from './sorted-index.ts';

export interface FieldDef {
  name: string;
  type: ColumnType;
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
 */
export type FilterNode =
  | { leaf: Predicate }
  | { op: 'and' | 'or'; children: FilterNode[] }
  | { op: 'not'; children: [FilterNode] };

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
    for (const f of fields) this.columns.set(f.name, createColumn(f.type));
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
    const idx = new EqIndex(col.type === 'bool');
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
   * Sorted index for numeric/temporal range filters and ORDER BY. Numeric ('i32'/'f64') or
   * 'date' fields only — a date column is an f64 epoch-ms column under the hood, so the same
   * order-preserving radix key and binary search apply unchanged (the f64 key path handles it).
   */
  createSortedIndex(field: string): void {
    const col = this.column(field);
    if (col.type !== 'i32' && col.type !== 'f64' && col.type !== 'date') {
      throw new Error(`sorted index requires a numeric or date field, "${field}" is ${col.type}`);
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
      this.columns.get(f.name)!.push(value);
      if (isNull) this.setNull(f.name, rowId);
      const eq = this.eqIndexes.get(f.name);
      if (eq !== undefined) eq.add(value, rowId);
      const sorted = this.sortedIndexes.get(f.name);
      if (sorted !== undefined) sorted.markDirty();
    }
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
    for (const idx of this.eqIndexes.values()) idx.warm();
  }

  /** Test/introspection: true if any index on the table would rebuild on the next read. */
  hasDirtyIndex(): boolean {
    for (const idx of this.sortedIndexes.values()) {
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
        // For a date column the bounds may be Date / ISO / number — coerce them to the same
        // canonical epoch-ms the column stored, so the binary search compares like with like.
        const isDate = this.column(p.field).type === 'date';
        const rawPair = p.value as [unknown, unknown];
        const lo = isDate ? coerceDate(rawPair[0]) : (rawPair[0] as number);
        const hi = isDate ? coerceDate(rawPair[1]) : (rawPair[1] as number);
        sorted.ensureBuilt(this.column(p.field), this.rowCount);
        // Selectivity guard: a wide range matching > ~50% of rows does O(k) SCATTERED `out.set`
        // (random in row-id space), which loses to NumericColumn.scan's branch-predictable
        // sequential O(n) pass. countRange is already O(log n) from the bounds, so estimating is
        // free. Above half the rows, fall back to the linear scan.
        if (sorted.countRangeBetween(lo, hi) * 2 > this.rowCount) {
          this.column(p.field).scan('between', p.value, out);
        } else {
          sorted.fillBitsetBetween(lo, hi, out);
        }
        this.excludeNulls(p.field, out);
        return;
      }
      // No sorted index: one-pass NumericColumn.scan checking lo <= x <= hi.
      this.column(p.field).scan('between', p.value, out);
      this.excludeNulls(p.field, out);
      return;
    }
    if (isRangeOp(p.op)) {
      const sorted = this.sortedIndexes.get(p.field);
      if (sorted !== undefined) {
        // A date column stores epoch-ms; coerce a Date / ISO / number bound to the same ms so the
        // sorted-index probe and the scan-fallback compare against the identical canonical value.
        const isDate = this.column(p.field).type === 'date';
        const bound = isDate ? coerceDate(p.value) : (p.value as number);
        sorted.ensureBuilt(this.column(p.field), this.rowCount);
        // Same >50% selectivity guard as $between: a non-selective range scatters more than it
        // saves, so fall back to the sequential scan when the slice exceeds half the rows.
        if (sorted.countRange(p.op, bound) * 2 > this.rowCount) {
          this.column(p.field).scan(p.op, p.value, out);
        } else {
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
  scanTree(node: FilterNode): Bitset {
    if ('leaf' in node) {
      const out = new Bitset(this.rowCount);
      this.fillPredicate(node.leaf, out);
      return out;
    }

    if (node.op === 'not') {
      return this.scanTree(node.children[0]).not(this.rowCount);
    }

    if (node.op === 'or') {
      const acc = new Bitset(this.rowCount); // empty OR = no rows
      for (const child of node.children) acc.or(this.scanTree(child));
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
    // narrows the accumulator fastest). Identical results to the probe path above.
    const evaluated = node.children.map((c) => this.scanTree(c));
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
      const isDate = this.column(p.field).type === 'date';
      const raw = p.value as [unknown, unknown];
      const lo = isDate ? coerceDate(raw[0]) : (raw[0] as number);
      const hi = isDate ? coerceDate(raw[1]) : (raw[1] as number);
      return sorted.countRangeBetween(lo, hi);
    }
    if (isRangeOp(p.op)) {
      const sorted = this.sortedIndexes.get(p.field);
      if (sorted === undefined || sorted.isDirty(this.rowCount)) return null;
      const isDate = this.column(p.field).type === 'date';
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
  matchSet(opts: QueryOptions): Bitset {
    if (opts.where !== undefined) return this.scanTree(opts.where);
    return this.scan(opts.filters ?? []);
  }

  query(opts: QueryOptions = {}): number[] {
    const matches = this.matchSet(opts);
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? Infinity;
    const sort = opts.sort ?? [];

    if (sort.length === 1 && this.sortedIndexes.has(sort[0]!.field)) {
      const key = sort[0]!;
      const idx = this.sortedIndexes.get(key.field)!;
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

    if (sort.length > 0) {
      const rows = matches.toArray();
      rows.sort(this.comparator(sort));
      const end = limit === Infinity ? rows.length : offset + limit;
      return rows.slice(offset, end);
    }

    return matches.slice(offset, limit);
  }

  /** Build a multi-key comparator that reads column values directly (fallback sort path). */
  private comparator(sort: SortKey[]): (a: number, b: number) => number {
    const keys = sort.map((k) => ({ col: this.column(k.field), sign: k.dir === 'desc' ? -1 : 1 }));
    return (a, b) => {
      for (const k of keys) {
        const va = k.col.at(a) as number | string | boolean;
        const vb = k.col.at(b) as number | string | boolean;
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
      // A date column stores epoch-ms; round-trip it back to a stable, documented ISO-8601 UTC
      // string (the same form `coerceDate` accepts), so materialize ∘ coerce is the identity.
      out[f.name] = col.type === 'date' ? new Date(col.at(row) as number).toISOString() : col.at(row);
    }
    return out;
  }
}
