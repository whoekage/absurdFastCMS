# Research — a consolidated, i18n-ready error module for `@conti/api`

**Goal:** one `src/errors/` module that (a) consolidates the ~37 ad-hoc error classes scattered across 12+
files, and (b) is i18n-ready from day one — error messages resolved in the caller's language at the HTTP
boundary, not baked in English at the throw site.

## 1. Current state (surveyed, not guessed)

- **~37 error classes**, each `extends Error`, spread across `db/ddl.ts` (15), `compose/builder.ts` (3),
  `db/schema/*` (~8), `store/*` (3), `storage/`, `db/body.parser.ts`, `db/entry.repository.ts`,
  `db/registry.ts`, `store/query.parser.ts`, etc.
- **263 `throw new` sites.** Top: `QueryParseError` (54), `BodyParseError` (52), **plain `Error` (45)**,
  `InvalidCursorError` (20), `DefaultTypeError` (15), `RegistryError`/`BuilderValidationError` (10 each).
- **Messages are BAKED IN ENGLISH at throw time** — e.g. `RegistryError` does
  `super(\`module "${apiId}" field "${field}": ${reason}\`)`. The string is frozen the moment it's thrown.
- **No error CODE concept.** Every `.code` in the tree is a *driver* code (PG `55P03`/`23505`, Node `ENOENT`),
  never an app code.
- **The HTTP boundary is SCATTERED** across ≥3 files via `instanceof` chains, each repeating the
  status mapping and forwarding `e.message` verbatim:
  - `http/read.router.ts` — `QueryParseError | InvalidCursorError → 400`
  - `http/write.handler.ts` — `HookError | BodyParseError | EntryWriteError | QueryParseError → 400`
  - `http/uws.adapter.ts` `builderError()` — Builder/Migration errors → 404/409/422 (+ inline multipart
    `{ status, message }` literals)
  - Wire shape: `{ error: "<english string>" }` (Builder routes: `{ ok:false, error, ...extras }`).
- **Locale infra exists but only for DATA** — `config.ts` `DEFAULT_LOCALE` (env, fallback `'en'`), used by the
  `locale` *query param* for localized content fields. **No `Accept-Language` parsing anywhere.**
- **SDK error tower** (`packages/sdk/src/client.ts`): `ApiError(status, message, body)` + per-status
  subclasses + `errorFromResponse(status, message, body)` + `messageFromBody(body)` reading `{ error }`.
  Carries `status`/`message`/`body`, **no `code`** — so clients today must parse English to branch.

**Root cause for i18n:** the message is a pre-formatted English string by the time it leaves the throw site.
You cannot translate a string you've already frozen — you can only translate from a stable **code + params**.

## 2. Recommended architecture — `src/errors/`

The single idea: **throw a code + structured params; render the message at the boundary in the request
locale.** Status and translations live in ONE catalog.

```
src/errors/
  app-error.ts   # the base class
  catalog.ts     # code → { status, messages: { en, ru, ... } }   (THE i18n seam)
  render.ts      # tiny {param} interpolator + render(code, params, locale)
  http.ts        # toErrorResponse(e, locale) — the ONE boundary (replaces every instanceof chain)
  locale.ts      # localeFromRequest(req) — Accept-Language → supported locale, fallback DEFAULT_LOCALE
  index.ts       # barrel
```

**Base class** — carries identity, not a frozen sentence:
```ts
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,                       // stable, e.g. 'module.not_found'
    readonly params: Record<string, string|number> = {},
    options?: { cause?: unknown },
  ) {
    super(render(code, params, DEFAULT_LOCALE), options); // default-locale text for LOGS/stack only
    this.name = 'AppError';
  }
  get status(): number { return CATALOG[this.code].status; }
}
```
- `super(...)` renders the **default-locale** message so Node stack traces / logs stay readable. The **wire**
  message is re-rendered per-request at the boundary — the throw site stays locale-agnostic.

**Catalog** — status + translations co-located (kills the scattered `instanceof→status` mapping):
```ts
export const CATALOG = {
  'module.not_found':       { status: 404, messages: { en: 'module "{apiId}" does not exist', ru: 'модуль "{apiId}" не найден' } },
  'query.invalid_operator': { status: 400, messages: { en: 'unknown operator "{op}"',          ru: 'неизвестный оператор "{op}"' } },
  'field.reserved':         { status: 422, messages: { en: '"{name}" is a reserved field name', ru: '"{name}" — зарезервированное имя поля' } },
  // ...
} as const satisfies Record<string, { status: number; messages: Record<Locale, string> }>;
export type ErrorCode = keyof typeof CATALOG;   // throw sites are type-checked against real codes
```

**Boundary** — the ONE function every handler calls:
```ts
export function toErrorResponse(e: unknown, locale: Locale): { status: number; body: { error: string; code: string } } {
  if (e instanceof AppError) return { status: e.status, body: { error: render(e.code, e.params, locale), code: e.code } };
  return { status: 500, body: { error: 'internal error', code: 'internal' } }; // never leak an arbitrary message
}
```

**Wire format — ADDITIVE (backward-compatible):** keep `error: "<localized string>"`, ADD `code: "<stable>"`.
Old clients reading `{ error }` keep working; new clients branch on `code` and can re-localize. (A breaking
`error: { code, message, params }` envelope is option D1 below — not recommended.)

**Locale source:** `Accept-Language` header → first supported locale, fallback `DEFAULT_LOCALE`. This is the
caller's **UI** language, deliberately DISTINCT from the data `locale` query param (content language).

## 3. SDK + admin payoff

- Add `readonly code?: string` to `ApiError`; `errorFromResponse` reads `body.code`. Consumers branch on a
  stable `e.code === 'module.not_found'` instead of parsing English.
- The admin can re-localize errors **client-side in the user's UI language** using the same code→message
  table, regardless of the server's locale. (Optional D6: a shared `@conti/errors` codes module / generated
  enum so api + sdk + admin share ONE source of truth for codes.)

## 4. Migration — incremental, stays green at every step

1. **Land the module** (base + catalog + render + boundary + locale). Seed the catalog `en` messages as the
   EXACT current strings → behaviour byte-identical. Wire `toErrorResponse` into the 3 handlers.
2. **Convert classes** with minimal churn: keep the semantic names as thin subclasses over `AppError` with a
   fixed code — `class QueryParseError extends AppError { constructor(p){ super('query.invalid_operator', p) } }`
   — so `instanceof` keeps working and the 263 throw sites change only their args (string → params object).
   Migrate high-traffic first (QueryParse 54, BodyParse 52, Builder 10, Registry 10); the long tail inherits
   the base. The 45 plain `throw new Error` are triaged: user-facing → a code; truly-internal → leave (→ 500).
3. **Add locales** (`ru`, …) — pure catalog data, zero code change.
4. **SDK**: add `code` (additive). Optionally extract shared codes.

**Scoping note:** only the **4xx** (user-facing) errors need translations. 5xx stays a generic
non-leaking "internal error" — never translate or echo internal messages.

## 5. Decisions to make (recommendation in **bold**)

- **D1 wire format** — **additive (`error` string + `code`)** vs breaking (`error: {code,message,params}`).
- **D2 i18n engine** — **bespoke ~10-line `{param}` interpolator** vs `@formatjs/intl-messageformat` (ICU
  plural/number — overkill for error strings, adds a dep + against no-build ethos).
- **D3 catalog storage** — **inline TS (type-safe `ErrorCode`, no build)** vs JSON-per-locale
  (translator-friendly, loses compile-time code checks).
- **D4 class strategy** — **keep semantic subclasses over `AppError`** (minimal diff, `instanceof` intact) vs
  collapse to one `AppError` + codes only (cleaner, far bigger diff across 263 sites).
- **D5 locale source** — **`Accept-Language` (UI language)** vs reuse data `locale` param vs fixed default.
- **D6 shared codes** — api-only vs a shared `@conti/errors` enum re-used by SDK/admin for client-side
  re-localization (**recommended once the api module is stable**).

## 6. On reusing an off-the-shelf skill / library

No Claude Code skill for errors+i18n fits (none available that matches). Off-the-shelf i18n libraries
(`i18next`, `@formatjs/intl-messageformat`) target rich UI-content localization (ICU plurals/gender/number,
pluggable backends, lazy bundles) — that's the wrong shape for a server error catalog, and pulls a runtime
dep into a zero-dep, no-build, single-instance project ([[single-instance-target]]). A bespoke ~150-LOC
module is the better fit: type-safe codes, status co-located, one boundary, trivial interpolation, and a
catalog that's just data. Build it; don't import it.
