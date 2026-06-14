import { Bitset } from './bitset.ts';
import { Table } from './table.ts';

/**
 * A single-hop relation between an OWNER table and a RELATED table, stored as a CSR
 * (compressed-sparse-row) adjacency over EXPLICIT edges `ownerRow -> relatedRow`.
 *
 * Layout (built once from the edge set):
 *
 *   offsets : Int32Array[ownerCount + 1]  — owner `o`'s related rows live in
 *                                           [offsets[o], offsets[o+1]) of `postings`.
 *   postings: Int32Array[edgeCount]       — related row ids, grouped by owner, ascending
 *                                           within each owner's slice.
 *
 * This ONE layout serves BOTH one-to-many and many-to-many: the cardinality is simply how
 * many edges land per owner (and per related row). The filter logic below is identical for
 * either — it never inspects how many edges an owner has, only whether ANY of them hit.
 *
 * Build is the same O(edges) counting sort the `EqIndex` uses: count edges per owner ->
 * prefix-sum into `offsets` -> scatter related ids into `postings`. Two TypedArray allocations
 * total, GC-exempt, cache-sequential — the report's §2.7 "CSR owner->related adjacency, no
 * graph structure, no roaring".
 *
 * --- FILTER SEMANTICS: EXISTS ("some related matches") -----------------------------------
 *
 * {@link ownersMatching} takes a Bitset of matching RELATED rows (produced by running ANY
 * predicate tree on the related Table via its existing `scanTree`) and returns the Bitset of
 * OWNER rows that have AT LEAST ONE related row in that set. This is exactly Strapi's relation
 * filtering semantics: `filter owners where SOME related row satisfies P`. An owner with zero
 * related rows can never match (its CSR slice is empty). An owner matches on the FIRST hit in
 * its slice (short-circuit), so the join is O(edges) worst case, far less when owners hit early.
 *
 * --- NULL / three-valued logic -----------------------------------------------------------
 *
 * Nulls are NOT re-handled here. The related Table's own `scanTree` already applies three-valued
 * logic at its leaves (a NULL related field is excluded BEFORE the bitset reaches us), so by the
 * time a related row's bit is set it is a genuine match. The join is a pure structural OR over
 * the adjacency — it must not second-guess the related table's null masking.
 *
 * --- COMPOSE -----------------------------------------------------------------------------
 *
 * The owner query evaluates its OWN predicate tree to a Bitset and ANDs it (the Slice-0 dense
 * combiner) with `ownersMatching(relatedBitset)`. See {@link Table.scanTree} on the owner table
 * for the owner predicate; the AND is one word-wise `Bitset.and`.
 *
 * --- SCOPE / DOCUMENTED LIMITATIONS (this slice) -----------------------------------------
 *
 *   - SINGLE-HOP only: no nested / deep relation chains (owner -> related -> related-of-related).
 *     A deep filter would compose multiple Relations; that orchestration is out of scope here.
 *   - APPEND-ONLY: edges can be added (via the constructor edge list or {@link link}); there is
 *     NO edge deletion. The CSR is rebuilt lazily from the full pending edge set, so adding edges
 *     after a build is fine, but removing one is not supported this slice.
 */
export class Relation {
  readonly owner: Table;
  readonly related: Table;

  /** Pending edges accumulated since the last build (append-only). */
  private readonly edgeOwners: number[] = [];
  private readonly edgeRelated: number[] = [];
  private dirty = true;

  // Built CSR state.
  private offsets = new Int32Array(1); // [ownerCount + 1]; a 0-owner table is just [0].
  private postings = new Int32Array(0);
  /** Owner row count the CSR was last built at (grows as the owner table grows). */
  private builtOwnerCount = 0;

  /**
   * Construct from an OWNER table, a RELATED table, and an optional initial edge list of
   * `[ownerRow, relatedRow]` pairs. More edges may be added later with {@link link}. The CSR
   * builds lazily on the first query.
   */
  constructor(owner: Table, related: Table, edges: [number, number][] = []) {
    this.owner = owner;
    this.related = related;
    for (const [o, r] of edges) this.link(o, r);
  }

  /**
   * Add one explicit edge `ownerRow -> relatedRow`. Append-only; marks the CSR dirty so the
   * next query rebuilds. Adding the same pair twice records two edges (a duplicate posting),
   * which is harmless for EXISTS semantics — the owner still matches on the first hit.
   */
  link(ownerRow: number, relatedRow: number): void {
    this.edgeOwners.push(ownerRow);
    this.edgeRelated.push(relatedRow);
    this.dirty = true;
  }

  /** Total explicit edge count recorded so far (pre/post build identical). */
  get edgeCount(): number {
    return this.edgeOwners.length;
  }

  /** True if a `link` since the last build means the next query would rebuild. */
  isDirty(): boolean {
    return this.dirty || this.builtOwnerCount !== this.owner.rowCount;
  }

  /**
   * Eagerly (re)build the CSR now — publish-time warm, so the rebuild never lands on the first
   * reader after a publish batch (mirrors `EqIndex.warm` / `SortedIndex` warming).
   */
  warm(): void {
    this.ensureBuilt();
  }

  private ensureBuilt(): void {
    if (this.isDirty()) this.rebuild();
  }

  /**
   * O(edges) counting sort into CSR: count edges per owner -> prefix-sum into `offsets` ->
   * scatter related ids into `postings`. Owners are indexed `[0, ownerCount)`; the owner row
   * count comes from the live owner table so a slice past the last edged owner is empty (its
   * offsets are equal). Walking edges in insertion order makes each owner's postings ascending
   * in related-row id only if edges were added ascending — but EXISTS never needs sorted
   * postings, so we do NOT rely on order (any related row in the slice is a hit).
   */
  private rebuild(): void {
    const ownerCount = this.owner.rowCount;
    const m = this.edgeOwners.length;

    // 1. Count edges per owner.
    const counts = new Int32Array(ownerCount);
    for (let i = 0; i < m; i++) counts[this.edgeOwners[i]!]!++;

    // 2. Prefix-sum into offsets[ownerCount + 1].
    const offsets = new Int32Array(ownerCount + 1);
    for (let o = 0; o < ownerCount; o++) offsets[o + 1] = offsets[o]! + counts[o]!;

    // 3. Scatter related ids into postings grouped by owner.
    const postings = new Int32Array(m);
    const cursor = offsets.slice(0, ownerCount); // mutable copy of group starts
    for (let i = 0; i < m; i++) {
      const o = this.edgeOwners[i]!;
      postings[cursor[o]!] = this.edgeRelated[i]!;
      cursor[o]!++;
    }

    this.offsets = offsets;
    this.postings = postings;
    this.builtOwnerCount = ownerCount;
    this.dirty = false;
  }

  /**
   * EXISTS filter primitive: given a Bitset of matching RELATED rows, return a fresh Bitset
   * (sized to the owner row count) of OWNER rows that have AT LEAST ONE related row in it.
   *
   * Iterate each owner's CSR slice; set the owner bit on the FIRST related row found in
   * `relatedBitset` and stop scanning that owner (short-circuit). O(edges) worst case. An owner
   * with an empty slice (zero related rows) never matches. A related row shared by several owners
   * makes ALL of them match (each owner's slice independently contains that related id).
   */
  ownersMatching(relatedBitset: Bitset): Bitset {
    this.ensureBuilt();
    const out = new Bitset(this.owner.rowCount);
    const offsets = this.offsets;
    const postings = this.postings;
    const ownerCount = this.builtOwnerCount;
    for (let o = 0; o < ownerCount; o++) {
      const end = offsets[o + 1]!;
      for (let i = offsets[o]!; i < end; i++) {
        if (relatedBitset.get(postings[i]!)) {
          out.set(o);
          break; // EXISTS: one hit is enough.
        }
      }
    }
    return out;
  }

  /**
   * Convenience read-side helper: the materialized objects of an owner's related rows (reusing
   * the related Table's own late-materialization). Not on the hot filter path — `ownersMatching`
   * is the load-bearing deliverable — but handy for surfacing the related scalars of a matched
   * owner. Returns one object per edge in this owner's CSR slice.
   */
  materializeRelated(ownerRow: number): Record<string, unknown>[] {
    this.ensureBuilt();
    const out: Record<string, unknown>[] = [];
    const end = this.offsets[ownerRow + 1]!;
    for (let i = this.offsets[ownerRow]!; i < end; i++) {
      out.push(this.related.materialize(this.postings[i]!));
    }
    return out;
  }
}
