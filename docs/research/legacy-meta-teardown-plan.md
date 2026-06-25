<!-- legacy-meta-teardown-plan workflow wf_485931d1-e1e: keep-vs-delete boundary + test blast radius, staged, adversarially critiqued. -->

# Legacy Meta-Path Teardown — Staged Plan (files + `_schema_applied` as sole truth)

> ## ▶ RESUME HERE (progress as of 2026-06-26)
> **Stage 0 DONE** (commit `97eb60e`): `components` threaded through `loadFromSchemas`/`swapFromIR` (default `[]`).
> **Stage 1 DONE (migratable set) — full suite green at 1105 pass / 0 fail.**
> - Test helpers in `test/helpers.ts`: `ct(spec)`, `startTestServerFromSchemas(sql, schemas, { components?, seed? })`, `ARTICLE_SCHEMA`, `startTestServerFromFilesWithAuth`. `cleanCatalog` now ALSO `DROP TABLE IF EXISTS _schema_applied` + `ALTER SEQUENCE IF EXISTS document_id_seq RESTART` (plan step 1.2) so per-test re-`migrate()` diffs from an empty snapshot.
> - Migrated (earlier commits `3a0f244`/`9127359`/`43ecdb1`): `write`, `load`, `entry-repo-backstop`, `postgres-store`, `entry-types`, `hooks.e2e`, `draft-publish`, `i18n`, `write-security`.
> - Migrated THIS pass: `sparse-field-selection.e2e` (+`cleanCatalog` reset, `27267b6`); the 4 relation GIANTS `relation-load`/`-filter`/`-populate`/`-write` (`5219408`); media `media-field.e2e`/`media-upload.e2e` (`87fb188`, def-projection asserts moved onto the returned `registry.mediaFields`); component `i18n-media.e2e`/`component-write.e2e`/`relation-in-component.e2e` (`980f14b`, per-test files-first servers + in-memory `ComponentSchema[]` via a local `cmp()` helper; **relation-in-component R0 retired + R0b merged → documented −2 coverage delta**); auth `auth.bridge`/`auth.team`/`auth.tokens` (`2efd4f8`, ONLY the `loadWithRegistry`→`loadFromSchemas` load path; **better-auth wiring untouched**).
> - PROVEN PATTERNS: `migrate(sql, schemas, {allowDestructive:true})` creates `ct_*`; link-table names via `deriveLinkTableName(owner, field)` or the built `registry` (replacing `addRelation`'s `rel.link_table`); the unpopulated-bytes test reuses a STABLE type id (spread the schema) so an added relation diffs as `addRelation`, not drop+recreate; a JSDoc string MUST NOT contain `ct_*/...` (the `*/` closes the comment).
>
> **DEFERRED (user decision 2026-06-26): `auth.route-gating.e2e` is NOT migrated in Stage 1.** It asserts 401/403/2xx gating on the LEGACY `POST /content-types` controller + `content_types` meta rows; under the files-first builder those routes 410. **REWRITE it in Stage 3, at the moment the legacy content-type controller it gates is deleted** (re-express the gate matrix onto the surviving `builder.manage` Builder routes + the data-write/media gates; accept the granular→whole-type collapse, document it in-file). It stays green through Stages 1–2 (controllers still alive). NOTE: the task-prompt phrase "port granular guards onto `preflightValidate`" refers to the `compose/builder.ts:124` SCHEMA-validation guards (the relation-declare field guards, Stage 2.7) — NOT to auth gating.
>
> DO-NOT-MIGRATE (DELETE in Stage 2, they assert the legacy controllers/meta directly): `content-type-meta`, `content-type-builder`, `component-builder.e2e`, `relation-declaration-over-http`, `schema-registry-equiv`; trim `registry.test` build cases; PORT then delete `relation-declare` guards (Stage 2.7).
> Then Stages 2 (boot re-root off `seedFromSchemas`→`migrate()` + delete legacy test files) → 3 (delete controllers/repos meta-writes/`Registry.build`/`loadWithRegistry`/`startTestServer` + **REWRITE `auth.route-gating`**) → 4 (drop meta tables + flip `cleanCatalog`). Full suite must stay green at each stage end.

Keyed to current code. Each stage ends GREEN (tsc + biome + full suite). Order is by dependency + risk: a prerequisite slice (components into the files boot path) MUST land first, then test migration, then the SRC delete, then the table drop LAST.

---

## Keep-vs-Delete boundary (the authoritative ledger)

> RULE: every "KEEP (pure)" symbol below was RE-AUDITED against its actual importers. Do NOT trust an "imported by X" claim without grepping — the repo uses biome, and a kept-but-unimported symbol trips `noUnusedVariables` and turns the stage RED. Before Stage 3, re-grep each kept symbol's importers one more time.

### DELETE whole files
- `src/http/content-type.controller.ts` — `handleContentTypeRequest`, `projectDef`, `mapError`, `syncCreate/syncSchema/syncRelation/syncDrop`.
- `src/http/component-type.controller.ts` — `handleComponentTypeRequest`, `projectComponentDef`.
- `test/content-type-meta.test.ts` — pure meta-repo unit test (asserts table-matches-meta + meta rollback).
- `test/content-type-builder.test.ts` — exercises the legacy mutating `/content-types` controller (files-first replacement = `builder-route.e2e.test.ts`).
- `test/component-builder.e2e.test.ts` — legacy `/component-types` controller.
- `test/relation-declaration-over-http.test.ts` — declares relations over the legacy POST `/content-types` + asserts meta rows.
- `test/schema-registry-equiv.test.ts` — the `Registry.build` ↔ `Registry.fromSchemas` equivalence ORACLE; once `build` is gone there is no oracle. Delete (do NOT half-rewrite).

### GUT (delete exports, keep the file as a pure-helpers module)
- `src/db/content-type.repository.ts`
  - DELETE write fns: `createContentType`, `addField`, `renameField`, `changeFieldType`, `dropField`, `dropContentType`, `addRelation`, + tx-private helpers `lockContentType`, `declareRelationInTx`, `assertFieldNameFree`, `nextRelationSort`, `paramsOf`, `defaultText`.
  - DELETE `validateRelationSpec` — **CORRECTED (was mis-listed KEEP)**: its only callers are `createContentType` (`:230`) + `addRelation` (`:478`), both DELETE-listed. It has NO external importer (`adapt.ts`/`migrate.ts` import only `resolveFields` + the row TYPES) → it is meta-write-only dead code; keeping it RED-fails biome.
  - DELETE `referencedComponents` — **CORRECTED (was mis-listed KEEP)**: private, used only by the deleted write fns → dead after the gut.
  - DELETE meta-read selects used ONLY by `Registry.build`/`rebuildType`: `listContentTypes`, `getFields`, `getRelations`.
  - DELETE the cross-repo import `import { assertComponentRefsExist } from './component-type.repository.ts'` (`:3`) — used only inside the deleted `createContentType` (`:244`) + `addField` (`:297`); leaving it dangling after Stage 3.6 deletes the export breaks tsc. Also drop any now-unused catalog imports (`resolveType`, `ContentTypeExistsError`, etc.) that only the write fns referenced.
  - KEEP `getContentType` ONLY until Stage 2 re-roots `seed.ts` off it (then DELETE; nothing else reads it after that — `rebuildType` is deleted in Stage 3).
  - KEEP (verified files-first reuse): `resolveFields` (imported by `schema/adapt.ts:2` + `schema/migrate.ts:20`), `rejectTopLevelRelation` (called BY the kept `resolveFields` at `:170` — keep for that reason ONLY, not for an external importer), and types `FieldSpec`, `RelationSpec`, `ContentTypeRow`, `FieldRow`, `RelationRow` (imported by `adapt.ts:1` + `registry.ts:11`).
- `src/db/component-type.repository.ts`
  - DELETE write fns: `createComponentType`, `addComponentField`, `dropComponentField`, `dropComponentType`, + private `lockComponentType`, `assertNoComponentCycle`, `referencedComponents`, `validateComponentApiId`, `assertComponentRefsExist`, `assertTargetTypesExist`.
  - DELETE meta-read selects used ONLY by `Registry.build`/`rebuildComponent`: `listComponentTypes`, `getComponentType`, `getComponentFields`.
  - KEEP (verified): `resolveComponentFields` (imported by `adapt.ts:3`), types `ComponentTypeRow`, `ComponentFieldRow`, `ComponentFieldSpec`, `ResolvedComponentField`.
  - KEEP error CLASSES (`ComponentTypeNotFoundError`, `ComponentCycleError`, `ComponentInUseError`, etc.) ONLY if a surviving importer remains after the controllers are deleted (Stage 3 verification: grep). The deleted controllers + deleted writers are their only known importers → expect to DELETE the controller-only ones; keep any thrown on a live read/populate path.
- `src/db/registry.ts`
  - DELETE `Registry.build` (`:720`), `rebuildType` (`:760`), `rebuildComponent` (`:741`), and the now-dead meta-read imports (`:15-17`).
  - KEEP `Registry.fromSchemas` (`:696`), `buildDef`, `buildComponentDef`, `removeType`, `removeComponent`, and all other instance methods.
- `src/db/postgres.store.ts`
  - DELETE `loadWithRegistry` (`:45-49`) AND `load()` (`:36`) — see Stage 3: `Store` declares only zero-arg `load(): Promise<Engine>`, which cannot supply the `schemas`/`components` args `loadFromSchemas` requires, so repointing is type-incompatible; DROP `load()` from BOTH the class and the interface.
  - KEEP `loadFromSchemas` (`:58`).
- `src/db/seed.ts`
  - Stage 2 re-roots `seedFromSchemas`/`seedSchemaIfAbsent` off `createContentType`. After Stage 2 the meta dependency is gone; depending on the chosen approach (A vs B below) either KEEP a slimmed `seed.ts` or fold its sole call into `boot-reconcile.ts` and DELETE `seedArticleIfAbsent` + `ARTICLE_SEED_FIELDS`.
  - KEEP `STATUSES` (`:17`) — also imported by `src/http/server.ts:3` (bench). If `seed.ts` is emptied, relocate `STATUSES` (e.g. into `server.ts` or a small const module) so its dead host file can go.
- `src/http/server.ts`
  - KEEP the `seed(n)` bench generator + the `STATUSES` import.
  - DELETE the `seedArticleIfAbsent` re-export (`:15`).
- `src/http/uws.adapter.ts`
  - DELETE imports `:18-19`; helpers `handleContentTypeRoute` (`:236-260`) + `handleComponentTypeRoute` (`:267-290`); `ctCtx` + `ctMutate` (`:881-906`, incl. the dead `builderActive` 410-shim `:887-890`) + route registrations `:907-914`; `cmpCtx` + `cmpMutate` (`:1132-1149`) + registrations `:1150-1155`; the `builderActive` flag (`:849`, dead once `ctMutate` is gone).
  - KEEP the `/builder/content-types*` surface (`:1023-1126`), the data-read routes `/:type` (`:825`) + `/:type/:id` (`:837`), the data-write routes (`:1157+`), and `WriteContext.rebuild` (`:858-866`).

### KEEP untouched (files-first infrastructure)
`src/db/schema/adapt.ts`, `src/db/schema/migrate.ts` (the DDL engine + `migrate()`), `src/db/ddl.ts`, `src/db/engine.loader.ts`, `src/db/engine.swap.ts`, `src/db/schema/load.ts`, `test/helpers.ts:109/:133` (`startTestServerFromFiles[WithAuth]`), all `migrate-edge-*.ts`, all engine/column/auth/storage/schema-* tests.

---

## PREREQUISITE SLICE (Stage 0) — wire components into the files boot path

This is NOT part of the delete; it is a blocking prerequisite. Today the ONLY way a component enters the registry is `Registry.build` (meta) + `rebuildComponent`. The existing e2e component tests (`component-write.e2e`, `relation-in-component.e2e`, `i18n-media.e2e`) seed their components by POSTing the legacy `/component-types` route and reading them back via `loadWithRegistry → Registry.build` — i.e. there is **no** files-first component path end-to-end TODAY. Deleting `Registry.build`/`rebuildComponent` with no files-first component loader BREAKS every component read/populate.

Evidence:
- `schema/load.ts:62-63` filters out `entities/components/`.
- `postgres.store.ts:59` calls `Registry.fromSchemas(schemas)` with NO components arg.
- `engine.swap.ts` `swapFromIR` likewise.
- `Registry.fromSchemas(schemas, components = [])` already accepts components and builds them via `componentSchemaToRows` — only the plumbing is missing.
- Components have NO physical table and NO DDL (`componentSchemaToRows` feeds the registry only; `migrate()`/`applyOne` has no component change kind) → **`migrate()` stays components-unaware; do NOT thread components through it** (that would be a spurious change). Components flow ONLY into `Registry.fromSchemas` via `loadFromSchemas` + `swapFromIR`.

Work:
1. Extend `loadTypes` (`schema/load.ts`) to ALSO load `entities/components/*` into a `ComponentSchema[]` (new field on `LoadedTypes`).
2. Thread `ComponentSchema[]` through `loadFromSchemas` (`postgres.store.ts`) and `swapFromIR` (`engine.swap.ts`) into `Registry.fromSchemas`'s existing second arg.
3. Prove the new loader with ONE NEW files-first component test BEFORE converting the existing e2e suite (so a loader bug is isolated from the bulk conversion).
4. Only THEN convert the existing component e2e tests.

> SCOPE NOTE: before 0.5, grep every test that obtains a component def (a `/component-types` POST, or `loadWithRegistry` + a component assertion) and enumerate the FULL set — the three named below are the known set, but confirm there are no others. `component-builder.e2e` is NOT in this list (it tests the controller itself → DELETE in Stage 2).

### ☐ Stage 0 steps
- [ ] 0.1 Add `components: ComponentSchema[]` to `LoadedTypes`; load `entities/components/*` in `loadTypesImpl`.
- [ ] 0.2 `loadFromSchemas(schemas, components, opts)` → `Registry.fromSchemas(schemas, components)`.
- [ ] 0.3 `swapFromIR` accepts + forwards components to `Registry.fromSchemas`. (NO `migrate()` change — components have no DDL.)
- [ ] 0.4 Update `startTestServerFromFiles[WithAuth]` to pass `components` from `loadTypes`.
- [ ] 0.5 Grep + enumerate ALL component-bootstrap tests. Add ONE NEW files-first component test (entities/components fixture → loader → assert populate) to prove the path in isolation.
- [ ] 0.6 Convert `component-write.e2e`, `relation-in-component.e2e`, `i18n-media.e2e` (+ any others found in 0.5) to the files-first component fixture + `startTestServerFromFiles`.
- [ ] 0.7 VERIFY: `tsc --noEmit` && `biome check` && full suite green.

---

## STAGE 1 — Migrate the data/read/write/relation/i18n/media/auth tests off the meta path

Build the thin helper FIRST (highest leverage), then sweep.

### The thin helper (add to `test/helpers.ts`)
```ts
export async function startTestServerFromSchemas(sql: Sql, schemas: ContentTypeSchema[], components: ComponentSchema[] = []) {
  await migrate(sql, schemas, { allowDestructive: true }); // CREATE TABLE ct_*, writes _schema_applied, ZERO meta
  const store = new PostgresStore(sql);
  const { engine, registry } = await store.loadFromSchemas(schemas, components);
  const server = createServer(engine, store, registry);
  const port = await freePort();
  const token = await server.listen(port);
  return { base: `http://127.0.0.1:${port}`, close: server.close, token, engine, registry };
}
```
This lets a Category-A test keep its in-code IR and swap two lines (no on-disk fixture file). `migrate()` materializes the `ct_` tables AND writes `_schema_applied` — exactly what `loadFromSchemas` needs (it streams existing tables; it does NOT create them).

### Category A — migrate bootstrap (use the helper or `startTestServerFromFiles`)
`write.test.ts`, `write-security.test.ts`, `relation-load.test.ts`, `relation-populate.test.ts`, `relation-write.test.ts`, `relation-filter.test.ts`, `relation-declare.test.ts` (the fixture-setup parts only — see B for the `dropContentType` guard cases), `sparse-field-selection.e2e.test.ts`, `load.test.ts`, `postgres-store.test.ts`, `entry-types.test.ts`, `entry-repo-backstop.test.ts`, `draft-publish.test.ts`, `i18n.test.ts`, `hooks.e2e.test.ts`, `media-field.e2e.test.ts`, `media-upload.e2e.test.ts`, `i18n-media.e2e.test.ts` (if not already done in Stage 0).
- Replace `seedArticleIfAbsent(sql)` + `createContentType(sql, {...})` + `startTestServer(sql)` with `startTestServerFromSchemas(sql, [ <article + fixture IR> ])`.
- The `article` IR is `ARTICLE_SEED_FIELDS` expressed as a `ContentTypeSchema` (build a small `articleSchema` test fixture in `helpers.ts` so all three ex-`seedArticleIfAbsent` consumers share it).
- Relation/component fixtures: declare target types + relations in the IR (or schema files for the `*FromFiles` variant), NOT via `addRelation`.
- `load.test.ts` / `postgres-store.test.ts` (use `Registry.build`/`buildEngine` directly): swap to `Registry.fromSchemas` + `migrate()` to materialize, then `buildEngine`.

### Auth tests
- `auth.bridge.e2e.test.ts`, `auth.tokens.test.ts`, `auth.team.test.ts`: swap `loadWithRegistry`→files-first helper; GET `/content-types` they probe is the Builder read route (kept, but the legacy GET shape differs from `/builder/content-types` — see gotcha; repoint the probe to a surviving gated route, e.g. a `/:type` read or the Builder GET).
- `auth.route-gating.e2e.test.ts` (**REWRITE, not a repoint — HIGHEST EFFORT + KNOWN COVERAGE DELTA**): this is the one place the granular legacy gate matrix does not map 1:1 onto the survivors. The test enumerates a 401-gating matrix over routes that the kept Builder surface does NOT mirror: `POST/DELETE/PUT /content-types/:apiId/fields[/:name]`, `POST /content-types/:apiId/relations`, and the entire `/component-types*` family (`:184-194`). The kept Builder surface is **whole-type** (`PUT/DEL/preview /builder/content-types/:apiId`, `/builder/reload`, one component-sync route) — there is NO per-field / per-relation / per-component-field gated route to repoint onto. Also: the test today runs WITHOUT `entitiesDir` (`builderActive=false`), so the legacy `ctMutate` gate is LIVE and actually mutates (asserts row creation at `:181`); switching to `startTestServerFromFilesWithAuth` flips `builderActive=true`, which 410-shims those same routes — so the old assertions cannot survive verbatim.
  - ACTION: re-express the gating matrix against the surviving Builder surface (`PUT/DEL/preview/reload` + the component-sync route). The granular field/relation/component-field 401 cases **collapse into the whole-type `PUT` gate** — accept and DOCUMENT that the security test now covers a NARROWER surface (granular per-sub-route coverage is lost, not relocated).
  - PRECONDITION (verified true, re-confirm): the Builder routes carry the IDENTICAL `builder.manage` gate (`uws.adapter.ts:1060/1081/1099/1113/1136`), and `startTestServerFromFilesWithAuth` wires `entitiesDir` so they register.

### Rewrite `cleanCatalog` (`test/helpers.ts:32`) — but do NOT drop meta tables yet
At this stage the meta tables still EXIST (dropped in Stage 4). Keep `cleanCatalog` functioning. Prepare a meta-free variant but only flip it in Stage 4. (It already sweeps `ct_`/`_lnk` by `information_schema` at `:38-41`; the meta-table `TRUNCATE` at `:42-44` and the `content_type_relations` SELECT at `:36` are what must go in Stage 4.) ADD: `DELETE FROM _schema_applied` + reset `document_id_seq` so a files-first test starts from an empty snapshot (otherwise the next `migrate()` diffs against stale applied rows). Land this additive reset now; it is safe alongside the still-present meta TRUNCATE.

### ☐ Stage 1 steps
- [ ] 1.1 Add `startTestServerFromSchemas` + a shared `articleSchema` fixture to `test/helpers.ts`.
- [ ] 1.2 Add `DELETE FROM _schema_applied` + `document_id_seq` reset to `cleanCatalog` (keep the meta TRUNCATE for now).
- [ ] 1.3 Sweep Category-A small files (helper one-liner swap): `write-security`, `load`, `postgres-store`, `entry-types`, `entry-repo-backstop`, `hooks.e2e`, `media-upload.e2e`.
- [ ] 1.4 Sweep Category-A relation/i18n/media files (IR fixtures): `write`, `relation-load`, `relation-populate`, `relation-write`, `relation-filter`, `sparse-field-selection.e2e`, `draft-publish`, `i18n`, `media-field.e2e`, `i18n-media.e2e`.
- [ ] 1.5 Auth: migrate `auth.bridge`, `auth.tokens`, `auth.team` (loadWithRegistry→files-first; repoint route probe).
- [ ] 1.6 Auth: REWRITE `auth.route-gating.e2e` — re-express the gate matrix onto the Builder surface (whole-type PUT/DEL/preview/reload + component-sync), accept the granular→whole-type coverage collapse, DOCUMENT the delta in the test file; re-confirm identical `builder.manage` gate + `entitiesDir` registration first.
- [ ] 1.7 VERIFY: `tsc --noEmit` && `biome check` && full suite green. (Meta path still present — only TEST callers moved.)

---

## STAGE 2 — Re-root the boot baseline off `createContentType`; delete legacy meta-route tests

### Boot rewrite (the HARD KNOT)
`boot-reconcile.ts:96-101` BASELINE branch calls `seedFromSchemas(sql, filesIR)` (`:98`) + `writeAppliedSnapshot(sql, filesIR)` (`:99`). `seedFromSchemas` → `seedSchemaIfAbsent` → `createContentType` (the meta-write that blocks the whole repo gut).

Replace with a single `migrate()` call (it does CREATE TABLE via the SAME `compileCreateTable` `createContentType` emits, AND writes `_schema_applied` via `reconcileApplied` — collapsing both `:98` and `:99`):
```ts
if (appliedIR.length === 0) {
  if (filesIR.length === 0) return { outcome: 'clean', recovered: [], schemas: [], hooks: filesHooks };
  await migrate(sql, filesIR, { allowDestructive: true }); // empty _schema_applied ⇒ diff = all addType ⇒ creates tables + writes snapshot
  return { outcome: 'clean', recovered: [], schemas: filesIR, hooks: filesHooks };
}
```
- Remove the `seedFromSchemas` import (`:8`) and the `writeAppliedSnapshot` import if it has no other caller (it does not after this — `writeAppliedSnapshot` `:357` becomes dead; DELETE it too).
- **SEMANTIC GOTCHA — RESOLVED (do NOT make `compileCreateTable` idempotent):** `seedFromSchemas` was create-if-ABSENT (swallowed `ContentTypeExistsError`/`23505`). `migrate()` against an empty `_schema_applied` emits `addType` for EVERY type; if a `ct_` table already physically exists it hits **`42P07` duplicate_table** because `compileCreateTable` has NO `IF NOT EXISTS` (`ddl.ts:534` documents this deliberately; the link-table builder + `migrate-edge-*` tests RELY on that non-idempotency to surface `42P07`). The "ct_ table present but `_schema_applied` empty" state ONLY existed because the legacy `seedFromSchemas` created tables out-of-band of the snapshot. Once boot uses `migrate()` (DDL + snapshot in the SAME tx), that state is **unreachable in production**. THEREFORE:
  - DO NOT add `IF NOT EXISTS` to `compileCreateTable` (it would break the `migrate-edge` duplicate-table tests).
  - INSTEAD **rewrite `boot-reconcile.test.ts` test D** (`:109-119`, "baseline … does NOT throw 23505 on the already-seeded table") so it DROPs the `ct_` table (or starts from a clean DB) BEFORE the baseline `migrate()`, rather than pre-creating the table and expecting idempotency. Update its `:111` "seed the legacy way" line to the new baseline path.

### `seed.ts` after the rewrite
- `seedFromSchemas` + `seedSchemaIfAbsent` now have NO caller → DELETE.
- `seedArticleIfAbsent` + `ARTICLE_SEED_FIELDS` → DELETE (the three ex-consumers — `write`, `draft-publish`, `i18n` — migrated in Stage 1).
- Relocate `STATUSES` out of `seed.ts` (kept for the `server.ts` bench), then DELETE the empty `seed.ts`.
- Drop the `seedArticleIfAbsent` re-export at `server.ts:15`.
- `createContentType` is STILL referenced by `seed.ts`'s import at this moment — it goes dead the instant `seed.ts` is gutted, but is not DELETED until Stage 3 (so the repo file still type-checks).

### Delete the legacy meta-route test files (their subjects survive until Stage 3, but these tests assert the legacy CONTROLLERS/META directly, so delete now to unblock the controller delete)
- `content-type-meta.test.ts`, `content-type-builder.test.ts`, `component-builder.e2e.test.ts`, `relation-declaration-over-http.test.ts`, `schema-registry-equiv.test.ts`.
- `registry.test.ts`: delete the `Registry.build` cases; keep/relocate any `fromSchemas` coverage.
- `relation-declare.test.ts` (**COVERAGE-PORT, not a blind delete**): ~95% of this file is input-validation rejection coverage on `createContentType`/`addRelation`/`dropContentType` — NOT mere fixture setup. Before deleting the meta cases, audit each guard against the files-first path and port/accept explicitly:
  - SQL-injection identifier guard (`:218`, `a"; DROP TABLE ct_book;--`) and `ReservedTableNameError` on a `ct_`-prefixed target (`:220`): STILL fire on the files-first path via `deriveTableName`/`validateIdentifier` in `buildRelation` → **port as `migrate()`/`Registry.fromSchemas` tests**.
  - 63-byte link-table truncation (`:226`): covered by `deriveLinkTableName` → port if not already in `migrate-edge-relations`.
  - `UnknownRelationKindError` (`:253`): verify the files path rejects → port.
  - `DependentTypesError`-on-drop guard: port to the `migrate()`/Builder drop path if not already covered by a `migrate-edge-*` test.
  - **`FieldExistsError` for relation-vs-scalar name collision (`:198`/`:209`): has NO files-first analog** — the files path (`relationRowsByType` in `adapt.ts`) only calls `deriveLinkTableName`/`deriveTableName` and defers to `buildRelation`, which does NOT re-run this collision check. Explicitly ACCEPT the coverage loss OR re-implement the collision guard on the files-first path. Do not silently drop it.

### ☐ Stage 2 steps
- [ ] 2.1 Rewrite `boot-reconcile.ts` baseline branch to `migrate(sql, filesIR, { allowDestructive: true })`; drop the `seedFromSchemas` + `writeAppliedSnapshot` imports. (Do NOT touch `compileCreateTable`.)
- [ ] 2.2 Rewrite `boot-reconcile.test.ts` test D (`:109-119`): drop/clean the `ct_` table before the baseline `migrate()`; update the `:111` legacy-seed line to the new baseline path.
- [ ] 2.3 DELETE `writeAppliedSnapshot` (`migrate.ts:357`) — now uncalled.
- [ ] 2.4 Relocate `STATUSES`; DELETE `seedFromSchemas`, `seedSchemaIfAbsent`, `seedArticleIfAbsent`, `ARTICLE_SEED_FIELDS`; DELETE `seed.ts` if empty.
- [ ] 2.5 DELETE the `seedArticleIfAbsent` re-export at `server.ts:15`.
- [ ] 2.6 DELETE test files: `content-type-meta`, `content-type-builder`, `component-builder.e2e`, `relation-declaration-over-http`, `schema-registry-equiv`; trim `registry.test.ts` (build cases).
- [ ] 2.7 PORT `relation-declare.test.ts` guards to the files-first path (injection/reserved-name/truncation/unknown-kind/dependent-types), explicitly accept-or-reimplement the relation-vs-scalar `FieldExistsError`, THEN delete the meta cases.
- [ ] 2.8 VERIFY: `tsc --noEmit` && `biome check` && full suite green. (Meta WRITE fns + `Registry.build` are now UNCALLED but still present — that is fine.)

---

## STAGE 3 — Delete the meta-write repos, controllers, adapter wiring, `Registry.build`, `loadWithRegistry`

Everything here is dead after Stages 0-2. Delete in this order so each sub-step type-checks.

### Adapter + controllers
- DELETE `uws.adapter.ts` imports `:18-19`, `handleContentTypeRoute` (`:236-260`), `handleComponentTypeRoute` (`:267-290`), `ctCtx`/`ctMutate` + registrations (`:881-914`), `cmpCtx`/`cmpMutate` + registrations (`:1132-1155`), and the now-dead `builderActive` flag (`:849`).
- DELETE `src/http/content-type.controller.ts` + `src/http/component-type.controller.ts` whole files.

### Registry + store
- DELETE `Registry.build` (`:720`), `rebuildType` (`:760`), `rebuildComponent` (`:741`) + the meta-read imports (`:15-17`).
- DELETE `loadWithRegistry` (`postgres.store.ts:45-49`) AND drop `load()` from BOTH `PostgresStore` and the `Store` interface (`store.ts` declares only the zero-arg `load(): Promise<Engine>`, which cannot supply `loadFromSchemas`'s required `schemas`/`components` args → repointing is type-incompatible; dropping is the only clean option). Grep-confirmed no production caller — `conti.ts` boot uses `loadFromSchemas`; the only `store.load()` caller was the (deleted) `startTestServer`.

### Repos (gut to pure-helper modules)
- `content-type.repository.ts`: DELETE the 7 write fns + tx-private helpers + `validateRelationSpec` (dead) + `referencedComponents` (dead) + the cross-repo `assertComponentRefsExist` import (`:3`) + any now-unused catalog imports + the meta-read selects `listContentTypes`/`getFields`/`getRelations` (and `getContentType`, now uncalled after Stage 2 + the `rebuildType` delete). KEEP `resolveFields`, `rejectTopLevelRelation` (called by `resolveFields`), and the row TYPES. RUN `tsc --noEmit` immediately after to surface any other dangling import.
- `component-type.repository.ts`: DELETE the 4 write fns + private helpers + `listComponentTypes`/`getComponentType`/`getComponentFields`/`assertComponentRefsExist`/`assertTargetTypesExist`/`validateComponentApiId`. KEEP `resolveComponentFields` + the row TYPES. Grep the error classes; DELETE the ones whose only importers were the deleted controllers/writers.

### Helpers
- DELETE `startTestServer` (`test/helpers.ts:93-102`) — all callers migrated in Stage 1.

### ☐ Stage 3 steps
- [ ] 3.1 Gut `uws.adapter.ts` (imports, both route helpers, `ctMutate`/`cmpMutate` + registrations, `builderActive`).
- [ ] 3.2 DELETE both controller files.
- [ ] 3.3 DELETE `Registry.build`/`rebuildType`/`rebuildComponent` + meta-read imports in `registry.ts`.
- [ ] 3.4 DELETE `loadWithRegistry` AND drop `load()` from `PostgresStore` + the `Store` interface (do NOT repoint).
- [ ] 3.5 Gut `content-type.repository.ts` (write fns + private helpers + `validateRelationSpec` + `referencedComponents` + the `assertComponentRefsExist` import at `:3` + unused catalog imports + meta-read selects); keep `resolveFields` + `rejectTopLevelRelation` + types; run `tsc --noEmit` to catch dangling imports.
- [ ] 3.6 Gut `component-type.repository.ts` (write fns + private helpers + meta-read selects); keep `resolveComponentFields` + types; grep + delete controller-only error classes.
- [ ] 3.7 DELETE `startTestServer` from `test/helpers.ts`.
- [ ] 3.8 VERIFY: `tsc --noEmit` && `biome check` && full suite green. (No code path touches the meta tables anymore — but the tables still exist, so `cleanCatalog`'s TRUNCATE still works.)

---

## STAGE 4 — Drop the meta tables; flip `cleanCatalog` meta-free

Now that NOTHING reads or writes the meta tables, drop them. `cleanCatalog` must flip in the SAME stage or every `beforeEach` errors on the missing tables.

### `cleanCatalog` (`test/helpers.ts:32`)
- DELETE the `SELECT ... FROM content_type_relations` (`:36`) and its `link_table` drop loop — the `%_lnk` suffix sweep (`:38-39`) already covers link tables on the files-first path.
- DELETE the two `TRUNCATE` of the 5 meta tables (`:42-44`).
- KEEP the `ct_`/`_lnk` `information_schema` sweep + the `DELETE FROM _schema_applied` + `document_id_seq` reset added in Stage 1.

### Init migration (`migrations/0001_init.sql` — edit in place; drop & recreate is allowed pre-launch)
- DROP table defs: `content_types` (`:12`), `content_type_fields` (`:36`), `content_type_relations` (`:62`), `component_types` (`:87`), `component_type_fields` (`:96`) + their indexes (`:33-34,55-56,76,78,94,110-111`).
- KEEP `document_id_seq` (`:10`), `files` (`:118`), all auth tables (`:147+`).

### ☐ Stage 4 steps
- [ ] 4.1 Flip `cleanCatalog` meta-free (remove the `content_type_relations` SELECT + drop loop, remove both meta TRUNCATEs).
- [ ] 4.2 Edit `migrations/0001_init.sql` in place: remove the 5 meta tables + their indexes.
- [ ] 4.3 Recreate the test DB from the consolidated init (Testcontainers picks it up fresh; per drop-&-recreate policy).
- [ ] 4.4 VERIFY: `tsc --noEmit` && `biome check` && full suite green.
- [ ] 4.5 FINAL grep gate: `grep -rE 'content_types|content_type_fields|content_type_relations|component_types|component_type_fields|createContentType|Registry\.build|loadWithRegistry|seedArticleIfAbsent' src test` returns ONLY the kept-helper file/symbol names you expect (ideally empty).

---

## Per-stage verification (run every stage)
```
node --experimental-strip-types ... tsc --noEmit     # or the project's tsc task
biome check .
<the project's full test runner against .env.test>    # Testcontainers real Postgres
```
GREEN at the end of EACH stage is the gate to proceed.

## Critical ordering invariants (do NOT reorder)
1. Stage 0 (components into files boot) BEFORE any delete — else component reads break.
2. Stage 1 (migrate TEST callers) BEFORE Stage 3 (delete the fns they call).
3. Stage 2 (re-root boot off `createContentType`) BEFORE Stage 3 (delete `createContentType`) — else production baseline boot breaks.
4. Stage 4 (drop tables + flip `cleanCatalog`) LAST and TOGETHER — dropping tables before `cleanCatalog` flips reds every `beforeEach`.

## Risks & mitigations (medium/low residuals)
- **`relation-declare` coverage port (medium):** the files-first relation path does NOT re-run every legacy `addRelation` validation. Injection/reserved-name/truncation/unknown-kind DO fire via `buildRelation` (port them); the relation-vs-scalar `FieldExistsError` collision has NO files-first analog — explicitly accept the loss or re-implement on the files path (Stage 2.7).
- **`auth.route-gating` coverage narrowing (medium, treated as HIGH-effort rewrite in 1.6):** granular per-field/per-relation/per-component-field 401 cases collapse into the whole-type `PUT /builder/content-types/:apiId` gate. Document the delta in-test so the narrower coverage is known, not silent.
- **Component-bootstrap test enumeration (medium):** the three named e2e tests are the KNOWN component-seeders; grep before Stage 0.6 to confirm the full set so none is missed.
- **Dangling cross-repo / catalog imports (medium):** removing write fns leaves `content-type.repository.ts:3 assertComponentRefsExist` and unused catalog imports dangling; remove them in the SAME sub-step as the fn deletions (3.5) and `tsc --noEmit` immediately.
- **`Store.load()` reconciliation (low):** drop `load()` from both class and interface — do NOT repoint the zero-arg signature at `loadFromSchemas` (type-incompatible).
- **`migrate()` component threading (low):** components have no DDL — keep `migrate()` components-unaware; thread components only into `Registry.fromSchemas` (Stage 0.2/0.3).
- **`compileCreateTable` idempotency (low, already decided):** never add `IF NOT EXISTS` — fix the one failing scenario by rewriting `boot-reconcile.test.ts` test D (Stage 2.2).

