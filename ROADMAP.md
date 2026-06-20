# absurdFastCMS — Roadmap

An *absurdly fast* headless CMS. Postgres is the source of truth; reads are served from an in-process
columnar in-memory engine with pre-serialized bytes. The query API speaks Strapi v5's bracket-filter
syntax, so existing Strapi clients work unchanged.

This roadmap is grounded in (a) a precise inventory of what is built, (b) the table-stakes feature set
of leading headless CMSs (Strapi v5, Directus, Payload, Contentful, Sanity), and (c) our architecture's
specific constraints (columnar in-memory read layer, Strapi-v5 emulation, single-instance OSS core).

> **Auth and transactional email are intentionally scheduled LAST** (Phases 8–9), per product decision —
> the open API is built against first, with auth seams already stubbed in the SDK and HTTP layer.

## Current state (strong foundation)

| Area | Status |
| --- | --- |
| Columnar in-memory read engine (serialize-on-write, bitset filter algebra, selectivity planner) | ✅ |
| Strapi-v5 query API: 24 filter operators, `$and/$or/$not`, sort, offset **and** keyset pagination | ✅ |
| `populate` (nested, depth-capped) — **parsed and executed** end-to-end | ✅ |
| Write path: create / partial-update / delete + relation ops (set/connect/disconnect) in one tx | ✅ |
| Runtime content-type **Builder** over HTTP (create type, add/rename/change-type/drop field, drop type) | ✅ |
| Typed, zero-dependency SDK (`@absurd/sdk`) at full HTTP parity | ✅ |
| Admin (`@absurd/admin`): generic content manager, list filter/sort/search, bulk, app-shell, relation UX, Playwright E2E | ✅ |
| 16 scalar field types (string/text/email/uid/enumeration/integer/biginteger/float/decimal/boolean/date/datetime/json/array/uuid; `time` excluded — engine load path rejects it) | ✅ |

## Gap matrix vs competitor table-stakes

| Capability | Competitors | Us | Gap |
| --- | --- | --- | --- |
| Scalar field types + rich text | 5/5 | ✅ scalars · ❌ rich text | med |
| Relations (o2o/o2m/m2o/m2m) | 5/5 | ⚠️ read+write+DDL exist, **no HTTP declaration / not in projectDef** | **high** |
| Components / dynamic zones / repeatables | 5/5 | ❌ (raw json only) | high |
| Query: filter/sort/paginate/**fields** | 5/5 | ✅ except `fields` (sparse selection) | low |
| `populate` / depth control | 5/5 | ✅ | — |
| **Draft & Publish** (`status`) | 5/5 | ❌ | **high** |
| **i18n** (per-field locale) | 5/5 | ❌ | high |
| **Media library** + image transforms + S3 | 5/5 | ❌ | **high** |
| Versioning / history / rollback | 5/5 (often paid) | ❌ | med |
| Webhooks / events | 5/5 | ❌ (ChangeBus exists — natural hook point) | med |
| GraphQL | 4/5 | ❌ | low (defer) |
| Scheduled publishing | 5/5 (often paid) | ❌ | low (depends on Draft&Publish) |
| RBAC / roles / **API tokens** | 5/5 | ❌ | → with auth (last) |
| Full-text / relevance search | 2/5 native | ⚠️ `$containsi` + opt-in trigram | differentiator |

**Strapi-v5 compatibility to audit:** v5 uses `documentId` (24-char stable id) and a flattened response
(no `data.attributes`). We must confirm whether we emulate this — the SDK and admin currently key on the
numeric `id`.

## Phased plan

Ordered by dependency and leverage. Auth (Phase 8) and email (Phase 9) are last by design.

### Phase 0 — Relations over HTTP *(start here — highest leverage)*
Close the nearly-complete relational layer. The repo layer already supports relations (`addRelation`,
link tables, inverse rows); reads already execute `populate`. What's missing is the HTTP/SDK surface:
- HTTP routes to **declare relations** in the Builder (`addRelation` exists in the repo but is unrouted).
- Emit relations in `projectDef` so a client can **discover** them → admin drops its localStorage relation config (the fe-06 workaround).
- Finish relation **deep filtering** at the query edge (parser supports it; confirm engine execution).
- SDK: `contentTypes.addRelation` + relation fields on `ContentTypeDefinition`; admin reads relations from the API.
- **No migration needed** — `content_type_relations` already exists (migration `0003`).

### Phase 1 — Strapi-v5 read-compat completeness ✅ *(be-02 + be-02b, done)*
- **be-02 — `fields`** (sparse field selection / projection). The flat `{data,meta}` shape is already
  v5-compliant (no `attributes` wrapper) — confirmed, no work. `fields` parse already exists but is
  discarded; the slice wires projection at response-assembly time (re-materialize + serialize the
  selected columns) without regressing the zero-copy full-row hot path.
- **be-02b — `document_id` (INTEGER, not string)**. Lay an `i32` `document_id` system column + sequence
  on every managed type, via the runtime-DDL mechanism (no hand-written migration). It is the grouping
  key shared by all variants (locales × draft/published) of one logical document — so it is laid now to
  de-risk **be-03** (draft/publish) and **be-06** (i18n), which reuse a parent's `document_id` per
  variant. **Deliberately integer, not Strapi's random 24-char string**: it fits the columnar engine's
  typed-array columns + `EqIndex` (cheapest equality grouping), is a plain JSON number on the wire (no
  string-conversion cost), and matches our existing `i32` `id` (same ~2.1B ceiling — no new limit).
  Strapi's string serves cross-env transfer + non-enumerable ids, neither of which binds us.

### Phase 2 — Draft & Publish ✅ *(be-03, done)*
- **Model A** (single row + `published_at`, null = draft), **per-type opt-in** via a `draft_publish` flag
  on `content_types`. A type that doesn't enable it is **byte-identical** to before (no column, no wire
  key, status is a no-op). `status=draft|published` query param (no `all` — Strapi-faithful);
  `POST /:type/:id/actions/publish|unpublish` (atomic + per-type invalidation). `published_at` reserved
  from user writes. `document_id` is NOT used here (publish is a same-row UPDATE) — it stays the variant
  key for i18n. 735/735 tests green. Model A → Model B (separate draft/published rows) is a future upgrade.

### Phase 3 — Media / asset library ✅ *(be-04, done)*
- Storage-provider interface + local-fs + **S3** (`@aws-sdk/client-s3`), env-selected. Multipart upload
  (`busboy`) with size bounds + filename sanitization; **content-addressed** sha256 keys; `files` asset
  registry in `0001_init.sql` (hash dedup). Metadata = mime/size/hash + **image dimensions via
  `image-size`** (pure-JS, NOT sharp). A `media` field type (scalar id / jsonb id-array → `files.id`),
  validated + populated on read; existing types byte-identical. Admin: media library + picker widget.
  Tests mock-free: local-fs (real temp dir) + **S3 against real MinIO via Testcontainers**. 807/807 green;
  `npm audit` clean for the new deps (only pre-existing `autocannon` devDep vulns remain). New deps:
  `@aws-sdk/client-s3`, `image-size`, `busboy`, `@testcontainers/minio` (dev).
- **Deferred to a separate slice (be-04b):** image **transforms** (resize / crop / format) via **sharp** —
  its own run + commits, per the dependency-weight decision.

### Phase 4 — Structured content: components & dynamic zones ✅ *(be-05 + be-05b, full parity)*
- Reusable component types over HTTP (`component_types` + `component_type_fields` in `0001_init.sql`);
  `component` / `component-repeatable` / `dynamiczone` field kinds (jsonb-backed, Strapi wire with inline
  `__component`); single + repeatable + **dynamic zones** + **nesting** (depth cap 10, 256 KiB per-instance
  guard, definition-time cycle rejection). **Nested-JSON storage, validated-on-write** (recursive, scoped
  errors, stable instance ids + order), emitted **verbatim/zero-copy** on read. **Media refs INSIDE
  components** (inline id, existence-checked, resolved by an opt-in populate-walk). Non-component types
  byte-identical. No filtering across dynamic zones (as Strapi). 830/830 green.
- **be-05b ✅:** **relation refs INSIDE components** — inline id ref to a target content-type,
  existence-checked on write, resolved by the populate-walk (applying target draft/publish + i18n
  visibility); top-level `relation` cmsType rejected (component-only). Mirrors the media-inside path.
  Full component parity now reached. 844/844 green.

### Phase 5 — i18n / localization ✅ *(be-06, done)*
- **Per-type opt-in** (`i18n` flag) + **per-field `localized`** (Strapi-faithful). Locale variants are
  rows sharing `document_id`; be-06 builds document_id's read-side **conditionally** (i18n types load +
  index + emit it; non-i18n stay byte-identical). Shared fields use **S1** (every variant row stores all
  fields; a shared-field write fans out across same-`document_id` rows in one tx — read path untouched).
  `UNIQUE(document_id, locale)`; `locale` param (omitted→`DEFAULT_LOCALE`, `<code>`, `*`; **no fallback**
  in v1); variant create via `POST /:type/:id/locales/:locale` (server-controlled seam). Composes with
  draft/publish (rows keyed by `(document_id, locale)`, each with its own `published_at`). Relations are
  per-variant in v1. 750/750 tests green. Fallback chains + enabled-locales registry deferred.

### Phase 6 — Events & versioning
- Webhooks (hook into the existing ChangeBus event seam); content history / rollback.

### Phase 7 — Scale & infrastructure *(can run in parallel; from the existing API roadmap)*
- Surgical writes (incremental in-engine update/delete + targeted cache invalidation, no full rebuild).
- Redis pub/sub `ChangeBus` for multi-instance invalidation. String collation for sorted indexes.
- Optional: GraphQL.

### Phase 8 — Auth, RBAC, API tokens *(second-to-last, by design)*
- Admin auth + content-API auth, API tokens (read-only / full / custom), RBAC (roles/permissions,
  field-level), then SSO/providers. Seams already stubbed: SDK `token`/`getHeaders`/`onUnauthorized`.

### Phase 9 — Transactional email *(last, by design)*
- Provider abstraction (Nodemailer / SES / Resend), consumed by auth flows (verification / password reset).

## Execution notes

- **Workflows:** each backend phase has a runnable workflow at `.claude/workflows/be-0N-*.js`, mirroring
  the `fe-0N-*` admin workflows (Implement → Verify → Review, with adversarial review). Run via the
  Workflow tool with `{ scriptPath }`.
- **No mocks:** tests are native `node:test` against a real Postgres 18 via Testcontainers
  (`npm test --workspace @absurd/api`, env from `.env.test`).
- **Migrations (pre-launch policy):** hand-written SQL, **consolidated into ONE init file**, applied by
  `src/db/migration.runner.ts`, evolved **in place** — on a schema change, edit the init file and **drop &
  recreate** the dev DB. **No backfill** (there are no clients / no prod data to preserve). `ct_<apiId>`
  tables are created by the runtime Builder DDL (`src/db/ddl.ts`), so per-type system columns
  (id/created_at/updated_at, `document_id`, later `published_at`/`locale`) live there; global objects (e.g.
  the `document_id` sequence, meta tables) live in the init migration. Revisit once there are real clients.
- **Never run the dev server** — a dev server is always running in a separate terminal.
