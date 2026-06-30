# Roadmap: remaining field options + Stage 6 follow-ups

Hand-off doc for a fresh session. Written 2026-06-30 after Stages 0–6 of the pixel-perfect
module-builder rebuild + the field-options work. Companion research lives in the auto-memory:
`field-options-research.md` (per-item competitor design + the 3 traps) and
`competitor-builder-bug-audit.md` (migration + interaction bug catalog). Read those first.

## Already shipped (do NOT redo)
- Field options: `required`(nullable), `default` (round-trips for every type), `length`, string
  char-`min`, integer/float numeric `min`/`max`, **biginteger/decimal value bounds (string-stored,
  BigInt/scaled-BigInt compared)**, `unique` (create-path), `editorWidth`, `condition`,
  per-field `localized`, **array `uniqueItems`/`minItems`/`maxItems`** (+ the `c.array` builder that
  was missing — array fields are now authorable).
- Builder UI Stages 0–5 (full-screen shell, fields editor, relations editor, Preview+Code modes,
  review modal) + Stage 6 part 1 (drag-reorder, unsaved-changes guard, module-switcher, locked
  pills, authored-in-code zone).

---

## RECIPE: how to add a write-time field option (followed by #1/#2/#5 below)

Every write-time option touches the same 8–9 places. The `unique` (commit 0d47c05) and
biginteger/decimal+array (commit c2bcc88) commits are the worked examples — diff them.

1. **`packages/api/src/db/type.catalog.ts`** — add the key to `interface FieldOptions`; write a
   small validating helper; merge it into the relevant resolver's `params` (resolvers are the
   `RESOLVERS` record). Throw `TypeOptionError` on bad input (validated at schema-author time).
2. **`packages/api/src/db/registry.ts`** — add the field to `interface RegistryField`; read it from
   `params` in `buildUserField` (use `numberParam`/`params['key']` patterns near the min/max reads).
3. **`packages/api/src/db/body.parser.ts`** — enforce at write in `coerce()` (switch on
   `field.engineType`; use `field.type` for logical-type branches like array). Throw `BodyParseError`
   → clean 400.
4. **`packages/api/src/db/schema/codegen.ts`** — EMIT the option in `fieldBuilderCall` (per-type) or
   the shared `cm` string (every type). **If you don't emit it, it's silently lost on the next boot**
   (the "info/label lesson"; `boot-reconcile.ts`'s `isRoundTrippable` is the backstop). Strings →
   `lit()`; numbers → bare.
5. **`packages/api/src/db/schema/define.ts`** — add to the relevant `*Opts` type + pass it in the
   builder's `clean({...})`. Universal metadata goes in `common()`.
6. **`packages/api/src/db/schema/model.ts`** — add to the Zod `fieldOptionsSchema` (`.strict()`).
7. **Mirrors**: `packages/sdk/src/types.ts` `FieldOptions` + `apps/admin/src/lib/builder-client.ts`
   `FieldOptions` (keep both in sync with the catalog).
8. **Admin UI**: `apps/admin/src/lib/field-types.tsx` (`CmsTypeOptionMeta` flag + `optionMeta` per
   type), `apps/admin/src/lib/module-draft.ts` (`FieldDraft` field + `emptyFieldDraft` +
   `draftFromField` + `draftOptions` + `validateFieldDraft`), `apps/admin/src/components/builder/field-config.tsx`
   (the input/toggle, gated on the meta flag).
9. **Tests**: `test/ddl.test.ts` (resolve + validation throws, pure), `test/builder.test.ts`
   (codegen ⇄ `loadTypes` round-trip, DB), `test/field-option-bounds.test.ts` or a new file (pure
   `validateBody` enforcement — build a `Registry.fromSchemas([schema({...})])`, call
   `validateBody(def, raw, 'create', reg)`, assert `BodyParseError`).

**Verify every change:** `npm run typecheck -w @conti/core` (ignore pre-existing `bench/*` errors),
`-w @conti/sdk`, `-w @conti/admin`; `npm test -w @conti/core` (baseline 1109/0, 5 skipped) +
`-w @conti/sdk` (113/0); `npm run build -w @conti/admin`; `npm run knip` (un-export anything only
used in its own file). Tests run with `--env-file=.env.test --test-global-setup=./test/global-setup.ts`
for DB tests; pure tests run with plain `node --test`. Never run `npm run dev` (a server is always up
in another terminal). Commit on a `feat/...` branch, then `git merge --ff-only` to main.

---

## #1 — string `pattern` (regex) — **HIGH value, ReDoS trap**
**Goal:** declarative regex validation for `string`/`email`/`uid`/`text`, full-match semantics.

**DECISION NEEDED FIRST (ask the user):** add a regex engine dependency. Options: `re2` (native
addon, linear-time, **cannot** ReDoS — structural guarantee) vs `re2js` (pure-JS RE2 port, no native
build, fits the project's minimal-build ethos but slower). **Recommend `re2js`** unless native is
acceptable. Do NOT use the built-in `RegExp` on author patterns — Node has no per-regex timeout
(nodejs/node#51659), so a crafted pattern+input stalls the single instance (ReDoS).

**Shape:** `pattern?: string` (source, no slashes), `patternFlags?: string`, `patternMessage?: string`.

**Steps (the RECIPE):**
- catalog: validate at resolve — compile the pattern through RE2 (catch its `SyntaxError` →
  `TypeOptionError`, which also rejects lookaround/backreferences RE2 can't do); allow flags `i m s u`,
  **reject `g`/`y`** (stateful lastIndex corrupts a cached regex); store `{pattern, patternFlags,
  patternMessage}` in params. Only for string-ish types (string/email/uid/text).
- registry: store the COMPILED RE2 matcher on the field (compile once in `buildUserField`, wrap source
  as `^(?:<source>)$` for full-match). Plus the raw strings for codegen.
- body.parser: in the `string`/`text` arm after the length/min checks —
  `if (field.patternRe && !field.patternRe.test(v)) throw new BodyParseError(field.patternMessage ?? '...')`.
  Cap input length first (defense-in-depth).
- codegen/DSL/Zod/mirrors/admin: per recipe. Admin field-config: a pattern input + optional flags +
  message, gated on a `pattern` meta flag for string-ish types.

**Traps:** ReDoS (RE2 only, never RegExp); full-match (wrap `^(?:…)$` — JS `.test` is partial by
default); reject g/y flags; `pattern` must not imply `required` (skip on null).

**Tests:** resolve rejects lookaround/backref/bad-flags; body.parser enforces full-match (e.g. `^\d+$`
rejects `"12a"`); a catastrophic pattern (`(a+)+$`) + a long non-matching input returns fast (linear),
does not hang.

---

## #2 — `date`/`datetime` `min`/`max` — MEDIUM
**Goal:** min/max date constraints, absolute ISO-8601 OR relative `$now` tokens.

**Shape:** reuse `min`/`max` (already `number|string`) holding an ISO-8601 string or a relative token
`"$now"`, `"$now(-7 days)"`, `"$now(+1 year)"`.

**Steps:**
- catalog: for `date`/`datetime`, validate the bound is ISO-8601 OR matches the `$now(±N unit)`
  grammar; store as string in params.
- body.parser: thread a single `now = new Date()` from `validateBody` entry down into `coerce` (so all
  relative bounds in one request resolve against the same instant — avoids sub-second skew). In the
  `date` arm, resolve the bound (absolute parse or `$now` adjust), compare. For `date` type:
  truncate-compare on the UTC calendar date (the Directus date-only bug — community#916). For
  `datetime`: full UTC instants. Inclusive bounds.
- codegen/DSL/Zod/mirrors/admin per recipe. Admin: `dateBounds` meta flag for date/datetime; min/max
  inputs (a date picker or text).

**Traps:** UTC / date-only truncation; resolve `$now` once per request; reject a bound with no offset
for datetime.

**Tests:** absolute + relative bounds enforced; a date-only field with `$now` doesn't off-by-one at
TZ boundaries.

---

## #4 — `private` / `readOnly` / `hidden` — **HIGH (private), SECURITY; own slice**
Three distinct concepts. `readOnly`/`hidden` are trivial admin metadata; **`private` is the real
work and touches the perf-critical read path.**

### #4a — `readOnly` + `hidden` (trivial, do anytime)
- Pure metadata: FieldOptions + Zod + DSL `common()` + codegen `cm` + SDK/admin mirror + admin
  field-config toggles. No engine, no body.parser. `hidden` = absent from admin form; `readOnly` =
  shown-but-locked. Document "hidden ≠ secure" in the UI (a hidden field is still API-readable/writable
  unless `private`).

### #4b — `private` (omit from API responses) — the careful part
**Investigate the read path first:** `packages/api/src/store/engine.ts` — `serializeRow` (~105, 442),
the compiled column projection (~563–668), `respondById` (~217). The engine serializes rows via a
precompiled zero-copy arena (perf-critical — see memory `uws-perf-audit`). Also
`packages/api/src/store/query.parser.ts` has a `fields=`/`select` projection.

**Design (per research):** `private` fields are stripped on the PUBLIC/content API; the authenticated
ADMIN read path MAY include them (gated by coarse RBAC). So you need a public-vs-admin read mode:
- Mark private fields in the def (RegistryField.private).
- Build a "public" serialization that excludes private columns (a second compiled projection, or a
  filtered field list), selected by a flag on the read entry-point. Identify where "public content
  API" routes vs "admin" routes call the engine, and pass the mode.
- A private field must NEVER be resurrectable via the `fields=`/`select` projection on the public API
  (Strapi's lookup-CVE + #16069 class) — the projection must intersect with the public field set.
- Cover NESTED: private fields inside components, and private fields on relation-populated targets.

**Traps:** the projection-bypass (`fields=private_field`), nested components/relations, perf (don't
add per-row work in the hot arena — prefer a precompiled public projection). `private`+`required`+
`default`+`unique` are all orthogonal (e.g. write-only password hash).

**Tests (security matrix — all must strip on public, include on admin):** get-by-id, list, nested
component, relation populate, AND `fields=`/projection. Add a dedicated test file.

---

## #5 — media `allowedTypes` + min/max count — MEDIUM
**Goal:** restrict a media field to image/video/audio/file categories + a count range.

**Shape:** extend the media options: `allowedTypes?: string[]` (Strapi categories
`images`/`videos`/`audios`/`files`, optionally explicit MIME by detecting a `/`); count via
`minItems`/`maxItems` (reuse, since multiple-media is an id array) or a media-specific min/max.

**Steps:**
- catalog: store allowedTypes + count in the media params (the media resolver / `field.media`).
- registry: extend `field.media` (currently `{ multiple }`) with `{ allowedTypes?, min?, max? }`.
- body.parser: in `coerceMedia` (~204) — after the existing existence/positive-int4 resolution, look
  up each file id in the files registry and check its **stored/detected MIME** (NEVER client-declared)
  against allowedTypes; check count vs min/max. This is the **shared write boundary** — enforce here,
  not just admin (Strapi CVE-2026-22707 + #14648 shipped because an alt upload path skipped the check).
- codegen/DSL/Zod/mirrors/admin per recipe. Admin: extend the media `Allowed count` section with an
  allowed-types multi-select + min/max.

**Traps:** trust the registry MIME not the client; enforce at the shared boundary; min orthogonal to
`required`.

**Tests:** wrong MIME rejected; count bounds; (DB test — needs files in the registry, see how
`coerceMedia` / media tests set up assets).

---

## #7 — `unique` partial-index for i18n / draft&publish — **MED-HIGH, DDL+engine, do PRE-LAUNCH**
**Goal:** fix that `unique` currently spans drafts + locale variants. Gate on be-06 i18n; schedule
**before launch** while migrations are still drop-and-recreate (after launch it's a failure-prone data
migration on existing violations).

**Shape:** `unique?: boolean | { scope?: 'locale' | 'global'; publishedOnly?: boolean }`. Default
`scope:'locale'`, `publishedOnly:false`.

**Steps:**
- `packages/api/src/db/ddl.ts` — today `columnSpec` emits an inline `.unique()`. Replace/augment with a
  separate `CREATE UNIQUE INDEX`:
  - i18n type, `scope:'locale'` (default): `(<field>, locale)`.
  - non-i18n type: single-column `(<field>)` — **must** detect this, else `(field, NULL)` is always
    distinct and the index silently does nothing.
  - `publishedOnly`: append `WHERE published_at IS NOT NULL` (partial index).
  - NULLs are distinct in PG (`NULLS NOT DISTINCT` is PG15+; only offer on effectively-required fields).
  ddl needs to know the type's i18n/D&P flags → thread the schema options into the DDL builder.
- `schema/diff.ts` + `schema/migrate.ts` — classify index add/drop (add unique over existing dups =
  data-dependent → ack; drop = safe). Map 23505 → clean i18n-aware error.
- catalog/Zod/DSL/codegen/mirrors — `unique` becomes a union; emit the object form in codegen.
- **Reject** `shared`(non-localized) + `scope:'global'` at schema-registration (a shared field copied
  into N locale rows would self-collide).
- **Regression test the single-row D&P advantage:** publishing (UPDATE `published_at`) must NOT
  self-collide on a unique field (Strapi #15636 — we're structurally immune; lock it in).

**Traps:** the non-i18n NULL-distinct silent-no-op; NULLS NOT DISTINCT PG version; shared+global
rejection; index-shape matrix (~6 variants: i18n? × scope × publishedOnly).

**Tests:** per-locale uniqueness (same value in two locales OK; dup within a locale rejected);
publishedOnly partial; non-i18n single-column still enforces; publish-no-self-collision.

---

## Stage 6 follow-ups (task #21)

### 6a — undo/redo (Cmd-Z / Cmd-Shift-Z)
Build a `useHistoryState<T>(initial)` hook (snapshot on each `setState`; cap ~100; coalesce optional)
returning `[state, setState, { undo, redo, canUndo, canRedo, reset }]`, and swap it in for
`useState<ModuleFormState>` in `module-form.tsx` (call sites unchanged). Add a keydown handler:
Cmd/Ctrl+Z → undo, Cmd+Shift+Z → redo — **skip when focus is in an input/textarea/select** (let native
text undo win). The pending pill + Discard already exist; surface undo/redo buttons next to them. Make
clear Cmd-Z reverts only UNSAVED edits (never a committed destructive migration).

### 6b — keyboard-accessible drag (replace native HTML5 DnD with @dnd-kit)
Current drag is mouse/touch only (native HTML5, armed-ref handle in `field-card.tsx` + `module-form.tsx`).
Add `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities` (DEP ADD — confirm w/ user). Wrap the
field list in `DndContext`+`SortableContext`, `useSortable` on FieldCard, add the keyboard sensor.
**Pin the dnd-kit version** and add a keyboard-reorder test (tab→space→arrows→space) — dnd-kit #1859
silently broke keyboard DnD on a minor bump. Keep the dedicated drag handle (row has edit/delete
buttons — don't make the whole row the keyboard activator; dnd-kit discussion #1447).

### 6c — move pending/undo/Discard into the header
They're a canvas toolbar now because the header (`BuilderShell`/`BuilderHeader`) is a sibling of
`ModuleForm` and can't see its state. Lift: create a `ModuleBuilder` component that owns the form state
+ renders `BuilderShell` with `headerRight={<pending/undo/discard/Review>}` and the canvas. Routes
(`modules.new.tsx`, `modules.$name.tsx`) render `<ModuleBuilder>` instead of
`<BuilderShell><ModuleForm/></BuilderShell>`.

### 6d — e2e rewrite (own checkpoint)
`apps/admin/e2e/content-type-builder.spec.ts` predates the files-first builder. Rewrite mock-free
against the real API: create a module through the full-screen UI (pick types from the gallery, set
options, add a relation), Review → Apply, then assert via the API + the content manager. Check the e2e
harness in `apps/admin/e2e/helpers.ts` + `README.md`.

### 6e — sidebar-vs-fullscreen decision (PRODUCT CALL — ask the user)
The updated Lua design shows the app sidebar ALONGSIDE the builder, but builder routes currently hide
it (`apps/admin/src/routes/__root.tsx` `isBuilderRoute` opt-out → full-screen). If the user wants the
sidebar back on builder routes: remove/relax the opt-out, and de-duplicate the builder-header brand vs
the app sidebar (the header's module-switcher was the "sidebar replacement while building").

---

## Suggested order for the new session
1. **#2 date min/max + #5 media allowedTypes** — cheap write-time, follow the recipe. (Or #1 regex if
   the user OKs the RE2 dep.)
2. **#4a readOnly/hidden** — trivial; **#4b private** — its own careful slice w/ the security matrix.
3. **6a undo/redo + 6c header lift** — pair them (the lift gives undo/redo a home in the header).
4. **6b @dnd-kit** + **6d e2e** — after a dep decision; e2e is its own checkpoint.
5. **#7 unique partial-index** — gate on / pair with be-06 i18n, pre-launch.
6. **6e sidebar decision** — whenever the user calls it.
