# Plugin / extensibility system — design proposal

> Research + design. **No code is changed by this document.** It proposes how a community developer
> extends absurdFastCMS, grounded in how the competitors do it and fitted to our architecture.
> Authored directly (the multi-agent research workflow kept dying on transient API 529s; this is the
> same research + design, by one author).

## 1. Executive summary & recommendation

**Recommendation: a trusted, in-process extension model with a WordPress/Directus-style filter+action
hook split, delivered in phases, starting with content LIFECYCLE HOOKS.** This mirrors a pattern we
**already run in-house** — `better-auth`'s `databaseHooks` (`src/auth/auth.ts`: `user`/`session`
`before`/`after`) — generalized to our content write path.

Two architecture facts dictate the shape:

1. **Reads are a zero-PG, pre-serialized hot path** (the engine serves byte-identical buffers). A hook on
   that path would destroy the sub-ms read perf we just spent the be-22* work protecting. → **Hooks fire on
   the WRITE path only. There is NO `beforeRead`/`afterRead` (Payload has them; we deliberately do not).**
2. **Single instance + rebuild-from-PG cold start.** Extensions load at boot; changing one = a restart =
   an engine rebuild from Postgres (seconds → minutes by data size). Fine for the single-instance target;
   it just sets the reload story (no hot-swap in v1).

**Phase 1 (MVP) = trusted in-process content lifecycle hooks** (`before*` filter / `after*` action) +
the loader/registration. Custom endpoints, field/operator extensions, jobs, and sandboxing for untrusted
code come later. **Trusted-only with review is the pragmatic security stance** — it is what Strapi, Payload,
Keystone, and WordPress all actually do; only Directus added an (optional) sandbox, and `vm2` (the obvious
sandbox) is dead.

A genuine DX edge we get for free: **Node native TS type-stripping means an extension is a plain `.ts`
file with no build step** — simpler than Strapi/Directus, which require a compile/bundle.

## 2. Competitor survey

| System | Hook taxonomy | Mutate / veto | Other extension surface | Registration | Trust model |
|---|---|---|---|---|---|
| **Strapi v5** | DB lifecycle hooks: `beforeCreate/afterCreate`, `beforeUpdate/afterUpdate`, `beforeDelete/afterDelete`, `*Many`, `beforeFindOne/Many`, `beforeCount` (event `{action,model,params,result,state}`). Also **Document Service middlewares** (`strapi.documents.use`). | before-hooks mutate `event.params` (data/where); throw to abort. | Plugins add routes/controllers/services/content-types/policies/middlewares; admin + server parts; Plugin SDK. | `register()`/`bootstrap()`/`destroy()`; `lifecycles.ts` per content-type or `strapi.db.lifecycles.subscribe`. | **Trusted, in-process.** Marketplace review. |
| **Payload** | Collection hooks: `beforeOperation`, `beforeValidate`, `beforeChange`, `afterChange`, `beforeRead`, `afterRead`, `beforeDelete`, `afterDelete`, `afterOperation`, `beforeLogin`… + **field hooks** + global hooks. | before-change/read hooks **return the (mutated) doc**; throw to abort. | Config-as-code (TS config object); plugins = `(config) => config`. | Hooks declared on the collection config; plugins mutate config at startup. | **Trusted, in-process.** |
| **Keystone** | `resolveInput`, `validateInput`, `validateDelete`, `beforeOperation`, `afterOperation`. | `resolveInput` returns mutated input; `validate*` throws. | `extendGraphqlSchema`; custom mutations/queries. | List/field config. | **Trusted, in-process.** |
| **Directus** | **`filter`** (blocking, **mutates payload + can throw to abort**) vs **`action`** (non-blocking, after-the-fact). Events: `items.create`, `items.update`, `items.delete`, `<collection>.items.*`, auth events. | filter mutates+vetoes; action is fire-and-forget. | Typed extensions: `hook`, `endpoint` (custom routes), `operation` (Flows), + app: `interface/display/layout/module/panel/bundle`. Extensions SDK (`create-directus-extension`). | `defineHook(({filter,action}) => …)`, `defineEndpoint`. | **Trusted by default + an optional SANDBOX**: capability-scoped API (declare `permissions`: `request`/`log`/`sleep`…), restricted runtime. |
| **WordPress** | **`do_action(hook, …args)`** (side-effects) vs **`apply_filters(hook, $value, …args)`** (transform — **must return the value**). `add_action/add_filter` with **priorities**. | filter mutates (return value); action is side-effect. | Everything is hooks; plus shortcodes, REST routes, CLI. | `add_action`/`add_filter` at load. | **Trusted, in-process.** The canonical, battle-tested model. |
| **Medusa** | Event-bus **subscribers** + workflows; **modules** (DI services). | subscribers are reactions; module services replace/extend. | Modules, plugins, workflow steps. | Module config + subscriber files. | **Trusted, in-process.** |
| **Sanity** | `definePlugin` (mostly **Studio**/editor extensibility, not backend hooks). | n/a (client-side). | Studio config plugins. | Studio config. | Studio-side. |

**The two recurring primitives** (we adopt both): a **filter** (transform/veto, runs *before*, returns the
value, may throw to abort) and an **action** (side-effect, runs *after*, fire-and-forget). WordPress and
Directus name this split explicitly; Strapi/Payload fold it into `before*` (mutate) / `after*` (react).

**Sandboxing reality (the untrusted-code question):**
- **`vm2` is dead** — deprecated 2023, unfixable isolate escapes, archived. Do not use it.
- **`isolated-vm`** — separate V8 isolates, no shared heap; the serious option for untrusted JS (heavier,
  marshalling cost across the isolate boundary).
- **`worker_threads`** — OS-thread isolation; usable with a locked-down global/`require`, but not a complete
  security boundary by itself (shared process resources).
- **WASM** — strong sandbox, but the author must compile to WASM (DX cost).
- **What everyone actually ships:** trusted, in-process plugins + a curated marketplace/review (Strapi,
  Payload, Keystone, WordPress). Only Directus offers a (capability-scoped) sandbox, opt-in. → **Trusted-only
  with review is the correct v1; sandboxing is a hard, optional, later layer.**

## 3. Recommended architecture for us (grounded in the code)

**Attachment points (file:line):**
- **Content lifecycle hooks → the write path.** `src/http/write.handler.ts:275 handleWrite(ctx, req)`
  dispatches each verb as `ctx.sql.begin(tx => <verb>Entry(tx, def, …))` (PG = truth, in a transaction) then
  a per-type engine rebuild + cache invalidation (e.g. publish at `:336-341`; create/update/delete/
  variant-create in the same shape). This is the single choke point where `before*`/`after*` fire.
- **Precedent to mirror:** `src/auth/auth.ts` `databaseHooks` (`user`/`session` `before`/`after`) — our own
  in-house hook pattern, wired through `buildAuth`. The content-hook registry should feel the same.
- **Custom endpoints → `src/http/uws.adapter.ts createServer`** (route registration + the per-handler
  AuthContext from be-09b). Extension routes mount here, gated by the same `can(perm)`.
- **Field types / validators / operators → `src/store/registry.ts`** (content-type/component defs +
  validation) and the engine type catalog (`src/db/type.catalog.ts`).
- **Reload / cold start → `src/db/postgres.store.ts loadWithRegistry`** (boot rebuild-from-PG). A restart
  re-runs this; extensions register during boot, before/around the load.
- **DO NOT TOUCH the read hot path** (`src/store/engine.ts respond`, zero-PG, pre-serialized). No hook fires
  there.

**Hook firing model on the write path (the serialize-on-write nuance):**
```
handleWrite(verb):
  1. resolve def + validate body
  2. run BEFORE filters (create|update|delete|publish):  payload = filter(payload, ctx)
        - filters may MUTATE the payload and may THROW to VETO (clean 4xx)
        - filters run synchronously-ish BEFORE the tx, so the mutated payload is what is
          written to PG *and* serialized into the engine -> consistent by construction
  3. ctx.sql.begin(tx => <verb>Entry(tx, def, payload))      // PG truth (atomic)
        - a hook needing transactional co-writes gets `tx` here (a "before-in-tx" capability)
  4. per-type engine rebuild + cache invalidate                // engine reflects the commit
  5. run AFTER actions (create|update|delete|publish):  void action(result, ctx)
        - actions fire AFTER commit + engine update -> they observe the new, durable state
        - actions are fire-and-forget, wrapped (timeout + try/catch) so a slow/throwing
          action cannot fail the (already-committed) write nor hang the core
```

This resolves the consistency question: **a `before` filter mutates the payload before BOTH PG and the
engine serialize-on-write, so PG and the in-memory engine never diverge** (the engine rebuilds from the
committed row). An `after` action sees the committed + engine-reflected state.

## 4. Lifecycle-hook taxonomy

Filters (transform + veto, run before, return the value, may throw):
- `content.beforeCreate(payload, ctx) -> payload`
- `content.beforeUpdate(payload, ctx) -> payload`
- `content.beforeDelete(id, ctx) -> void | throw`
- `content.beforePublish(id, ctx)` / `content.beforeUnpublish(id, ctx)`
- (variant-create reuses `beforeCreate` with `ctx.variantLocale` set)

Actions (side-effect, run after commit + engine update, fire-and-forget):
- `content.afterCreate(result, ctx)`
- `content.afterUpdate(result, ctx)`
- `content.afterDelete(result, ctx)`
- `content.afterPublish(result, ctx)` / `content.afterUnpublish(result, ctx)`

Scoping: a hook registers for a **specific content-type** (`article.beforeCreate`) or **all** (`*`), with an
optional **priority** (WordPress-style ordered execution). **No read/query/count hooks** (hot-path
protection); bulk verbs reuse the single-row hooks per row in v1 (a dedicated `*Many` is a later option).

Event/context object (`ctx`): `{ type, action, principal (be-09b), tx?, registry, variantLocale?, … }` —
the resolved caller `principal` is available so a hook can do permission-aware logic, but **a hook never
receives raw request internals it could abuse**, and the principal/role still comes only from the validated
session (no mass-assignment regression).

## 5. Minimal hook-API sketch (illustrative TypeScript — not wired)

```ts
// What a community extension implements. Plain .ts, no build step.
export interface ContentHookContext {
  readonly type: string;                 // api id, e.g. 'article'
  readonly action: 'create' | 'update' | 'delete' | 'publish' | 'unpublish';
  readonly principal: Principal | null;  // be-09b: resolved from the session, never the body
  readonly tx?: Sql;                      // present in the before-in-tx phase for transactional co-writes
  readonly variantLocale?: string;        // i18n variant-create
}

export interface ContentHooks {
  // FILTERS — run before, may mutate the returned payload, may throw to VETO (clean 4xx).
  beforeCreate?(payload: Record<string, unknown>, ctx: ContentHookContext): MaybePromise<Record<string, unknown>>;
  beforeUpdate?(payload: Record<string, unknown>, ctx: ContentHookContext): MaybePromise<Record<string, unknown>>;
  beforeDelete?(id: number, ctx: ContentHookContext): MaybePromise<void>;
  beforePublish?(id: number, ctx: ContentHookContext): MaybePromise<void>;
  // ACTIONS — run after commit + engine update, fire-and-forget (timeout-guarded).
  afterCreate?(result: EntryRow, ctx: ContentHookContext): MaybePromise<void>;
  afterUpdate?(result: EntryRow, ctx: ContentHookContext): MaybePromise<void>;
  afterDelete?(result: EntryRow, ctx: ContentHookContext): MaybePromise<void>;
  afterPublish?(result: EntryRow, ctx: ContentHookContext): MaybePromise<void>;
}

export interface Extension {
  name: string;
  // Called once at boot, BEFORE the engine loads, to register hooks/routes/field-types.
  register?(api: ExtensionApi): MaybePromise<void>;
  // Called once at boot, AFTER the engine has loaded (warm), for setup that needs live data.
  bootstrap?(api: ExtensionApi): MaybePromise<void>;
}

export interface ExtensionApi {
  hooks(scope: string /* 'article' | '*' */, hooks: ContentHooks, priority?: number): void;
  route(method: HttpMethod, path: string, handler: RouteHandler, opts?: { permission?: string }): void; // phase 2
  // fieldType(...) / operator(...) — phase 3
}
```

## 6. Packaging, loading & registration

- An extension is a directory/package exporting a default `Extension` (a plain `.ts` module — **no build**).
- **Discovery:** a configured `extensions/` dir (and/or `package.json` deps tagged as extensions). Loaded at
  boot in a deterministic order (config-declared) so hook priority is stable.
- **Lifecycle:** `register()` (wire hooks/routes/field-types — runs before `loadWithRegistry`) then
  `bootstrap()` (after the engine is warm). Mirrors Strapi’s `register`/`bootstrap` and our `buildAuth`
  composition-root wiring.
- Hooks are collected into a per-type registry (a small `Map<type, {before[], after[]}>` keyed by
  content-type name — bounded by schema size, not rows, so no Map-ceiling concern).

## 7. Custom endpoints & field/operator extensions (phases 2–3)

- **Endpoints:** `api.route(method, path, handler, { permission })` registers into `createServer`
  (uws.adapter), gated by the be-09b `AuthContext.can(permission)`. The handler gets `{ principal, engine
  (read), store (write), registry }` — read via the fast engine, write via the same validated write path
  (so content written by an extension still fires content hooks + updates the engine consistently).
- **Field types / validators / operators:** register into the registry + type catalog. Higher risk (they
  touch the columnar engine’s typed columns); gated behind the validated content-type build path. A custom
  *operator* must define both its filter semantics AND stay off the zero-PG read hot path’s fast lanes
  (likely a brute fallback unless it can reuse an index) — designed conservatively.

## 8. Security stance & failure isolation

- **v1 = trusted, in-process, with review.** Extensions run with full Node access (like Strapi/Payload/
  WordPress). This is honest and standard; the alternative (a real sandbox) is a large, separate effort.
- **Failure isolation (what we DO enforce in v1):**
  - **after-actions** run post-commit, wrapped in `try/catch` + a soft timeout (`Promise.race`) so a
    throwing/slow action cannot fail the durable write nor block the response.
  - **before-filters** that throw → a clean veto (4xx), not a 500.
  - **Honest limit:** the core runs on ONE uWS event loop. A *synchronous CPU-bound / infinite-loop* hook
    can still hang the server — in-process trust cannot prevent that. This is the core argument for the
    eventual sandbox/worker phase and the reason v1 is trusted-only.
- **Phase 5 (optional, hard): sandbox for untrusted/marketplace extensions** — `worker_threads` or
  `isolated-vm`, with a **capability-scoped API** (Directus-style: an extension declares the host functions
  it needs — `db.read`, `log`, `http`, …). Not `vm2`. Only build this if an untrusted-marketplace exists.

## 9. Reload / cold-start story (single instance)

- Extensions load at boot; **changing an extension = a restart**, which re-runs `loadWithRegistry` (rebuild
  the in-memory engine from PG). Cost scales with data (the engine-ops bench: ~80k rows/s simple, ~8k/s with
  exotic types → 1M rows ≈ seconds–minutes; 10M ≈ minutes). On a single instance that is brief deploy
  downtime — acceptable for the target, and the same restart cost we already accept for any deploy.
- **Dev:** a watch-restart. **No hot-swap of hooks in v1** (would fight the single-instance + boot-load
  model and add reload-coherence bugs). If hot-reload is ever wanted, it is its own slice.

## 10. Phased roadmap

1. **MVP — content lifecycle hooks (trusted, in-process):** the `before*` filter / `after*` action taxonomy
   on the `handleWrite` seam; the extension loader (`register`/`bootstrap`); per-type hook registry;
   failure isolation (timeout + try/catch on actions, veto on filters). Tests: a hook mutates a create
   payload (persisted + engine-reflected); a `before` veto → clean 4xx + no write + no engine change; an
   `after` action observes committed state; a throwing/slow action does not fail the write; hooks never run
   on the read path. NO MOCKS (real PG).
2. **Custom endpoints** — `api.route` into `createServer`, gated by `AuthContext`.
3. **Custom field types / validators / query operators** — into the registry + type catalog.
4. **Scheduled jobs + an event/subscriber bus** — decoupled reactions (cron-ish; an in-process bus that does
   NOT reintroduce the cross-instance ChangeBus we removed).
5. **(Optional, hard) Sandbox for untrusted extensions** — worker/isolated-vm + capability-scoped API.

## 11. Open questions (to resolve before/while building)

- **Atomicity:** should `before`-filters with co-writes share the content tx (`ctx.tx`), and should a
  failing in-tx hook roll back the whole write? (Proposed: yes — in-tx hooks roll back with the write;
  after-actions are post-commit and cannot.)
- **Hook ordering / conflicts:** explicit numeric priority (WordPress) vs registration order. (Proposed:
  numeric priority, stable.)
- **Bulk:** per-row hooks vs dedicated `*Many` (Strapi has both). (Proposed: per-row in v1.)
- **Where do extension content-types live** in the single consolidated `0001_init.sql` migration policy?
  (An extension that adds a content-type must fold into the same migration discipline — or content-types
  stay dynamic via the existing builder path.)
- **API-stability contract** for extension authors (semver of the hook API) before any public marketplace.

---

### Sources (verify against current docs when implementing)
Strapi lifecycle hooks + Document Service middlewares + Plugin SDK (docs.strapi.io); Payload hooks
(collection/field/global) + config plugins (payloadcms.com/docs); Keystone hooks (keystonejs.com/docs);
Directus extensions (hooks filter/action, endpoints, operations) + **sandboxed extensions** capability model
(directus.io/docs/extensions); WordPress actions vs filters + priorities (developer.wordpress.org); Medusa
modules/subscribers (docs.medusajs.com); `vm2` deprecation + `isolated-vm` (github.com/patriksimek/vm2,
github.com/laverdet/isolated-vm).
