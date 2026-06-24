# conti — Package / Module Decomposition (lead-architect synthesis)

Status: RECOMMENDED. Date: 2026-06-24. Scope: how to carve the current `@conti/api`
monolith (+ `@conti/sdk`, `apps/admin`) into a coherent, publishable package graph without
violating the four hard constraints.

## Hard constraints (non-negotiable, drive every decision)

1. **No-build TS** — Node >=24 native type-stripping. The consumed surface must contain no
   enums-as-values, no decorators, no namespaces; user extensions stay plain `.ts`.
2. **Engine out of user reach** — user/plugin code must be *physically unable* to import the
   zero-PG read hot path (`store/engine.ts respond/respondById` and everything under it).
3. **Single instance** — one process, serialize-on-write. No Redis, no multi-instance seams.
   Never reintroduce them.
4. **Write-seam-only hooks** — content lifecycle hooks attach EXCLUSIVELY on the write path
   (`write.handler.ts handleWrite`). The read path must remain hook-free *by construction*.

## Recommendation in one line

**Adopt COARSE as the published shape (`@conti/core` + `@conti/cli` + `@conti/sdk` +
`@conti/admin`), but graft three cheap, verified boundary fixes from the fine-grained
candidate into Phase 1 so the single package is internally honest, and keep the fine-grained
internal libs as an explicitly deferred Phase 4 behind the unchanged published surface.**

Rationale: the judge scored fine-grained 29 vs coarse 28 — architecturally fine-grained is
stronger, but it is the highest-blast-radius candidate (a 6-lib + 3-published simultaneous
split of one package, ~50 files re-specified, two god-files split, the registry edge inverted —
all before anything runs). On a single-instance, pre-1.0, no-build CMS that is the wrong bet to
make *first*. COARSE is a near-free lift (a rename + a function extraction + an exports map) and
preserves the one real architectural port (the `Store` interface). The synthesis takes the two
points where the judge correctly docked COARSE — "markets deferral as cleanliness" and "an
unbuilt exports-map as a hot-path guarantee" — and closes both *inside Phase 1*, so we get
COARSE's migration cost with most of fine-grained's boundary honesty.

## Verified code facts (the synthesis is grounded, not hand-waved)

Confirmed against the tree on 2026-06-24:

- **Only two packages + one app exist today**: `packages/api` (`@conti/api`), `packages/sdk`
  (`@conti/sdk`), `apps/admin`. So `@conti/admin` is a *promotion of an app to a published
  package*, not a rename — real scope, accounted for in Phase 3.
- **`registry.ts` is the one real downward layering violation.** It lives in `src/store` yet has
  RUNTIME (value) imports from the db layer:
  - `../db/ddl.ts` (`deriveTableName`, `validateIdentifier`, `RELATION_KINDS`)
  - `../db/content-type.repository.ts`
  - `../db/component-type.repository.ts`
  - `../db/type.catalog.ts` (`isComponentFieldKind`)
  Everything else in `store/` has ZERO db/postgres deps. This is the edge that poisons
  `engine -> db` acyclicity, and `engine.ts` deliberately does NOT import `registry.ts` (it holds
  only `FieldDef`s + parallel relation maps) — a designed seam to preserve.
- **`column.ts` has a stray runtime engine->db value edge**: `import { DECIMAL_MAX_SAFE_PRECISION }
  from '../db/type.catalog.ts'` (used at column.ts:682). Trivially fixable by relocating that one
  const into the engine cluster. Until moved, "engine has ZERO db deps" is literally false.
- **`column.ts <-> indexes/` is a genuine runtime cycle** and MUST stay one module:
  `column.ts` imports `indexes/substring.index.ts` (StringColumn embeds a SubstringIndex), while
  `indexes/sorted.index.ts` and `indexes/string-sorted.index.ts` import `Column`/`I64Column`/
  `StringColumn` back. Do not split.
- **`server.ts start(port)` is already the composition root**: `runMigrations -> new PostgresStore
  -> seed -> loadWithRegistry({cursorCodec}) -> buildAuth/TeamView/SessionCache/RbacRegistry (with
  the documented cycle-breaker thunk order) -> createServer(engine, store, registry, undefined,
  auth, sessionCache, rbac, teamView) -> server.listen(port)`. `createConti(config)` is a literal
  function-extraction of this body.
- **`createServer` is already a param-seam**: `createServer(engine, store?, registry?,
  publishClock?, auth?, sessionCache?, rbac?, teamView?)`. Optional params let tests build
  read-only / ungated servers. Preserve verbatim.
- **`WriteContext` is already the single mutation seam** (write.handler.ts:44):
  `{ engine(), registry(), sql, rebuild(type), publishClock() }`, and `handleWrite` (line 275)
  validates -> single PG statement -> `ctx.rebuild(type)`. This is exactly where lifecycle hooks
  hang. The read path imports none of it.
- **`@conti/sdk` is already decoupled**: `sdk/src/types.ts` hand-writes the contract types with an
  explicit "never import from `@conti/api`" warning (postgres.js/uWS would poison a browser
  bundle). So the SDK's real dependency on core is **zero** — the COARSE candidate's "sdk dependsOn
  core for shared wire types" edge is wrong. We drop that edge.

## Final package graph

### Published packages

| Package | Kind | Responsibility | dependsOn |
|---|---|---|---|
| `@conti/core` | published | The whole runnable guts as a library: columnar read engine (store/*), schema Registry + body.parser + inspect, uWS http layer, db layer (postgres.store, engine.loader, repos, ddl, type.catalog, migrations), auth/rbac, storage (local+S3). Exposes ONE runtime entry `createConti(config)` + `defineConfig` + a type-only extension surface. All engine/store/db/http/auth/storage internals are UNEXPORTED via the package.json `exports` map. | (none) |
| `@conti/cli` | published | `bin: { conti }`. `init` (scaffold thin project), `dev`, `start` (`createConti(config).start()`), `schema pull/push`, `gen:types` (emit `content-types.d.ts` for the editor + `tsc --noEmit` — NOT a runtime build). Thin process/orchestration shell over core's library API; owns no engine logic. | `@conti/core` |
| `@conti/sdk` | published | Typed HTTP client (Strapi-bracket query builder, read/write, relation/populate/media helpers). Talks to a running server over the wire. **Hand-writes its own contract types — depends on NOTHING at the package level** (constraint: a browser bundle must never pull postgres.js/uWS). | (none) |
| `@conti/admin` | published | The Studio SPA (content manager, Builder UI, dashboard, Lua design system). Pure frontend; talks to the server through `@conti/sdk` over HTTP. Promoted from today's `apps/admin`. | `@conti/sdk` |

### Internal modules INSIDE `@conti/core` (Phase-1 honest layering; Phase-4 extractable)

These are *directory/module* boundaries enforced by lint, not separate packages. They are drawn
so that Phase 4 (optional) can lift them into private `@conti/*` libs with no public-surface
change. The DAG below is the *internal* layering the lint guard enforces from day one.

| Internal module | Responsibility | dependsOn (internal) |
|---|---|---|
| `core/engine` | Zero-PG read core: primitives (bitset, csr), off-heap interners, columns + indexes (the cycle — one module), table, relation, cursor.codec, query.parser, response.cache, engine+store seam, inspect. Owns `Engine.respond/respondById`. After the `DECIMAL_MAX_SAFE_PRECISION` move, ZERO db deps. **This is the cluster that must stay out of user reach.** | (none) |
| `core/db` | Postgres + schema-as-truth: database client, ddl, type.catalog, repositories, migration runner, postgres.store (implements `engine.Store`), engine.loader. **ABSORBS `registry.ts`** (moved out of store/, fixing the one downward violation). | `core/engine` |
| `core/auth` | better-auth provider + bridge + dialect, off-heap SessionCache/SessionStore, RbacRegistry, TeamView. | `core/db` (PG handle) |
| `core/storage` | Storage provider abstraction (local + S3), file metadata extract. | (none) |
| `core/http` | Transport + handlers + the write/lifecycle seam: read.router (incl. the extracted `http-contract` primitives `CoreRequest/CoreResponse/JSON_CT/CANONICAL_INT/errorResponse`), write.handler (+ hook firing), builder controllers, media handlers, populate, the auth-gate, and uws.adapter (composition of routes). body.parser moves here (it is a WRITE concern, miscategorised in store/). | `core/engine`, `core/db`, `core/auth`, `core/storage` |
| `core/compose` | `createConti(config)`, `defineConfig`, the `ContiConfig` type, the extension loader + content-hook registry. The single composition root + the only runtime export. | `core/http`, `core/db`, `core/auth`, `core/storage`, `core/engine` |

## Textual dependency DAG / layering (acyclic — verified)

```
                         ┌──────────────────────────────────────────────┐
PUBLISHED                │                  @conti/admin                 │  (SPA)
                         └───────────────────────┬──────────────────────┘
                                                 │ HTTP-over-wire + dep
                         ┌───────────────────────▼──────────────────────┐
                         │                   @conti/sdk                  │  (no pkg deps;
                         └───────────────────────────────────────────────┘   hand-written types)
                         ┌───────────────────────────────────────────────┐
                         │                   @conti/cli                  │
                         └───────────────────────┬──────────────────────┘
                                                 │ depends on
                         ┌───────────────────────▼──────────────────────┐
                         │                   @conti/core                 │
                         │   (single published runnable lib; ONLY        │
                         │    createConti/defineConfig/types exported)   │
                         └───────────────────────────────────────────────┘

INTERNAL LAYERING INSIDE @conti/core  (lint-enforced acyclic DAG; arrows = "imports")

      core/compose  ──────────────┐  (createConti, defineConfig, extension loader, hook registry)
        │     │     │     │        │
        ▼     ▼     ▼     ▼        ▼
   core/http  ───────────────────────────────────┐
     │   │      │        │                        │
     ▼   ▼      ▼        ▼                        │
 core/auth  core/storage │                        │
     │                   │                        │
     ▼                   │                        │
  core/db ◄──────────────┘ (http & auth & registry touch PG)
     │
     ▼
 core/engine   ◄── (NO upward edges; after DECIMAL const move, zero db deps)
   └─ primitives → interners → columns⇄indexes (one node) → table → relation
        → cursor.codec → query.parser → response.cache → engine+store seam → inspect
```

Layering rule (top imports down only): `compose -> http -> {auth, storage} -> db -> engine`.
`engine` is the bottom and imports nothing internal. The historical `engine -> db` back-edges
(`registry.ts`, `column.ts DECIMAL const`) are removed in Phase 1, which is what makes the DAG
acyclic for real and not just at the 4-package granularity.

## Public API surface

### `@conti/core` (the load-bearing `exports` map)

`package.json` `exports` is the *resolution boundary* that enforces "engine out of user reach":

```jsonc
"exports": {
  ".":      "./src/compose/index.ts",   // createConti, defineConfig, ContiApp
  "./types":"./src/compose/types.ts",   // type-only: ContiConfig, Extension, ExtensionApi,
                                         //   ContentHooks, ContentHookContext, wire DTOs
  "./cli":  "./src/cli/index.ts"         // used by @conti/cli only
  // store/*, db/*, http/*, auth/*, storage/* are DELIBERATELY UNMAPPED ->
  // `import '@conti/core/store/engine'` fails at module resolution.
}
```

Runtime surface (the only values a user/plugin can import):

- `createConti(config: ContiConfig): ContiApp` — `ContiApp = { start(): Promise<void>;
  stop(): Promise<void> }`. The composition root.
- `defineConfig(config: ContiConfig): ContiConfig` — identity helper for editor types.

Type-only surface (`@conti/core/types`, erased by type-stripping — no enums/decorators/namespaces):

- `ContiConfig` — `{ db, auth, storage, server, extensions: Extension[] }`.
- `Extension` — `{ name: string; register?(api): void | Promise<void>;
  bootstrap?(api): void | Promise<void> }`.
- `ExtensionApi` — `{ hooks: ContentHooks; addRoute(...); addFieldType(...) }` (route/field-type
  are declared now, may be `phase-2` stubs).
- `ContentHooks` — per-type `beforeCreate/Update/Delete/Publish/Unpublish` (filters) +
  `afterCreate/...` (actions), keyed by content-type name.
- `ContentHookContext`, and wire DTOs shaped like `CoreRequest`/`CoreResponse`.

### `@conti/cli`

`bin: { conti }`. Subcommands: `init`, `dev`, `start`, `schema pull`, `schema push`, `gen:types`.
All are thin wrappers over `@conti/core`'s library API. `gen:types` is explicitly NOT a build —
it reads the Registry/snapshot and emits `content-types.d.ts` consumed only by the editor and
`tsc --noEmit`. The runtime never imports generated types.

### `@conti/sdk`

Default export: `createClient(opts) -> ContiClient` with the Strapi-bracket query builder
(`find`, `findOne`, `create`, `update`, `delete`, relation/populate helpers, `upload`). Exports
its hand-written contract types. Zero package dependencies.

### `@conti/admin`

No programmatic API — a deployable SPA. Consumes `@conti/sdk` and the public inspect/devtools
routes only.

## Where the lifecycle / plugin seam lives

Two distinct seams, both INSIDE `@conti/core`, neither exposing engine internals:

1. **Boot / plugin lifecycle — lives in `core/compose`.** `createConti` owns the extension
   loader. Deterministic order mirroring Strapi register/bootstrap and the existing `buildAuth`
   `databaseHooks` precedent:
   - `extension.register(api)` runs **before** `loadWithRegistry` warms the engine — this is when
     content hooks are wired into the per-type hook registry (and phase-2 routes/field-types
     declared).
   - `extension.bootstrap(api)` runs **after** the warm engine exists.
   The CLI's scaffolded `bootstrap.ts` in the user project is the single entry; it receives
   `ExtensionApi`.

2. **Content lifecycle hooks — attach EXCLUSIVELY on the WRITE seam (`core/http/write.handler.ts`).**
   `handleWrite`'s `WriteContext` gains a hook-registry param. Firing order:
   - `before*` filters run **before** `sql.begin` (mutate payload + veto-by-throw) so PG and the
     serialize-on-write engine never diverge.
   - `after*` actions run **post-commit, post-`ctx.rebuild(type)`**, timeout-guarded + try/catch.
   The read hot path (`engine.respond/respondById`, read.router GET routes) gets NO hook
   attachment point: the hook registry is threaded only into the write path, and because the
   engine/store modules are unexported AND the internal lint forbids `core/http` read routes from
   importing the hook registry, a hook on a read is unreachable by construction (constraint 4
   satisfied structurally, not by convention).

## Ordered migration plan (phases) from `@conti/api`

### Phase 0 — guard rails first (so later phases can't silently regress)

- Add an internal-layering ESLint guard (`no-restricted-imports`) encoding the
  `compose -> http -> {auth,storage} -> db -> engine` rule and forbidding any `store/*` file from
  importing `db/*`/`http/*`/`auth/*`. It will FAIL today (registry.ts, column.ts) — that is the
  Phase-1 worklist.

### Phase 1 — honest single package (the cheap boundary fixes, BEFORE any rename ships externally)

1. Move `DECIMAL_MAX_SAFE_PRECISION` out of `db/type.catalog.ts` into the engine cluster
   (e.g. a `store/decimal.const.ts`), repoint `column.ts`. Removes one `engine -> db` value edge.
2. Relocate `registry.ts` out of `src/store` into `src/db` (it already depends downward on
   ddl + two repositories + type.catalog + postgres). Repoint all importers (db loaders, http
   controllers/populate/write.handler/uws.adapter). Removes the *biggest* layering violation.
   Run full real-PG suite — no behavior change, pure move.
3. Relocate `body.parser.ts` out of `src/store` into `src/http` (it is a WRITE-side validator,
   single consumer `write.handler.ts`).
4. Extract the four `http-contract` primitives (`CoreRequest`, `CoreResponse`, `JSON_CT`,
   `CANONICAL_INT`, `errorResponse`) out of `read.router.ts` into `src/http/http-contract.ts` so
   read.router stops being a fan-in hub.
   After 1-4 the Phase-0 lint guard goes green and the internal DAG is genuinely acyclic.

### Phase 2 — the library entry + config + hooks (still one package, still `@conti/api` name)

5. Lift `server.ts start()` body into `createConti(config: ContiConfig): ContiApp` in a new
   `src/compose/index.ts`. Keep `server.ts` as a thin shim calling
   `createConti(loadConfigFromEnv()).start()` so the running boot path is byte-unchanged.
6. Define `ContiConfig` + `defineConfig()`; route every scattered `getenv()` through the config
   object (env stays the default source — `.env` in dev, `.env.test` in test; fail-closed in prod
   for missing secrets).
7. Implement the per-type content-hook registry (`Map<type, {before[], after[]}>`), thread it
   through `WriteContext` into `handleWrite` (before-filters pre-tx, after-actions post-commit,
   timeout-guarded). Add the extension loader to `createConti` (register before
   `loadWithRegistry`, bootstrap after). Real-PG tests per plugin-system design; NO mocks.

### Phase 3 — the published split (rename + exports map + CLI + admin promotion)

8. Rename `@conti/api -> @conti/core`. Add the `exports` map (only `.`, `./types`, `./cli`
   mapped; everything else unmapped). Add a resolution probe test asserting
   `import('@conti/core/store/engine')` rejects. Audit the public path for enums-as-values /
   decorators / namespaces and erase any (no-build TS).
9. Create `@conti/cli` (`bin: conti`) wrapping core: `start`, `dev`, `init` (scaffold the thin
   project: `conti.config.ts`, `bootstrap.ts`, `extensions/`, `schema/`, `generated/`,
   `.env.example`), `schema pull/push`, `gen:types`. `server.ts` becomes obsolete (`conti start`
   replaces it).
10. Leave `@conti/sdk` functionally as-is (already decoupled — no edge to core). Promote
    `apps/admin` to the published `@conti/admin` (real scope: package.json, build/publish config),
    keep its dep on `@conti/sdk`.
11. Add the cross-package import guard (no `@conti/core/store|db|http|auth` deep imports from
    outside core) to CI alongside the resolution probe.

### Phase 4 — OPTIONAL, DEFERRED: extract the internal libs into private `@conti/*` packages

Only if a concrete need appears (independent testing/versioning of the engine). The Phase-1
module boundaries + Phase-0 lint already make this mechanical: lift `core/engine`, `core/db`,
`core/auth`, `core/storage`, `core/http` into private (unpublished) `@conti/*` packages, converting
deep `../../` relatives into `@conti/*` specifiers. The published surface (`@conti/core`,
`@conti/cli`, `@conti/sdk`, `@conti/admin`) does NOT change. **Do not do this pre-1.0** — it is the
high-blast-radius work the fine-grained candidate front-loads, and there is no single-instance,
pre-marketplace payoff for it yet.

### Explicitly out of scope

The ALTER-based schema-diff engine for prod `schema push` (flagged as its own slice) — this
decomposition does not require it.

## Risks

- **`createConti` becomes a second god-file.** The boot has 10+ ordered steps with a documented
  cycle-breaker (TeamView before SessionCache before auth; `rbacInvalidate`/`teamViewReload`
  thunks). Mitigate by keeping `createConti` a thin orchestrator that only *calls* existing
  builders in order — do not inline logic. Treat it like `uws.adapter` (which is itself a 1400-LOC
  god-file warning sign).
- **Exports-map enforcement is real work, not free.** Until Phase 3 ships the map + probe + CI
  guard, "engine out of user reach" is aspirational. Sequence the probe test into Phase 3 step 8,
  not "later".
- **No-build TS regressions in the public path.** A stray enum/decorator/namespace in anything
  reachable from `@conti/core/.` or `/types` breaks native type-stripping for user projects.
  Phase 3 step 8 audit + a CI smoke test that imports the public surface under `node --strip-types`
  from a fixture project.
- **Admin promotion is unstated scope.** `apps/admin` -> published `@conti/admin` means
  build/publish pipeline, versioning, and a decision on whether the SPA ships pre-built assets or
  source. Budget Phase 3 step 10 accordingly.
- **registry.ts relocation touches many importers** (db loaders + several http files). It is a pure
  move, but the import-specifier churn is the largest mechanical edit in Phases 1-3; do it as its
  own commit with the full real-PG suite gating it.
- **Deferring Phase 4 risks latent debt being marketed as done.** Be explicit in docs: the engine
  is *unreachable* (good) but not *independently versioned* (deferred). Don't claim the
  fine-grained benefits we chose not to buy.

## Open questions

- **Does `@conti/admin` publish pre-built assets or source?** Decides whether admin needs a build
  step (it's a separate frontend toolchain, not subject to the no-build server constraint) and how
  the CLI's `dev` serves it.
- **Where does the user project's `conti.config.ts` live relative to `bootstrap.ts`** — one file or
  two? (config = data via `defineConfig`; bootstrap = the `register/bootstrap` entry.) Leaning two,
  matching Strapi, but confirm against onboarding DX.
- **Should `addRoute`/`addFieldType` be first-class in `ExtensionApi` at 1.0 or stay phase-2 stubs?**
  Content hooks are the floor; route/field-type extension is the differentiator. Decide the 1.0
  extensibility ceiling.
- **`schema push` to prod without the ALTER diff engine** — is `pull/push` snapshot-only at 1.0,
  with prod schema changes gated behind the deferred diff slice? Confirm the 1.0 story.
- **Do we want a private Phase-4 `@conti/engine` ever published standalone** (a columnar engine as
  its own product)? If yes, the off-heap-hash duplication between `store/string-interner.ts` and
  `auth/session.store.ts` becomes a shared-primitive extraction worth doing; if no, leave them as
  independent siblings.
```
