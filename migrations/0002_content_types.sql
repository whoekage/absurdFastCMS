-- Runtime content-type catalog. Meta is the SOURCE OF TRUTH; each row's per-type physical table is
-- derived from it. Created by the hand-written migration runner, never by the runtime DDL path.
-- IF NOT EXISTS so the runner stays idempotent (matches 0001's style).
CREATE TABLE IF NOT EXISTS "content_types" (
	"id"          serial PRIMARY KEY NOT NULL,
	"api_id"      varchar(63) NOT NULL,
	"table_name"  varchar(63) NOT NULL,
	"created_at"  timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at"  timestamp with time zone NOT NULL DEFAULT now()
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
	"params"          jsonb NOT NULL DEFAULT '{}'::jsonb  -- {length}|{precision,scale}|{values:[...]} etc.
);
-- App enforces case-insensitive duplicate rejection; these are the DB backstops.
CREATE UNIQUE INDEX IF NOT EXISTS "ctf_type_name_lower_uq" ON "content_type_fields" (content_type_id, lower("name"));
CREATE UNIQUE INDEX IF NOT EXISTS "ctf_type_sort_uq"       ON "content_type_fields" (content_type_id, "sort");
