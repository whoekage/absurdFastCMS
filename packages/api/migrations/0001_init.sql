-- Init migration: the global document_id allocator + the SYSTEM tables (media `files`, auth). The
-- content-type CATALOG is FILES-FIRST — `entities/<apiId>/schema.ts` + the `_schema_applied` snapshot are
-- the source of truth, and each per-type `ct_` table (+ link tables) is materialized by `migrate()`. The
-- legacy meta tables (content_types / content_type_fields / content_type_relations / component_types /
-- component_type_fields) were REMOVED in the legacy-meta teardown. Hand-written runner; IF NOT EXISTS
-- everywhere so the runner stays idempotent. (Pre-launch: drop & recreate, no backfill.)

-- Global document_id allocator. ONE id space across EVERY ct_ table: a managed type's document_id
-- column DEFAULTs to nextval('document_id_seq'). A draft/publish or i18n variant REUSES a parent
-- document's id (explicit insert) rather than drawing a fresh one. Global singleton => migration, not the
-- per-type Builder DDL. Created FIRST so any later DDL may reference it safely.
CREATE SEQUENCE IF NOT EXISTS "document_id_seq";

-- Media/asset registry (be-04). A dedicated SYSTEM table — NOT a content_type / engine type: the columnar
-- engine is built ONLY from the files-first content-type schemas, so assets live + serve from here via their
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
  ('team.manage'),      -- be-09f: manage the team (list/add/suspend/role/remove); super-admin only this slice
  ('token.manage')      -- be-09c: create/revoke API keys for ANOTHER user (cross-user admin path); super-admin only
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
