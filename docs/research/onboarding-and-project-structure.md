# Project onboarding & structure — design proposal

> Research + design. **No code is changed by this document.** It proposes how a developer onboards an
> conti project (`npx absurd init`), what is scaffolded vs hidden in the core, where the schema
> lives long-term, and the bootstrap/dev→prod flow. Authored directly (the research workflow kept dying on
> transient API 529s; same research + design, by one author). Companion to `plugin-system-design.md`.

## 1. Executive summary & recommendation

**Recommendation — Variant 1: a hidden runnable CORE package + a thin scaffolded project, with PG as the
schema source-of-truth + a committed file SNAPSHOT for versioning.** This keeps our architecture intact
(PG-truth, the dynamic Builder UI, the in-memory engine rebuilt from PG) and adds the one thing PG-only
schema lacks — versioning / code-review / reproducible dev→prod — via a `schema pull` / `schema push`
snapshot, exactly the reconciliation Directus uses (the only major competitor that also stores schema in the
DB). It aligns with the stated long-term lean ("if schema is in the DB, then schema in the DB").

The decision lives on two orthogonal axes:
- **Axis A — distribution / who owns the server code.**
- **Axis B — the source of truth for the content SCHEMA.**

Today (`packages/api` = `@conti/api`) is a single runnable monolith: `server.ts start()` →
`runMigrations` → `loadWithRegistry` (engine+Registry from PG) → `listen`. No CLI/bin, no library exports.
To support `npx absurd init` + "hide the guts", the core must be packaged as a library + a CLI, with a thin
scaffolded user project on top.

## 2. How the competitors onboard (survey)

| System | `init` / scaffold | What the user OWNS | Schema source of truth | Versioning / dev→prod | Types |
|---|---|---|---|---|---|
| **Strapi** | `npx create-strapi-app` → a FULL app (src/api, config/, the admin) | the whole app (controllers/services/routes + content-type schema.json files) | **files** (`src/api/*/content-types/*/schema.json`); DB mirrors | git (files) + migrations | `strapi ts:generate-types` from the file schemas |
| **Payload** | `npx create-payload-app` → a Next/Express app | the app + the `payload.config.ts` (collections IN config) | **config-as-code (TS files)**; DB mirrors | git (config) + migrations | generated from the same config (types fall out) |
| **Directus** | `npx directus init` (env + db) → a runnable server you configure | only **config (.env) + extensions/**, NOT the server code | **the DATABASE** (schema edited in the app) | **`directus schema snapshot` → a YAML you commit + `schema apply`** | `directus` SDK + an optional types gen from the schema |
| **Keystone** | `keystone.ts` config in your repo | the `keystone.ts` config (lists/fields in code) | **config-as-code** | git + `keystone prisma migrate` | generated from the config |
| **Medusa** | `npx create-medusa-app` → a full app + admin | the app + modules + subscribers | DB + migrations (code-defined entities) | migrations | TS entities |

Two camps: **files/config-first** (Strapi/Payload/Keystone/Medusa — schema in code, git-native, types fall
out, but a runtime Builder is secondary or absent) vs **DB-first** (Directus — schema in the DB edited via
the app, reconciled to git via a committed **schema snapshot**). Our architecture (PG-truth + a runtime
Builder + the in-memory engine rebuilt from PG) is the DB-first camp → Directus's snapshot model is the
proven fit.

## 3. The two axes & the three coherent variants

**Axis A — distribution:** (a) scaffold-and-own (Strapi/Rails); (b) library-mount (Payload —
`createX(config).listen()`); (c) runnable-core + thin project (Directus — the core IS the server, you own
only config/extensions/schema/types).

**Axis B — schema source of truth:** (i) PG-only (current; un-versionable as-is); (ii) PG-truth + committed
file snapshot (Directus); (iii) files-first / config-as-code (Payload — DB mirrors).

**Critical long-term rule: ONE source of truth.** A two-source design (Variant 3) is the trap — it creates
ambiguous conflict resolution and drift.

### Variant 1 — runnable-core + PG-truth + snapshot (A=c, B=ii) — RECOMMENDED
Keeps the architecture (PG-truth, Builder UI, engine-from-PG); the committed snapshot gives
versioning/dev→prod/review. The Builder UI (a product feature for non-developers to model content) survives.
Best fit; aligns with the stated lean.

### Variant 2 — files-first config-as-code (A=b, B=iii, Payload-style)
Content-types defined in TS files (`collections/article.ts`); PG mirrors; types + versioning fall out for
free; best raw developer DX. **But it REVERSES our model:** it kills the runtime Builder UI (non-devs can no
longer model content in the UI) and contradicts "the engine loads from PG". Presented as the honest
trade-off — only choose it if the product pivots away from a runtime Builder toward a dev-only,
code-defined-schema product.

### Variant 3 — hybrid / two sources (NOT recommended)
Define via Builder OR files, sync both ways. Flexible but ambiguous source of truth → drift + conflict
resolution complexity. Avoid.

## 4. Recommended project structure (Variant 1)

```
my-cms/
  package.json          # deps: @conti/core ; scripts: dev / start / gen:types / schema:pull / schema:push
  absurd.config.ts      # TYPED server config: db, auth, plugins[], server opts — config-as-code for the SERVER, NOT content
  bootstrap.ts          # the register()/bootstrap() lifecycle entry: register hooks / routes / field-types (+ onStart/onShutdown)
  .env / .env.test      # secrets: DATABASE_URL, AUTH_SECRET, CURSOR_SECRET, ... (commit .env.example, gitignore .env)
  extensions/           # the user's hooks, custom controllers, field types (auto-discovered or registered in bootstrap.ts)
  schema/               # COMMITTED schema snapshot (PG <-> file): the versioned source for dev->prod + review
  generated/            # gen:types output: modules.d.ts (committed, for the editor + tsc --noEmit)
  .gitignore            # node_modules, .env, (decide: generated/)
```
The "guts" — the columnar engine, uWS HTTP, postgres.js, auth — live in **`@conti/core`** (node_modules),
never in the user's repo. The user owns only the thin project above.

**Packaging change required:** split the runnable `@conti/api` monolith into:
- **`@conti/core`** — a LIBRARY exporting `createAbsurd(config): AbsurdApp` (+ `app.start()/stop()`),
  wrapping today's `server.ts start()` (migrate → load engine → mount → listen) behind a config object.
- **`@conti/cli`** — `bin: { absurd }` — the `npx absurd` commands.
- (`@conti/sdk` client, `@conti/admin` Studio — unchanged.)

## 5. Config vs content (the separation that must NOT be conflated)

- **`absurd.config.ts` = SERVER config, config-as-code, typed:** `{ db, auth, plugins: [...], server: {...},
  storage, ... }`. This is code (git), small, dev-authored. (Payload conflates modules INTO its config;
  WE do not — see below.)
- **Content SCHEMA = PG truth + committed snapshot, NOT the config.** Content-types are dynamic (the Builder
  UI / the be-02 API write PG). They are versioned via `schema/` (snapshot), not by hand-editing config.
  This separation is the crux: server wiring is code; content modeling is data (with a file projection).

## 6. CLI commands (`@conti/cli`)

- `absurd init [dir]` — scaffold §4 (config, bootstrap, extensions/, schema/, generated/, .env.example, scripts).
- `absurd dev` — watch + run (the dev server); in dev, optionally `schema push` from the snapshot on boot.
- `absurd start` — production boot (see §7).
- `absurd schema pull` — read modules from PG/the Registry → write `schema/` snapshot (commit it).
- `absurd schema push` — apply the committed `schema/` snapshot to PG (dev→prod, idempotent/diff). **This is
  the production schema-promotion mechanism** (see the open risk §9).
- `absurd gen:types` — read the snapshot (or PG) → emit `generated/content-types.d.ts` (cmsType→TS mapping;
  see `plugin-system-design.md` §10b). Tie it to `schema pull` so types track the schema.

**The single schema-change flow:** edit in the Builder UI (→ PG) → `schema pull` (snapshot) → `gen:types`
(types) → commit both. PG is the source; the snapshot + types are derived projections.

## 7. Bootstrap flow (`absurd start`)

```
1. load absurd.config.ts + .env (typed config; FAIL CLOSED if a prod secret is missing — no dev fallback in prod)
2. runMigrations() — the single consolidated 0001_init.sql + any folded extension tables
3. schema push — apply the committed schema/ snapshot to PG (reproducible env). Dev may skip (Builder-driven).
4. extensions: register() — wire content lifecycle hooks / custom routes / field-types — BEFORE the engine load
5. loadWithRegistry() — build the in-memory engine + Registry from PG (the cold start)
6. extensions: bootstrap() — setup that needs the warm engine/live data
7. mount /auth/* + the content API + extension routes (gated by the be-09b AuthContext)
8. server.listen()
```
`bootstrap.ts` is the single extension entry point: `register`/`bootstrap` (plugin lifecycle), the content
lifecycle hooks (`plugin-system-design.md`), and optional server `onStart`/`onShutdown`. It hides the boot
machinery (the user writes intent, not the migrate/load/mount plumbing).

## 8. dev → prod story

- **Dev:** `absurd init` → `absurd dev`. Model content in the Builder UI (writes PG). `schema pull` to
  capture into `schema/`, `gen:types` for editor types, commit both.
- **Prod:** deploy the thin project (+ `@conti/core` dep). `absurd start` migrates, **`schema push`** applies
  the committed snapshot (so prod schema is reproducible from git, NOT from clicking the Builder in prod),
  loads the engine, listens. A deploy = a brief cold-start (engine rebuild from PG — see the engine-ops
  baseline; seconds–minutes by data size, single-instance).

## 9. The critical long-term open risk — PROD module migration (ALTER, not drop & recreate)

Our migration policy is a single hand-written `0001_init.sql` with **drop & recreate, no backfill —
PRE-LAUNCH**. That is fine before launch. But once there is data, `schema push` (e.g. add a field to
`article`) MUST **ALTER the table + preserve data + rebuild the engine**, never drop & recreate. Today the
Builder/be-02 path is mostly CREATE; a real **schema-diff / ALTER engine** (compute the diff between the
committed snapshot and live PG, emit safe ALTERs, handle add/rename/retype/drop with data, then rebuild the
affected engine tables) is **what makes "schema in the DB" production-viable long-term.** This is the single
biggest piece this onboarding model implies and is effectively its own slice — flag it explicitly, do not
hand-wave it.

## 10. Other open questions

- **Snapshot format:** one `schema/snapshot.json` vs per-module files (better diffs/review). (Lean:
  per-type files for reviewable diffs, like Strapi's per-type schema.json, but generated from PG.)
- **`generated/` committed or gitignored?** Commit it (reproducible typechecks; Strapi commits its gen'd
  types) + a CI check that it is up to date with `schema/`.
- **Packaging:** how `@conti/core` exposes `createAbsurd(config)` cleanly (the monolith → library refactor)
  and keeps native TS type-stripping working for a consumer project (no build step for the user).
- **`absurd.config.ts` typing:** ship a `defineConfig()` helper (Payload/Vite-style) for autocomplete.
- **Extension discovery:** explicit list in config vs auto-scan `extensions/` (lean: auto-scan + config
  order override, deterministic).
- **First-run / seeding:** `init` could seed a demo module + a first-admin bootstrap (be-09b) prompt.

## 11. One-line summary
Ship absurd as a **hidden runnable `@conti/core` + a thin scaffolded project + an `absurd` CLI**; keep **PG
as the schema source of truth with a committed snapshot** (`schema pull/push`) for versioning + dev→prod +
review (Directus-proven, keeps our Builder + engine-from-PG); **codegen types from the snapshot**;
`bootstrap.ts` is the single extension/lifecycle entry. The make-or-break long-term piece is a real
**ALTER-based module migration engine** for `schema push` post-launch.

---

### Sources (verify against current docs when implementing)
create-strapi-app + ts:generate-types + module schema.json (docs.strapi.io); create-payload-app +
payload.config + collections-in-config (payloadcms.com/docs); **Directus init + `directus schema
snapshot/apply`** (directus.io/docs) — the DB-first + committed-snapshot model we mirror; Keystone
`keystone.ts` config + prisma migrate (keystonejs.com/docs); create-medusa-app + modules (docs.medusajs.com).
