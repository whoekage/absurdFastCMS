import type { Bitset } from './bitset.ts';
import type { Table } from './table.ts';

/**
 * A scalar boundary value, lossless across the engine's column types:
 *   - number   : i32 / f64 / date (epoch-ms)
 *   - bigint   : i64 / decimal (mantissa)
 *   - string   : string / text
 *   - boolean  : bool
 *   - null     : the boundary row was NULL on that key
 */
export type BoundaryValue = number | bigint | string | boolean | null;

/**
 * The boundary a cursor anchors to: the sort-tuple VALUES of the boundary row (one per
 * client sort key, in order) plus the stable Postgres PK `id`. NEVER a dense row index.
 */
export interface Boundary {
  sortValues: BoundaryValue[];
  id: number;
}

/**
 * One resolved sort key for the composite index: a field, a sign (1=asc, -1=desc), and the
 * NULL ordering rule (nullsFirst => a NULL is the SMALLER value; else the LARGER). The final
 * appended key is always `{ field: 'id', sign: 1, nullsFirst: false }` — a unique total order.
 */
export interface ResolvedSortKey {
  field: string;
  sign: 1 | -1;
  nullsFirst: boolean;
}

/**
 * A MULTI-KEY, seekable sorted index — the substrate the single-column {@link SortedIndex} lacks.
 *
 * Holds ONE `Int32Array rows` permutation of `[0, rowCount)`, ordered by the full resolved sort
 * spec (the client sort keys + the appended unique `id:asc`). Built by a STABLE comparator sort
 * that reproduces `Table.comparator`'s per-key `va<vb ? -sign : va>vb ? sign : 0` EXACTLY, plus
 * the per-key NULL rule applied first (off the Table's null bitset), plus the unique `id` tail.
 *
 * Seeks to a cursor {@link Boundary} with a per-key-direction comparator (the OR-of-AND — valid
 * for MIXED asc/desc, unlike a single tuple `>`), then walks forward/backward applying filter
 * bitset membership with early termination at `pageSize + 1` (peek-one-extra => hasMore).
 *
 * Built lazily per (sort-spec) like {@link SortedIndex}; rebuilt on write (markDirty). Because a
 * write swaps a FRESH `Table` via `Engine.replaceType`, a rebuilt engine starts with empty
 * composite indexes — no stale rows survive a rebuild.
 */
export class CompositeSortedIndex {
  private rows = new Int32Array(0);
  private len = 0;
  private dirty = true;

  markDirty(): void {
    this.dirty = true;
  }

  isDirty(rowCount: number): boolean {
    return this.dirty || this.len !== rowCount;
  }

  ensureBuilt(table: Table, keys: ResolvedSortKey[], rowCount: number): void {
    if (this.dirty || this.len !== rowCount) this.rebuild(table, keys, rowCount);
  }

  private rebuild(table: Table, keys: ResolvedSortKey[], rowCount: number): void {
    // Pre-read per-key flat value + null arrays ONCE (avoid the virtual col.at in the hot
    // comparator), mirroring SortedIndex.rebuild. Values are TRANSIENT (GC'd after the sort);
    // only the `rows` permutation (4 bytes/row) is retained.
    const nk = keys.length;
    const vals: (number | bigint | string | boolean)[][] = new Array(nk);
    const nulls: Uint8Array[] = new Array(nk);
    for (let k = 0; k < nk; k++) {
      const key = keys[k]!;
      const col = table.column(key.field);
      const v = new Array<number | bigint | string | boolean>(rowCount);
      const nb = new Uint8Array(rowCount);
      for (let r = 0; r < rowCount; r++) {
        v[r] = col.at(r) as number | bigint | string | boolean;
        if (table.isNull(key.field, r)) nb[r] = 1;
      }
      vals[k] = v;
      nulls[k] = nb;
    }

    const cmpRows = (a: number, b: number): number => {
      for (let k = 0; k < nk; k++) {
        const key = keys[k]!;
        const an = nulls[k]![a]!;
        const bn = nulls[k]![b]!;
        if (an !== 0 || bn !== 0) {
          if (an !== 0 && bn !== 0) continue; // both null on this key => tie
          // one null: nullsFirst => null is smaller, else null is larger.
          const nullIsSmaller = key.nullsFirst;
          if (an !== 0) return nullIsSmaller ? -1 : 1;
          return nullIsSmaller ? 1 : -1;
        }
        const va = vals[k]![a]!;
        const vb = vals[k]![b]!;
        if (va < vb) return -key.sign;
        if (va > vb) return key.sign;
      }
      return 0; // unreachable: the last key is the unique id => total order.
    };

    const idx = new Array<number>(rowCount);
    for (let r = 0; r < rowCount; r++) idx[r] = r;
    idx.sort(cmpRows);
    const rows = new Int32Array(rowCount);
    for (let i = 0; i < rowCount; i++) rows[i] = idx[i]!;

    this.rows = rows;
    this.len = rowCount;
    this.dirty = false;
  }

  /**
   * Sorted-order sign of (row vs boundary): -1 if `row` sorts before the boundary, +1 after,
   * 0 iff `row` IS the boundary row (same id). Uses the per-key DIRECTION comparator (signs
   * already applied) — correct for MIXED asc/desc, where a uniform tuple `>` would be wrong.
   */
  private cmpToBoundary(table: Table, keys: ResolvedSortKey[], row: number, boundary: Boundary): number {
    const nk = keys.length;
    for (let k = 0; k < nk; k++) {
      const key = keys[k]!;
      if (key.field === 'id') {
        // The `id` key (whether the appended unique tie-break OR a client `id` sort key): compare
        // the row's id value against the boundary id, APPLYING `key.sign` exactly as `cmpRows` does
        // in the build — otherwise a client `id:desc` key would seek ascending while the index is
        // ordered descending, skipping/duplicating rows. The appended key has sign +1 (ascending
        // tie-break), so its behavior is unchanged. `id` is the non-null, unique Postgres serial PK,
        // so the null rule legitimately does not apply on this branch (invariant enforced by
        // resolveSortKeys, which requires an `id` field and asserts it is i32).
        const rid = table.column('id').at(row) as number;
        if (rid < boundary.id) return -key.sign;
        if (rid > boundary.id) return key.sign;
        continue;
      }
      const rNull = table.isNull(key.field, row);
      const bVal = boundary.sortValues[k]!;
      const bNull = bVal === null;
      if (rNull || bNull) {
        if (rNull && bNull) continue; // both null on this key => tie
        const nullIsSmaller = key.nullsFirst;
        if (rNull) return nullIsSmaller ? -1 : 1;
        return nullIsSmaller ? 1 : -1;
      }
      const rv = table.column(key.field).at(row) as number | bigint | string | boolean;
      // bVal is a non-null scalar of the matching type (number/bigint/string/boolean).
      if (rv < (bVal as typeof rv)) return -key.sign;
      if (rv > (bVal as typeof rv)) return key.sign;
    }
    return 0;
  }

  /**
   * BINARY-SEARCH the boundary position in the sorted permutation, then walk in sorted order,
   * emitting up to `pageSize` rows that pass the filter `matches` bitset, peeking one extra to set
   * `hasMore`.
   *
   *  - forward=true  : rows STRICTLY AFTER the boundary, ascending walk from the seek point.
   *  - forward=false : rows STRICTLY BEFORE the boundary, descending walk; the caller reverses the
   *                    collected page back into ascending presentation order.
   *  - boundary=null : first page — start at head (forward) / tail (backward), no seek.
   *
   * `cmpToBoundary(row)` is MONOTONIC along the sorted `rows` (negative before the boundary's order
   * position, 0 at the boundary row if present, positive after), so the start index is a binary
   * search — even when the boundary row was DELETED (no 0 exists; the search still lands at the first
   * row after where it would sort). Because the appended `id` is unique the boundary is EXACT: no row
   * is duplicated or skipped across a tie group of any size. Cost is O(log n + page + skipped-non-
   * matches) — DEPTH-INDEPENDENT (no linear scan-and-discard to reach a deep cursor).
   */
  walk(
    table: Table,
    keys: ResolvedSortKey[],
    matches: Bitset,
    boundary: Boundary | null,
    forward: boolean,
    pageSize: number,
    onRow: (row: number) => void,
  ): { hasMore: boolean } {
    const rows = this.rows;
    const len = this.len;
    let collected = 0;
    let hasMore = false;

    const consume = (row: number): boolean => {
      if (!matches.get(row)) return true; // filtered out — keep walking.
      if (collected === pageSize) {
        hasMore = true;
        return false; // peek-one-extra: a further match exists => stop.
      }
      onRow(row);
      collected++;
      return true;
    };

    if (forward) {
      // First index strictly AFTER the boundary (cmp > 0); 0 when boundary is null (head).
      const start = boundary === null ? 0 : this.firstIndexWith(table, keys, boundary, /* strictlyAfter */ true);
      for (let i = start; i < len; i++) if (!consume(rows[i]!)) break;
    } else {
      // Walk descending from the last index strictly BEFORE the boundary: that is (firstIndexWith
      // cmp >= 0) - 1; when boundary is null start at the tail.
      const start = boundary === null ? len - 1 : this.firstIndexWith(table, keys, boundary, /* strictlyAfter */ false) - 1;
      for (let i = start; i >= 0; i--) if (!consume(rows[i]!)) break;
    }
    return { hasMore };
  }

  /**
   * Binary search over the sorted permutation for the first index `i` whose row sorts at-or-after
   * the boundary: with `strictlyAfter` the predicate is `cmpToBoundary > 0` (first row strictly
   * after — the forward seek); otherwise `cmpToBoundary >= 0` (first row at-or-after — used to derive
   * the backward seek's "last strictly before" as the index just below). Valid because cmpToBoundary
   * is monotonic non-decreasing along `rows`.
   */
  private firstIndexWith(table: Table, keys: ResolvedSortKey[], boundary: Boundary, strictlyAfter: boolean): number {
    const rows = this.rows;
    let lo = 0;
    let hi = this.len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const c = this.cmpToBoundary(table, keys, rows[mid]!, boundary);
      const passed = strictlyAfter ? c > 0 : c >= 0;
      if (passed) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }
}
