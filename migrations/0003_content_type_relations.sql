-- Relation catalog. ONE row per relation SIDE: the OWNING side (is_owner=true) drives the link-table
-- DDL; a two-way relation adds an INVERSE row (is_owner=false, SAME link_table, NO DDL — read reversed).
-- Meta is the SOURCE OF TRUTH: link_table stores the RESOLVED (possibly hash-suffixed) physical name so
-- the loader / drop path NEVER re-derive ambiguously. Idempotent IF NOT EXISTS (matches 0002).
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
