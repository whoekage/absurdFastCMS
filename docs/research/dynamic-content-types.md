# Dynamic content-types — architecture research

Research for the headline feature: user-defined content-types (declare an entity with named typed
fields at runtime, à la Strapi/Directus). Produced by a multi-agent research workflow (5 survey angles
→ synthesis → adversarial fact-check against primary sources). Verdict: central recommendation
**supported, high confidence**, with one factual correction (see end).

## Decisions locked (2026-06-15)

- **Storage:** real **table-per-content-type** with real user-named columns in real native Postgres
  types, via runtime DDL. (Earlier decision.)
- **All-in:** everything becomes a content-type (including `article`); static schema + Drizzle removed.
- **DDL tool:** **Kysely** schema-builder — used as a DDL builder/compiler over the existing
  postgres.js connection (so we keep a single driver: either the `kysely-postgres-js` dialect or
  `.compile()` → execute via `sql.unsafe`). (Chose Kysely over a hand-rolled generator.)
- **Type scope:** broad from v1 — add new engine column types `i64` (bigint), scaled-int `decimal`,
  and lazy-parsed `json`, alongside existing `i32/f64/bool/string/date/text`.
- **Defaults:** enum = `varchar + CHECK` (not native pg enum); datetime = `timestamptz`; field rename
  = real `ALTER TABLE … RENAME COLUMN` (better than Strapi/Directus drop+recreate).

## 1. Real tables / real columns / real types via runtime DDL — yes

Production-proven (Directus, Strapi). Postgres DDL (`CREATE/ALTER TABLE`) is **transactional**: a
content-type change (create table + N add-column + meta insert) wraps in one `BEGIN…COMMIT`, atomic
rollback keeps the physical table and the meta layer in sync. PG 11+ `ADD COLUMN` with no default or a
constant/non-volatile default is a metadata-only catalog flip (no rewrite), `ACCESS EXCLUSIVE` only
briefly. Sources: postgresql.org/docs/current/sql-altertable.html;
wiki.postgresql.org/wiki/Transactional_DDL_in_PostgreSQL.

## 2. Column ordering — metadata, never physical

Postgres column order is `pg_attribute.attnum`, immutable; `ADD COLUMN` always appends, `DROP COLUMN`
leaves a tombstoned slot. No portable reorder. → Store an explicit `sort` integer in field metadata and
project an explicit ordered column list; never `SELECT *` and trust ordinal order. Directus uses a
`sort` int in `directus_fields` (init it eagerly — it can default null until first reorder, issue
#18273); Strapi matches columns **by name**, never ordinal. For us the read path is the RAM engine, so
physical order is irrelevant anyway.

## 3. Build vs buy

Both Directus and Strapi are built on **Knex.js**. Their cross-dialect design makes them **drop
Postgres-native types** (Strapi: no native uuid/enum, decimal hard-coded `(10,2)`; Knex: 14-type set).
We want native `uuid`/`numeric(p,s)`/enum, so we use **Kysely** (lighter, TS-first, auto-quotes
identifiers, `sql\`\`` escape hatch covers native types on `addColumn`; note `alterTable.setDataType`
only takes `ColumnDataType` — kysely issue #474). Run it over our postgres.js connection to keep one
driver.

## 4. How Directus & Strapi do it

- **Directus** — Knex.js + `knex-schema-inspector`. Real tables/columns; `CollectionsService.createOne`
  validates name, injects default `id` PK, wraps DDL + meta inserts in one transaction;
  `FieldsService.addColumnToTable` maps abstract type → Knex builder. 14-member `KNEX_TYPES`. Field
  order = `sort` int in `directus_fields`. No native column rename (drop+recreate), no native pg enum
  (varchar + choices in meta), relations = real FKs + `directus_relations` meta.
- **Strapi** — `@strapi/database` over Knex (pg dialect). Content types declared in `schema.json`
  `attributes`; a **diff-based schema sync on every boot** converges the DB, matching columns **by
  name**. `getColumnType`: `integer→integer`, `biginteger→bigInteger`, `decimal→decimal(10,2)` (fixed!),
  `float→double`, `json→jsonb`, `string/email/uid/enumeration→varchar`, `text→text`,
  `datetime→timestamp(6)` (no TZ), `boolean→boolean`. No native uuid/enum/arrays. Renames are
  data-losing drop+add; unknown columns silently dropped (gated by `forceMigration`). Enum values must
  start with a letter (GraphQL Name regex).

## 5. Type catalog (CMS field → Postgres → engine column)

| CMS type | Postgres | Engine type | Notes / pitfalls |
|---|---|---|---|
| string / email / uid / enum | `varchar` (+CHECK for enum) | `string` (dict) | email/uid validated at app layer |
| text / richtext | `text` | `text` | — |
| boolean | `boolean` | `bool` | — |
| integer | `integer` | `i32` | — |
| **biginteger** | `bigint` | **`i64` (BigInt64Array)** | JS Number loses precision >2^53; postgres.js returns int8 as **string** — parse to BigInt, never via Number; `JSON.stringify(BigInt)` throws → emit as string at API edge |
| float | `double precision` | `f64` | — |
| **decimal** | `numeric(p,s)` (configurable, not (10,2)) | **scaled-int (BigInt64Array of round(v·10^s), scale in meta)** | never store money as f64; postgres.js returns numeric as exact **string**; >18 digits overflows i64 → cap or fallback |
| **uuid** | `uuid` (native) | `string` (dict) for v1 | 128 bits; packed BigUint64Array hi/lo is a later optimization |
| **json / array** | `jsonb` | `text` + lazy parse | don't JSON.parse every row at load; parse only when queried |
| date | `date` | `date` | — |
| datetime | `timestamptz` | `date` (epoch ms) or `i64` µs if sub-ms needed | f64-ms/JS Date can't hold µs |
| time | `time` | `i32` seconds-of-day | — |

**Three load-bearing pitfalls:** (1) Number overflow on bigint, (2) f64 rounding of money, (3)
`JSON.stringify` throws on BigInt. postgres.js returns int8/numeric/uuid as **strings** — parse those
directly into the exact engine representation, never through `Number`.

New engine work for "broad now": `i64` column (BigInt64Array) incl. its sorted-index path (the current
sorted index is f64-radix — bigint needs a comparison/i64 path); scaled-int `decimal`; lazy-parse
`json` on the text substrate. `uuid`/`enum` reuse dict-coded `string`.

## 6. Safety (runtime DDL)

Identifiers can't be parameter-bound. Defense in depth: **allowlist** `^[A-Za-z_][A-Za-z0-9_$]*$`;
**≤63-byte** length check (Postgres silently truncates → collisions); double-quote even after allowlist;
reserve/reject a namespace prefix. Each schema change = one transaction. `CREATE INDEX CONCURRENTLY`
can't run in a transaction block → after the meta tx. Cheap: `ADD COLUMN` (no/constant default).
**Rewrites (background, never request-path):** volatile default, stored generated/identity column, most
`ALTER COLUMN TYPE`, and notably **`int4→int8`** (integer→bigint is NOT binary-coercible).

## 7. Proposed approach

- **Meta tables:** `content_types(api_id, table_name, …)`, `content_type_fields(content_type_id, name=
  column, cms_type, pg_type + params, nullable, default, unique, sort)`. Single source of truth; the
  physical table is derived from it.
- **Per-type tables:** one real table per type, native columns, created/altered via Kysely over
  postgres.js; identifiers allowlisted + 63-byte-checked + quoted; literals via `$n`. One tx per change.
- **Ordering:** `content_type_fields.sort` only; always project explicit ordered column lists.
- **Engine ingest:** read bigint/numeric/uuid as strings, parse into engine types directly. json/array
  stay lazy text. Serialize bigint/decimal back to strings at the API edge.
- **Renames:** true `RENAME COLUMN` + update meta in one tx (improvement over Strapi/Directus).
- **Type changes:** route through a background/rewrite-aware path, not the request path.

## Open questions (deferred / N/A for now)

- Native enum vs `varchar + CHECK` → chose CHECK.
- timestamptz vs naive timestamp → chose timestamptz; need µs (`i64`)? → default no (f64-ms).
- decimal max precision (scaled-i64 breaks >~18 digits) → cap TBD.
- Multi-tenancy isolation, Redis cluster invalidation sequencing → N/A (single process today).

## Verification corrections

- **Factual fix:** postgres.js **does** auto-quote dynamic identifiers now (`sql('name')` → `"name"`);
  old issue #21 is resolved. (Makes the DDL layer easier; allowlist still advisable as defense-in-depth.)
- Minor: the "can't run in a transaction block" list (CREATE INDEX CONCURRENTLY, CREATE/DROP DATABASE,
  TABLESPACE, VACUUM) is true but documented on each command's own page, not sql-altertable.html.
- Minor: the metadata-only `ADD COLUMN` fast-path lock level is a real-world characterization slightly
  beyond what sql-altertable.html states verbatim.
