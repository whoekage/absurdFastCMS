# Schema source-of-truth — files-first (schema.json) + stable IDs + migrate-from-file

> Decision + detailed implementation plan. conti PIVOTS from DB-first (Builder writes PG, engine loads
> schema from `content_types` tables) to **files-first**: a committed `schema.json` is the source of truth,
> the Builder (dev only) REWRITES it, and the DB is migrated FROM the file. This gives the Strapi/Payload
> prod lifecycle (git-versioned, reviewed, prod-locked) the user wants, and — via stable field IDs — fixes
> the data-loss-on-rename bug Strapi never solved.

## 1. Strapi research (what we mirror, what we improve)

**Mirror (Strapi got these right):**
- **schema.json shape:** `kind`, `collectionName` (the DB table name — DECOUPLED from the display name, so
  a display rename never touches the table), `info { singularName, pluralName, displayName }`, `options`
  (draft&publish, etc.), `attributes { <key>: { type, ...opts } }`. Files live in the repo + are committed.
- **Builder is dev-only:** the Content-Type Builder requires `autoReload` and is DISABLED in `strapi start`
  (prod) — schema changes flow through code + redeploy. This IS the prod-lock we want.
- **Migrations run on boot BEFORE the auto schema-sync**, with the full Knex API (incl. rename helpers).
  Ordered files. dev→prod = ship the schema files + run in prod.

**Improve (Strapi's unsolved pain):**
- **RENAME = data loss.** Strapi identifies a field BY ITS NAME (the attribute key). Renaming = a new key =
  "drop old column + add new column", silently losing data ([#12626], [#19141]); the only fix is a
  hand-written Knex migration. Their CTB-refactor for graceful rename is indefinitely deferred.
- **Our fix:** every content-type and field carries a STABLE `id` separate from its `name`. The diff matches
  by `id`, so a rename is `id` unchanged + `name` changed → emitted as `ALTER ... RENAME COLUMN` (instant,
  lossless in Postgres). No guessing, no data loss, no manual migration.

## 2. Target model

```
project/
  schema/
    <apiId>.json          # one file per content-type (reviewable diffs), source of truth
  generated/
    content-types.d.ts    # TS types codegen'd from schema/   (committed; CI checks freshness)
    validators.ts         # Zod validators codegen'd from schema/
  migrations/
    2026..._<desc>.sql     # generated, data-preserving ALTERs (optional artifact; see §6)
```

- **JSON is the source** (Builder writes/diffs it mechanically); **Zod + TS types are GENERATED from it**
  (Builder-authored Zod-TS would be fragile codegen). Best of both: JSON truth + Zod runtime validation + types.
- **Stable IDs:** every type and field has `id` (short uid, never changes) + `name` (the API key / column
  name). Physical column = `name` (readable); rename = `id`-matched diff → `ALTER RENAME COLUMN` (safe).
  *(Alternative considered: column = `id` so rename is metadata-only/no-DDL; rejected — opaque columns,
  harder debugging. Postgres `RENAME COLUMN` is instant + lossless, so `name`-as-column is safe enough.)*
- **Registry loads schema from `schema/`** (not from `content_types` PG tables). The columnar engine + the
  zero-PG read path + byte-identical output are UNCHANGED — only the schema SOURCE moves; DATA stays in PG.
- **Prod:** Builder OFF; `conti migrate` applies the committed schema to PG on deploy.

### schema.json (per type) — proposed shape
```json
{
  "id": "ct_a1b2c3",
  "apiId": "article",
  "collectionName": "ct_article",
  "info": { "singularName": "article", "pluralName": "articles", "displayName": "Article" },
  "options": { "draftAndPublish": false, "i18n": false },
  "fields": [
    { "id": "f_x1", "name": "title",  "type": "string",      "options": { "length": 512, "nullable": true } },
    { "id": "f_x2", "name": "status", "type": "enumeration", "options": { "values": ["draft","published","archived"], "nullable": false } }
  ]
}
```
`id`s are the identity; `apiId`/`name`/`collectionName` are renamable labels. Field order is preserved
(byte-identical wire ordering).

## 3. The dev → prod lifecycle (the user's Strapi-grade flow, with a live dev Builder)
```
dev:   Builder edit → rewrites schema/<apiId>.json (PRESERVING ids) → conti migrate (local) applies to dev-PG
git:   commit schema/ + generated/ → PR → conti migrate lint (CI) → review → merge
prod:  deploy → conti migrate (from committed schema/) → data-preserving ALTERs → engine rebuilds
       Builder is OFF in prod; schema changes ONLY via the committed files
```

## 4. The diff engine (the heart — by stable id)
`diff(prevSchema, nextSchema)` → an ordered change-set, matching types/fields BY `id`:
- type: `addType` / `dropType` / `renameType` (id match, name change) / `retableType` (collectionName change)
- field: `addField` / `dropField` / `renameField` (id match, name change → `RENAME COLUMN`) /
  `retypeField` (type/options change → `ALTER TYPE` or expand-contract) / reorder (wire-only)
- "prev" = the last-applied schema (a committed snapshot / a `_schema_applied` row), so deploy diffs
  committed-vs-applied, dev diffs file-vs-live. Pure + exhaustively unit-tested (no DB needed for the diff).

## 5. Lint (destructive-op gate — Atlas-inspired)
`conti migrate lint` flags, and BLOCKS without an explicit ack, the data-dangerous ops:
- `dropField` / `dropType` (data loss), `retypeField` that can't losslessly cast, adding `NOT NULL` without
  a default to a non-empty table. Renames are SAFE (RENAME COLUMN) → never flagged. Runs in CI on the PR.

## 6. Migrate execution — two viable shapes (decide in S4)
- **(a) Diff-at-deploy (declarative):** `conti migrate` computes the diff (committed schema vs applied) at
  apply time → ALTERs. No migration files. Simpler; the diff engine + stable ids make it rename-safe.
- **(b) Capture-to-file:** the diff is written to a timestamped `migrations/*.sql` at edit/commit time;
  prod replays files. More reviewable (explicit SQL in the PR), Rails-like.
  → Lean **(a)** first (less moving parts; the schema.json IS the reviewable artifact), keep (b) as an
  upgrade. Either way the engine is the same diff + DDL; only WHERE/WHEN the SQL is materialized differs.

## 7. Slice decomposition (each: tested, real-PG suite as oracle, no behaviour/byte regression)

- **S1 — schema model + loader + Registry-from-DATA (EXPAND-CONTRACT, zero test-thrash).** The chosen
  strategy is EXPAND-CONTRACT, *not* a one-shot source flip — so the existing suite stays a behaviour-
  preserving ORACLE the whole way (tests do NOT change with the code, so a green suite proves no regress).
  Steps:
  1. NEW pure modules (no behaviour change, unit-tested standalone): `schema/model.ts`
     (`ContentTypeSchema`/`FieldSchema` with stable `id`+`name`, Zod-validated); `schema/serialize.ts`
     (parse/stringify one `schema/<apiId>.json` + `loadSchemaDir`); `schema/adapt.ts` (`schemaToRows`,
     reusing the meta writer's own `resolveFields` so a file resolves byte-identically; the reverse
     `rowsToSchema` is DEFERRED to S5, where the Builder's meta→file export needs it).
  2. Refactor `Registry` to assemble defs FROM schema OBJECTS — `Registry.fromSchemas(schemas, components)`
     — `schema → rows (schemaToRows) → the SAME buildDef` the meta path uses. The Registry gains a
     file-driven entry that consumes schema as DATA; the FILESYSTEM read lives at the EDGE
     (`createConti`/the seed read `<projectDir>/schema/`), NEVER inside the Registry (so per-file-DB tests
     cannot cross-contaminate through a shared on-disk dir).
  3. LEAVE `Registry.build(sql)` UNCHANGED as the **TEMPORARY** compat shim — it still reads the meta tables
     → `buildDef` directly (it does NOT route through schema). This is SCAFFOLDING — flagged for deletion in
     the Cleanup ledger (§7.1). Because it is untouched, ALL ~30 existing `Registry.build(sql)` call sites +
     the full suite stay GREEN, byte-identical — and a real-PG oracle asserts `fromSchemas(article.json)`
     builds a def byte-identical to `build(sql)`, proving the file path is behaviour-equivalent.
  4. Prove the REAL file path end-to-end: commit `packages/api/schema/article.json` (the demo seed,
     replacing the in-code `ARTICLE_SEED_FIELDS`), and have `createConti` read `<projectDir>/schema/` →
     schemas → engine/registry. `ct_article` is still MATERIALISED by the existing DDL path (real
     migrate-from-file is S4).
  Out of scope for S1 (deferred): removing the meta WRITE (Builder still writes meta until S5); removing the
  meta tables / the compat shim (Cleanup ledger §7.1); the diff engine (S3); migrate (S4). *Biggest slice —
  but de-risked into a pure-add + a behaviour-preserving refactor.* Oracle: full suite byte-identical + new
  unit tests on the model/serialize/adapt round-trips.
- **S2 — codegen FUNCTION (folds into S5, not a standalone command).** A pure `generate(schema) →
  { content-types.d.ts, validators.ts (Zod) }` that the BUILDER calls whenever it rewrites a schema file —
  types/validators are a side-effect of the Builder edit, never a manual daily step. A THIN
  `conti gen:types --check` exists ONLY as a CI freshness gate (catches a hand-edit to schema.json that
  bypassed the Builder) + a manual regen escape valve. Test: generated output matches the schema; `--check`
  fails on drift.
- **S3 — diff engine.** Pure `diff(prev, next)` by id → change-set (§4). Exhaustive unit tests (add/drop/
  rename/retype/reorder, incl. id-matched rename, nested components). No DB.
- **S4 — migrate + lint.** Apply the change-set to PG (data-preserving DDL via the existing `ddl.ts` +
  `migration.runner.ts`); `_schema_applied` tracking; `conti migrate lint` destructive gate. Real-PG tests:
  rename preserves data, drop blocked-without-ack, retype, add-with-default.
- **S5 — Builder rewrites schema.json + START the CONTRACT (delete the scaffolding).** The Builder's write
  target flips PG-meta → `schema/*.json` (preserving ids; mint a new id only for genuinely-new fields); dev
  edits call `conti migrate` locally. Builder routes GATED OFF in prod (env). With files now the source, the
  meta tables are 100% redundant — so this slice BEGINS the contract phase of the Cleanup ledger (§7.1):
  delete `Registry.build(sql)` + the meta-read repos, re-point `loadWithRegistry`, migrate the ~30 test call
  sites to `Registry.fromSchemas`. Tests: a Builder edit produces the right file diff + a rename keeps the
  same `id`. (§7.1's table-drops + final grep-clean finish in S6.)
- **S6 — prod lifecycle wiring.** `conti migrate` on `conti start`/deploy from committed `schema/`; prod
  Builder-lock; the documented dev→prod flow; an e2e (edit → migrate → serve → rename → data intact).

Dependencies: S1 (EXPAND) → S3 → S4 → S5 (Builder rewrite + codegen side-effect, the S2 function + START of
the CONTRACT phase per §7.1) → S6 (FINISH the contract: drop the meta tables, prod lifecycle). The compat
shim `Registry.build(sql)` lives ONLY between S1 and S5 — it is scaffolding, never permanent.

### 7.1 Cleanup ledger — the scaffolding S1 adds, and where it ALL gets DELETED (contract phase, S5→S6)

S1's expand-contract leaves exactly ONE piece of deliberate, TEMPORARY scaffolding: the meta→schema compat
shim. Once files are the source of truth (the Builder writes files — S5), the meta tables are 100% redundant
with `schema/*.json`, and EVERYTHING below is removed. Nothing here is permanent — this is the contract
checklist.

- **`Registry.build(sql)` — THE HEADLINE. DELETE IT EVERYWHERE.** It exists ONLY as the S1 compat shim.
  - the method itself in `db/registry.ts` → removed (the real, permanent entry is `Registry.fromSchemas`).
  - `PostgresStore.loadWithRegistry` / `load` → re-pointed to read schemas from `<projectDir>/schema/` (the
    EDGE), NOT from `Registry.build(sql)`.
  - the ~30 test call sites of `Registry.build(sql)` → migrated to `Registry.fromSchemas(...)` (or a
    `loadSchemaFixtures()` test helper). **Done = `grep -rn 'Registry\.build' packages` returns ZERO.**
- **Meta-READ repo fns** — `listContentTypes` / `getContentType` / `getFields` / `getRelations`
  (`content-type.repository.ts`); `listComponentTypes` / `getComponentType` / `getComponentFields`
  (`component-type.repository.ts`) → removed (only the shim read them).
- **Meta-WRITE path** — `createContentType` / `addField` / `renameField` / `dropField` / `changeFieldType` /
  … in the repos → their meta-table INSERT/UPDATE/DELETE is removed; the Builder writes FILES instead. The
  Kysely DDL COMPILERS in `ddl.ts` STAY (reused by migrate, S4) — only the meta PERSISTENCE dies.
- **Meta TABLES** — `content_types` / `content_type_fields` / `content_type_relations` / `component_types` /
  `component_type_fields` → dropped from `migrations/0001_init.sql` (pre-launch drop&recreate allows it). The
  DB then holds only DATA (`ct_*`), `_migrations`, `_schema_applied` (S4), `files`, and the auth tables.
- **`db/seed.ts`** (`seedArticleIfAbsent` + `ARTICLE_SEED_FIELDS`) → deleted; `schema/article.json` is the seed.
- **`cleanCatalog` test helper** → reworked (it TRUNCATEs the meta tables today; post-contract it resets the
  schema dir + drops only the `ct_*` DATA tables).
- **`schema/adapt.ts` `rowsToSchema` direction** → lands in S5 purely to EXPORT existing meta into the new
  `schema/*.json` files (a one-time migration aid for live dev DBs); contract-phase scaffolding too.

Definition of done for the contract: `grep -rn 'Registry\.build\|content_types\|seedArticleIfAbsent'
packages/api/src` returns nothing but comments, and the suite is green serving FROM FILES alone.

## 8. Risks / edge cases
- **Multi-dev merge:** two devs add fields → two `schema/*.json` diffs; ids prevent collision, but a
  type-level reorder/rename race needs a deterministic merge (ids make it tractable; document the workflow).
- **Dev drift:** dev-PG ahead of committed `schema/` if a dev forgets to commit → `conti schema status`
  surfaces it (file-vs-applied diff).
- **Destructive intent:** an genuinely-wanted drop needs an explicit `--allow-destructive` / an ack token in
  the PR (lint gate).
- **Expand-contract** for unavoidable breaking changes (retype that can't cast): guide add-new → backfill →
  switch → drop-old.
- **The pre-launch policy** (single `0001_init.sql` + drop&recreate) is replaced by this post-pivot; keep it
  until S4 lands.

## 9. What we reuse (not a rewrite)
`ddl.ts` (DDL generation — already emits CREATE/ALTER for Builder actions), `migration.runner.ts` (+
`_migrations` tracking), the columnar engine + zero-PG read path + byte-identical serialization (untouched —
only the schema source moves), the Builder UI + HTTP (write target re-pointed), the CLI (`conti migrate`/
`gen:types` as new commands).
