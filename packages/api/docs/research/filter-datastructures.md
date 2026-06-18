# absurdFastCMS — Read-Layer Filter Engine: Per-Operator Data-Structure Routing

> An in-process, columnar, in-RAM read layer for a Strapi-5-style filter API (~24 operators).
> Postgres is the write source of truth; this layer is **read-mostly** (publish rarely, read constantly).
> Node.js 24 + TypeScript (native type-stripping). Zero native dependencies.

## 0. Thesis

The headline finding of the adversarial review is uncomfortable but load-bearing: **the bottleneck is not the index shape, it is the missing wiring.** Reading the actual source:

- `Table.scan` (`src/store/table.ts:130`) is **AND-only** — `result.and(scratch)` in a loop. There is **no `or()` or `andNot()` call site anywhere in the query path**, even though `Bitset` already implements them (`bitset.ts:49,58`).
- `ScanOp` (`column.ts:6`) is only `eq | ne | gt | gte | lt | lte`.
- `StringColumn.scan` **throws** on anything but `eq`/`ne` (`column.ts:158`).
- There is **no null representation** anywhere: `insert()` throws on a missing field (`table.ts:84`), `NumericColumn` can't distinguish NULL from 0, `StringColumn.at` would crash on a hole.
- There is **no case-folding** anywhere.

So `$or`, `$not`, `$in`, `$notIn`, `$null`, `$notNull`, `$eqi`, `$nei`, `$contains*`, `$startsWith*`, `$endsWith*` — **18 of 24 operators — do not exist today.** Picking a clever index without the OR/ANDNOT combiner and a null bitset ships nothing. This report routes each operator to its theoretically-optimal *and* practically-fastest structure, but the build plan front-loads the wiring.

The second finding: **simple wins in V8.** Every place we tested a fancier structure (RangeBitmap/BSI, Elias-Fano, FST, suffix automaton, flat-byte `Buffer.indexOf`, roaring) it lost to constant factors, GC, or an N-API boundary. The recurring reason is that the dense `Uint32Array` bitset and the flat `Int32Array` are the *best* shapes TurboFan compiles, and a dictionary already in RAM collapses the search space from N rows to D distinct values.

---

## 1. Shared substrate (what every operator reuses)

| Layer | Choice | Why |
|---|---|---|
| String search space | **Dictionary encoding** — `codes:Int32Array` is the source of truth | Equality compares ints; substring/affix scan the **deduped** dictionary (D≪N), not rows |
| Result / combine | **Dense `Uint32Array` Bitset**, word-wise AND/OR/ANDNOT — **not roaring** | Flat ArrayBuffer, monomorphic, branch-free, no boxing, no N-API boundary. At 1e4–1e7 rows a plane is 1.25 KB–1.25 MB |
| Equality payload | **Per-column tier by c/n**: dense planes (low-card) / **flat CSR postings** (mid-high) / dict-Map (near-unique) | One allocation, GC-exempt, cache-sequential; never `Map<value, number[]>` |
| Case-insensitivity | **Parallel folded dictionary**, `fold = casefold(NFKC(s))` applied **once at intern** | No per-row, no per-query folding |
| Nulls | **Per-column null Bitset** (a new primitive) | `$ne`/`$notIn`/`$notNull` must ANDNOT it for correct SQL semantics |
| Output | **Late materialization** from pre-serialized JSON Buffers | `res.send(bytes)`, no per-request `JSON.stringify` |
| Planning | **Selectivity-ordered AND** over exact counts already in the store | `HashIndex` bucket length / dict counts; `SortedIndex.countRange` |

### Why not Roaring (for *all* dimensions)

Lemire's own record states an uncompressed bitset that fits in RAM beats compressed bitmaps on dense data ([roaringbitmap.org/about](https://roaringbitmap.org/about/), [arxiv.org/abs/1402.6407](https://arxiv.org/abs/1402.6407)). The JS numbers that flatter `roaring-node` over `FastBitSet` measure against JS object graphs and amortize the N-API tax (~20 ns/call, [github.com/nodejs/node/issues/14379](https://github.com/nodejs/node/issues/14379)) over repeated ops — not our **rebuild-per-query-then-marshal-back-to-JS** reality. And critically: **roaring never helps you *find* a substring match** — it only combines row ids. It is irrelevant to the actual gap. Kept only as a documented escalation if a tenant column becomes huge+sparse *and* the combiner is first generalized to a bitset interface.

---

## 2. Per-category analysis

### 2.1 Equality & set membership — `$eq $eqi $ne $nei $in $notIn $null $notNull`

**Pick:** dictionary `codes` as truth; equality structure chosen **per column by measured c/n at build time:**

1. **LOW** (`c ≤ 256 && c/n < 1/1000`) — `status`, `locale`, `bool`, published-state: **one dense `Uint32Array` plane per code.** Composes with `and()/or()/andNot()` at **zero scatter cost.** This is the *only* tier where dense planes are admissible.
2. **MEDIUM–HIGH** — `stock` (500), author, tag, category: **one shared flat CSR** — `offsets:Int32Array[c+1]` + `postings:Int32Array[n]`, row ids grouped by code. `$eq` = scatter slice `[offsets[code], offsets[code+1])`; `$in` = scatter k slices. **Replaces `HashIndex`'s `number[]` buckets.**
3. **NEAR-UNIQUE** (`c/n > 0.5`) — slug/email/uuid: the **dictionary Map *is* the index** + a ~1-row CSR slice. Building a plane per value is quadratic blowup (500k planes × 125 KB = **60+ GB OOM**).

**Why the academic "one dense plane per value" default refutes itself:** at the bench's own `N=1,000,000`, one plane = `ceil(1e6/32)·4 = 125 KB`. The `stock` field (500 distinct) = **62.5 MB resident, mostly zeros**; a slug column (~1M distinct) = ~60 GB. The genuine default is CSR; planes are gated.

**Why CSR beats `Map<code, Uint32Array>`:** 500 buckets × 2000 rows = 500 separately-allocated growable JSArrays the GC traces, plus Map-entry overhead, plus SMI boxing. CSR = **2 allocations total**, `4n + 4(c+1)` bytes, GC-exempt, cache-sequential. Build is O(n) counting sort (count → prefix-sum → scatter), postings emerge ascending per code for free.

| Op | Mechanism | Complexity |
|---|---|---|
| `$eq` | plane OR / CSR slice scatter | O(1) / O(matches) |
| `$in` | k plane ORs / k slice scatters | O(k·matches) |
| `$eqi` | folded-code set → `$in` | O(matching codes) |
| `$ne` | `fill(n).andNot(match).andNot(nullBitset)` | O(words) |
| `$null`/`$notNull` | `nullBitset` / `fill(n).andNot(nullBitset)` | O(words) |

**Rejected:** Roaring (FFI), BSI (range tool, log c passes for point eq — wrong), MPH/FST (optimizes an already-O(1) `Map.get`), suffix/n-gram (substring tools).

### 2.2 Numeric range — `$lt $lte $gt $gte $between`

**Pick:** **keep the sorted array + binary search** (`sorted-index.ts`) — but **conditional per column** (build only for selectively-filtered or sort-key fields), not blanket. Floor for unindexed fields = the already-shipped per-operator `NumericColumn.scan` (`column.ts:52`).

**Why no fancy structure wins:**
- **BSI / RangeBitmap:** the author concedes it "doesn't get close to IntervalsEvaluator" (a sorted index) and is ~an order of magnitude slower for range *retrieval*; its only domain is *unsorted* data + range-restricted *aggregation*, neither of which we have. ([richardstartin.github.io/posts/range-bitmap-index](https://richardstartin.github.io/posts/range-bitmap-index))
- **Elias-Fano:** a space win in native C++; in V8 there is no fast 64-bit popcount/select (`Math.clz32` is 32-bit, `BigInt` is slow), so per-access `select` cost erases the win, and it needs a parallel permutation that erases the space win too. ([Ottaviano & Venturini, partitioned EF](https://dl.acm.org/doi/10.1145/2600428.2609615))
- **B+tree:** GC pointer-chasing; flattened to TypedArrays it *is* a sorted array (already rejected by the project).
- **Eytzinger/branchless probe:** 2.5–3× only on cache-resident arrays, worse on large ones; the O(log n) probe is dominated by the O(k) slice anyway. ([algorithmica.org/en/eytzinger](https://algorithmica.org/en/eytzinger))

**Two corrections the original rationales overstated:**
1. **The "contiguous matching slice" advantage does NOT materialize in the filter path.** `fillBitset` (`sorted-index.ts:112`) scatters *value-ordered* row ids into the bitset — random in row-id space, so **scattered word writes, not a sequential stream.** The slice is contiguous only for `countRange` (pure pointer arithmetic) and the ORDER-BY walk. Claim cache-locality only there.
2. **Non-selective regression:** when `k ≈ n`, the index does O(k) scattered `out.set()`, which can lose to `NumericColumn.scan`'s O(n) sequential branch-predictable loop. **Add a guard:** `countRange` is free (O(log n)); if matches > ~50% of rows, fall back to the scan (or compute the small complement).

**Build wart (the one real perf fix):** `rebuild` (`sorted-index.ts:40`) allocates `new Array<number>(n)` of **boxed** numbers + a closure comparator — the biggest GC source on the publish path. Replace with `Uint32Array` + LSD radix (i32) / order-preserving bit-flip key radix (f64).

`$between` = one native `rangeSliceBetween(lo,hi,...)` (one probe pair), avoiding a scratch Bitset + AND pass.

### 2.3 Temporal range — `$lt/$lte/$gt/$gte/$between` on dates, recency ORDER BY

**Pick:** **reuse the f64 sorted index with epoch-MILLIS** encoding. No new structure. Temporal == numeric range once epoch-encoded; `$between` is one slice; recency `ORDER BY + LIMIT` is already free via `forEachOrdered('desc')` early-termination.

**Precision is genuinely fine:** ms epoch (1.78e12) and even µs epoch (1.78e15) stay under `2^53 = 9.007e15`. Only **ns epoch overflows** — reject ns at schema validation.

**Two corrections to the original rationales:**
1. **The "BigInt is 36% slower" claim did not reproduce on Node 24** (scan parity; BigInt comparator was actually *faster*). Justify f64 by "ms is exact, we never need sub-ms," **not** by a speed myth — anyone re-running the cited number loses trust in the analysis.
2. **NULL/NaN sort corruption (real bug):** drafts have `publishedAt = NULL`. Encoding NULL as NaN makes range ops correctly return false, **but `vals[a]-vals[b]` returns NaN → an inconsistent comparator that corrupts the sorted order and pollutes every binary search.** Use a **per-column null Bitset** (sentinel `-Infinity` in the value array to keep the comparator total), and ANDNOT nulls out of range results. The "reuse unchanged" framing hides this.

**Latency cliff:** `markDirty` fires on every insert (`table.ts:89`); the first read after a publish rebuilds O(n log n) (measured 368 ms @1M) — a p99.9 spike that contradicts "absurdly fast." **Warm at publish** (`Table.warmIndexes()`), never lazily on the reader. Coerce ISO/Date/number→UTC ms **at ingest** (timezone/DST folded to UTC) or `$between` on "a calendar day" silently mis-includes rows near midnight. **Reject** Elias-Fano/Gorilla/BigInt64 here.

### 2.4 Prefix & suffix — `$startsWith $startsWithi $endsWith $endsWithi`

**Pick (simpler than both passes proposed):** **brute-force `startsWith`/`endsWith` over the deduped (folded) dictionary → `Uint8Array` code mask → one O(n) pass over `codes` sets the Bitset.** A forward sorted permutation (`Uint32Array` of codes by `dict[code]`) is an **opt-in, prefix-only** accelerator for large-D fields. **No reversed-string twin, no UTF-8 key blob.**

**Why the fancy proposals are over-built:** Both passes cost the query as "binary-search the slice, then **OR the per-value bitsets**" — but **those bitsets don't exist.** Turning matched codes into rows is **one O(n) pass over `codes` no matter how the dictionary lookup is done.** The binary search only accelerates the *dictionary-side seek* (O(log D · L) vs O(D · L)) — a rounding error next to the unavoidable N-pass. The reversed twin and the concatenated UTF-8 blob buy a log-factor on a non-bottleneck while adding a second permutation, a **surrogate-pair-safe reversal hazard**, a third byte-ordering to reconcile (UTF-16 `<` vs `localeCompare` vs UTF-8), and a second sorted rebuild. `D ≪ N` is the whole game: `log2(D) ≈ 17` saves nothing next to `1e6` Int32 reads.

**Rejected:** FST/FM-index (no production JS builder, WASM/N-API tax), object/double-array tries (V8 GC anti-pattern), roaring (container dispatch hurts at our densities). Gate the prefix accelerator on cardinality (`D > ~4096`); never build it for low-card enum fields.

### 2.5 Arbitrary substring — `$contains $containsi $notContains $notContainsi`

**Pick (hybrid, escalation promoted to first-class):**
- **PRIMARY / FLOOR:** brute-force `String.prototype.includes` over the **deduped, pre-folded** dictionary → matched codes → O(rows) expand to Bitset. Right for low/medium cardinality, short needles, and needles `< 3` chars.
- **ACCELERATOR (build-on-publish for contains-heavy columns):** a **trigram (3-gram) inverted index over dict-CODES** (sorted `Int32Array` per trigram). Extract needle trigrams; if `len < 3` or any trigram is absent → fall back to full dict scan; else intersect the rarest postings → candidate codes → **verify each with `includes()`** (kills false positives) → expand to rows. `$notContains` = build contains Bitset then `fill(n).andNot(contains)`.

**Two measured errors in the original passes:**
1. **The flat-buffer claim is a trap.** "`Buffer.indexOf` 4.1 ms" holds only as a *single whole-buffer* call — which **crosses dictionary value boundaries and produces false matches** (a latent bug in `bench_substr_research.mjs`). Done **correctly per-value**, it explodes to **2117 ms — 220× slower** than `String.includes`, because each `Buffer.indexOf` pays a fixed JS↔C++ boundary cost amortized over ~40 bytes. **Keep the dictionary as a V8 `string[]`.**
2. **The code→row expansion is mandatory, not free.** `scan()` returns a Bitset over **rows**, not codes (`column.ts`). Skipping it breaks AND/OR/ANDNOT composition. Measured ~0.3 ms over 300k rows — cheap, but new code.

**Why trigram is not "reserve":** at 280k distinct / 35-char values, a selective ≥3-char needle is **9.8 ms scan → 0.04 ms trigram (260×)**; at 1M distinct, 35.6 ms → 0.13 ms (264×). For publish-rarely/read-constantly, a 1.3 s publish-time build + ~37 MB (postings over **codes**, not rows — posting over rows loses the dedup multiplier) to convert 10 ms→0.04 ms per read is an obvious win. **Verification is non-optional** (trigram intersection returns candidates with false positives). **Rejected:** suffix array (5–9× memory scaling with *total* text, cache-hostile), suffix automaton/tree (pointer/Map graph = GC catastrophe), FM-index (no mature Node lib; wavelet `rank()` constant factors lose to a 7 ms scan).

### 2.6 Predicate combination — `$and $or $not`, nested groups

**Pick:** keep the dense Bitset combiner; add a node-tree `scanGroup`. `$and` = selectivity-reordered word-wise AND into a **pooled** scratch; `$or` = chained `or()` into one accumulator; `$not` = child Bitset then a **direct masked complement** `Bitset.not(rowCount)` (cheaper than `fill(n)+andNot`, avoids a second full buffer). Nested groups recurse, each returning one Bitset.

**The combiner is the easy 20%** — it is correctly the simple structure. The genuine engineering is at the *leaf* (§2.4, §2.5). **Two V8 traps:**
- **`scan()` churns two 125 KB bitsets per query + a `fill(0)` per leaf** (`table.ts:120,126,128`). **Pool/reuse** scratch buffers per worker; reset only the touched word range.
- **Probe-most-selective-first is oversold.** `Column.at()` is a **megamorphic** virtual dispatch across 3 column classes that returns a **boxed `number|string|boolean`** and double-indirects for strings (`dict[codes[row]]`) — one of the worst shapes for TurboFan. Probe-first wins only when the lead set is **tiny (<~1–2%)** *and* residuals are eq/range/ne probed **directly against raw `codes`/`data` TypedArrays** (resolve the eq target to a code once, compare ints), **never through `at()`**. Substring/`-i` leaves always build a bitset and AND.

Selectivity ordering is **free** — `HashIndex.cardinality` and `SortedIndex.countRange` already exist; engine-standard (Lucene leads with the sparsest posting list / `ConjunctionDISI` by docFreq). Gate `countRange` estimation behind "index already built (not dirty)" so estimating doesn't trigger an O(n log n) rebuild.

### 2.7 Boolean & relation

- **Boolean** (`column.ts:68`): cardinality 2 — the textbook dense-plane tier. Two planes (true/false), `$eq` = plane OR, `$ne` = the other plane (+ ANDNOT null). 2 × 125 KB @1M = trivial.
- **Relation:** a relation filter is equality/set-membership over foreign keys + a posting-list join. Resolve the related-table predicate to a Bitset, map to owning rows via a **CSR owner→related adjacency** (same flat `Int32Array` layout), compose with the parent Bitset. No graph structure, no roaring. Late-materialize related scalars off the same pre-serialized buffers.

---

## 3. Routing table (condensed)

| Operator group | Type | Structure | Complexity |
|---|---|---|---|
| `$eq $ne $in $notIn` | string | dict + CSR postings (planes if low-card, dict-Map if near-unique) | O(matches) / O(1) plane; build O(n) counting sort |
| `$eqi $nei` | string | folded dict + folded-code set → `$in` machinery | O(matching codes) |
| `$contains* ` | string | brute `includes` over deduped dict → O(n) codes pass; trigram-over-codes accelerator | brute O(D·L)+O(n); trigram O(rarest+cand·L)+O(n) |
| `$startsWith* $endsWith*` | string | brute `startsWith/endsWith` over deduped dict → O(n) pass; opt-in forward sorted permutation (prefix, large-D) | O(D·L)+O(n); accel O(log D+slice+n) |
| `$lt $lte $gt $gte $between` | number | sorted array + binary search (conditional per column) + `countRange` selectivity guard | O(log n)+O(k) |
| `$lt..$between` | date | f64 epoch-ms sorted index + null bitset (NOT NaN sentinel) | as numeric |
| `$eq $ne $in $notIn` | bool | two dense planes | O(1) / O(words) |
| `$null $notNull` | any | per-column null Bitset | O(words) |
| relation filter | relation | CSR owner→related adjacency + bitset compose | O(matched)+O(n) |
| `$and $or $not` | any | dense Bitset AND/OR/masked-NOT, selectivity-reordered, pooled scratch | O(k · words) |

---

## 4. Build plan (ordered, incremental, on the existing store)

0. **Combiner + null substrate** — `Bitset.not(rowCount)`; refactor `Table.scan` into `scanGroup(node)` (AND reorder + pooled scratch, OR accumulator, NOT complement); per-column `nullBitset` set in `insert` (stop throwing on missing/null fields). *Unblocks 18 operators.*
1. **Operator surface at the leaf** — widen `ScanOp` to the full Strapi set; wire `$in/$notIn/$null/$notNull`; `$ne/$notIn/$notNull` ANDNOT the null bitset; stop `StringColumn.scan` throwing.
2. **Folded dictionary** — `foldedDict` + `foldedLookup`, `fold = casefold(NFKC)` once at intern; `$eqi/$nei`.
3. **Substring + affix (brute primary)** — deduped-dict scan → code mask → O(n) codes pass; all 8 substring/affix operators, zero new persistent structure.
4. **CSR eq-index** — counting-sort build replacing `HashIndex`; cardinality gate (planes only when `c≤256 && c/n<1/1000`); boolean planes.
5. **Sorted-index hardening** — `rangeSliceBetween`; >50% `countRange` fallback; replace boxed `order[]` with `Uint32Array`+radix; `Table.warmIndexes()` at publish.
6. **Temporal columns** — f64 epoch-ms flavor; coerce at edge, reject ns; nulls via bitset.
7. **Selectivity planner** — opt-in tiny-lead probe against raw TypedArrays (never `at()`).
8. **Trigram accelerator** — `SubstringIndex` (packed-3gram → sorted code postings, intersect+verify+expand), gated on contains-heavy / `D>~50k`.
9. **Relation filtering** — CSR adjacency join.
10. **Bench + prove** — extend `bench/scan.bench.ts` (no mocks; drive through real `Table.insert`) with `$in/$ne/$null/$containsi/$between`, a high-card slug column (prove no planes, CSR stays `4n`), and an interleaved publish+read p99.9.

---

## 5. Open risks to benchmark before committing

1. The combiner/null wiring (Slice 0–1) gates everything — measure *after* the leaves exist.
2. Cardinality-gate thresholds (256, 1/1000, D>4096, D>50k) are estimates — confirm on the real schema.
3. Non-selective range crossover (>50% guard) — measure on i32 + f64.
4. Rebuild tail-latency under interleaved publish+read (warm-at-publish fix).
5. Boxed `order[]` → radix publish-time win.
6. Case-fold semantics ($containsi fold choice) vs Postgres ILIKE expectations.
7. Trigram 37 MB / 1.3 s build acceptability per column; verification correctness.
8. Live-append vs publish-snapshot (main+delta vs rebuild-on-publish; cardinality-gate re-evaluation).
9. Relation join semantics (1-to-many vs m-to-m, nested, deletion invalidation).

## 6. Citations

- RoaringBitmap design / "uncompressed bitset wins in RAM" — https://roaringbitmap.org/about/ , https://arxiv.org/abs/1402.6407
- RangeBitmap/BSI ~10× slower than a sorted index for retrieval — https://richardstartin.github.io/posts/range-bitmap-index
- Partitioned Elias-Fano (space win is native, not V8) — https://dl.acm.org/doi/10.1145/2600428.2609615
- Eytzinger / branchless binary search (cache-resident only) — https://algorithmica.org/en/eytzinger
- N-API call overhead — https://github.com/nodejs/node/issues/14379
- Postgres pg_trgm (trigram inverted-index pattern) — https://www.postgresql.org/docs/current/pgtrgm.html
- Lucene conjunction ordering by docFreq (`ConjunctionDISI`) — https://lucene.apache.org/core/
- DuckDB columnar execution / late materialization — https://duckdb.org/why_duckdb
- ClickHouse skip indexes / min-max (zone maps, deferred here) — https://clickhouse.com/docs/en/optimize/skipping-indexes