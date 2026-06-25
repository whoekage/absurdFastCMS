# absurd columnar engine vs DuckDB — benchmark

**TL;DR — it depends on the workload, and the gap is enormous in both directions.**
absurd is a *read-serving* engine; DuckDB is an *analytics* engine. Each wins its own axis by 1–4 orders
of magnitude. Pick by job, not by a single "faster" number.

Run it yourself: `node bench/duckdb-vs-absurd.bench.ts` (set `BENCH_N`, or `BENCH_AXIS=B` for analytics
only). Needs the `@duckdb/node-api` devDependency. Both engines load the **same** deterministic
LCG-seeded rows — no mocks. Numbers below are one machine (M-series, Node 24); the **ratio** is the point.

## Axis A — CMS read (filter + sort + paginate → JSON bytes ready to send)

This is absurd's actual job. Query: `status='published' ORDER BY views DESC LIMIT 25`.
absurd's `Engine.respond()` returns the `{data,meta}` Buffer — the row JSON was serialized **once at write
time** (serialize-on-write), so a read is a zero-copy arena-slice concat. DuckDB runs the SQL and
serializes the result set on **every** read (we include JSON encoding, and give DuckDB its best native
`getRowObjectsJson` path too).

| rows | absurd respond→bytes | DuckDB native JSON | absurd advantage |
| --- | --- | --- | --- |
| 100 k | 0.0016 ms | 3.00 ms | **~1,900×** |
| 1 M | 0.0019 ms | 4.32 ms | **~2,300×** |
| 1 M, deep page (offset 10k) | 0.0014 ms | 10.9 ms | **~7,800×** |

absurd is effectively flat in N (sorted-index walk early-terminates + zero-copy bytes); DuckDB's per-query
cost grows (plan + execute + materialize + serialize, and `ORDER BY … OFFSET` gets pricier deep in).
**For a read-heavy CMS this is decisive** — absurd pre-paid the serialization that DuckDB pays per hit.

## Axis B — analytics (COUNT / GROUP BY, SUM / AVG over the whole table)

**absurd's query API CANNOT do this — there is no aggregation surface.** The "naive-JS" row is NOT a
product feature; it's a hand-rolled tight loop over flat typed arrays, included only as the ceiling of
"what our storage *could* do unaided" — for context.

| rows | DuckDB SUM+AVG | naive-JS SUM+AVG | DuckDB COUNT GROUP BY | naive-JS COUNT GROUP BY |
| --- | --- | --- | --- | --- |
| 100 k | 0.31 ms | 0.10 ms | 2.49 ms | 0.21 ms |
| 1 M | 0.66 ms | 1.01 ms | 4.76 ms | 2.07 ms |
| 10 M | 3.43 ms | 9.98 ms | 37.0 ms | 20.9 ms |

Two honest findings:
- **SUM/AVG (single-pass):** DuckDB's vectorization pays off by ~1 M rows and pulls ahead ~3× by 10 M, and
  keeps widening. This is its home turf.
- **COUNT GROUP BY with tiny cardinality (3 groups):** a naive 3-counter loop stays competitive even at
  10 M because DuckDB's hash-aggregate setup is fixed overhead the small group count can't amortize. With
  *high*-cardinality grouping DuckDB would run away. (And at small N, DuckDB's per-query planner overhead
  makes it *lose* its own axis — see 100 k.)

## What this means for us

- absurd is the right engine for the product it is: a Strapi-shaped **read API**. Serving a content page
  is ~1000–5000× cheaper than asking a SQL engine to do the same end-to-end, precisely because the
  response bytes already exist.
- We are **not** an analytics engine and shouldn't pretend to be — no aggregations, no ad-hoc joins, no
  arbitrary SQL. If analytics/reporting becomes a requirement, the right move is to feed the same source
  data into DuckDB (or a column store) for that workload, not to bolt aggregation onto this engine.
- Known limit surfaced by the bench: the `string` cmsType is dictionary-encoded, so a near-unique
  high-cardinality string column tops out (~10 M distinct → V8 Map limit). Such columns should be `text`
  (UTF-8 arena), not `string`. Unrelated to query speed, but worth recording.

## Caveats

- One machine, in-process (no network); absolute ms vary, ratios are stable.
- absurd reads are in-process Buffers; a real HTTP path adds uWS framing (small, same for both if both
  were fronted by HTTP). DuckDB here is embedded in-process too — the fairest possible footing.
- The `@duckdb/node-api` dependency is **bench-only** (added to `packages/api` devDependencies). It pulls
  native binaries and reports a few `npm audit` advisories of its own; remove it if you don't want the
  bench reproducible from a clean install.
