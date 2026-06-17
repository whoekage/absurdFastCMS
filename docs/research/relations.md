# Relations between content-types — research + decisions (June 2026)

Multi-agent research (4 angles → synthesis → adversarial fact-check). Verdict: SOUND, high confidence.
Reads are served from a per-type PRE-SERIALIZED FLAT byte arena (no nested-object slot) — so populate
output is the hard part. Existing substrate: `src/store/relation.ts` (CSR owner→related + EXISTS
`ownersMatching`, serves 1:N and M:N) and a `populate` PARSER — both unwired; `relation` is not a
declarable type; populate is parsed but never executed.

## Decisions

- **Storage: ONE uniform LINK TABLE per relation field (owning side only), for ALL 4 kinds.** Cardinality
  = UNIQUE constraints, not different structures. Strapi creates a join table for EVERY kind; we follow
  it (reject Directus FK-on-owner — it would mutate `ct_` arenas + need two DDL paths). `ct_` tables stay
  UNTOUCHED → the unpopulated read path is byte-identical, zero regression. One DDL path + one edge loader.
  ```
  CREATE TABLE <linkTable> (
    id serial PRIMARY KEY,
    owner_id   integer NOT NULL REFERENCES ct_<owner>(id)  ON DELETE CASCADE,
    related_id integer NOT NULL REFERENCES ct_<target>(id) ON DELETE CASCADE,
    ord double precision   -- our design choice (presentation order); EXISTS filtering ignores it
  );
  ```
  | kind | UNIQUE | 
  |---|---|
  | manyToMany | (none, or UNIQUE(owner_id,related_id) to dedup) |
  | oneToMany  | UNIQUE(related_id) |
  | manyToOne  | UNIQUE(owner_id) |
  | oneToOne   | UNIQUE(owner_id) AND UNIQUE(related_id) |
  Link-table name `<owner>_<field>_lnk`, hash-suffixed on >63-byte overflow, stored in meta. ON DELETE
  CASCADE prunes link rows (link-row cascade only — Strapi has the same gap; no entry cascade in v1).
- **Kinds:** all four + one-way AND two-way (inverse is a virtual meta field reading the SAME link table
  with columns swapped — no DDL). Owning side declares target+kind+inverseField, emits the DDL.
- **Populate execution = HYBRID:** re-materialize ONLY the owner frame (serializeRow minus the trailing
  `}`), then byte-splice the related rows' pre-serialized arena slices (to-one = one rowSlice or bare id
  at the depth frontier; to-many = `[`+slices joined by `,`+`]`), close `}`. Related bytes NEVER parsed/
  re-stringified. `assemblePopulated` parallel to `assemble`. Depth cap 2 (Payload default; bare id at
  frontier). Owner filter+sort+offset+keyset run BEFORE assembly, untouched (populate is opt-in; nested
  relation pagination unsupported in Strapi too). Response shape = Strapi v5 flat (nested object / array
  directly under the field key).
- **Filtering by related field:** parser routes a `filters[<relation>]` key → recurse on the TARGET
  schema → a `{relation, sub}` FilterNode leaf; scanTree runs `relatedTable.scanTree(sub)` →
  `relation.ownersMatching(relatedBitset)` → folds into the AND/OR/NOT bitset combiner. Reuses relation.ts
  + bitset.ts UNCHANGED; deep ≤3 is inside-out orchestration over single-hop relations.
- **Edge loading:** two-phase (load all ct_ tables first, then `SELECT owner_id, related_id FROM
  <linkTable> ORDER BY owner_id` → `link(ownerTable.rowIdByEq('id',owner_id), relatedTable.rowIdByEq('id',
  related_id))`; inverse two-way from the same query swapped). Per-write: re-derive the full edge set from
  Postgres into a fresh Relation + swap (matches the per-type rebuild discipline; sidesteps append-only).
- **Write side:** Strapi set / connect / disconnect of related ids inside the write tx (DELETE+INSERT /
  INSERT ON CONFLICT DO NOTHING / DELETE), then re-derive + swap the CSR.
- **id vs documentId:** Strapi v5 surfaces a 24-char documentId; WE keep the numeric Postgres PK `id` as
  the public key (consistent with the whole project — respondById etc.). Conscious divergence.

## Step-by-step plan (each shippable, mock-free, Testcontainers)

1. `relation.ts` correctness: add `relatedRows(ownerRow): number[]` (postings, no materialization) +
   `fromEdges` rebuild; brute-oracle tests for ownersMatching + rebuild-after-grow. (pure data structure)
2. Declare a relation in meta (a `content_type_relations` table) + link-table runtime DDL (per-kind
   UNIQUE + ON DELETE CASCADE + 63-byte name guard); `dropContentType` → DependentTypesError when targeted.
3. Load edges into the CSR at boot (two-phase) + inverse for two-way.
4. Relational FILTERING (parser routing + scanTree relation leaf + deep ≤3). Highest value/effort.
5. POPULATE execution (the crux): assemblePopulated, byte-splice, depth 2, compose with filter/sort/
   offset/keyset; byte-compare vs a hand-built nested envelope.
6. Write-side set/connect/disconnect + per-write CSR re-derive; ON DELETE cascade prunes edges.
7. (v1.1) populate[rel][filters]/[sort] + populated-response cache invalidation across related types.

## Open questions (deferred / my defaults)
- Meta: a separate `content_type_relations` table (recommended) vs columns on content_type_fields.
- Per-write CSR re-derive: only affected relation(s) vs all touching the type (full is simpler).
- Populated-response caching: v1 = DON'T cache populated responses (correctness first); cross-type
  invalidation later.
- to-many order in populate output: store `ord`, present in order; v1 may be loose (Strapi is buggy here).
- Self-referential / cyclic relations: in scope; depth cap bounds cycles; the two-phase loader +
  DependentTypesError must tolerate a type targeting itself.
