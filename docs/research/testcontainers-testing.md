# Test isolation via Testcontainers — research + decisions (June 2026)

Multi-agent research (4 survey angles → synthesis → adversarial fact-check vs primary sources +
empirical check on Node 24.2). Verdict: core architecture **SOUND, high confidence**; several
report claims were corrected (below).

## Decision (locked)

Replace the shared-DB manual isolation (api_id prefixes + `test/catalog-lock.ts` advisory lock) with:

**ONE reusable Postgres container (owned by Testcontainers) + a fresh DATABASE per test FILE, cloned
from a golden TEMPLATE.** Migrations run ONCE into `absurd_golden` in `--test-global-setup`; each file
does `CREATE DATABASE … TEMPLATE absurd_golden` in `before()` (no per-file re-migration) and drops it in
`after()`. Per-file DB = true isolation → delete the advisory lock + prefixes + scoped cleanup.

**Escape-hatch (chosen):** if `DATABASE_URL` is already set, the helper uses it as the admin URL instead
of starting a container (run against any external Postgres / the compose pg, no Testcontainers). Default
(no `DATABASE_URL`) = Testcontainers boots an ephemeral pg → CI-self-sufficient, no manual `db:up`.

## How it works

- `test/global-setup.ts` (passed via `node … --test --test-global-setup=./test/global-setup.ts`):
  start ONE `PostgreSqlContainer('postgres:18-alpine')` `.withReuse()` (local) OR use `DATABASE_URL`;
  build `absurd_golden` once via `runMigrations(goldenUrl)`; expose the admin URI to test child
  processes by MUTATING `process.env` in `globalSetup()` (Node applies the env-diff to spawned workers).
- `test/db-per-file.ts`: `createFileDatabase(label)` → admin handle → `CREATE DATABASE t_<label>_<rand>
  TEMPLATE absurd_golden` (serialized by a NARROW advisory lock only around the CREATE, to avoid
  template-contention) → return a `createSql(fileUrl)`. `dropFileDatabase` in `after()`.
- `src/db/client.ts createSql(url)` and `src/db/migrate.ts runMigrations(url)` are UNCHANGED (already
  take a url). No `src/` runtime change.

## Packages

`@testcontainers/postgresql@^12` + `testcontainers@^12` (dev only). No `pg` needed (we keep postgres.js;
connect by URI). Ships precompiled JS+d.ts → imports fine under Node native type-stripping (no build).

## Verdict corrections (the report was wrong here — DO these instead)

- `await using` is NOT rejected by type-stripping (it's ES2026 Explicit Resource Management, valid JS;
  verified on Node 24.2). Using module-scoped `let container` + explicit `stop()` is a STYLE choice, not
  a necessity.
- reuse opt-in in node is `TESTCONTAINERS_REUSE_ENABLE` env / `.withReuse()` in code — NOT the Java
  `.testcontainers.properties` file (that does nothing in node). "Experimental" is a Java-doc label.
- Do NOT set `TESTCONTAINERS_RYUK_DISABLED=true`: reuse already survives via label-exclusion (reuse-marked
  containers don't get the session-id label Ryuk watches); disabling Ryuk globally can leak containers.
- The global-setup → child-process env propagation (env-diff) is REAL but UNDOCUMENTED, on a Node
  Stability-1.0 feature (`--test-global-setup`, added Node 24.0). This is the main fragility risk.
- `PostgreSqlContainer` wait = healthcheck + listening ports (not a log wait); no sleep needed.

## Config defaults

- reuse: local only; CI sets `TESTCONTAINERS_REUSE_ENABLE=false`, Ryuk ON (fresh container reaped).
- Pin `postgres:18-alpine` (match dev/prod PG18); ideally a digest.
- Connection hygiene (so `node:test` EXITS): every postgres.js handle `await sql.end()` in `after()`/
  `finally`; admin handles `.end({ timeout: 5 })`.
- Keep a NARROW advisory lock only around `CREATE DATABASE … TEMPLATE` (template-contention), NOT the
  whole-suite catalog lock.

## Delete vs keep

DELETE: `test/catalog-lock.ts`, api_id prefixes (`ps_`/`wr_`/`m_`/…), `LIKE` scoped cleanup, per-file
`runMigrations()` in `before()`. KEEP: `createSql`/`runMigrations`/`_migrations` table, mock-free real-PG
posture, `.env`/`.env.test` split. `write.test` no longer needs to be the sole `article` owner (each
file has its own DB), but seeding `article` per file is fine.

## Open questions (resolved/deferred)

1. PG ownership → Testcontainers-default + DATABASE_URL escape-hatch. (RESOLVED)
2. Exact `postgres:18-alpine` digest → pin during impl (tag acceptable v1).
3. `dropFileDatabase` in CI → optional (container discarded); keep for local cleanliness.
4. Docker-for-local mandated → escape-hatch covers "no Docker" (set DATABASE_URL).
5. create-lock over-engineering at ~10 files → keep narrow lock (cheap insurance).
