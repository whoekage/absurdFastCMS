/**
 * Trigram (3-gram) inverted index over dictionary CODES, the build-on-publish substring
 * accelerator of report §2.5. It accelerates `$contains*` on contains-heavy / large-distinct
 * string columns; the deduped-dictionary brute scan (`StringColumn.scanBrute`) stays the
 * mandatory verification + fallback floor and the default for unflagged columns.
 *
 * ── Shape ────────────────────────────────────────────────────────────────────────────────
 * For each distinct dictionary string (addressed by its dense code), we extract every
 * contiguous 3-unit window of its (raw or folded) text and post the CODE under that trigram.
 * Posting lists are stored as a sorted `Int32Array` per trigram (codes ascending, deduped —
 * a code appears at most once per trigram even if the trigram repeats in the string), packed
 * into a single CSR-style flat buffer so there is no `Map<trigram, number[]>` GC graph.
 *
 *   trigramOf   : Map<string, number>   — trigram string -> dense trigram id [0, T)
 *   offsets     : Int32Array[T + 1]      — codes for trigram id `g` live in [offsets[g], offsets[g+1])
 *   postings    : Int32Array[totalPostings] — dict codes, grouped by trigram id, ascending within each
 *
 * ── Trigram unit ─────────────────────────────────────────────────────────────────────────
 * The unit is a UTF-16 code unit (a JS string index step), chosen CONSISTENTLY for both build
 * and query. A surrogate pair therefore spans code units, so a trigram may straddle half a
 * surrogate — that is fine: it only changes candidate GRANULARITY, never correctness, because
 * every candidate is re-verified with the SAME `includes()` the brute path uses. Over-generating
 * candidates is acceptable; under-generating (missing a real match) would be a bug, and the
 * trigram cover of any substring of length >= 3 is a strict subset of the value's trigrams, so
 * intersection never drops a real match.
 *
 * ── Query (codes-only; row expansion + null masking stay at the Table/column boundary) ─────
 * `candidateCodes(needle)` returns either:
 *   - `null`  => "cannot accelerate, fall back to the full dictionary brute scan" — emitted when
 *               `needle.length < 3` (no trigram) OR any needle trigram is ABSENT from the index
 *               (absent trigram => zero values can contain the needle, but we still defer to the
 *               brute floor so the verification contract is uniform), and
 *   - an array of candidate codes otherwise: the intersection of the RAREST few needle-trigram
 *     postings. These are a SUPERSET of the true matches (false positives possible), so the
 *     caller MUST verify each candidate with the exact same predicate (`dict[code].includes`)
 *     before accepting it. That verification is what makes the accelerator byte-identical to
 *     brute regardless of trigram granularity.
 */

/** Minimum needle length that yields a trigram; shorter needles fall back to the brute scan. */
export const MIN_TRIGRAM_LEN = 3;

/**
 * How many of the rarest needle trigrams to intersect. Intersecting the rarest postings first
 * shrinks the candidate set fastest (Lucene's lead-with-the-sparsest-posting heuristic); every
 * additional trigram only ever removes candidates, so using a bounded few keeps the intersection
 * cheap while `includes()`-verification removes whatever false positives the cap lets through.
 */
const MAX_INTERSECT_TRIGRAMS = 3;

/**
 * The unit a posting addresses. For a {@link StringColumn} this is a dictionary CODE (the dedup
 * key); for a {@link TextColumn} it is a ROW ID directly (bodies are near-unique, no dict). The
 * index is agnostic — it only ever stores and intersects ascending ints — so the SAME structure
 * serves both; the only difference is what the caller VERIFIES the returned candidates against
 * (`dict[code].includes` for StringColumn, an arena-decode of the row for TextColumn).
 *
 * `(i) => space[i]` for an in-memory string[] (StringColumn dict / folded dict); an arena-decode
 * closure `(row) => decodeFold(row)` for TextColumn, so the body text is materialized ONLY during
 * the (transient) build pass and never pinned in a heap dictionary.
 */
export type TextAccessor = (index: number) => string;

export class SubstringIndex {
  /** trigram string -> dense trigram id. The query side resolves needle trigrams through this. */
  private readonly trigramOf = new Map<string, number>();
  /** CSR group offsets: postings for trigram id `g` are [offsets[g], offsets[g+1]). */
  private offsets = new Int32Array(1);
  /** CSR postings: dict codes, grouped by trigram id, ascending (and deduped) within each group. */
  private postings = new Int32Array(0);

  /**
   * Build the index from the deduped dictionary `space` (the RAW dict for case-sensitive
   * `$contains`, the FOLDED dict for `$containsi`). `space[code]` is the text for that code.
   * Thin wrapper over {@link SubstringIndex.over}: a string[] is just a count + index accessor.
   */
  constructor(space: readonly string[]) {
    this.build(space.length, (i) => space[i]!);
  }

  /**
   * Generic factory: build over `count` entries, each entry's text fetched lazily via `accessor`.
   * For a TextColumn the accessor decodes (and, for the folded index, folds) the row's bytes from
   * the off-heap arena, so the only string objects created are the transient per-row decode during
   * this build pass — there is NO persistent heap dictionary of bodies. Postings are therefore the
   * accessor INDEX (= row id), and the caller verifies each candidate by decoding it from the arena.
   */
  static over(count: number, accessor: TextAccessor): SubstringIndex {
    const idx = Object.create(SubstringIndex.prototype) as SubstringIndex;
    // The fields are initialized by build(); seed the Map (a class field initializer the bypassed
    // constructor would normally run).
    (idx as unknown as { trigramOf: Map<string, number> }).trigramOf = new Map<string, number>();
    idx.build(count, accessor);
    return idx;
  }

  /**
   * Shared two-pass CSR build. O(total text length): a counting pass to size each trigram's group,
   * then a scatter pass. Deduping an entry within a trigram group uses a per-trigram "last entry
   * written" cursor, which works because each entry's trigrams are emitted contiguously (we scan
   * entry-by-entry). `accessor(i)` yields entry `i`'s text (already raw or folded by the caller).
   */
  private build(count: number, accessor: TextAccessor): void {
    const d = count;

    // Pass 1: intern every distinct trigram and COUNT distinct (trigram, entry) pairs. We count an
    // entry at most once per trigram (a trigram repeating in one string posts that entry once), so
    // we track, per trigram id, the last entry that contributed to its count.
    const counts: number[] = [];
    const lastCounted: number[] = [];
    for (let code = 0; code < d; code++) {
      const s = accessor(code);
      const limit = s.length - MIN_TRIGRAM_LEN;
      for (let i = 0; i <= limit; i++) {
        const g = s.slice(i, i + MIN_TRIGRAM_LEN);
        let gid = this.trigramOf.get(g);
        if (gid === undefined) {
          gid = counts.length;
          this.trigramOf.set(g, gid);
          counts.push(0);
          lastCounted.push(-1);
        }
        if (lastCounted[gid] !== code) {
          lastCounted[gid] = code;
          counts[gid]!++;
        }
      }
    }
    const t = counts.length;

    // Prefix-sum into CSR offsets[t + 1].
    const offsets = new Int32Array(t + 1);
    for (let g = 0; g < t; g++) offsets[g + 1] = offsets[g]! + counts[g]!;
    const total = t === 0 ? 0 : offsets[t]!;
    const postings = new Int32Array(total);

    // Pass 2: scatter entries into their trigram groups, ascending within each group for free
    // (entries are visited in increasing order). Re-dedupe with the same per-trigram last-entry
    // cursor so each (trigram, entry) lands exactly once, matching the counted sizes.
    const cursor = offsets.slice(0, t); // mutable group write heads
    const lastWritten: number[] = new Array(t).fill(-1);
    for (let code = 0; code < d; code++) {
      const s = accessor(code);
      const limit = s.length - MIN_TRIGRAM_LEN;
      for (let i = 0; i <= limit; i++) {
        const gid = this.trigramOf.get(s.slice(i, i + MIN_TRIGRAM_LEN))!;
        if (lastWritten[gid] !== code) {
          lastWritten[gid] = code;
          postings[cursor[gid]!] = code;
          cursor[gid]!++;
        }
      }
    }

    this.offsets = offsets;
    this.postings = postings;
  }

  /** Distinct trigram count — build introspection (a real seam, not a mock). */
  get trigramCount(): number {
    return this.trigramOf.size;
  }

  /**
   * Candidate dict codes for `needle`, or `null` to signal "fall back to the brute scan".
   *
   * Returns `null` when `needle.length < 3` (no trigram to key on) or when ANY of the needle's
   * trigrams is absent from the index. Otherwise it intersects the RAREST few needle-trigram
   * postings and returns the resulting candidate codes — a SUPERSET of the real matches, which
   * the caller must `includes()`-verify. An empty array is a valid answer (the trigrams exist
   * but never co-occur in one value), distinct from `null` (defer to brute).
   */
  candidateCodes(needle: string): number[] | null {
    return this.candidates(needle);
  }

  /**
   * Generic candidate-entry lookup. Returns ascending candidate entry IDs (dict codes for a
   * StringColumn, row ids for a TextColumn) or `null` to signal "fall back to the brute scan".
   * Identical semantics to {@link candidateCodes}; named neutrally for the row-id (TextColumn) path.
   */
  candidates(needle: string): number[] | null {
    if (needle.length < MIN_TRIGRAM_LEN) return null;

    // Collect the DISTINCT trigrams of the needle and resolve each to its posting slice. Any
    // absent trigram means no value can contain the needle (its 3-gram cover can't be matched),
    // so we hand off to the brute floor rather than guessing.
    const seen = new Set<string>();
    const slices: { start: number; end: number; len: number }[] = [];
    const limit = needle.length - MIN_TRIGRAM_LEN;
    for (let i = 0; i <= limit; i++) {
      const g = needle.slice(i, i + MIN_TRIGRAM_LEN);
      if (seen.has(g)) continue;
      seen.add(g);
      const gid = this.trigramOf.get(g);
      if (gid === undefined) return null; // absent trigram -> defer to brute scan.
      const start = this.offsets[gid]!;
      const end = this.offsets[gid + 1]!;
      slices.push({ start, end, len: end - start });
    }

    // Intersect the rarest postings first (smallest list bounds the candidate count). Sort the
    // slices ascending by length, then intersect up to MAX_INTERSECT_TRIGRAMS of them; the
    // remaining trigrams' filtering is subsumed by includes()-verification at the caller.
    slices.sort((a, b) => a.len - b.len);
    let candidates = this.sliceToArray(slices[0]!);
    for (let s = 1; s < slices.length && s < MAX_INTERSECT_TRIGRAMS && candidates.length > 0; s++) {
      candidates = this.intersectSorted(candidates, slices[s]!);
    }
    return candidates;
  }

  /**
   * COST GUARD (additive; no allocation). Returns a TIGHT UPPER BOUND on the post-intersection
   * candidate count for `needle` — the length of its RAREST constituent trigram posting — WITHOUT
   * materializing or intersecting any posting. The intersection of the needle's trigram postings is
   * a subset of its smallest member, so `min(posting length)` >= the true candidate count; if that
   * minimum already exceeds an affordable fraction of N, the index cannot beat the brute floor and
   * the caller should defer to brute.
   *
   * Mirrors the {@link candidates} resolve loop EXACTLY (same `needle.length < 3` and absent-trigram
   * `null` defer contract), so it preserves the identical "cannot accelerate" routing — it only adds
   * a cheap pre-check. O(needle.length) Map lookups + int subtracts; no `sliceToArray`/`intersectSorted`.
   *
   * Returns `null` (defer to brute, same as {@link candidates}) when `needle.length < 3` or any
   * trigram is absent; otherwise the minimum posting length over the needle's distinct trigrams.
   */
  minPostingLen(needle: string): number | null {
    if (needle.length < MIN_TRIGRAM_LEN) return null;
    const seen = new Set<string>();
    const limit = needle.length - MIN_TRIGRAM_LEN;
    let min = Infinity;
    for (let i = 0; i <= limit; i++) {
      const g = needle.slice(i, i + MIN_TRIGRAM_LEN);
      if (seen.has(g)) continue;
      seen.add(g);
      const gid = this.trigramOf.get(g);
      if (gid === undefined) return null; // absent trigram -> defer to brute (same as candidates()).
      const len = this.offsets[gid + 1]! - this.offsets[gid]!;
      if (len < min) min = len;
    }
    return min === Infinity ? null : min;
  }

  /** Copy a posting slice (ascending sorted codes) into a plain array seed for intersection. */
  private sliceToArray(slice: { start: number; end: number }): number[] {
    const out: number[] = [];
    const p = this.postings;
    for (let i = slice.start; i < slice.end; i++) out.push(p[i]!);
    return out;
  }

  /**
   * Intersect an ascending `candidates` array with a sorted posting slice via a linear two-pointer
   * merge (both sides ascending), returning the common codes. O(|candidates| + |slice|).
   */
  private intersectSorted(candidates: number[], slice: { start: number; end: number }): number[] {
    const p = this.postings;
    const out: number[] = [];
    let i = 0;
    let j = slice.start;
    const end = slice.end;
    while (i < candidates.length && j < end) {
      const a = candidates[i]!;
      const b = p[j]!;
      if (a === b) {
        out.push(a);
        i++;
        j++;
      } else if (a < b) {
        i++;
      } else {
        j++;
      }
    }
    return out;
  }
}
