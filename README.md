# absurdFastCMS

An *absurdly fast* headless CMS. Postgres is the source of truth, but reads never touch it — they
are served from an in-process, columnar, in-memory read layer with pre-serialized response bytes.
The query API speaks Strapi v5's bracket-filter syntax, so existing clients work unchanged.

> **Status:** early development. The read engine, the Strapi-style query parser, the HTTP layer, the
> Postgres source-of-truth, the write path, and the runtime content-type builder are built and tested
> (mock-free, native `node:test`). An admin UI, an SDK, and Redis-based multi-instance invalidation are
> planned.

## Monorepo layout

This is an npm-workspaces monorepo. `packages/*` holds publishable/importable units; `apps/*` holds
deployable sites.

```
packages/
  api/        # @absurd/api — the columnar read engine + Strapi-v5 query API + runtime content-type builder
  admin/      # (planned) the content manager / content-type builder GUI
  sdk/        # @absurd/sdk — typed, isomorphic, zero-dependency JS client for the query + write + Builder API
apps/
  landing/    # (planned) marketing site
  docs/       # (planned) documentation site
```

The open-source build is single-instance. Multi-instance cache invalidation (Redis pub/sub `ChangeBus`)
is a swappable implementation behind an interface — a separate concern, not core surgery.

## Packages

- **[`packages/api`](packages/api/README.md)** — the backend: architecture, query API, content-type
  builder, performance notes, and getting started. **Start here.**
- **[`packages/sdk`](packages/sdk/README.md)** — `@absurd/sdk`, a typed, isomorphic, zero-dependency
  JS client covering the full HTTP surface: Strapi-v5 filters/sort/pagination/populate, writes +
  relation ops, the runtime content-type Builder, and lossless bigint/decimal/json/date wire fidelity.

## Getting started

Requires **Node.js ≥ 24** (native TypeScript type-stripping — no build step) and **Docker** (Postgres 18).

```bash
npm install              # installs all workspaces (deps hoist to the root)
npm run db:up            # start Postgres 18 for DEV (delegates to @absurd/api)
npm run db:migrate       # apply migrations to the dev database
npm test                 # run the api test suite (mock-free, Testcontainers-backed)
```

Each command at the root delegates to the relevant workspace; you can also `cd packages/api` and run
its scripts directly. See [`packages/api/README.md`](packages/api/README.md) for the full backend docs.

## License

Not yet specified.
