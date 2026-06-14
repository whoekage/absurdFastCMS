# absurdFastCMS

An *absurdly fast* headless CMS. Postgres is the source of truth, but reads never touch it — they are served from an in-process, columnar, in-memory read layer with pre-serialized response bytes. The query API speaks Strapi v5's bracket-filter syntax, so existing clients work unchanged.

> **Status:** early development. The read engine, the Strapi-style query parser, and the HTTP layer are built and tested (mock-free, native `node:test`). Postgres loading and Redis-based cluster invalidation are planned seams, not yet wired.

## Why

Mainstream OSS headless CMSs serve reads straight from the database (plus a generic cache). None combine **Postgres as the durable source of truth** + **an in-process RAM read layer** + **Redis pub/sub cache invalidation** for horizontal scaling. That's the gap this project fills: keep Postgres's durability for writes, but answer reads at memory speed.

## Architecture

```
        writes                         reads
          │                              │
          ▼                              ▼
   ┌─────────────┐   load/seed    ┌──────────────────────┐
   │  Postgres   │ ─────────────▶ │  In-process columnar  │
   │ (source of  │                │   read engine (RAM)   │
   │   truth)    │   invalidate   │  + pre-serialized     │
   └─────────────┘ ◀──ChangeBus── │    response bytes      │
                                  └──────────┬───────────┘
                                             │
                                   ┌─────────▼──────────┐
                                   │ uWebSockets.js HTTP │
                                   │  (N cluster workers)│
                                   └────────────────────┘
```

- **Runtime:** Node.js 24 + TypeScript, run via native type-stripping — **no build step**. Erasable-syntax-only TS (no enums / parameter-properties). Tests use the native `node:test` runner with **no mocks**.
- **Source of truth:** Postgres. Redis is reserved for pub/sub cache invalidation in the future clustered version — never as the source of truth.
- **Read layer:** an in-process **columnar** store (`src/store/`). Columns are the query engine: typed arrays, tight scan loops, dictionary-encoded strings, and equality / sorted / substring / relation indexes. Output uses **late materialization** — each row's response JSON is serialized to UTF-8 bytes **once at write time** into a flat byte arena; a list response is assembled by concatenating arena slices, which benchmarked at ~3× the throughput of per-request `JSON.stringify`.
- **HTTP:** **uWebSockets.js** (C++ core, native WebSockets) behind a framework-agnostic pure core. `src/http/router.ts` is `handleRequest(engine, {method, path, query}) → {status, contentType, body: Buffer}` with zero framework imports; `src/http/app.ts` is a thin uWS adapter; `src/http/server.ts` forks N cluster workers (one per core) with `SO_REUSEPORT`. The server is swappable behind the pure core.
- **Caching:** an assembled-buffer response cache — a hot query is one `Map.get` → send. Invalidation goes through a `ChangeBus` interface: an in-process implementation for the single-instance OSS build, a Redis pub/sub implementation for the clustered (paid) build. Clustering is a second `ChangeBus` impl, not core surgery.

## Query API

Emulates **Strapi v5** bracket syntax so existing clients/tooling work unchanged:

```
GET /articles?filters[title][$contains]=hono&filters[views][$gte]=100&sort=views:desc&pagination[limit]=20
```

- ~24 filter operators (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$contains`, `$startsWith`, `$endsWith`, their case-insensitive `*i` variants, `$between`, `$in`, `$null`, …).
- Nested `$and` / `$or` / `$not` combinators.
- Both pagination styles (`pagination[page]` / `pagination[pageSize]` and `start` / `limit`).
- Relation populate via a `populate` plan (Payload-style `depth` reserved for nested populate).

Everything is validated against the content-type schema: an unknown field, unknown operator, type-mismatched value, or malformed bracket syntax throws a clear `QueryParseError` — never a silent wrong query.

## Performance notes

Measured on an M1 Pro (10-core), Node 24 — see `experiments/http-serialization/` and `bench/`:

- **Serialization strategy dominates the framework.** Pre-serialized buffers ≈ 3× the throughput of `JSON.stringify` on a 28 KB list payload, on every server tested. Framework choice moved results by <10%.
- **Read engine** (1M rows): single full scan ≈ 0.8B rows/s (~1.2 ms); selective equality via index ≈ 11× faster than full scan; `ORDER BY … LIMIT 20` ≈ 0.014 ms via sorted-index walk with early termination.
- **HTTP** (real uWS stack, 10k rows, cache on, single process): list ~45.6k req/s (p99 3 ms), single-item ~61.4k req/s. Horizontal scaling is the lever — node cluster ×6 reached ~113k req/s on a 28 KB payload (bandwidth-bound).

## Project layout

```
src/
  store/        # columnar read engine
    column.ts        bitset.ts        table.ts
    engine.ts        query-parser.ts  (Strapi v5 parser)
    eq-index.ts      sorted-index.ts  substring-index.ts
    relation.ts      response-cache.ts
    store.ts         # the durable-source seam (Store interface)
    content-type.ts  # shared `article` schema + index plan
  db/             # Postgres source of truth (Drizzle + postgres.js)
    schema.ts        client.ts        migrate.ts
    postgres-store.ts  # boot load: cursor-stream Postgres -> Engine
  http/
    router.ts        # pure, framework-agnostic request core
    app.ts           # uWebSockets.js adapter
    server.ts        # cluster bootstrap (N workers, SO_REUSEPORT)
drizzle/        # generated SQL migrations (drizzle-kit)
test/           # node:test suites (slices, fuzz oracles, http, postgres) — no mocks
bench/          # engine microbenchmarks
experiments/    # HTTP serialization / framework benchmarks
docs/research/  # filter data-structure research
docker-compose.yml  # Postgres 18 (host port 5673)
```

## Getting started

Requires **Node.js ≥ 24** (for native TypeScript type-stripping) and **Docker** (for Postgres 18).

```bash
npm install
npm run db:up           # start Postgres 18 (host port 5673; creates absurd_dev + absurd_test)
npm run db:migrate      # apply migrations to the dev database (.env)
npm run db:migrate:test # apply migrations to the test database (.env.test)
npm test                # node --test, mock-free (runs against absurd_test)
npm run bench           # engine scan benchmark (in-memory seed, no DB)
```

Environment is split by file: dev reads `.env`, tests read `.env.test` (both gitignored). Each cluster
worker loads its own in-memory Engine from Postgres at boot via `PostgresStore`, then serves reads
entirely from RAM.

Database workflow:

- `npm run db:generate` — generate a SQL migration from `src/db/schema.ts` (never hand-write migrations)
- `npm run db:migrate` / `db:migrate:test` — apply migrations programmatically to dev / test
- `npm run db:down` — stop the Postgres container

## Roadmap

- [x] Columnar storage + scan, equality / sorted / substring / relation indexes
- [x] Strapi v5 filter/sort/pagination parser with schema validation
- [x] Late-materialization output arena + assembled-buffer response cache
- [x] uWebSockets.js HTTP layer + cluster bootstrap
- [x] Postgres `Store` seam — boot load from Postgres (Drizzle schema + migrations, PK-addressed `id`)
- [ ] Write path (POST/PUT/DELETE → Postgres → RAM update + cache invalidation) + change capture
- [ ] Redis pub/sub `ChangeBus` for clustered invalidation
- [ ] Keyset/cursor pagination; selectivity-based predicate ordering
- [ ] String collation for sorted indexes; relation populate from Postgres

## License

Not yet specified.
