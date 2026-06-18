# `@absurd/sdk` — Roadmap to API parity

Goal: a typed, isomorphic, zero-dependency client that covers **everything** `@absurd/api` exposes over
HTTP. Drafted 2026-06-18.

## Cross-cutting decisions

- **No mocks (project rule).** Pure functions (the query-string builder) are tested by feeding their
  output into the **real `parseQuery` from `@absurd/api`** (round-trip, no network). The client is tested
  against a **real server**: `createServer(engine, store, registry)` + a Testcontainers Postgres on an
  ephemeral port — same harness style as the api suite.
- **No build (ship source).** The package ships `.ts` source via `exports → ./src/index.ts`, like
  `@absurd/api`; consumers (Vite / Node 24 type-stripping) handle it. A build step is added only when
  publishing to npm (Slice 10).
- **Never bundle the server.** Contract types are hand-written here, NOT imported from `@absurd/api`
  (which pulls postgres.js / uWebSockets.js into the browser bundle).
- **Scope boundary.** The dev-only `/debug-inspect` route is intentionally OUT of scope (a dev tool, not
  product API). Everything else in the api is in scope.

---

## Slice 0 — Package skeleton & toolchain
- [x] **0.1** `package.json` (`@absurd/sdk`, ESM, no-build, `exports → ./src/index.ts`)
- [x] **0.2** `tsconfig.json` — api conventions + `lib: ["ES2023","DOM"]` (fetch / URLSearchParams / AbortSignal)
- [x] **0.3** `src/index.ts` — empty barrel placeholder
- [x] **0.4** Workspace check: `npm pkg get name -w @absurd/sdk`; loads under type-stripping

## Slice 1 — Contract types (shared vocabulary)
- [x] **1.1** `CmsType` (16 — incl. `time`, `array`, `uuid`) + `FieldOptions` + `FieldSpec`
- [x] **1.2** `FieldDefinition` + `ContentTypeDefinition` (the `projectDef` shape)
- [x] **1.3** Envelope: `Entry`, `ListResponse<T>`, `SingleResponse<T>`
- [x] **1.4** Pagination meta: `OffsetPaginationMeta`, `KeysetPaginationMeta` + `isKeysetPagination` guard
- [x] **1.5** `FilterOperator` (all 21) + logical (`$and/$or/$not`) and relation-filter types
- [x] **1.6** Wire-format brands: `biginteger`/`decimal` as `string` (anti precision-loss), `json` as `unknown`
- *Test:* type-only usage smoke (compiles under `strict` + `exactOptionalPropertyTypes`).

## Slice 2 — Query-string builder (read query → Strapi bracket syntax)
- [x] **2.1** Core flattener (object/array/scalar → `key[..]=value`); encoding (values encoded, keys literal)
- [x] **2.2** `filters`: operators + short form (`field=value` → `$eq`)
- [x] **2.3** `filters`: `$in/$notIn` (array), `$between` (pair), `$null/$notNull` (flag `true`)
- [x] **2.4** `filters`: `$and/$or/$not` (nested trees)
- [x] **2.5** `filters`: relation nesting `filters[rel][field][$op]` (up to `MAX_RELATION_HOPS=3`)
- [x] **2.6** `sort` (string | multi-key `['views:desc','id:asc']`)
- [x] **2.7** `pagination` — 3 modes: page/pageSize, start/limit, keyset (cursor/before + pageSize + withCount)
- [x] **2.8** `fields` projection (NOTE: server validates but does not project yet — forward-compat)
- [x] **2.9** `populate` (string | array | `*` | nested `populate[rel][populate][...]`)
- *Test (mock-free):* `parseQuery(ctx, buildQueryString(x))` parses without error to the expected structure
  for every case. Round-trip against the real parser.

## Slice 3 — HTTP client core
- [x] **3.1** `AbsurdClient` ctor: `baseUrl`, injectable `fetch`, async `getHeaders()` slot (token seam)
- [x] **3.2** `request()`: URL build, header merge, JSON, `AbortSignal`, empty body
- [x] **3.3** `ApiError` (status + message from `{error}` + raw body)
- [x] **3.4** Typed subclasses by status: `BadRequest(400)`/`NotFound(404)`/`MethodNotAllowed(405)`/`Conflict(409)`/`PayloadTooLarge(413)`/`ServerError(5xx)`
- *Test:* real server → `GET /unknown-type` throws `NotFound`.

## Slice 3.5 — Test harness (mock-free integration) ⚠️ blocks 4/5/6
- [x] **3.5.1** `test/server.ts`: boot `createServer` + Testcontainers Postgres (reuse api golden-template), listen on :0, return `{baseUrl, close}`
- [x] **3.5.2** `withType()` helper: create a temp content-type for a test, drop after
- [x] **3.5.3** Global setup in api style (`.env.test`), parallel isolation

## Slice 4 — Read methods
- [x] **4.1** `list<T>(type, params?)` → `ListResponse<T>` (full `QueryParams`)
- [x] **4.2** `findOne<T>(type, id, {populate?})` → `SingleResponse<T>`; + `findOneOrNull` (404 → null)
- [x] **4.3** `count(type, filters?)` — extract `total` (offset always; keyset via `withCount`)
- [x] **4.4** Offset iterator: `listAll()` / async generator over pages
- [x] **4.5** Keyset iterator: follow `nextCursor` until `hasNextPage=false` (opaque cursor)
- *Test:* seed N rows → verify filters/sort/3 pagination modes/populate against real responses.

## Slice 5 — Write methods
- [x] **5.0** *Research:* read `body.parser.ts` + `relation.repository.ts` → capture exact relation-op body shape (`connect/disconnect/set`)
- [x] **5.1** `create<T>(type, data)` → `SingleResponse<T>` (201)
- [x] **5.2** `update<T>(type, id, data)` → partial, Strapi semantics (200/404)
- [x] **5.3** `delete<T>(type, id)` → deleted row (200/404)
- [x] **5.4** Relation-write types (`connect/disconnect/set`) in body
- *Test:* create → read-back → update → delete; relation connect/disconnect; 413 on oversized body.

## Slice 6 — Content-Type Builder (meta / runtime DDL)
- [x] **6.1** `contentTypes.list()` / `.get(apiId)`
- [x] **6.2** `contentTypes.create({apiId, fields})` → `ContentTypeDefinition` (201, canonical casing)
- [x] **6.3** `contentTypes.drop(apiId)` → `{apiId, dropped:true}`
- [x] **6.4** `contentTypes.addField` / `.updateField({newName?, cmsType?, options?})` / `.dropField`
- [x] **6.5** Meta error mapping: 409 (exists/conflict), 404, 400 (invalid identifier / unknown cmsType / enum / option / type-change)
- *Test:* full DDL lifecycle + error cases (duplicate → 409, bad apiId → 400).

## Slice 7 — Wire fidelity: value (de)serialization
- [x] **7.1** Schema-aware decode: per `ContentTypeDefinition`, map raw entry → typed (`biginteger`/`decimal` stay `string`; opt-in `BigInt`/`Date`)
- [x] **7.2** Encode for writes: `Date → ISO`, `bigint → string`
- [x] **7.3** Anti precision-loss guarantee (`JSON.parse` keeps big numbers as the quoted strings they are on the wire) — pin with a test
- *Test:* round-trip `biginteger > 2^53`, `decimal` with scale, `json` verbatim, `datetime` ISO.

## Slice 8 — Ergonomics / DX
- [x] **8.1** Fluent filter builder (opt): `f('views').gte(100).and(f('status').eq('published'))` → `FilterObject`
- [x] **8.2** Bound collection: `client.collection<Article>('article')` → `{list, findOne, create, update, delete}`
- [x] **8.3** Retries on idempotent GET + `timeout`
- [x] **8.4** `onRequest`/`onResponse` hooks (also the token-refresh seam)
- *Test:* builder→parser round-trip; collection binding.

## Slice 9 — Auth readiness (forward-compat)
- [x] **9.1** Formalize `getHeaders()` (per-request — Bearer slot)
- [x] **9.2** 401/403 handling + `onUnauthorized` hook (no-op until the api has auth)
- [x] **9.3** Document the seam; track with the api auth roadmap item
- *(Mostly design now; wires up when the api gains an auth scope.)*

## Slice 10 — Packaging / publishing (when going external) — deferred
- [x] **10.1** Decided: build. tsup ESM `dist/index.js` + separate `tsc --noCheck` `.d.ts` (post-emit `.ts`→`.js` specifier fixup); tsup/typescript devDeps only, zero runtime deps
- [x] **10.2** Dual `exports` (`source`→`./src/index.ts` for dev/workspace, `types`/`default`→`dist` for npm); workspace/tests pinned with `--conditions=source`
- [ ] **10.3** `private:false` + version + changelog (deferred — do at publish time)

## Slice 11 — Docs & examples
- [x] **11.1** README: quickstart + every method + cookbook per operator / pagination mode
- [x] **11.2** Examples mirroring the api README query examples
- [x] **11.3** Link from the root README

---

## Critical path
`0 → 1 → 2` (unblock everything) → `3.5` (harness) → `3 → 4 → 5 → 6` → `7 → 8 → 9` → (`10/11` when ready).

## Definition of Done — parity checklist  ✅ COMPLETE (Slices 0–11; 105 tests green; `tsc` src clean)
- [x] All **7 HTTP routes** covered by methods
- [x] All **21 filter operators** + `$and/$or/$not` + relation filters
- [x] All **3 pagination modes** + `withCount` + iterators
- [x] All **16 `cmsType`s** + `FieldOptions` in types and decode/encode
- [x] All **error codes** (400/404/405/409/413/5xx) → typed exceptions
- [x] **Wire fidelity**: bigint/decimal/json/date lossless — pinned by a test
- [x] Full **mock-free** test suite (real server + round-trip against the real parser)

> Only deferred: **10.3** (flip `private:false` + version + changelog) — for when the SDK is published to npm.
