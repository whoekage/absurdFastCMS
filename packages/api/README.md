# conti

An *absurdly fast* headless CMS. Postgres is the source of truth, but reads never touch it — they are served from an in-process, columnar, in-memory read layer with pre-serialized response bytes. The query API speaks Strapi v5's bracket-filter syntax, so existing clients work unchanged.

> **Status:** early development. The read engine, the Strapi-style query parser, and the HTTP layer are built and tested (mock-free, native `node:test`). Postgres loading and Redis-based multi-instance invalidation are planned seams, not yet wired.

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
                                   │   (single process)  │
                                   └────────────────────┘
```

- **Runtime:** Node.js 24 + TypeScript, run via native type-stripping — **no build step**. Erasable-syntax-only TS (no enums / parameter-properties). Tests use the native `node:test` runner with **no mocks**.
- **Source of truth:** Postgres. Redis is reserved for pub/sub cache invalidation in the future multi-instance version — never as the source of truth.
- **Read layer:** an in-process **columnar** store (`src/store/`). Columns are the query engine: typed arrays, tight scan loops, dictionary-encoded strings, and equality / sorted / substring / relation indexes. Output uses **late materialization** — each row's response JSON is serialized to UTF-8 bytes **once at write time** into a flat byte arena; a list response is assembled by concatenating arena slices, which benchmarked at ~3× the throughput of per-request `JSON.stringify`.
- **HTTP:** **uWebSockets.js** (C++ core, native WebSockets) behind a framework-agnostic pure core. `src/http/router.ts` is `handleRequest(engine, {method, path, query}) → {status, contentType, body: Buffer}` with zero framework imports; `src/http/app.ts` is a thin uWS adapter; `src/http/server.ts` is a single-process entrypoint that loads the Engine from Postgres and listens. The server is swappable behind the pure core.
- **Caching:** an assembled-buffer response cache — a hot query is one `Map.get` → send. Invalidation goes through a `ChangeBus` interface: an in-process implementation for the single-instance OSS build, a Redis pub/sub implementation for the multi-instance (paid) build. Multi-instance invalidation is a second `ChangeBus` impl, not core surgery.

## Query API

Emulates **Strapi v5** bracket syntax so existing clients/tooling work unchanged:

```
GET /articles?filters[title][$contains]=intro&filters[views][$gte]=100&sort=views:desc&pagination[limit]=20
```

- ~24 filter operators (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$contains`, `$startsWith`, `$endsWith`, their case-insensitive `*i` variants, `$between`, `$in`, `$null`, …).
- Nested `$and` / `$or` / `$not` combinators.
- Both pagination styles (`pagination[page]` / `pagination[pageSize]` and `start` / `limit`).
- Relation populate via a `populate` plan (Payload-style `depth` reserved for nested populate).

Writes go to Postgres (the source of truth) and then rebuild the in-memory engine:

```
POST   /articles       # create        -> 201 { data }
PUT    /articles/:id   # partial update -> 200 { data }   (Strapi semantics)
DELETE /articles/:id   # delete         -> 200 { data }
```

Everything is validated against the content-type schema: on reads an unknown field / operator / type-mismatched value / malformed bracket syntax throws a clear `QueryParseError`; on writes an unknown field, a client-set `id`, a missing required field, a wrong type, or a `null` on a NOT-NULL field throws a `BodyParseError` (→ 400) — never a silent wrong query or write.

## Content-Type Builder

Content-types are **user-defined at runtime**: declaring one creates a real Postgres table (`ct_<apiId>`) with real native columns, and the type becomes readable and writable immediately — no restart. The schema lives in meta tables (`content_types`, `content_type_fields`); the physical table and the in-memory engine are derived from it.

```
POST   /content-types                       # create a type {apiId, fields:[{name, cmsType, options?}]} -> 201
GET    /content-types                       # list type definitions
GET    /content-types/:apiId                # one definition
DELETE /content-types/:apiId                # drop the type (and its table)
POST   /content-types/:apiId/fields         # add a field {name, cmsType, options?}
PUT    /content-types/:apiId/fields/:name   # rename and/or change a field's type {newName?, cmsType?, options?}
DELETE /content-types/:apiId/fields/:name   # drop a field
```

Field types (`cmsType`) map to native Postgres + an exact in-memory column: `string`/`email`/`uid`/`enumeration` → `varchar` (enum adds a CHECK), `text`, `integer` (i32), `biginteger` (`bigint`, exact i64), `float` (f64), `decimal` (`numeric(p,s)`, exact scaled-int), `boolean`, `date`, `datetime` (`timestamptz`), `uuid`, `json` (`jsonb`, stored verbatim). `bigint`/`decimal` are emitted as quoted strings on the wire (lossless > 2⁵³); `json` round-trips byte-exact. Every change is one atomic Postgres transaction; an identifier (table/column name) is allowlist-validated (`^[A-Za-z_][A-Za-z0-9_$]*$`, ≤ 63 bytes, reserved names rejected) **before** any DDL, so a client string can never reach a SQL identifier position.

> **Note:** the Builder is currently **unauthenticated** — any client can create/alter/drop content-types (runtime DDL). Gating it behind admin authn/authz is a required follow-up before untrusted exposure.

## Performance notes

Measured on an M1 Pro (10-core), Node 24 — see `experiments/http-serialization/` and `bench/`:

- **Serialization strategy dominates the framework.** Pre-serialized buffers ≈ 3× the throughput of `JSON.stringify` on a 28 KB list payload, on every server tested. Framework choice moved results by <10%.
- **Read engine** (1M rows): single full scan ≈ 0.8B rows/s (~1.2 ms); selective equality via index ≈ 11× faster than full scan; `ORDER BY … LIMIT 20` ≈ 0.014 ms via sorted-index walk with early termination.
- **HTTP** (real uWS stack, 10k rows, cache on, single process): list ~45.6k req/s (p99 3 ms), single-item ~61.4k req/s. A 28 KB list payload is bandwidth-bound; horizontal scale-out (running multiple instances behind a load balancer) is a future deployment concern, not built into the server.

## Project layout

```
src/
  store/        # columnar read engine
    column.ts        bitset.ts        table.ts
    engine.ts        query-parser.ts  (Strapi v5 parser)
    eq-index.ts      sorted-index.ts  substring-index.ts
    relation.ts      response-cache.ts
    store.ts         # the durable-source seam (Store interface)
    registry.ts      # the RAM content-type registry (built from the meta tables)
    content-type.ts  # the `article` seed definition
    body-parser.ts   # registry-driven write-body validation/coercion
  db/             # Postgres source of truth (postgres.js only, no ORM)
    client.ts        migrate.ts       # connection + hand-written SQL migration runner
    type-catalog.ts  # cms type -> Postgres type + engine column type
    ddl.ts           # Kysely-compiled runtime DDL + identifier safety (CREATE/ALTER TABLE)
    content-type-repo.ts # meta CRUD: create/alter/drop a content-type (atomic DDL+meta tx)
    entry-repo.ts    # generic row write repo: INSERT/UPDATE/DELETE ... RETURNING
    postgres-store.ts  # boot load: build registry + cursor-stream every type -> Engine
    load.ts          # per-type (re)build of the in-memory engine from Postgres
  http/
    router.ts            # pure, framework-agnostic read core
    write.ts             # async data-write core (validate -> Postgres -> per-type rebuild)
    content-type-api.ts  # async content-type Builder core (/content-types runtime DDL)
    app.ts               # uWebSockets.js adapter (sync reads + async writes/builder)
    server.ts            # single-process entrypoint (load from Postgres + listen)
migrations/     # hand-written SQL migrations, applied by src/db/migrate.ts
test/           # node:test suites (engine slices, fuzz oracles, http, content-types) — no mocks
  global-setup.ts  db-per-file.ts  helpers.ts   # Testcontainers Postgres + per-file DB isolation
bench/          # engine microbenchmarks
experiments/    # HTTP serialization / framework benchmarks
docs/research/  # design research (filters, dynamic content-types, testcontainers)
docker-compose.yml  # Postgres 18 for DEV (host port 5673); tests use Testcontainers
```

## Getting started

Requires **Node.js ≥ 24** (for native TypeScript type-stripping) and **Docker** (for Postgres 18).

```bash
npm install
npm run db:up           # start Postgres 18 for DEV (host port 5673; creates absurd_dev)
npm run db:migrate      # apply migrations to the dev database (.env)
npm test                # node --test, mock-free; Testcontainers owns the test Postgres (see below)
npm run bench           # engine scan benchmark (in-memory seed, no DB)
```

Environment is split by file: dev reads `.env`, tests read `.env.test` (both gitignored). The process
loads its in-memory Engine from Postgres at boot via `PostgresStore`, then serves reads entirely from RAM.

Database workflow:

- migrations are hand-written SQL in `migrations/*.sql`, applied in order by `src/db/migrate.ts`
- `npm run db:migrate` — apply migrations programmatically to the dev database
- `npm run db:down` — stop the dev Postgres container

The **test** schema is NOT applied via a script. `npm test` runs `test/global-setup.ts`, which (by default)
boots a reusable Testcontainers Postgres (`postgres:18-alpine`), builds a golden template `absurd_golden`
once via the migration runner, and clones a fresh per-file database from it for each DB test file. To run
against an external/compose Postgres instead, set `TEST_DATABASE_URL=postgres://<superuser>@host:port/<db>`
(admin/superuser-capable; must NOT point at `absurd_golden`). On that escape-hatch the external server will
accrue `absurd_golden` plus transient `t_*` per-file databases that it does not auto-reap.

## Deployment

A conti project (`conti init`) runs as **one process**: the content API under `/api` and the prebuilt admin
SPA at the root `/`, served from RAM. The admin bundle ships inside `@conti/core` (no per-project build).

**Same-origin (recommended).** Put a reverse proxy with TLS in front; admin and API share one origin, so the
admin calls a relative `/api`, cookies are same-origin, and there is no CORS. Nothing to configure.

```caddy
example.com {
  reverse_proxy 127.0.0.1:3000   # both / (admin) and /api (content API) — one upstream
}
```

**Separate admin origin** (e.g. `admin.example.com` + API on `example.com`). Set two env vars:

- `CONTI_PUBLIC_URL=https://example.com` — the API's own public origin. The admin's API base can't be baked
  into the prebuilt bundle, so the server injects `window.__CONTI__.apiBase = https://example.com/api` into
  the served `index.html` at runtime (no rebuild).
- `CONTI_TRUSTED_ORIGINS=https://admin.example.com` — the origin(s) allowed to call the API with credentials
  (comma-separated). This switches on the whole credentialed cross-origin bundle: CORS (exact `Allow-Origin`
  echo + credentials + preflight), a CSRF Origin-check on every write, and `SameSite=None; Secure` session
  cookies. Each must be a bare https origin (no `*`, no path) — validated at boot.

Both must be `https` (SameSite=None requires Secure). Same-origin (the default) needs neither — the admin
calls a relative `/api`, cookies stay `SameSite=Lax`, and there is zero CORS surface.

> **Sub-path mounting is not supported.** The admin is served at the origin **root** only — the prebuilt
> bundle references its assets at an absolute `/assets/…`, so hosting it under a path (`example.com/cms`)
> would break asset loading. Give it its own (sub)domain instead. This is why `CONTI_PUBLIC_URL` must be a
> bare origin with no path.

## Roadmap

- [x] Columnar storage + scan, equality / sorted / substring / relation indexes
- [x] Strapi v5 filter/sort/pagination parser with schema validation
- [x] Late-materialization output arena + assembled-buffer response cache
- [x] uWebSockets.js HTTP layer (single-process)
- [x] Postgres `Store` seam — boot load from Postgres (hand-written SQL migrations, PK-addressed `id`)
- [x] Write path — POST/PUT/DELETE → Postgres (source of truth) → per-type engine rebuild (strict body validation)
- [x] Dynamic content-types — real table-per-type + Kysely runtime DDL, broad type catalog (i64/decimal/json exact), RAM registry
- [x] Content-Type Builder HTTP API — create/alter/drop types + fields at runtime, live (no restart)
- [ ] AuthN/authZ — gate the Builder (and writes) behind an admin scope
- [ ] Surgical writes — incremental in-engine update/delete + targeted cache invalidation (replace the full rebuild)
- [ ] Redis pub/sub `ChangeBus` for multi-instance invalidation
- [ ] Keyset/cursor pagination; selectivity-based predicate ordering
- [ ] String collation for sorted indexes; relations from Postgres

## License

Not yet specified.
