# Research — wiring the trigram `$contains` accelerator into production

**Trigger:** the trigram/substring accelerator (the `scan.bench` "HEADLINE WIN 1: ~116×" on `$contains`) is
BUILT, TESTED, BENCHMARKED — but NEVER wired into production. Every `$contains`/`$startsWith` on a live
`string`/`text` field runs the brute O(n) path. This doc decides HOW index creation should be declared, then
gives the wiring plan.

## 1. Current state (surveyed)

**Index declaration today is fully AUTOMATIC, by field type** — there is no per-field index knob anywhere.
`buildIndexPlan(fields)` (`src/db/registry.ts:422`) emits exactly two lists:

- `eq`:    `id`, `document_id`, `locale` (i18n), `bool`, and `enumeration` (low-card `string` with `values`).
- `sorted`: `i32` / `f64` / `date` / `i64` / `decimal`.
- SKIPPED: `json`, `published_at` (null-bitset served), and — crucially — **plain `string` and `text`
  (non-enum) get NO index at all.** Those are exactly the `$contains` targets, and they get nothing.

`IndexPlan` is `{ eq: string[]; sorted: string[] }` — there is no `substring` slot. `engine.loader.ts:76-77`
creates only `createEqIndex` + `createSortedIndex`.

**The trigram machinery exists and is opt-in BY DESIGN.** `src/store/indexes/substring.index.ts` (header):
"the deduped-dictionary brute scan stays the **mandatory verification + fallback floor and the default for
unflagged columns**." The per-column flag is `Table.enableSubstringIndex(field)` → `StringColumn/TextColumn
.enableSubstringIndex()`, which builds `rawTrigrams`/`foldedTrigrams` lazily on publish. **But
`enableSubstringIndex` is called ONLY from tests + benches — never from the schema→registry→loader path.**
So the flag is never set in prod. `FieldOptions` (the schema field-options grab-bag) has no `searchable`/
`index` key, so nothing CAN set it. That is the entire gap.

**Cost shape (important — cheaper than it looks):** the trigram indexes over **distinct dictionary CODES**,
not rows. For each DISTINCT string it posts the code under each of its 3-gram windows; postings are a
CSR-packed `Int32Array` (no `Map`/GC graph). So memory ≈ Σ(distinct-string trigram-count) × int32, scaling
with DISTINCT VALUES not row count. Low-card columns (status) are trivial; a high-card `text` (body) pays per
distinct body. Build is on-publish (warm), amortized. The brute floor stays the fallback + the correctness
verifier (every trigram candidate is re-checked with the same `includes()`), so accelerating is always safe.

## 2. The product question — auto-all-by-type vs explicit opt-in

`eq`/`sorted` are CHEAP (eq ≈ one int32 code/row; sorted ≈ a permutation), so auto-by-type is right for them.
**The trigram is a different cost class** (per-distinct-value postings + on-publish build), so the same
"auto everything" rule does not transfer.

**Industry precedent is unanimous — trigram/full-text is declared EXPLICITLY, per-field, selectively:**
- **Postgres `pg_trgm`**: opt-in `CREATE INDEX … USING gin (col gin_trgm_ops)`; docs + practitioners say use
  it **selectively for pattern matching, not universally** — it is memory-heavy and not a B-tree replacement.
- **Payload CMS**: explicit per-field `index: true` (code-first); index the fields you actually query.
- **Strapi**: index the frequently-queried fields (explicit).
- Nobody auto-indexes every text field, least of all with a trigram/GIN.

**Single-instance + in-RAM ([[single-instance-target]]) makes memory THE constraint.** A schema with many
`string`/`text` fields (tags, names, slugs, descriptions…), most never searched, would pay trigram memory +
build on ALL of them under auto-all. That is wasteful even when affordable.

**Decision: opt-in per field, NOT auto-all.** This matches (a) the engine's own "unflagged → brute" design,
(b) every comparable system, (c) the memory-conscious single-instance target. `eq`/`sorted` stay auto-by-type.

### The opt-in surface — a `searchable` field option (schema code, not admin UI)

NOTE: the runtime admin Builder UI was removed ([[content-type-to-module-rename]]); schema is files-first.
So index intent lives as a FIELD OPTION in the schema code (`c.text({ id, searchable: true })`), persisted in
`schema/<apiId>.json` + `_schema_applied`. A future admin can surface it as a toggle; the files-first
`/builder/modules` PUT already round-trips arbitrary field options. There is no "admin UI vs auto" fork —
under files-first it is "field option in code (optionally surfaced by a UI later)".

Naming: **`searchable: true`** (product-facing — an editor/dev understands "make this field searchable") in
preference to `index: 'trigram'` (leaks the impl) or `fullText: true` (implies tokenized FTS, which this is
not). Internally it maps to the trigram accelerator; if more opt-in index kinds appear later, promote to
`index?: { trigram?: boolean; … }` then.

## 3. Wiring plan (incremental, byte-identical for non-searchable fields)

1. **Schema option.** Add `searchable?: boolean` to `FieldOptions` (`src/db/type.catalog.ts`) + the Zod
   `fieldOptionsSchema` (`src/db/schema/model.ts`). Validate it is set ONLY on `string`/`text` (reject on
   numeric/bool/date/json/enum-only at the schema boundary with a friendly error — the engine already throws
   `substring index requires a string/text field`, but fail earlier + nicer).
2. **Authoring builders.** `c.string({ …, searchable })` / `c.text({ …, searchable })` accept + forward it.
3. **RegistryField.** Thread `searchable` from the field row → `RegistryField` (alongside `nullable`/`localized`).
4. **IndexPlan.** Add `substring: string[]`. `buildIndexPlan` pushes a field name onto `substring` when
   `searchable === true` (and type ∈ {string, text}). `eq`/`sorted` unchanged.
5. **Loader.** `engine.loader.ts`: after eq/sorted, `for (const f of def.indexPlan.substring)
   t.enableSubstringIndex(f)` — BEFORE `warmIndexes()` so the trigram builds during warm.
6. **Live-reload + rebuild.** Ensure `rebuildType`/`swapFromIR` re-apply `enableSubstringIndex` from the new
   def, so a Builder edit toggling `searchable` takes effect on swap (same path as eq/sorted re-creation).
7. **Wire projection (additive).** Surface `searchable` on the projected `FieldDefinition` (SDK
   `projectSchemas`) so a future admin field editor can read/round-trip it.
8. **No SQL migration.** The trigram is a RAM index; the only persisted change is the `searchable` flag inside
   the field options (files-first `_schema_applied`). `0001_init.sql` untouched.
9. **Tests.** e2e: a `searchable:true` text field's `$contains` hits the accelerator (assert via a large-row
   fixture that the result is correct AND, if observable, that the accel fired); a non-searchable field's
   `$contains` returns the SAME rows via brute (correctness parity). Plus the schema-validation rejection on a
   non-string field, and the projection round-trip.

**Scope note (`$startsWith`/`$endsWith`):** the trigram accelerates the `$contains*` family. Affix
(`$startsWith`/`$endsWith`) currently brutes (see `scan.bench` "startsWith [dict brute]"); a sorted-by-string
or affix accel is a SEPARATE slice. Ship `$contains` acceleration first; affix stays brute (correct) under
`searchable` until a follow-up.

## 4. Decisions to confirm (recommendation in **bold**)

- **D1 — option name:** **`searchable: boolean`** vs `index: 'trigram'` vs `fullText: boolean`.
- **D2 — default:** **`false` (explicit opt-in)** — memory-honest, matches pg_trgm/Payload + the engine's
  "unflagged → brute" default — vs `true for text` (search-by-default; better DX, pays trigram on every body).
- **D3 — first scope:** **`$contains`/`$containsi` only** (affix `$startsWith`/`$endsWith` a follow-up) vs
  all string ops at once.

Recommendation: ship **`searchable: boolean`, default `false`, `$contains` family first** — minimal, honest,
matches the engine's design and the industry, and activates the dormant 116× win exactly where asked for.
