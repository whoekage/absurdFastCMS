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
  → **DECIDED (S4): (a) diff-at-deploy.** The "applied" state is stored as a `_schema_applied` snapshot of
  OUR canonical schema JSON (not introspected DB metadata) — so the diff compares like-for-like and never
  produces a phantom diff from type-spelling/default/collation normalization (the churn class that forces
  Atlas's `--dev-url`). (b) capture-to-file remains a future upgrade if explicit reviewable SQL is wanted.

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
- **S3 — diff engine.** SHIPPED (`db/schema/diff.ts`). Pure `diff(prev, next)` by stable id → an ordered
  `ChangeSet`. Ops: addType / dropType / renameType (apiId→table rename) / setTypeOption (D&P/i18n toggle) /
  addField / dropField / renameField / retypeField / setFieldNullable / reorderFields. EACH op carries a
  `risk` (`safe` | `data-dependent` | `destructive` | `forbidden`) — the seam the S4 lint gates on per-op
  (not one global `--force`). Cross-ecosystem lessons baked in (see the diff-engine survey): id-matching
  makes rename-vs-recreate decidable (kills the Strapi #12626/#19141, Prisma #4694, Alembic, TypeORM-sync,
  Directus rename-data-loss class); a field that renames AND retypes in one step emits BOTH ops (impossible
  for Django/Drizzle name-pairing); REORDER is wire-only (`sort`, never physical column position);
  presentation (`info`, derived `collectionName`) emits no DDL (Directus #10755); type changes reuse
  `classifyTypeChange`; `diff(x,x)` is empty (anti-churn idempotency invariant). Relations + component-type
  schemas DEFERRED (fail loud, consistent with S1). Exhaustive pure unit tests; no DB.
- **S4 — migrate + lint.** SHIPPED (`db/schema/migrate.ts`). `migrate(sql, schemaDir, {allowDestructive})`
  diffs the committed files against the STORED applied snapshot (`_schema_applied`, our canonical JSON —
  NOT introspected DB metadata, so no phantom-diff churn), gates, and applies the change-set in ONE
  transaction via the existing `ddl.ts` compile-only builders (+ two new ones: `compileRenameTable`,
  `compileSetColumnNotNull`). Per-op gate: `forbidden` always blocks; `destructive`/`data-dependent` block
  unless `allowDestructive` (the `migrate lint` engine reports the blocked subset without applying). reorder
  is a NO-OP (file order drives the registry); `setTypeOption` (D&P/i18n toggle) is DEFERRED (loud). Idempotent
  (a no-change re-run is a no-op). `_schema_applied` is created on-demand like `_migrations` (no hand-written
  migration file). Real-PG tests prove: rename preserves data (the Strapi #12626/#19141 fix), rename-TYPE
  preserves data, drop blocked-without-ack, add NOT NULL + default backfills, retype gated + value carried
  across the cast. The CLI wires `conti migrate [--allow-destructive]` + `conti migrate lint` to these via
  the `compose/migrate.ts` wrappers (resolve config → db + schema dir, run base migrations, then the
  files-first migrate); a blocked migration prints a clean message and exits 1.
- **S5 — codegen (DONE) + Builder rewrites schema.json + START the CONTRACT.**
  - **codegen — SHIPPED (`db/schema/codegen.ts`).** Pure `generateTypes(schemas) → content-types.d.ts`
    (CmsType→TS, enum→literal union, nullable→`?: T|null`, i64/decimal→string, conditional D&P/i18n system
    fields; component/relation/json→`unknown` until their files-path support lands). The Builder will call it
    as a side-effect; `conti gen:types --check` will be the CI freshness gate.
  - **Builder + contract — BLOCKED, sequencing corrected.** The Builder's write target flips PG-meta →
    `schema/*.json`, and the contract deletes `Registry.build(sql)` + the meta repos and migrates the ~25
    `Registry.build`/`loadWithRegistry` test call sites to `Registry.fromSchemas`. BUT a recon found the
    blocker: those call sites include the relation / component / media tests, and S1/S3/S4 **deferred
    relations + components in the files path** (`diff`/`migrate`/`fromSchemas` throw on them). So the contract
    CANNOT reach its "`grep Registry.build` → ZERO" done-gate until the files path supports relations +
    components. **New prerequisite slice S4.5 (relations + components in model/diff/migrate/fromSchemas)
    must land BEFORE the contract.** Until then the compat shim stays.
- **S6 — prod lifecycle wiring.** `conti migrate` on `conti start`/deploy from committed `schema/`; prod
  Builder-lock; the documented dev→prod flow; an e2e (edit → migrate → serve → rename → data intact).

Dependencies (CORRECTED): S1 (EXPAND) → S3 → S4 → **S4.5 (relations + components in the files path —
prerequisite for the contract)** → S5 (codegen ✓ + Builder rewrite + START the CONTRACT) → S6 (FINISH the
contract: drop the meta tables, prod lifecycle). The compat shim `Registry.build(sql)` lives until the
contract — it is scaffolding, never permanent, but it cannot be removed until S4.5 unblocks the relation/
component test call sites.

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

## 10. Build-vs-buy: the migrator stays ours (decided)

Considered replacing our diff+migrate with Drizzle Kit / TypeORM / Atlas / Prisma / Stripe pg-schema-diff.
Verdict after a 3-angle source-level review: **keep our engine.** Adopting any of them is a DOWNGRADE.

- **Drizzle Kit** — `drizzle-kit/api` (`generateMigration`) is undocumented + version-unstable + **ESM-broken**
  (#2853 "Dynamic require of 'fs' is not supported") → collides with our no-build type-stripping; rename
  detection lives in **interactive TTY prompts** (hanji) that can't run headless; can't do rename+retype
  together (#3826); models DB columns only.
- **TypeORM** — migration generation is **CLI-only** (#4494 closed not-planned), needs decorators/build step,
  **no rename detection** (always drop+add). Worst fit.
- **Atlas / Prisma / Stripe pg-schema-diff** — Go/Rust binaries (shell-out, breaks `npm i`); and **none do
  id-based rename** — even Stripe's pg-schema-diff is name-based (rename = drop+add), i.e. worse than ours.
- **No rich-field-model CMS hands a static schema to an ORM.** The two that reuse an ORM migrator
  (Payload→drizzle-kit, Keystone→Prisma) **generate the ORM schema from their own field config at runtime** —
  they still own the bridge (the larger half). Strapi + Directus wrote their OWN diff on a query builder —
  exactly our ~300 lines on Kysely. All of them lose data on rename; our stable-id rename-safety is unique.

We already buy the dangerous parts (Kysely compile-only DDL + postgres.js apply); the only custom part is the
stable-id diff — which no commodity tool offers. **Steal ideas, not tools:** (1) Atlas's analyzer taxonomy
(DS101/MF103/BC101…) → named lint codes; (2) Stripe's temp-DB plan validation → dry-run DDL on an ephemeral
schema before the live apply. Expand-contract (pgroll/reshape) is YAGNI for single-instance — documented
escape hatch only.

## 11. Authoring PIVOT: TS DSL (code-first) feeding the kept migrator

Schema source moves from `schema/*.json` to `schema/<apiId>.ts` — a conti DSL (Payload/Drizzle-style),
typed, with colocated lifecycle hooks. The migrator/IR/engine are UNCHANGED; only the authoring→IR layer
swaps (parse JSON → import module + introspect the DSL → the same `ContentTypeSchema` IR).

```ts
import { defineType, c, type InferType } from '@conti/core';
const Article = defineType({
  id: 'ct_article',
  options: { draftAndPublish: false, i18n: false },
  fields: {                                   // Builder rewrites ONLY this literal (AST), hooks preserved
    title:  c.string(['', { id: 'f_title', max: 512 }][1]),
    status: c.enum(['draft','published','archived'], { id: 'f_status', nullable: false }),
    author: c.relation('writer', { id: 'f_author', kind: 'manyToOne', inverse: 'posts' }),
  },
  hooks: { beforeCreate: (entry, ctx) => {/* ... */} },
});
export default Article;
export type Article = InferType<typeof Article>;   // types for free, no codegen
```

- Field/type **`id` is optional**; absent ⇒ id = the key/apiId (name-based); pin an explicit id to make a
  rename lossless (id-match → RENAME). Keeps our rename-safety as an opt-in.
- Types come from the builder generics (phantom `T`), not a separate codegen; runtime validation stays
  registry-driven (no redundant zod object). `c.*` can later also expose a zod validator for the SDK.
- Visual Builder REMAINS: it AST-rewrites only the `fields` literal (dev-only, off the hot path), leaving
  `hooks` untouched. Introspection (engine/migrate/types) just executes the module — no AST.
- Phases: (1) DSL `defineType`+`c.*`; (2) `defToSchema` (DSL→IR) + equivalence vs the JSON-IR; (3) TS loader
  + `article.ts` + createConti/migrate switch; (4) hooks registry + write-path; (5 later) Builder AST-write.

## 12. Content lifecycle hooks — domain responsibility (pivot phase 4, DONE)

Researched across Strapi/Payload/Directus/Keystone/Sanity + ORMs (TypeORM/Sequelize/Mongoose/Prisma).
Convergent model: TWO classes split on the COMMIT boundary, owned by the content-service seam (NOT the
HTTP transport, NOT the per-row db repo — the Strapi-v5 lesson: row-level hooks multi-fire on D&P/i18n and
lose the semantic event).

- **`before*` — TRANSFORM + VETO.** Runs INSIDE the write transaction, pre-persist. RETURN-value mutation
  contract (Payload/Directus, not mutate-in-place): receives `data`, returns the (possibly transformed)
  data to persist. THROW vetoes → rollback → 400 (`HookError` for a clean message). No side-effects.
- **`after*` — REACT.** Runs AFTER commit + the read-engine rebuild, with the committed row. Side-effects
  only; ISOLATED so a throw is logged, never fatal (the TypeORM #2816 / Sequelize #8585 / Mongoose #8618
  footgun, avoided by construction).

Seam: `handleWrite` already had the ideal shape — `row = await sql.begin(tx => …write…)` then
`await rebuild(type)`. `before*` slots at the top of the `sql.begin`; `after*` after `rebuild`. The
columnar-engine rebuild is the FIRST post-commit step (infrastructure, not a user hook), so `afterCreate`
observes the committed row already queryable. Wiring: hooks are `defineHooks({...})` in the entity's
`hooks.ts` (§13); `loadTypes` returns `{ schemas, hooks: Map<apiId,Hooks> }`; `createConti` builds a
`HookRegistry` → `createServer` → `WriteContext.hooks`; `handleWrite` dispatches create/update/delete
(variant-create + publish deferred). Hookless servers are byte-identical (the dispatch is guarded).

Footguns designed out: no side-effects in `before` · after-throw swallowed+logged · `HookError`→400 vs a
generic throw→500. Deferred: a tx handle / auth principal in the hook ctx, a recursion guard, and a
transactional OUTBOX for durable post-commit side-effects (email/webhooks — be-07).

## 13. Project layout — `entities/<apiId>/` (one folder per content-type)

Final source layout (Strapi-style, naming chosen deliberately — `entities` over `schema`/`api`, matching how
we already speak of "entities"):

```
entities/
  article/
    schema.ts        export default defineType({ id, options, fields })   [required]
    hooks.ts         export default defineHooks({ before*/after* })        [optional]
    services.ts      custom reusable domain fns   [reserved — not loaded yet]
    controller.ts    custom routes beyond CRUD    [reserved — not loaded yet]
  components/
    seo/schema.ts    component definitions (no hooks/services)             [loader: future]
```

- **apiId = the FOLDER name** (rename the folder → rename the type; the stable `id` keeps it lossless).
- The loader (`loadTypes`) scans `entities/*/`: an entity is a subdir containing `schema.ts`; it pairs an
  optional `hooks.ts`. The `components/` grouping dir is skipped by the content-type loader (it has no
  top-level `schema.ts`) and reserved for the future component loader.
- **Why two files, not one (`defineType({ hooks })`):** the visual Builder OWNS + regenerates `schema.ts`
  wholesale (pure codegen from the edited schema — NO AST/ts-morph surgery), and NEVER touches the dev-owned
  `hooks.ts`/`services.ts`/`controller.ts`. Clean machine/human split = no fragile in-place file rewriting.
- Config: `ContiConfig.entities.dir` (default `<cwd>/entities`); `conti init` scaffolds `entities/article/`
  with all four files (services/controller commented placeholders).

## 14. Migration edge-case sweep — what we handle, what we don't (found by a workflow)

An 8-agent adversarial workflow wrote 74 real-PG migration tests (test/migrate-edge-*.ts) — create entity →
insert real rows → migrate → SELECT + assert data. All 74 green. The sweep HANDLES (verified with data):
rename (field + type, lossless via stable id; rename+retype together; rename round-trip; the stable-id-vs-
new-id contrast proving id-matching prevents loss), drop (gated; sibling data intact; re-add is fresh),
retype safe casts (int→bigint, varchar grow, decimal — values carried), nullability + defaults (NOT NULL+
default backfills; NOT NULL w/o default on populated gated; nullable→NOT NULL with NULLs gated), multi-op in
ONE migrate (rename+add+retype atomic, data preserved, topological order), transactional rollback (a blocked
or failing op applies NOTHING — no partial), idempotency + the full lifecycle, relations (link tables +
edges survive unrelated migrations; drop keeps endpoint rows).

Three engine/harness fixes the sweep forced:
- **diff ordering:** `dropField` now precedes field renames/adds within a migrate, so dropping `legacy` +
  renaming `current`→`legacy` (or dropping `headline` + adding a new `headline`) in ONE migrate works
  (previously collided with the not-yet-dropped column). 
- **enum value-set change (FIXED):** the `retypeField` apply now treats enum involvement as a CHECK swap —
  drop the old `<table>_<col>_check` (discovered via `pg_constraint`), alter the varchar type ONLY on a
  category change or a GROW (never a shrink, which would truncate in-use values), then add the new CHECK with
  the next value-set (`compileAddCheck`/`compileDropConstraint` in `ddl.ts`). ADD a member → grown + insertable;
  REMOVE an unused member → enforced; REMOVE an in-use member → the new CHECK is validated against the live row,
  fails, and the whole migrate rolls back (old CHECK restored, data intact). Pinned by 3 tests in
  `migrate-edge-retype.test.ts`.
- **test harness:** `cleanCatalog` now sweeps `*_lnk` link tables by name (the files-first migrate writes no
  meta, and `DROP ct_x CASCADE` only drops the FK, not the link table) — they lingered across tests.

KNOWN LIMITATIONS found (data is SAFE in all — they reject/roll back, never corrupt — but the op is
unsupported; each is pinned by a passing test asserting the current behaviour):
1. **field-name SWAP in one migrate** (rename A→B AND B→A): rejected (Postgres 42701) + atomic rollback.
   Needs intermediate temp-name staging. Rare; two-step rename works today.
2. **lossy shrink on ack** (varchar shorten / decimal scale reduce): once `allowDestructive` is given, PG
   truncates/rounds silently rather than failing loud on rows that would lose information. A data-loss
   surface distinct from the rollback path — arguably acceptable (it was acked) but worth a pre-flight check.
