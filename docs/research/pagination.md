# Pagination strategy — research + decisions (June 2026)

Multi-agent research (4 angles → synthesis → adversarial fact-check). Verdict: core recommendation
**SOUND, high confidence**, with corrections (below). Our read path is an IN-MEMORY columnar engine, NOT
SQL — so SQL "offset is evil" does not transfer directly.

## Decision: HYBRID — keep OFFSET as the default, add an OPT-IN opaque keyset cursor

OFFSET is NOT a problem for us: it's an in-RAM O(offset) walk over the sorted index testing the filter
bitset (~1.68 ms @ offset 500k). It stays the default and remains fully Strapi-compatible
(page/pageSize + start/limit + withCount). Keyset is added as a non-breaking third mode, worth it for:

1. **Concurrent-write stability (headline win for us).** Every write rebuilds the per-type engine and
   re-densifies row ids, so an OFFSET cursor points at a *different* logical row after any write. A keyset
   cursor anchors to (sort values + the stable Postgres PK `id`), which survives the rebuild — the dense
   row index does NOT, and must never be encoded.
2. **Unbounded forward scroll.** N sequential offset pages re-walk 0..offset each (quadratic); keyset is
   O(log n + pageSize) per page regardless of depth.

**Bonus SQL keyset can't match:** we keep `total`/`pageCount` free via a bitset popcount (verified in
engine.assemble: total = matchSet.count()). Relay/Stripe drop total because SQL COUNT is a second scan;
JSON:API confirms total MAY accompany a cursor. So our keyset returns total AND hasNextPage/endCursor.

Sources: use-the-index-luke.com/no-offset (offset = algorithmic discard + drift), Relay Cursor
Connections spec (opaque cursors, pageInfo), Stripe API pagination (limit + starting_after/ending_before
+ has_more, no total), JSON:API cursor profile, GitLab keyset_pagination (mixed-direction + NULLs + PK
tie-break), Strapi v5 sort-pagination (no native cursor).

## Keyset algorithm (over sorted-index + filter bitset)

- Single key ASC: `pos = lowerBound(values, cursor.sortVal)`; forward-walk from pos, skip the already-seen
  tie-break group (`v == cursor.sortVal && pk <= cursor.pkId`), test bitset membership, collect `limit`,
  peek one extra → `hasNextPage`. Complexity O(log n + limit + skipped-non-matches), depth-independent.
  DESC mirrors via forEachOrdered(DESC) from upperBound.
- Multi-key: lexicographic tuple seek; the FIRST key drives the binary search, remaining keys + PK
  evaluated per-row by a per-key-direction comparator (NOT a single tuple `>` — that's only valid for
  uniform direction; mixed asc/desc needs the OR-of-AND, applied as a comparator). PK `id` is the final
  key → total order.
- NULL: per the field's null rule; in THIS engine NULL is a sentinel + a separate null bitset (NOT a
  contiguous boundary block), so NULL-ordered seek must consult the null bitset explicitly.

## Cursor token

`base64url(JSON{ v, sig, sortValues:[...], id })`. Encodes the boundary row's sort-tuple values + the
stable Postgres PK `id` + a `sig = hash(sortKeys+directions+nullOrdering+filterShape+schemaVersion)` +
a version tag. NEVER the dense in-RAM row index. Opaque to clients. Recommend an HMAC so the token is
tamper-evident (it's decodable base64, so the PK leaks — acceptable, but sign it). A cursor whose `sig`
mismatches the live request's sort/filter → HTTP 400 invalid-cursor.

## API shape (additive third mode)

- Forward: `pagination[cursor]=<opaque>&pagination[pageSize]=25&sort=...&filters[...]`
- Backward: `pagination[before]=<opaque>` (mutually exclusive with cursor; Stripe-style)
- meta.pagination: `{ pageSize, total, pageCount, nextCursor, prevCursor, hasNextPage, hasPreviousPage }`
  (total/pageCount gated by withCount). Existing offset modes stay verbatim.

## Edge cases

deleted cursor row → seek by VALUE lands at the next match (PK is tie-break, not seek key); page beyond
end → empty data, hasNextPage=false; cursor under different sort/filter → 400 (sig mismatch);
write-then-page → keyset re-seeks correctly (the differentiator vs offset drift).

## Verdict corrections (apply these)

- **SUBSTRATE GAP (impl cost):** there is NO composite multi-key sorted index. Verified in table.ts: the
  forEachOrdered early-termination path fires ONLY for sort.length === 1; multi-key sort falls back to a
  full O(n log n) comparator sort. So SINGLE-KEY keyset is cheap (index already supports it); MULTI-KEY
  keyset needs new infrastructure (a composite sorted index, or first-key index + O(1) rowId→other-key
  value lookups). SortedIndex.lowerBound/upperBound are PRIVATE + numeric/i64 only; forEachOrdered has no
  cursor-seek param. PK lookup is rowIdByEq('id') (value→row); the reverse (row→pk) reads the id column.
- NULLs are sentinel + null bitset, not a contiguous boundary block (correct comparator logic, wrong
  substrate claim).
- Miscitations (cosmetic): jOOQ does NOT state the mixed-direction rule (use GitLab); Relay spec requires
  opacity but does NOT recommend base64; Stripe cursors are RAW object ids, not opaque encoded tokens.

## Recommended scope

v1 = SINGLE sort-key forward keyset (cheap on the existing index) + opaque HMAC cursor + kept total +
sig-bound 400. Multi-key keyset (needs a composite sorted index) and backward `before` walk = follow-ups.
