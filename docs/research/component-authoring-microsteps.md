# Phase 5 — Component visual authoring: microstep plan (with tests)

The be-05 component **runtime** (validate-on-write, populate-on-read, `ComponentDef`,
`componentSchemaToRows`, `buildComponentDef`, `getComponent`) is shipped and tested via
**in-memory injected** components (`startTestServer(sql, schemas, { components })`). What is
missing is the **authoring + loading + builder-write + codegen + admin** layer. This document
splits that work into small, independently-landable, individually-tested microsteps.

## Architecture invariants (hold at every step)

1. **Component definitions have NO table → NO DDL → NO migrate.** A component change = write
   `modules/components/<name>.ts` + rebuild the registry + `swapFromIR(applied=[])`. They never
   touch `_schema_applied` or `migrate()`.
2. **A module field that REFERENCES a component IS a jsonb column** (`component` /
   `component-repeatable` / `dynamiczone`). Adding/dropping/retyping it rides the EXISTING module
   diff/migrate (addField jsonb = safe; dropField = destructive). No new migrate logic needed.
3. **Byte-identical with no components.** Every wiring step must keep a project that has no
   `modules/components/` dir behaving exactly as today (`loadComponents → []`). The full existing
   suite must stay green after each step.
4. **No mocks; real Postgres on `.env.test`.** Pure logic (DSL/codegen) → `node --test` unit
   tests; loader → real-FS test; everything else → real-DB e2e via the existing harnesses.

## Test seams (already exist)

- **Pure**: `test/schema-define.test.ts`, `test/schema-codegen.test.ts`, `test/type-catalog*`.
- **Runtime with injected components**: `startTestServer(sql, schemas, { components })`
  (`test/helpers.ts:313`) — used by `component-write.e2e.test.ts`, `relation-in-component.e2e.test.ts`.
- **Boot-from-FILES + auth + builder routes**: `startTestServerFromFilesWithAuth(sql, genDir)`
  (`test/builder-route.e2e.test.ts`) — writes real `modules/*` files then boots. This is the seam
  for loader/boot/swap and the `/builder/components` route tests.

## Dependency DAG

```
A1 DSL defineComponent ─┐
A2 DSL repeatable+min/max ─┼─> A3 loader ─> A4 boot wiring ─> A5 swap/reload wiring   (Milestone A: code-authored components work)
                          │
B1 codegen kinds ─────────┘ ─> B2 generateComponentSource                            (Milestone B: builder can write component files)
A5,B2 ─> C1 preflight existence ─> C2 GET ─> C3 version ─> C4 PUT ─> C5 DELETE ─> C6 preview   (Milestone C: /builder/components)
C2 ─> D1 SDK read ─> D2 admin client ─> D3 module-draft authorable                    (Milestone D: wire)
D3 ─> E1 component editor route ─> E2 attach-on-module ─> E3 replace AuthoredInCode    (Milestone E: UI / frame 11)
```

Milestones land in order; **A is independently shippable** (closes the latent prod bug where
`conti.ts:95` hardcodes `[]`, so file-authored components never load).

---

## Milestone A — code-authored components load & work end-to-end

### A1 · DSL: `defineComponent` + `defToComponentSchema`
- **Files**: `db/schema/define.ts`.
- **Change**: add `defineComponent({ id?, fields })` (identity helper) + `defToComponentSchema(def, name): ComponentSchema` mirroring `defToSchema` (fields-only; no `options`, no top-level `relations`). Scope fields to scalar + media + nested `component` for now.
- **Test** (pure): `defToComponentSchema(defineComponent({ fields: { meta_title: c.string(), og_image: c.media() } }), 'seo')` deep-equals the expected `ComponentSchema` (ids fall back to field key). Add to `test/schema-define.test.ts`.
- **Safety**: pure addition; nothing imports it yet.
- **Deferred sub-step A1b**: inline-relation-INSIDE-a-component in the DSL (lower a `c.relation` to a `FieldSchema{ type:'relation', options:{target, multiple} }` per `resolveComponentField('relation', …)`). Runtime already supports it via injected IR; only the DSL mapping is missing.

### A2 · DSL: repeatable component + min/max
- **Files**: `db/schema/define.ts`, `db/type.catalog.ts` (`resolveComponentField`).
- **Change**: `c.component(name, { repeatable?, min?, max?, id? })` → kind `component` | `component-repeatable`, options carry `component` + `min`/`max`. `resolveComponentField` carries `min`/`max` in `params` for both component kinds.
- **Test** (pure): the builder lowers to the right kind + options; `resolveComponentField('component-repeatable', { component:'seo', min:0, max:5 })` returns params incl. `min/max`. Extend `test/schema-define.test.ts` + the type-catalog test.
- **Safety**: additive; existing single-component path unchanged when `repeatable` absent.

### A3 · Component file loader
- **Files**: `db/schema/load.ts`.
- **Change**: `loadComponents(dir)` + cache-busted variant read `modules/components/*.ts` (default-export `defineComponent`) → `ComponentSchema[]`; missing dir → `[]`. Extend `LoadedTypes` with `components: ComponentSchema[]`; `loadTypes`/`loadTypesCacheBusted` return them. (Note: `load.ts:63` currently filters `components` out of the module walk — keep that; add the separate component read.)
- **Test** (real FS, no DB): write a temp `modules/components/seo.ts`, assert `loadTypes(dir).components` matches; no dir → `[]`; cache-bust re-reads an edited file. New `test/load-components.test.ts`.
- **Safety**: no caller consumes `.components` yet → behavior unchanged.

### A4 · Boot wiring
- **Files**: `compose/conti.ts:91-95`.
- **Change**: `const { schemas, hooks, components } = await loadTypes(modulesDir)` → `store.loadFromSchemas(schemas, components, …)`.
- **Test** (real DB, boot-from-files): via `startTestServerFromFilesWithAuth` write a `components/seo.ts` + a module with a `seo` component field; POST an entry with a nested instance → 201; GET populates it. **Regression**: every existing test (no components dir) stays green.
- **Safety**: no components dir → `components=[]` → byte-identical boot.

### A5 · Swap + reload wiring
- **Files**: `http/server.ts` (`swapAfter` ~931, reload ~1105).
- **Change**: load components (cache-busted) and pass to `swapFromIR(…, nextComponents)` in both the builder-swap and `POST /builder/reload` paths (`engine.swap.ts` already threads them into `Registry.fromSchemas`).
- **Test** (real DB, files harness): with a component+module loaded, do a module PUT (or `/builder/reload`); a subsequent content write with a component instance still validates (components survived the swap). Before this step the swap would drop components → write 400.
- **Safety**: no components → `[]` → identical swap.

> **After A: file-authored components work at boot, reload, and across builder edits. Shippable on its own; no admin changes.**

---

## Milestone B — component codegen (so the builder can WRITE component files)

### B1 · Fix `component-repeatable` codegen + kind dispatch
- **Files**: `db/schema/codegen.ts` (the kind→builder dispatch ~153 that currently throws on `component-repeatable`).
- **Change**: emit `c.component(name, { repeatable: true, min, max })` for `component-repeatable`; keep `component`/`dynamiczone`. (The options-assembly already emits `min/max/private/...`.)
- **Test** (pure): a module field of kind `component-repeatable` now codegens to valid source (previously threw) and round-trips. Extend `test/schema-codegen.test.ts`.

### B2 · `generateComponentSource(component)`
- **Files**: `db/schema/codegen.ts`.
- **Change**: emit a `defineComponent({ id, fields:{…} })` file from a `ComponentSchema` (parallel to `generateSchemaSource`).
- **Test** (pure + FS): `generateComponentSource(cmp)` → write to a temp `components/<name>.ts` → `loadComponents` → IR deep-equals the input. New case in `test/schema-codegen.test.ts`.

---

## Milestone C — the `/builder/components` resource

### C1 · Module component-field existence check (preflight)
- **Files**: `compose/builder.ts` (`preflightValidate`, thread the loaded component-name set through `resolveEdit`).
- **Change**: reject (422) a module field whose `options.component` / each of `options.components` names an unknown component.
- **Test** (e2e, builder-route): PUT a module with a `component` field referencing a missing component → 422; referencing a loaded one → 200.

### C2 · `GET /builder/components[/:name]`
- **Files**: `http/server.ts` (+ a `readComponents` in `compose/builder.ts`).
- **Change**: public read returning the loaded `ComponentSchema[]` (+ the catalog version for ETag).
- **Test** (e2e): GET lists the components present on disk; `/:name` 200/404.

### C3 · catalog-version includes components
- **Files**: `compose/catalog-version.ts` (`canonicalIR` + `computeCatalogVersion`).
- **Change**: fold `components` (sorted by id, canonicalized) into the hash so a component edit advances the ETag.
- **Test** (pure/e2e): editing a component file changes `computeCatalogVersion`; module-only edits still change it as before (no regression to existing version tests).

### C4 · `PUT /builder/components/:name` — write file + swap, NO migrate
- **Files**: `compose/builder.ts` (`applyComponentEdit`: resolve ids → validate names/nested kinds → atomic temp-write of `components/<name>.ts` → registry rebuild + `swapFromIR(applied=[])`), `http/server.ts` (route gated `builder.manage`, If-Match/ETag, Idempotency-Key).
- **Test** (e2e): PUT creates a component; GET reflects it; a module that references it now creates; a content write with a nested instance validates + populates. PUT update (id-preserved) changes fields and the populate shape updates.
- **Safety**: no `migrate()` call on this path; reuse the temp-file discipline from `applyResolvedPlan`.

### C5 · `DELETE /builder/components/:name` with inbound guard
- **Files**: `compose/builder.ts`, `http/server.ts`.
- **Change**: block (422) if any module field references the component (mirror the inbound-relation guard at `builder.ts:260`); else remove the file + swap.
- **Test** (e2e): delete a referenced component → 422 (message names the module.field); delete an unreferenced one → 200 + GET 404.

### C6 · `POST /builder/components/:name/preview`
- **Files**: `compose/builder.ts`, `http/server.ts`.
- **Change**: dry-run returning `generatedSource` (+ a trivial change list — component edits are registry-only, never destructive). Writes nothing.
- **Test** (e2e): preview returns source and the on-disk file is unchanged.

---

## Milestone D — SDK + admin wire

### D1 · SDK read surface
- **Files**: `packages/sdk/src/{modules,types,client}.ts`.
- **Change**: `api.components.list()` over `GET /builder/components` + `ComponentDefinition` type.
- **Test** (sdk): returns the components; typecheck.

### D2 · Admin builder-client
- **Files**: `apps/admin/src/lib/builder-client.ts`.
- **Change**: `ComponentSchema`/`ComponentDraft` wire types + `listComponents/saveComponent/deleteComponent/previewComponent` (mirror the module fns). Typecheck.

### D3 · module-draft: component fields become authorable
- **Files**: `apps/admin/src/lib/module-draft.ts`, `field-types.tsx`.
- **Change**: extend `FieldDraft` with `componentRef` / `repeatable` / `min` / `max`; `isAuthorableField` includes `component` + `component-repeatable`; `draftFromField`/`draftToField`/`draftOptions`/`validateFieldDraft` handle them. **Keep** `dynamiczone` + inline-relation as `raw` (still round-trip verbatim) until their own sub-steps. Typecheck + ensure non-authored kinds still round-trip (no corruption).

---

## Milestone E — admin UI (frame 11)

### E1 · Component manager route + editor
- A list + create/edit screen for a component's nested fields, reusing `field-card.tsx` / `field-config.tsx` (a component has no options / no top-level relations). CRUD via the D2 client.

### E2 · Attach a component on a module field
- Type picker offers `component`; a control to pick which component + single/repeatable + min/max → writes the module field's `options.component`/`min`/`max`.

### E3 · Replace the read-only `AuthoredInCode` zone
- Component/`component-repeatable` fields render the live editor instead of the read-only zone (`module-form.tsx:811`). `dynamiczone` + inline-relation stay in the read-only zone until their sub-steps.
- **Verify**: manual in the running dev server (no admin unit runner) + a Playwright e2e (author a component, attach it, confirm it round-trips). 

---

## Scope cuts (explicit, each a later sub-step)
- **A1b** inline-relation-inside-component in the DSL (runtime already supports the IR).
- **Dynamic-zone authoring** in the admin (kept read-only round-trip).
- **Content-entry component editing** (editing actual component DATA in `entry-form.tsx`) — a
  SEPARATE surface from frame 11 (builder authoring); not part of Phase 5.

## Recommended landing order
Ship **A** first (fixes the latent prod bug, fully tested, no UI). Then **B+C** (the backend
authoring resource, fully e2e-tested). Then **D+E** (the visible editor). Each microstep is a
green-suite checkpoint.
