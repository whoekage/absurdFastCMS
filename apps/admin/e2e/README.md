# Admin E2E tests (Playwright)

Mock-free, end-to-end tests for `@absurd/admin`. Playwright drives a **real Chromium** against the
**real admin** (Vite dev server on `:5173`), which proxies `/api` to the **real API** (`:3000`)
backed by **real Postgres**. Nothing is stubbed — each spec creates a throwaway content type, seeds
rows, exercises the UI, and tears everything down so reruns are idempotent.

## Specs

| File | Covers |
| --- | --- |
| `content-crud.spec.ts` | Entry CRUD: create an entry → see it in the list → open it → edit a field → verify the change → delete → verify it's gone. |
| `content-type-builder.spec.ts` | Builder: create a temp type with two fields → see it in the sidebar + the content-types list → add a field → drop the type (cleanup). |
| `list-filter-search.spec.ts` | List filtering: seed rows, apply a `$containsi` search + a status (enumeration) filter, assert the filtered result. |

## Running

The dev servers are **not** auto-started by Playwright (it attaches to your running admin via
`reuseExistingServer: true`, and never touches the API). Start both yourself, then run the suite:

```sh
# 1. API (port 3000, reads .env) — in its own terminal
npm run dev

# 2. Admin (Vite, port 5173, reads .env) — in its own terminal
npm run dev:admin

# 3. Run the E2E suite — from the repo root
npm run e2e --workspace @absurd/admin
```

Interactive / debugging UI mode:

```sh
npm run e2e:ui --workspace @absurd/admin
```

### Notes

- `E2E_BASE_URL` overrides the admin URL (defaults to `http://localhost:5173`).
- The API base comes from the admin's Vite `/api` proxy → `http://localhost:3000`; point the API
  elsewhere by setting `VITE_API_URL` for the admin dev server.
- Browser binary: `npx playwright install chromium` (run once).
