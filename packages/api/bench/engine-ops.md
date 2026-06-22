# Engine operator baseline

A refactoring reference: load N rows across **every** column type into the in-memory engine and benchmark
every operator class over indexed and brute paths, with the **response cache DISABLED** (raw compute —
filter + scan + serialize, not a warm-cache `Map.get`). Re-run before/after an engine change and diff.

Harness: `bench/engine-ops.bench.ts`. Run: `node --expose-gc bench/engine-ops.bench.ts`
(`BENCH_N=<rows>`, default 10M). Deterministic seeded LCG; one machine, one run, single-threaded.

Schema (12 columns, one per `ColumnType`): `id i32`, `status string`(3), `category string`(500),
`title string`(near-unique, off-heap dict), `body text`(arena), `views i32`(sorted-idx), `rating f64`,
`active bool`, `price decimal(12,2)`, `bigid i64`, `created_at date`(sorted-idx), `meta json`.
Indexes: eq on `status`,`category`; sorted on `id`,`views`,`created_at`.

## Baseline — 2,000,000 rows (cache disabled)

build: 24.9 s (80,200 rows/s) · arrayBuffers ~1.7 GB (~860 B/row). (Build throughput DEGRADES with N —
~8,000 rows/s at 10M — from GC pressure + the type-aware serializer; see Finding B.)

```
operation                                          p50       p90       p99      p999       max     samples
point lookup id=X    [sorted-index/brute]        8.1122    8.2995    8.7255   70.2832   70.2832      178
eq status=published  [eq-index, low-card]        0.2252    0.2853    0.6235    1.5078   21.6910     3000
eq category=<one>    [eq-index, mid-card]        0.4597    0.5689    1.0080   22.6194   26.2670     2810
ne status!=draft     [low-card]                 14.7295   15.0027   19.7553   25.7987   25.7987      101
in status IN(2)      [eq-index]                  0.3245    0.3804    0.6737    1.3805    1.5658     3000
notIn category(3)                               57.8879   58.6828   68.3253   68.3253   68.3253       26
eqi status (folded)                             13.3730   13.6080   13.8240   59.9385   59.9385      109
views > 500k        [sorted-index]               1.9906    2.1041    2.9088   15.1668   15.1668      714
views BETWEEN       [sorted-index]              17.7237   17.9773   18.8461   18.8461   18.8461       85
created_at BETWEEN  [sorted-index, date]        22.8693   23.1691   23.3235   23.3235   23.3235       66
rating > 2.5        [f64 brute]                 21.2317   21.5371   27.4922   27.4922   27.4922       71
price BETWEEN       [decimal brute]             22.5626   22.8252   23.3645   23.3645   23.3645       67
bigid > mid         [i64 brute]                 17.6435   17.8960   18.3531   18.3531   18.3531       85
active = true       [bool]                      17.6064   18.1369   23.4185   23.4185   23.4185       85
title IS NULL                                    0.3354    0.4630    1.1993   34.1634   54.1961     2860
title IS NOT NULL                                0.3352    0.3896   25.3696   50.9718   51.3514     1947
title contains  [dict brute]                  467.3443  467.6047  467.6047  467.6047  467.6047        4
title startsWith [dict brute]                 433.2206  484.9424  484.9424  484.9424  484.9424        4
title containsi [folded brute]                470.8888  589.4797  589.4797  589.4797  589.4797        3
body contains   [arena brute]                 435.2080  439.6682  439.6682  439.6682  439.6682        4
status=published AND views>500k                  2.6045    2.7505   88.6057  140.5190  140.5190      359
status=published AND title contains           473.4691  474.4870  474.4870  474.4870  474.4870        4
page: status=pub ORDER BY views DESC LIMIT 25    0.2329    0.3221    0.5139    1.9740    2.0153     3000
page: ORDER BY created_at DESC LIMIT 25          0.1505    0.2177    0.3526    7.8176   66.8504     3000
deep offset: views DESC OFFSET 100k LIMIT 25     0.5069    0.6000    1.1540   52.9517   63.3555     2462
full serialize: views DESC LIMIT 100             0.1673    0.2655    0.5592    5.6990    6.2345     3000
page: ORDER BY title ASC LIMIT 25 [string sort]   2169.3457  (single call)
title contains  [TRIGRAM]                       25.5845   27.0384   27.7478   27.7478   27.7478       59
body contains   [TRIGRAM arena]                566.3488  687.2771  687.2771  687.2771  687.2771        3
```
(ms; cache disabled. Brute scans scale ~linearly with N — ~5× these at 10M.)

## Strength (confirmed)
Indexed reads are **sub-millisecond**: the canonical page query (`status=pub ORDER BY views DESC LIMIT 25`)
is **0.23 ms p50**; eq on an indexed low-card column 0.23 ms; sorted-index range `views>500k` 2.0 ms;
deep-offset 100k 0.5 ms. The serialize-on-write read thesis holds on raw compute.

## Findings / optimization targets (ranked)
- **A (high) — EqIndex on a high-cardinality column overflows the V8 Map (~8.4M / 2^23 effective).**
  `createEqIndex('id')` THROWS at >~8.4M rows (`id` is unique = N distinct). `eq.index.ts` interns values
  into `codeOf = new Map`. Every table has a PK → this bites every large table. → off-heap EqIndex (be-22b).
- **6 (high) — eq on a sorted-indexed (non-eq-indexed) column does NOT use the index → brute.** Point
  lookup `id=X` is **8.1 ms** (O(n) scan), not a binary search. With A, PK point lookups are O(n) at scale.
- **5 (high) — `ORDER BY <string>` is catastrophic: 2,169 ms for ONE call at 2M** (no string sorted index;
  brute comparator, O(n log n) string compares). `?sort=title` is effectively unusable at scale.
- **4 (med) — the trigram accelerator HURTS on the `body` arena: 435 → 566 ms** (common needle → huge
  candidate set → per-row arena verify costs more than brute). It helps `title` hugely (467 → 25.6 ms, 18×).
- **3 (med) — `between` on a sorted-indexed column is ~9× slower than `gt`** (17.7 vs 2.0 ms): it collects
  all matches before the LIMIT, while `gt` walks the sorted tail.
- **B (med) — write throughput collapses with exotic types**: `json`/`decimal`/`i64` force the type-aware
  row serializer (vs the fast `JSON.stringify` path), ~80k→8k rows/s, degrading with N (GC). Bulk-loading
  tens of millions of full-schema rows is impractical (10M ≈ 20 min).
- **C (low) — the response-cache key builder crashes on a `BigInt` predicate value**
  (`response.cache.ts` `encodeValue` → `JSON.stringify`). The cache key is built even when the cache is
  disabled. Wire-path i64 filters are strings (so likely not a prod crash), but a 1-line hardening is due.
- Brute scans (`ne`, `notIn`, range on non-indexed `f64`/`decimal`/`i64`/`bool`) ≈ 15–58 ms at 2M.

## Notes
- A full-schema 10M run is impractical to iterate (Finding B). For headline brute-scan numbers at tens of
  millions, run a SIMPLE schema (drop `json`/`decimal`/`i64`) which builds ~20× faster.
- Memory at 2M ≈ 860 B/row in ArrayBuffers (serialize-on-write JSON + the `json` column dominate).
