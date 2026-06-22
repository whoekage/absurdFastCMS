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

-- COMPONENT catalog (be-05). A component type is a REUSABLE field group with NO physical ct_ table and NO
-- engine presence: it lives ENTIRELY as meta (component_types + component_type_fields). A content-type (or
-- another component) attaches a component via a `component` / `component-repeatable` / `dynamiczone` field —
-- which renders as a single jsonb COLUMN on the owner ct_ table (no link table), the component instance
-- tree stored inline. Mirrors content_types / content_type_fields, MINUS every physical concern (no
-- table_name, no pg_type/engine_type, no draft_publish/i18n) — a component field's full spec lives in
-- cms_type + params. Created by the migration runner, never the runtime Builder DDL. No backfill (pre-launch).
CREATE TABLE IF NOT EXISTS "component_types" (
	"id"         serial PRIMARY KEY NOT NULL,
	"api_id"     varchar(63) NOT NULL,                    -- the component api_id (e.g. "seo", "hero")
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
-- Case-insensitive uniqueness on the component api_id (mirrors content_types_api_id_lower_uq).
CREATE UNIQUE INDEX IF NOT EXISTS "component_types_api_id_lower_uq" ON "component_types" (lower("api_id"));

CREATE TABLE IF NOT EXISTS "component_type_fields" (
	"id"                serial PRIMARY KEY NOT NULL,
	"component_type_id" integer NOT NULL REFERENCES "component_types"("id") ON DELETE CASCADE,
	"name"              varchar(63) NOT NULL,   -- exact, untruncated field name (also the in-jsonb key)
	-- cms_type: a catalog CmsType (string/integer/...) OR a nesting kind ('component'|'component-repeatable'|
	-- 'dynamiczone') OR 'media'. A component field has NO pg_type/engine_type — it is never a physical column.
	"cms_type"          varchar(32) NOT NULL,
	-- params: the FULL field spec. scalar: {length}|{precision,scale}|{values}|... ; media: {multiple} ;
	-- component/component-repeatable: {component:"<apiId>"} ; dynamiczone: {components:["a","b",...]}.
	"params"            jsonb NOT NULL DEFAULT '{}'::jsonb,
	"nullable"          boolean NOT NULL DEFAULT true,
	"sort"              integer NOT NULL        -- ordering is metadata only; eager, NOT NULL, no nulls
);
-- App enforces case-insensitive duplicate rejection; these are the DB backstops (mirror ctf_*_uq).
CREATE UNIQUE INDEX IF NOT EXISTS "cmptf_type_name_lower_uq" ON "component_type_fields" (component_type_id, lower("name"));
CREATE UNIQUE INDEX IF NOT EXISTS "cmptf_type_sort_uq"       ON "component_type_fields" (component_type_id, "sort");

-- Media/asset registry (be-04). A dedicated SYSTEM table — NOT a content_type / engine type: the columnar
-- engine is built ONLY from content_types/content_type_fields, so assets live + serve from here via their
-- own thin endpoints (POST/GET/DELETE /_files...), never the read engine. Created by the migration runner,
-- never the runtime Builder DDL. No backfill (pre-launch). The `_files`/`files` table name has no ct_
-- prefix and is not user-derivable, so it can never collide with a runtime per-type table.
CREATE TABLE IF NOT EXISTS "files" (
	"id"          serial PRIMARY KEY NOT NULL,            -- positive int4; a media field ref points here
	"filename"    varchar(255) NOT NULL,                  -- SANITIZED original name (display only)
	"mime"        varchar(127) NOT NULL,                  -- sniffed-or-declared content type
	"size"        bigint NOT NULL,                        -- byte length
	"width"       integer,                                -- NULL for non-image uploads
	"height"      integer,                                -- NULL for non-image uploads
	"hash"        varchar(64) NOT NULL,                   -- sha256 hex of the bytes (content address)
	"provider"    varchar(16) NOT NULL,                   -- 'local' | 's3' (which backend holds the bytes)
	"storage_key" varchar(255) NOT NULL,                  -- opaque hash-based key in that provider
	"url"         text,                                   -- cached public URL (nullable; derivable from provider+key)
	"created_at"  timestamp with time zone NOT NULL DEFAULT now()
);
-- Content-addressed dedup: identical bytes upload once. A re-upload of the same hash returns the row.
CREATE UNIQUE INDEX IF NOT EXISTS "files_hash_uq" ON "files" ("hash");

-- ============================================================================================
-- better-auth (generated, do not edit by hand) — be-09a
-- ============================================================================================
-- Emitted by `@better-auth/cli@1.4.21 generate` (Kysely adapter) from src/auth/auth.cli.ts (core
-- emailAndPassword + DB sessions + the @better-auth/api-key plugin's `apikey` table) and FOLDED here
-- VERBATIM (only `IF NOT EXISTS` added for runner idempotency, and the bare `create` upcased). better-auth
-- NEVER runs its own migrations at runtime — runMigrations() owns the whole schema. Credential password
-- hashes live in `account.password` (better-auth hashes at rest); these are the ONLY tables that hold an
-- auth secret. To regenerate after an auth-config change: re-run the CLI against an EMPTY database and
-- re-fold the diff. Per migration-policy: ONE consolidated init file, drop & recreate, no backfill.
-- be-09f: the four admin-plugin columns (role/banned/banReason/banExpires) are folded onto "user" exactly
-- as `@better-auth/cli generate` emits them with the admin() plugin enabled. NOTE: `role` here is a
-- better-auth field with ZERO CMS authority (adminRoles:[]); our RBAC tables own authorization.
CREATE TABLE IF NOT EXISTS "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null, "role" text, "banned" boolean, "banReason" text, "banExpires" timestamptz);

-- be-09f: the admin-plugin `impersonatedBy` column folded onto "session" (impersonation is NOT exposed as
-- a route this slice — scope fence — but the column is part of the plugin's emitted schema).
CREATE TABLE IF NOT EXISTS "session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade, "impersonatedBy" text);

CREATE TABLE IF NOT EXISTS "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

CREATE TABLE IF NOT EXISTS "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

CREATE TABLE IF NOT EXISTS "apikey" ("id" text not null primary key, "configId" text not null, "name" text, "start" text, "referenceId" text not null, "prefix" text, "key" text not null, "refillInterval" integer, "refillAmount" integer, "lastRefillAt" timestamptz, "enabled" boolean, "rateLimitEnabled" boolean, "rateLimitTimeWindow" integer, "rateLimitMax" integer, "requestCount" integer, "remaining" integer, "lastRequest" timestamptz, "expiresAt" timestamptz, "createdAt" timestamptz not null, "updatedAt" timestamptz not null, "permissions" text, "metadata" text);

CREATE INDEX IF NOT EXISTS "session_userId_idx" on "session" ("userId");
CREATE INDEX IF NOT EXISTS "account_userId_idx" on "account" ("userId");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" on "verification" ("identifier");
CREATE INDEX IF NOT EXISTS "apikey_configId_idx" on "apikey" ("configId");
CREATE INDEX IF NOT EXISTS "apikey_referenceId_idx" on "apikey" ("referenceId");
CREATE INDEX IF NOT EXISTS "apikey_key_idx" on "apikey" ("key");

-- ============================================================================================
-- RBAC registry tables (hand-written) — be-09a
-- ============================================================================================
-- The permission rules the in-memory RbacRegistry folds into a Map<userId, Set<action>> at boot (PG =
-- truth, RAM = served; a check is a pure in-memory set test). UNIFIED IDENTITY: user_roles.user_id is an
-- FK to the better-auth "user"(id) (text) — no separate identity store. These tables hold NO secrets.
-- ON DELETE CASCADE everywhere so dropping a user/role/permission tidies its assignments. Pre-launch:
-- drop & recreate, no backfill.
CREATE TABLE IF NOT EXISTS "roles" (
	"id"   serial PRIMARY KEY NOT NULL,
	"name" text UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS "permissions" (
	"id"     serial PRIMARY KEY NOT NULL,
	"action" text UNIQUE NOT NULL          -- e.g. 'content.read', 'content.write'
);

CREATE TABLE IF NOT EXISTS "role_permissions" (
	"role_id"       integer NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
	"permission_id" integer NOT NULL REFERENCES "permissions"("id") ON DELETE CASCADE,
	PRIMARY KEY ("role_id", "permission_id")
);

CREATE TABLE IF NOT EXISTS "user_roles" (
	"user_id" text    NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"role_id" integer NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
	PRIMARY KEY ("user_id", "role_id")
);

-- be-09f: the TEAM table — management users (admins/editors/moderators) over the unified better-auth
-- identity. NOT a content_type (no ct_ prefix, no engine presence) — a system table like `files`/`roles`.
-- user_id is the unified identity FK; one row per user (UNIQUE). status gates membership (active/suspended).
-- The RESOLVED ROLE is NOT stored here — it lives in user_roles (RBAC truth); team_view JOINs them at read.
-- timestamptz only (never the `time` cmsType — it bricks a type on registry reload). Drop & recreate, no backfill.
CREATE TABLE IF NOT EXISTS "team" (
	"user_id"    text         NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"status"     varchar(16)  NOT NULL DEFAULT 'active',     -- 'active' | 'suspended'
	"created_at" timestamptz  NOT NULL DEFAULT now(),
	"updated_at" timestamptz,
	PRIMARY KEY ("user_id")
);

-- be-09b: seed the COARSE permission actions + the four default roles + their grants.
-- Idempotent (ON CONFLICT DO NOTHING) so a re-run / drop-recreate is safe. NO user_roles seeded here —
-- role GRANTS to users come ONLY from the advisory-locked first-admin bootstrap (see auth.ts), never a body.
INSERT INTO "permissions" ("action") VALUES
  ('content.read'),     -- defined for completeness; NOT enforced this slice (reads are public by config)
  ('content.create'),
  ('content.update'),
  ('content.delete'),
  ('content.publish'),
  ('builder.manage'),   -- content-type + component-type mutations
  ('media.upload'),
  ('team.manage')       -- be-09f: manage the team (list/add/suspend/role/remove); super-admin only this slice
ON CONFLICT ("action") DO NOTHING;

INSERT INTO "roles" ("name") VALUES
  ('super-admin'), ('editor'), ('author'), ('viewer')
ON CONFLICT ("name") DO NOTHING;

-- super-admin = EVERY permission.
INSERT INTO "role_permissions" ("role_id", "permission_id")
  SELECT r.id, p.id FROM "roles" r CROSS JOIN "permissions" p WHERE r.name = 'super-admin'
ON CONFLICT DO NOTHING;

-- editor = full CRUD + publish + media, NO builder.manage.
INSERT INTO "role_permissions" ("role_id", "permission_id")
  SELECT r.id, p.id FROM "roles" r JOIN "permissions" p
    ON p.action IN ('content.read','content.create','content.update','content.delete','content.publish','media.upload')
  WHERE r.name = 'editor'
ON CONFLICT DO NOTHING;

-- author = create + update + read + media (row-level "own" scoping is be-09e; coarse here = create+update).
INSERT INTO "role_permissions" ("role_id", "permission_id")
  SELECT r.id, p.id FROM "roles" r JOIN "permissions" p
    ON p.action IN ('content.read','content.create','content.update','media.upload')
  WHERE r.name = 'author'
ON CONFLICT DO NOTHING;

-- viewer = read only.
INSERT INTO "role_permissions" ("role_id", "permission_id")
  SELECT r.id, p.id FROM "roles" r JOIN "permissions" p ON p.action = 'content.read'
  WHERE r.name = 'viewer'
ON CONFLICT DO NOTHING;
