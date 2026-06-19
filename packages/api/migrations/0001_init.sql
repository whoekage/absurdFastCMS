-- Init migration: the runtime content-type catalog (meta is the SOURCE OF TRUTH; each row's per-type
-- physical ct_ table is derived from it by the Builder DDL, never by this migration) plus the global
-- document_id allocator. Created by the hand-written migration runner, never by the runtime DDL path.
-- IF NOT EXISTS everywhere so the runner stays idempotent. Consolidated from the former 0002 + 0003.

-- Global document_id allocator. ONE id space across EVERY ct_ table: a managed type's document_id
-- column DEFAULTs to nextval('document_id_seq'). A future draft/publish or i18n variant REUSES a
-- parent document's id (explicit insert) rather than drawing a fresh one. Global singleton => migration,
-- not the per-type Builder DDL. Created FIRST so any later DDL may reference it safely.
CREATE SEQUENCE IF NOT EXISTS "document_id_seq";

CREATE TABLE IF NOT EXISTS "content_types" (
	"id"          serial PRIMARY KEY NOT NULL,
	"api_id"      varchar(63) NOT NULL,
	"table_name"  varchar(63) NOT NULL,
	"created_at"  timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at"  timestamp with time zone NOT NULL DEFAULT now(),
	-- PER-TYPE OPT-IN Draft & Publish (Model A). META flag only: when true, the Builder DDL adds a
	-- nullable snake_case "published_at" system column to ct_<type> (NULL = draft, NOT NULL = published).
	-- DEFAULT false => every existing/seeded type is non-D&P (byte-identical reads); pre-launch drop &
	-- recreate means no backfill. NOTE: distinct from the article seed's USER field "publishedAt"
	-- (camelCase) — physically and on the wire a different key.
	"draft_publish" boolean NOT NULL DEFAULT false,
	-- PER-TYPE OPT-IN i18n (localization). META flag only: when true, the Builder DDL adds a NOT NULL
	-- snake_case "locale" system column (varchar) to ct_<type> + a UNIQUE(document_id, locale) constraint
	-- (one row per (document, locale)). DEFAULT false => every existing/seeded type is non-i18n
	-- (byte-identical reads: no locale column, document_id still loader-skipped). Pre-launch drop &
	-- recreate means no backfill.
	"i18n" boolean NOT NULL DEFAULT false
);
-- Case-insensitive uniqueness on BOTH the api_id and the derived table_name (PG-quoting semantics +
-- truncation rule): two api_ids that fold/truncate to one table are rejected by the DB as a backstop.
CREATE UNIQUE INDEX IF NOT EXISTS "content_types_api_id_lower_uq"     ON "content_types" (lower("api_id"));
CREATE UNIQUE INDEX IF NOT EXISTS "content_types_table_name_lower_uq" ON "content_types" (lower("table_name"));

CREATE TABLE IF NOT EXISTS "content_type_fields" (
	"id"              serial PRIMARY KEY NOT NULL,
	"content_type_id" integer NOT NULL REFERENCES "content_types"("id") ON DELETE CASCADE,
	"name"            varchar(63) NOT NULL,   -- exact, untruncated user field name (also the column name)
	"cms_type"        varchar(32) NOT NULL,   -- catalog cms_type literal (string/integer/biginteger/...)
	"pg_type"         varchar(64) NOT NULL,   -- rendered pg type literal (e.g. varchar(255), numeric(10,2))
	"engine_type"     varchar(16) NOT NULL,   -- INTENT string (i32/.../text PLUS i64/decimal/json) — NOT ColumnType
	"nullable"        boolean NOT NULL DEFAULT true,
	"sort"            integer NOT NULL,       -- ordering is metadata only; eager, NOT NULL, no nulls
	"default_value"   text,                   -- constant default as a literal string (NULL = none)
	"params"          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {length}|{precision,scale}|{values:[...]} etc.
	-- PER-FIELD i18n localization (only meaningful on an i18n type). true => the field is LOCALIZED
	-- (each locale variant row carries its own value). false => the field is SHARED across the
	-- document's locale variants (write-side fan-out keeps siblings in sync — a later slice). DEFAULT
	-- true: every field is localized by default, so each variant row stands alone and reads stay
	-- one-row-per-locale (S1 read-fast invariant). Irrelevant for a non-i18n type (no variants exist).
	"localized"       boolean NOT NULL DEFAULT true
);
-- App enforces case-insensitive duplicate rejection; these are the DB backstops.
CREATE UNIQUE INDEX IF NOT EXISTS "ctf_type_name_lower_uq" ON "content_type_fields" (content_type_id, lower("name"));
CREATE UNIQUE INDEX IF NOT EXISTS "ctf_type_sort_uq"       ON "content_type_fields" (content_type_id, "sort");

-- Relation catalog. ONE row per relation SIDE: the OWNING side (is_owner=true) drives the link-table
-- DDL; a two-way relation adds an INVERSE row (is_owner=false, SAME link_table, NO DDL — read reversed).
-- Meta is the SOURCE OF TRUTH: link_table stores the RESOLVED (possibly hash-suffixed) physical name so
-- the loader / drop path NEVER re-derive ambiguously.
CREATE TABLE IF NOT EXISTS "content_type_relations" (
	"id"              serial PRIMARY KEY NOT NULL,
	"content_type_id" integer NOT NULL REFERENCES "content_types"("id") ON DELETE CASCADE,
	"field_name"      varchar(63) NOT NULL,   -- the relation field / API key on THIS side's type
	"kind"            varchar(16) NOT NULL,   -- oneToOne|oneToMany|manyToOne|manyToMany (closed set; app-validated)
	"target_api_id"   varchar(63) NOT NULL,   -- api_id of the OTHER type (string, not an FK; mirrors content_types.api_id)
	"is_owner"        boolean NOT NULL,       -- true => this row emitted the link-table DDL
	"inverse_field"   varchar(63),            -- NULL for one-way; the partner field name for two-way
	"link_table"      varchar(63) NOT NULL,   -- RESOLVED <=63-byte link-table name (possibly hash-suffixed)
	"sort"            integer NOT NULL,       -- relation ordering within its own type (independent of content_type_fields.sort)
	"created_at"      timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at"      timestamp with time zone NOT NULL DEFAULT now()
);
-- Relation-vs-relation uniqueness within a type (case-insensitive); the 23505 backstop for a re-declare race.
CREATE UNIQUE INDEX IF NOT EXISTS "ctr_type_field_lower_uq" ON "content_type_relations" (content_type_id, lower("field_name"));
-- Cheap inbound-reference scan for the drop guard (lower(target_api_id)).
CREATE INDEX IF NOT EXISTS "ctr_target_api_id_lower_idx" ON "content_type_relations" (lower("target_api_id"));
