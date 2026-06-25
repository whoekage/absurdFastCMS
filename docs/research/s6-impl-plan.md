<!-- s6-reground-plan workflow wf_53574403-8c9: re-grounded against post-S5 code, adversarially critiqued, fixes merged. -->

# S6 Implementation Plan (FINAL, post-S5, code-grounded) — Builder Route Concurrency Hardening

This plan is keyed to the CURRENT code (verified by reading the files). It does NOT re-open the committed intent. Where the original `s5-s6-impl-plan.md` referenced line numbers that S5 reshaped, the verified current locations are used. Header plumbing (`CoreResponse.headers?`, `writeResponse` iteration, `builderJson(status,fields,headers)`) is ALREADY DONE in post-S5 — S5-1/S6-e are no-ops and are NOT re-added.

The two HIGH-severity correctness gaps from review (keyed no-op never records its replay row; replayed-envelope version wrong across reload) are FIXED directly in §4/§5 below. The test #20 / canonicalization contradiction is resolved in §1 and §9. The mutex-acquire-before-any-await tightening is applied in §2/§5.

---

## 0. What already exists (do not rebuild)

- `writeResponse` iterates `result.headers` after Content-Type (`uws.adapter.ts:108`); `corkSend` forwards it (`:158`); `builderJson(status, fields, headers?)` emits it (`:165`). Retry-After / ETag / 412-body plumbing is complete.
- The live cell `live` is at `uws.adapter.ts:419`; `swapFromIR` imported at `:11`. VERIFIED `swapFromIR(sql, live, next, applied, nextHooks)` at `engine.swap.ts:39`: with `applied = []` it rebuilds NO per-type storage but DOES reassign `live.registry = Registry.fromSchemas(next)`, `live.hooks = nextHooks`, and re-derives all relations (`:80-86`).
- The single apply core `applyResolvedPlan(sql, plan, opts)` is at `builder.ts:162`; `migrateLint` gate + temp-write/rename or rm + the `migrate()` call all live there. The unlink-on-throw is at `builder.ts:182`.
- `applySchemaEdit` (`:212`), `applySchemaDelete` (`:225`), `previewSchemaEdit` (`:242`) delegate to the core; `resolveEdit` (`:199`) + `preflightValidate` (`:114`) + `resolveSchema` (`:72`) + `BuilderValidationError`/`BuilderNotFoundError` exist.
- `migrate(sql, next, opts)` (`migrate.ts:404`) → VERIFIED: `ensureAppliedTable` (`:405`) → `readAppliedSchemas` (`:406`) → `diff` (`:407`) → `lint` (`:408`) → **`if (cs.changes.length === 0) return { noop: true, applied: [] }` (`:410`)** → `applyChangeSet(sql, cs, next)` (`:411`). `applyChangeSet` (`:358`) runs the `sql.begin` tx with `SET LOCAL lock_timeout = '5s'` (`:374`), `pg_advisory_xact_lock(MIGRATE_LOCK_KEY)` (`:376`, key `0x5c_3e_a9_01` at `:52`), `reconcileApplied(handle, next)` (`:391`). `ensureAppliedTable` (`:271`), `readAppliedSchemas` (`:281`), `writeAppliedSnapshot` (`:350`).
- Adapter builder block (`uws.adapter.ts:904–1017`): `applyEditFn` closure (`:907`), `applyDeleteFn` closure (`:919`), `okEnvelope` (`:927`), the two public GETs (`:935`, `:949`), POST preview (`:966`), PUT (`:985`), DELETE (`:1002`). `applyEdit` spread at `:1585`; `UwsServer.applyEdit` type at `:76`.
- `gate(res, req, perm, readsBody, proceed)` (`:502`): reads headers SYNC off `req` (`:510-511`), buffers body, resolves auth, then calls `proceed(body, aborted)` AFTER auth passes. `req` is dead after the first await — params/headers MUST be read at the top of the route handler.
- 304/410/412/422/428 status lines exist (`:83-96`).
- `SchemaChangeConflictError` is real at `ddl.ts:148` (NOT fabricated); `runSchemaTx`'s `5s` (`ddl.ts:609`) is a DISTINCT path with a distinct advisory key — leave it untouched.

What does NOT exist yet and is S6 work: `compose/catalog-version.ts` (`computeCatalogVersion`), the `currentVersion` cache, the `writerBusy` mutex, If-Match/Idempotency-Key/If-None-Match reads, 409-busy/412/428/304, `ensureIdempotencyTable` + the idempotency persistence path, the 55P03 retry loop, `lock_timeout` lowering, `POST /builder/reload`, the auth-lift in `helpers.ts`.

---

## 1. `compose/catalog-version.ts` (NEW) — S6-1

Create `packages/api/src/compose/catalog-version.ts`:

```ts
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { defToSchema, type TypeDef } from '../db/schema/define.ts';
import type { ContentTypeSchema } from '../db/schema/model.ts';

/** Re-import every entities/<apiId>/schema.ts with a cache-bust token so an out-of-band edit is RE-READ
 *  (Node ESM cache otherwise serves the stale module). Mirrors loadTypes' dir-walk but is schema-only
 *  (hooks do not affect the catalog version) and appends ?v=<token>.
 *  MUST tolerate a concurrently renamed/removed entry mid-walk: an ENOENT on a directory that vanished
 *  between readdir and import is SKIPPED, not thrown (a DELETE's rm can race a GET's lazy version init). */
async function loadSchemasCacheBusted(dir: string, token: string): Promise<ContentTypeSchema[]> { /* walk like load.ts:37-66, import `${href}?v=${token}`; wrap each import in try/catch → on ENOENT skip */ }

/** sha256 of the canonical on-disk IR (the SOURCE OF TRUTH = files, not _schema_applied). */
export async function computeCatalogVersion(entitiesDir: string): Promise<string> {
  const schemas = await loadSchemasCacheBusted(entitiesDir, String(Date.now()) + ':' + Math.random());
  const canonical = canonicalize(schemas); // sort types by id; sort each fields[]/relations[] by id; stable key order
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Same canonicalization applied to a request body — the idempotency request_hash basis (S6-5). */
export function canonicalizeForHash(value: unknown): string { /* stable-stringify */ }
```

Notes:
- `loadTypes` (`load.ts:37`) does NOT cache-bust today (it imports `pathToFileURL(...).href` with no query — `load.ts:55,62`). The version path MUST cache-bust so a `POST /builder/reload` after an out-of-band file edit yields a NEW hash (test #20). Do NOT mutate `loadTypes`'s boot semantics — implement the cache-busted walk locally in `catalog-version.ts` (schema-only). `POST /builder/reload`'s rebuild uses its OWN fully cache-busted `loadTypes` variant (schema AND hooks — see §7); only the VERSION uses the cache-busted schema-only hash here.
- **Canonicalization is reorder-INVARIANT but value-SENSITIVE**: types ordered by `id`; within each type, `fields` and `relations` ordered by `id`; object keys emitted in a fixed order (recursive sorted-key stringify). This makes the hash invariant to file-presentation reordering yet sensitive to any real catalog change (a new field, an attribute, a description, an options key). Test #20 is designed around this exact contract (§9, #20): it does NOT reorder; it adds an IR-visible, non-migratable attribute so the hash bumps while `_schema_applied` stays byte-identical.
- `erasableSyntaxOnly`: plain functions, no enums/param-props. `exactOptionalPropertyTypes`: spread optional schema fields conditionally (mirror `resolveSchema` `:101-104`).

### `currentVersion` cache + recompute points — S6-2

Declare inside the `if (entitiesDir !== undefined)` block (`uws.adapter.ts:904`), next to `dir`/`sql` (`:905-906`), so it is PER-SERVER (never module-scope — two test servers must not share it):

```ts
let currentVersion = '';            // cached on-disk catalog version (sha256).
```

Recompute / cache at exactly these points:
- **Boot (EAGER — chosen over lazy):** compute `currentVersion = await computeCatalogVersion(dir)` once right after server construction, before `listen` resolves (wire it into the construction inside the `:904` block, or as an awaited step the `listen` path gates on). This ELIMINATES the GET-vs-apply lazy-init interleave (review medium "version TOCTOU"). The lazy `if (currentVersion === '') ...` guard is kept ONLY as a defensive fallback in each GET/apply path (cheap, near-always a no-op), but the eager boot init is the primary path. Document the choice.
- **On apply (PUT/DELETE)**: INSIDE the mutex, AFTER `runEdit`/`runDelete` returns ok, SKIP on no-op (`result.applied.length === 0` — mirror the swap guard at `:909`/`:921`), else `currentVersion = await computeCatalogVersion(dir)`; put it in the 200 envelope + `ETag`. The keyed idempotency row's stored version is RECONCILED to this post-recompute value (see §4 HIGH-2 fix).
- **On reload** (§7): after the cache-busted import + swap, `currentVersion = await computeCatalogVersion(dir)`.

---

## 2. The `writerBusy` mutex — S6-3

Declare per-server alongside `currentVersion` (inside `:904` block):

```ts
let writerBusy = false;
```

It must wrap **version-precheck + idempotency-lookup + apply + post-apply version recompute + idempotency-row reconcile** together in ONE `try/finally` (acquire FIRST, before any catalog/version read — the committed order; precheck-outside-the-mutex reopens the lost-update race).

**MUTEX ACQUIRE MUST PRECEDE ALL AWAITS (review medium fix):** the `if (writerBusy) return …; writerBusy = true;` pair is the FIRST synchronous statements of the async IIFE, with ZERO awaits between the check and the set, and BEFORE any `await pruneIdempotency`. This guarantees serialization for BOTH keyless AND keyed concurrent writers (the prior draft's `await pruneIdempotency` before the check would let two keyed writers both pass the busy check). `pruneIdempotency` moves to AFTER acquisition (it is cheap; the "no latency under the lock" concern is negligible for an opportunistic prune).

### PUT handler rewrite (`uws.adapter.ts:985-999`)

Capture headers SYNC at `:986` (before `gate`, because `gate`'s `resolveAuth` await invalidates `req`):

```ts
app.put('/builder/content-types/:apiId', (res, req) => {
  const apiId = req.getParameter(0) ?? '';
  const ifMatch = req.getHeader('if-match');         // '' when absent (uWS contract; lowercase key)
  const idemKey = req.getHeader('idempotency-key');
  gate(res, req, 'builder.manage', true, (raw, aborted) => {
    const parsed = parseBody(raw);
    if (!parsed.ok) return corkSend(res, aborted, parsed.error);                       // pre-mutex, terminal
    const body = parsed.body as { allowDestructive?: boolean; version?: string } & ContentTypeDraft;
    if (body.apiId !== apiId) return corkSend(res, aborted, builderJson(422, { ok: false, error: 'body.apiId must equal the path apiId' }));
    if (ifMatch === '' && body.version === undefined) return corkSend(res, aborted, builderJson(428, { ok: false, error: 'precondition required' }));  // 428 pre-mutex, terminal
    void (async () => {
      // === MUTEX ACQUIRE: first statements, zero awaits before set ===
      if (writerBusy) return corkSend(res, aborted, builderJson(409, { ok: false, error: 'builder busy' }, { 'Retry-After': '1' }));
      writerBusy = true;
      try {
        if (idemKey !== '') await pruneIdempotency(sql).catch(() => {});   // AFTER acquire; opportunistic TTL
        if (currentVersion === '') currentVersion = await computeCatalogVersion(dir);  // defensive; boot already set it
        const expected = ifMatch !== '' ? ifMatch : body.version!;
        if (expected !== currentVersion) return corkSend(res, aborted, builderJson(412, { ok: false, error: 'stale version', currentVersion }, { ETag: currentVersion }));
        const requestHash = sha256(canonicalizeForHash({ m: 'PUT', apiId, body: strip(body) }));
        if (idemKey !== '') {
          const hit = await idempotencyLookup(sql, idemKey);
          if (hit) {
            if (hit.request_hash !== requestHash) return corkSend(res, aborted, builderJson(422, { ok: false, error: 'idempotency key reused for a different request' }));
            // HIGH-2 fix: the stored response carries its OWN version (reconciled at original write); replay that verbatim.
            return corkSend(res, aborted, builderJson(hit.status, hit.response,
              hit.status === 200 ? { ETag: (hit.response as { version?: string }).version ?? '' } : undefined));
          }
        }
        const idem = idemKey !== '' ? { key: idemKey, requestHash } : undefined;
        let r: SchemaEditResult;
        try { r = await runEdit(body, { allowDestructive: body.allowDestructive === true, idem }); }
        catch (e) {
          // terminal-4xx idem persist (own short tx) happens in builderError-mapping path below if keyed
          if (idemKey !== '') await persistTerminalIdem(sql, idemKey, requestHash, e).catch(() => {});
          throw e;
        }
        if (r.ok && (r.applied?.length ?? 0) > 0) currentVersion = await computeCatalogVersion(dir);
        const env = okEnvelope(r, currentVersion);       // okEnvelope extended (§3)
        // HIGH-1 + HIGH-2 reconcile: on a KEYED apply, persist/UPDATE the idem row with the FINAL version now.
        if (idemKey !== '') await reconcileIdemRow(sql, idemKey, requestHash, env).catch(() => {});
        corkSend(res, aborted, env);
      } catch (e) {
        corkSend(res, aborted, builderError(e));          // SchemaChangeConflictError → 409 (§5)
      } finally {
        writerBusy = false;
      }
    })();
  });
});
```

Helpers: `sha256`/`strip` are tiny local helpers (`strip` removes the HTTP-only `allowDestructive`/`version` keys before hashing so the request_hash is over the schema-meaningful body). `idempotencyLookup`/`pruneIdempotency`/`reconcileIdemRow`/`persistTerminalIdem` are NEW small helpers near `ensureIdempotencyTable` (in `compose/builder.ts` or `catalog-version.ts`; keep them together).

**HIGH-1 + HIGH-2 fix (idempotency persistence model):** because `migrate()` returns at the noop check (`:410`) BEFORE `applyChangeSet`, an in-`applyChangeSet` INSERT is UNREACHABLE on a keyed no-op apply. And the success envelope's `version` is only known AFTER the post-apply recompute (and can be advanced by a `reload`/out-of-band edit between two replays), so an in-tx pre-rename INSERT cannot store the correct version. RESOLUTION: persist the keyed SUCCESS idem row from the ADAPTER, INSIDE the mutex, AFTER the post-apply version recompute, via `reconcileIdemRow(sql, key, hash, env)` (own short tx, `ON CONFLICT (key) DO NOTHING`), storing the COMPLETE final envelope (incl the correct `version`). This covers BOTH the migrating-apply AND the no-op apply uniformly (no reliance on `applyChangeSet` being reached). Accepted trade-off: a crash between the migrate commit and `reconcileIdemRow` leaves no row → a same-key replay re-runs the apply, which now diffs to a no-op (benign, byte-identical). The in-migrate-tx INSERT path (originally §4) is therefore DROPPED in favor of this single adapter-side reconcile — strict tx-atomicity is traded for correctness across reload and the noop branch (documented).

### DELETE handler rewrite (`uws.adapter.ts:1002-1016`)

Identical mutex/version/idempotency wrap. Capture `ifMatch`/`idemKey` at `:1003`. Keep the existing `body.allowDestructive !== true` → 409 guard (`:1008`) BEFORE the mutex (cheap, terminal). Add the 428 check after parseBody. Then (inside mutex, busy-check first) → 412 precheck → idempotency lookup/replay → `runDelete(apiId, { allowDestructive: true, idem })` → recompute version → `reconcileIdemRow` if keyed → `okEnvelope(r, currentVersion)`. (`applyDeleteFn` is NOT on the returned server object, so no programmatic-mutex concern for DELETE — HTTP only.)

### Programmatic `applyEdit` + self-deadlock avoidance — S6-3

Factor the closure bodies so the HTTP path (already inside the held mutex) and the programmatic path do not double-acquire:

- Factor `applyEditFn`'s body (`:908-916`) into `const runEdit = async (draft, opts) => { ... }` (NO guard). `opts` type grows `idem?: { key: string; requestHash: string }`.
- `applyEditFn = async (draft, opts) => { if (writerBusy) throw new BuilderBusyError('builder busy'); writerBusy = true; try { return await runEdit(draft, opts); } finally { writerBusy = false; } }` — programmatic callers serialize and a contended call THROWS `BuilderBusyError` (it cannot return a `CoreResponse`).
- HTTP PUT calls `runEdit(body, …)` from inside its OWN held mutex (NOT `applyEditFn!`) — no self-deadlock.
- DELETE similarly: factor `applyDeleteFn` (`:919-925`) into `runDelete(apiId, opts)`; HTTP DELETE calls `runDelete` inside its mutex.

`runEdit` body (verified against current closure):
```ts
const runEdit = async (draft, opts) => {
  const result = await applySchemaEdit(sql, dir, draft, opts ?? {});
  if (!result.ok || result.next === undefined || (result.applied?.length ?? 0) === 0) return result;
  const { hooks: nextHooks } = await loadTypes(dir);
  await swapFromIR(sql, live, result.next, result.applied!, new HookRegistry(nextHooks));
  return result;
};
```

`BuilderBusyError` is a NEW plain `class extends Error` in `builder.ts` (match `BuilderValidationError` shape, `erasableSyntaxOnly`-safe); `builderError` is NOT extended for it (the programmatic caller catches it directly; the HTTP path never throws it because it checks `writerBusy` itself).

---

## 3. `okEnvelope` extension — S6-2 envelope/ETag

`okEnvelope` (`uws.adapter.ts:927-930`) gains a `version` param and emits it + sets `ETag`:

```ts
const okEnvelope = (r: SchemaEditResult, version: string): CoreResponse =>
  r.ok
    ? builderJson(200, { ok: true, version, applied: r.applied ?? [], blocked: [], live: true, ...(r.schema !== undefined ? { schema: r.schema } : {}) }, { ETag: version })
    : builderJson(409, { ok: false, applied: [], blocked: r.blocked ?? [], error: 'requires allowDestructive' });
```

The 409 (requires-allowDestructive) leg carries no ETag (no version change). On no-op (`applied.length === 0`), `version` passed in is the UNCHANGED `currentVersion` (skip recompute), which is correct; and `reconcileIdemRow` stores THAT version, so a keyed no-op replays byte-identical (HIGH-1).

---

## 4. `migrate.ts` — lock_timeout + idempotency table — S6-5/S6-6

### lock_timeout (S6-6)

`migrate.ts:374`: change the literal `'5s'` → `'1500ms'`. This is the ONLY lock_timeout on the migrate path. Do NOT touch `ddl.ts:609` (runSchemaTx, distinct per-table path, distinct advisory key).

### `ensureIdempotencyTable` (NEW export, after `ensureAppliedTable` at `:278`)

```ts
export async function ensureIdempotencyTable(sql: Sql): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS _builder_idempotency (
    key text PRIMARY KEY,
    request_hash text NOT NULL,
    status int NOT NULL,
    response jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
}
```

### Idempotency persistence is ADAPTER-SIDE, not in the migrate tx (HIGH-1 + HIGH-2)

The originally-planned in-`applyChangeSet` INSERT is DROPPED. Rationale (verified): `migrate()` returns at `:410` before `applyChangeSet` on a no-op, so the in-tx INSERT never fires for a keyed no-op apply; and the correct post-apply `version` is unknown pre-rename and can be advanced by a later `reload`, so the in-tx row cannot carry the right version. Instead:

- The adapter calls `reconcileIdemRow(sql, key, requestHash, env)` INSIDE the mutex AFTER the version recompute, writing the COMPLETE final envelope in its own short tx (`ON CONFLICT (key) DO NOTHING`). This is uniform for migrating AND no-op applies and stores the right version.
- `migrate()`/`applyChangeSet()` signatures are therefore UNCHANGED (no `idem?` param threading through `migrate`/`applyChangeSet`/`reconcileApplied`). This also avoids touching `boot-reconcile.ts:137` and `writeAppliedSnapshot`'s reuse of `reconcileApplied`.
- `ensureIdempotencyTable(sql)` is called once at boot (alongside the harness/`conti` table ensures) OR lazily by `idempotencyLookup`/`reconcileIdemRow` on first keyed request; pick once-at-boot to keep the request path INSERT-only. Test `beforeEach` drops it (§8/§9).
- `runEdit`/`runDelete`'s `opts.idem` is now used ONLY to thread the `{key, requestHash}` for nothing downstream of `applySchemaEdit` — so `applySchemaEdit`/`applySchemaDelete`/`applyResolvedPlan` do NOT need an `idem` param either. Simplify: drop `idem` from the `runEdit`/`runDelete` opts entirely; the adapter holds `key`/`requestHash` locally and does the reconcile itself after `runEdit` returns. (This is strictly simpler than the draft's thread-through and removes the §4-draft "CRITICAL ordering" hand-wave.)

---

## 5. `applyResolvedPlan` — 55P03 retry + SchemaChangeConflictError — S6-6

Import `SchemaChangeConflictError` from `../db/ddl.ts` into `builder.ts` (add to the `:6` import group). Replace the current try/catch (`builder.ts:178-185`) with a bounded retry that keeps `tmp` across attempts and unlinks ONCE on final failure:

```ts
let result: Awaited<ReturnType<typeof migrate>> | undefined;
let lastErr: unknown;
for (let attempt = 0; attempt < 3; attempt++) {
  try { result = await migrate(sql, plan.next, opts); lastErr = undefined; break; }
  catch (err) {
    if ((err as { code?: string }).code === '55P03') { lastErr = err; await sleep(50 * 2 ** attempt + Math.random() * 25); continue; }
    if (tmp) await unlink(tmp).catch(() => {});     // non-55P03: fail immediately
    throw err;
  }
}
if (lastErr || result === undefined) { if (tmp) await unlink(tmp).catch(() => {}); throw new SchemaChangeConflictError('builder migrate lock contended; retry'); }
if (plan.write && tmp) await rename(tmp, plan.write.target);
if (plan.removeDir) await rm(plan.removeDir, { recursive: true, force: true });
return plan.schema !== undefined
  ? { ok: true, applied: result.applied, schema: plan.schema, next: plan.next }
  : { ok: true, applied: result.applied, next: plan.next };
```

- `sleep` = a tiny local `(ms) => new Promise(r => setTimeout(r, ms))`.
- Retry on `55P03` ONLY (lock_timeout). 40P01/40001 NOT retried (unreachable under the single-writer mutex + advisory lock; untested branch).
- `migrateLint` (`:168`) stays OUTSIDE the loop (read-only re-diff).
- The current per-throw unlink (`:182`) MOVES into the loop's non-55P03 branch + the single final-failure unlink (do NOT unlink per 55P03 attempt — a retried rename target would be gone).
- **Per-attempt cost (review medium "55P03 retry math"):** each retried `migrate()` call re-runs `ensureAppliedTable` + `readAppliedSchemas` + `diff` + `lint` BEFORE the timing-out tx, so per-attempt cost is `>1500ms`. Backoff sums: sleeps fire after attempts 0 and 1 only (break on success/non-retry) ≈ `50 + 100 + jitter ≈ ~175ms`. Floor ≈ `3×1500 + 175 ≈ 4.7s`; the pre-tx work makes the realistic ceiling higher under load. Test #19 therefore asserts `< 6s` (NOT `< 5s`) to avoid flakiness. (Optional future optimization: hoist `ensureAppliedTable` out of the retried call — NOT required for S6.)

### Adapter status mapping for SchemaChangeConflictError → 409

`builderError` (`uws.adapter.ts:171`) currently maps known builder/migrate errors and returns 500 otherwise. Add a branch:

```ts
if (e instanceof SchemaChangeConflictError) return builderJson(409, { ok: false, error: 'schema lock timed out; retry' }, { 'Retry-After': '1' });
```

Import `SchemaChangeConflictError` into `uws.adapter.ts`. This 409 is TRANSIENT and must NOT be persisted as an idempotency outcome. The PUT/DELETE handlers call `runEdit`/`runDelete` inside `try { } catch (e) { corkSend(res, aborted, builderError(e)); }`, so the conflict surfaces as 409 (not a leaked 500).

### Terminal-4xx idempotency persistence (`persistTerminalIdem`, adapter, own short tx)

When `idemKey !== ''` and the apply THROWS/returns a TERMINAL 4xx (422 data-loss/validation, 409 requires-destructive — NOT 409-busy, NOT 409-lock-timeout, NOT 412/428), `persistTerminalIdem(sql, key, requestHash, errOrEnv)` writes the row in its OWN short tx (no migrate ran):

```ts
await sql`INSERT INTO _builder_idempotency (key, request_hash, status, response)
  VALUES (${idemKey}, ${requestHash}, ${status}, ${sql.json(envelope)}) ON CONFLICT (key) DO NOTHING`;
```

It maps the thrown error to its terminal status/envelope (reuse `builderError`'s mapping to derive status/body). NEVER persist transient `409 builder busy` / `409 lock timed out` / `412` / `428` (guard on the mapped status).

### Mutex release on abort (review low — no leak)

`writerBusy = false` is in `finally`, which runs on EVERY path incl client abort (abort only affects `corkSend`'s write-skip, not control flow) — no lock leak. The `409-busy` early return is strictly BEFORE `writerBusy = true; try {`, so the busy-loser never enters the `try`/`finally` and never resets a flag it did not set. Keep a code comment marking this invariant; it is easy to regress.

---

## 6. ETag / 304 on GETs — S6-7

### 304 must send a ZERO-LENGTH body (review low — HTTP compliance + test #21)

A 304 MUST NOT carry a message body. `writeResponse` always `res.end`s the serialized fields buffer, so `builderJson(304, {})` would emit `{}` (2 bytes). FIX: special-case `status === 304` in `writeResponse`/`corkSend` to emit a zero-length body while STILL writing the `ETag` header (and Status line). Add a dedicated 304 path or a `bodyless` flag on `CoreResponse` honored by `writeResponse`. Test #21 asserts an empty body.

### GET collection (`uws.adapter.ts:935`)

Currently `(res) =>` with NO `req`. Change to `(res, req) =>` and read If-None-Match SYNC at the top:

```ts
app.get('/builder/content-types', (res, req) => {
  const inm = req.getHeader('if-none-match');
  let aborted = false;
  res.onAborted(() => { aborted = true; });
  void (async () => {
    try {
      if (currentVersion === '') currentVersion = await computeCatalogVersion(dir);  // defensive; boot set it
      if (inm !== '' && inm === currentVersion) return corkSend(res, () => aborted, builderJson(304, {}, { ETag: currentVersion }));  // bodyless 304
      const schemas = await readAppliedSchemas(store.sql);
      corkSend(res, () => aborted, builderJson(200, { ok: true, schemas, version: currentVersion }, { ETag: currentVersion }));
    } catch { corkSend(res, () => aborted, builderJson(500, { ok: false, error: 'internal error' })); }
  })();
});
```

### GET one (`:949`)

Already has `req`. Read `const inm = req.getHeader('if-none-match');` at `:950`. Same defensive version init; bodyless 304 on match; else add `version: currentVersion` to the 200 body and `{ ETag: currentVersion }`.

Header KEYS lowercase (`'if-none-match'`); `req.getHeader` returns `''` when absent — test `inm !== ''`.

### read hot-path unchanged (test #22)

The data-read path (`handleRequest` → `writeResponse`, e.g. `:827`) sets NO `headers`, so output is byte-identical. No change needed — guarded by an explicit test.

---

## 7. `POST /builder/reload` (NEW) — S6 (escape hatch + version contract)

Mount inside the `:904` block, GATED on `builder.manage`. It acquires the SAME `writerBusy` mutex (busy-check first, zero awaits before set; 409+Retry-After on contention), cache-busts the import, rebuilds via `swapFromIR`, recomputes the version, runs NO migrate:

- acquire `writerBusy` (busy-check FIRST; 409+Retry-After on contention).
- **Fully cache-busted `loadTypes` variant (review low):** `loadTypes` (`load.ts:55,62`) imports `pathToFileURL(...).href` with NO query, so an out-of-band edit to schema.ts OR hooks.ts is served STALE from the ESM cache. Implement a `loadTypesCacheBusted(dir, token)` that appends `?v=${token}` to BOTH the schema.ts AND hooks.ts import specifiers, returning `{ schemas, hooks }`. (Reusing only the schema-only walk from `catalog-version.ts` is insufficient — hooks must re-read too.)
- **swapFromIR with `applied = []` (VERIFIED behavior):** `swapFromIR(sql, live, freshSchemas, [], new HookRegistry(freshHooks))` rebuilds NO per-type column storage (creates/drops/changes are all empty), but DOES reassign `live.registry`, `live.hooks`, and re-derive relations (`engine.swap.ts:80-86`). This is CORRECT for a reload: a reload changes the IR/hooks but applies NO DDL (the columns are unchanged on disk), so swapping registry+hooks+relations is exactly the intended effect. Document that per-type column storage is intentionally NOT rebuilt on reload (no schema change reached the DB). If a future reload must also rebuild storage from an out-of-band-applied DDL, that is OUT OF SCOPE here.
- `currentVersion = await computeCatalogVersion(dir)` AFTER the import.
- `200 { ok: true, version: currentVersion }` + `ETag`.
- release in `finally`.

This makes a pre-reload PUT carrying the old version fail 412 (test #20).

---

## 8. `helpers.ts` auth lift — S6 test harness

Add `startTestServerFromFilesWithAuth(sql, entitiesDir)` to `test/helpers.ts` (the existing `startTestServerFromFiles` at `:105` wires NO auth → gate OPEN; the auth pattern lives only in `auth.route-gating.e2e.test.ts`). Build the full auth stack with the construction order that breaks the cycle:

```ts
import { setAuthSql, closeAuth } from '../src/auth/auth.dialect.ts';
import { buildAuth } from '../src/auth/auth.ts';
import { SessionCache } from '../src/auth/session.cache.ts';
import { RbacRegistry } from '../src/auth/rbac.registry.ts';

export async function startTestServerFromFilesWithAuth(sql: Sql, entitiesDir: string) {
  setAuthSql(sql);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const store = new PostgresStore(sql);
  let auth: ReturnType<typeof buildAuth>;
  const sessionCache = new SessionCache(() => auth);     // lazy ()=>auth breaks the cycle
  const rbac = new RbacRegistry(sql);
  auth = buildAuth({ baseURL: base, sessionEvictor: sessionCache, sql, rbacInvalidate: () => rbac.rebuild() });
  await rbac.rebuild();
  const { schemas, hooks } = await loadTypes(entitiesDir);
  const { engine, registry } = await store.loadFromSchemas(schemas);
  // positions: auth=5, sessionCache=6, rbac=7 ⇒ authEnabled; HookRegistry=9, entitiesDir=10 ⇒ builderActive.
  const server = createServer(engine, store, registry, undefined, auth, sessionCache, rbac, undefined, new HookRegistry(hooks), entitiesDir);
  const token = await server.listen(port);

  const signUp = async (email: string): Promise<string> => { /* verbatim auth.test:38-50; MUST send origin: base */ };
  const userIdOf = async (email: string): Promise<string> => { /* verbatim :53-57 */ };
  const grantRole = async (userId: string, role: string): Promise<void> => { /* verbatim :60-67; await rbac.rebuild() */ };

  return { base, close: server.close, token, applyEdit: server.applyEdit!, sql, rbac, sessionCache, signUp, userIdOf, grantRole };
}
```

- Teardown in `after()`: `srv.close(token); srv.sessionCache.stop(); await closeAuth();` (plus the per-file `sql.end()`/`dropFileDatabase`).
- Golden-template: `createFileDatabase` clones `absurd_golden` (built via `runMigrations`), so roles/permissions + better-auth tables already exist — no `runMigrations` in this harness. `cleanCatalog` does NOT wipe `user`/`roles`/`user_roles`/`_schema_applied`/`_builder_idempotency` — use UNIQUE emails per test, and `beforeEach` drops `_builder_idempotency` + `_schema_applied`.
- **Privileged cookie: do NOT rely on first-admin bootstrap (review medium fix).** Because emails are unique per test and the bootstrap auto-promotion fired only on the very FIRST signUp against the db, a later unique-email signUp gets ZERO perms. EVERY privileged test must EXPLICITLY `await grantRole(userIdOf(adminEmail), 'super-admin')` after signing up its admin email, then use that cookie for the 200-path PUT/DELETE/reload. Only `super-admin` carries `builder.manage` (0001_init cross-joins every permission to super-admin); `editor`/`viewer` get none → 403. Add a harness/setup ASSERTION that the privileged cookie actually resolves `builder.manage` (e.g. a probe PUT/DELETE returns NOT 401/403) before a suite proceeds, so a missing grant fails loudly rather than as a confusing 403.

---

## 9. Full S6 TEST LIST (real PG via `createFileDatabase`, all over `fetch`, NO mocks)

New file `packages/api/test/builder-concurrency.e2e.test.ts` using `startTestServerFromFilesWithAuth`. Header-aware fetch helpers: `put(apiId, body, {cookie, 'If-Match', 'Idempotency-Key'})`, `del(...)`, `versionOf(apiId)` = `(await fetch(GET, {cookie})).headers.get('etag')`. `beforeEach`: `cleanCatalog(sql)` + drop `_schema_applied` + drop `_builder_idempotency` + `rm(genDir,{recursive,force})` + reopen server. Each privileged test signs up a UNIQUE admin email and `grantRole(userIdOf(email),'super-admin')` (per §8).

**#12 — auth 401/403/public:** Harness up. No-cookie `PUT`/`DELETE`/`POST preview`/`POST reload` → **401**. Sign up a SECOND user (unique email), `grantRole(userIdOf(email),'editor')`, use its cookie on `PUT`/`DELETE`/`preview`/`reload` → **403**. `GET /builder/content-types` and `/:apiId` with no cookie → **200** (public). Asserts each status.

**#14 — single-writer mutex:** Seed `gadget` via PUT (super-admin cookie), capture V. Drive `Promise.allSettled([put('gadget', bodyA, {cookie,'If-Match':V}), put('gadget', bodyB, {cookie,'If-Match':V})])` (NO idempotency key). Assert exactly ONE `status===200` and ONE `status===409` with `Retry-After` set. (Busy-check+set is the first sync statements, zero awaits between → deterministic for BOTH keyless and keyed now.) Optional in-process variant: two `srv.applyEdit(draft)` → one resolves, one throws `BuilderBusyError`.

**#15 — stale If-Match → 412:** Seed `gadget`, `GET` → V1. `PUT gadget {If-Match:V1, ...changeA}` → **200**, read new `version`/ETag → V2. Second `PUT gadget {If-Match:V1, ...changeB}` → **412**, assert body `currentVersion === V2`.

**#16 — missing precondition → 428:** `PUT gadget` (no If-Match, no `body.version`) → **428**; `DELETE gadget {allowDestructive:true}` (no If-Match, no body.version) → **428**.

**#17 — idempotency replay (incl no-op, HIGH-1):** Seed `gadget`, `GET` → V. `PUT gadget {If-Match:V, Idempotency-Key:'K', fields:[...new field...]}` → **200**, capture envelope incl `version`, `schema.id`, each `schema.fields[].id`. Second identical `PUT` same `K` (now-current If-Match) → byte-identical `response` body, SAME ids (not re-minted), SAME stored `version`. Assert `SELECT count(*),max(applied_at) FROM _schema_applied` unchanged between the two. **NEW (HIGH-1) keyed-no-op:** `PUT gadget {If-Match:<current>, Idempotency-Key:'KN', <schema already applied, diffs to empty>}` → **200** with `applied:[]`; same-key `KN` replay → byte-identical 200 WITHOUT re-applying (proves the adapter-side reconcile records the no-op row). Different body + same `K` → **422** (key reused). Terminal-4xx replay: enum control-char PUT with `K2` → **422**; retry `K2` → same **422** (persisted via `persistTerminalIdem`). Transient not stored: trigger 409-busy with a key, then a later same-key request is processed FRESH.

**#18 — re-mint guard (no key):** id-less retry (`fields[]` without ids) against an existing `gadget` WITHOUT an Idempotency-Key → **422** (the `resolveSchema` ownership guard). Setup: seed `gadget` with field `title`; PUT a body re-sending `title` WITHOUT its id → 422.

**#19 — lock_timeout → 409 bounded:** Open a SECOND independent `postgres(db.url)` handle `h2`; `h2.begin(async tx => { await tx\`SELECT pg_advisory_xact_lock(${0x5c_3e_a9_01})\`; await held; })` (the EXACT `MIGRATE_LOCK_KEY`). While held, fire `PUT gadget {If-Match:V,...}`; measure wall-clock; assert **409** (`Retry-After` set) within **`< 6s`** (3×1500ms lock waits + ~175ms backoff + per-attempt pre-tx work ≈ ~4.7s floor; bound widened to 6s for flake-resistance). Release the held lock in `finally`.

**#20 — version recompute on reload (on-disk source; reorder-invariant hash):** Apply an edit (V→V2), `GET` → V2. Write an out-of-band change to `entities/gadget/schema.ts` that is **IR-visible but NON-migratable** so `_schema_applied` stays byte-identical yet the canonical hash bumps — e.g. add a `description`/`options` key (or a field attribute) that `defToSchema` carries into the IR but `diff()` does NOT classify as a migratable `Change`. (Do NOT use a pure field REORDER — canonicalize is reorder-invariant by design, §1, so a reorder yields the SAME hash and the test premise would fail.) Pre-step: VERIFY such an IR-visible-but-non-migratable attribute exists by checking `defToSchema` carries it AND `diff` ignores it; if NO such attribute exists, redesign #20 to assert reload recomputes the SAME version and demonstrate the 412 path via a normal applied edit instead. Then `POST /builder/reload` (cookie) → **200** with `version` V3 ≠ V2. `GET` → V3. `PUT gadget {If-Match:V2,...}` after reload → **412**. (Also guards HIGH-2: a replay of an earlier key after this reload returns its OWN stored version, not V3.)

**#21 — GET ETag / 304 (bodyless):** `GET /builder/content-types` → `ETag: V`. Repeat with `If-None-Match: V` → **304** with an EMPTY body (zero bytes — asserts the bodyless-304 fix). After a successful `PUT`, `GET` with `If-None-Match: V_old` → **200** with the new version + new ETag.

**#22 — read hot path unchanged:** A normal content read `GET /gadget` returns a response with NO `ETag`/extra builder headers (byte-identical to pre-S6) — guards the `headers?` addition.

---

## Risks & mitigations (folded medium/low)

- **Version TOCTOU on lazy GET init (medium):** mitigated by EAGER boot init of `currentVersion` (§1/§2) so GETs never compute under a concurrent apply; the lazy guard remains only as a near-never-hit fallback. The cache-busted dir-walk additionally tolerates ENOENT mid-walk (skip vanished entries) so a GET racing a DELETE's `rm` cannot throw (§1).
- **Keyed-writer mutex non-determinism (medium):** mitigated by moving the `writerBusy` check+set to the first synchronous statements of the IIFE with zero awaits before the set, and moving `pruneIdempotency` to AFTER acquisition (§2) — both keyless and keyed concurrent writers now serialize.
- **55P03 retry wall-clock under load (medium):** per-attempt pre-tx work (`ensureAppliedTable`/`readAppliedSchemas`/`diff`) makes 3 attempts exceed 5s under load; mitigated by widening test #19's bound to `< 6s` and documenting the floor math (§5/§9). Optional future hoist of the ensures out of the retried call.
- **First-admin bootstrap vs per-test unique emails (medium):** mitigated by always explicitly granting `super-admin` to each privileged test's admin email and adding a setup assertion that the privileged cookie resolves `builder.manage` (§8).
- **Reload cache-busting incompleteness (low):** mitigated by a full `loadTypesCacheBusted` (BOTH schema.ts and hooks.ts get `?v=token`), not the schema-only walk (§7). `swapFromIR([])` behavior verified: swaps registry+hooks+relations, intentionally rebuilds no per-type storage (no DDL on reload) — documented.
- **Mutex release on client abort (low):** no leak — `finally` runs on abort; the 409-busy loser never enters the `try` (§5). Marked with a comment to prevent regression.
- **304 body non-compliance (low):** mitigated by a dedicated bodyless-304 path in `writeResponse`/`corkSend` (§6).
- **Idempotency crash window (accepted):** persisting the keyed success row from the adapter (post-recompute) rather than inside the migrate tx opens a crash window where the apply committed but the idem row did not; a same-key replay then re-applies → diffs to a no-op → byte-identical, benign. Documented trade chosen for correctness across no-op and reload (§2/§4).

---

## Ordered, checkable step list

- [ ] **S6-1** Create `packages/api/src/compose/catalog-version.ts`: `computeCatalogVersion(entitiesDir)` (cache-busted schema-only import, ENOENT-tolerant walk → reorder-invariant value-sensitive canonical IR → sha256) + `canonicalizeForHash`. Local cache-busted dir-walk (do NOT change `loadTypes` boot semantics).
- [ ] **S6-2** Declare `let currentVersion = ''` per-server inside `uws.adapter.ts:904` block; EAGER init right after construction (lazy guard kept as fallback). Recompute INSIDE the mutex post-apply (skip no-op) and in the reload primitive. Extend `okEnvelope` (`:927`) to take `version` and emit it in the 200 body + `ETag`.
- [ ] **S6-3** Declare `let writerBusy = false` per-server (`:904` block). Factor `runEdit`/`runDelete` (closure bodies minus guard, no `idem` threading); guard `applyEditFn` (programmatic, throws `BuilderBusyError`) around `runEdit`. HTTP PUT/DELETE: busy-check+set as the FIRST sync statements of the IIFE (zero awaits before set), call `runEdit`/`runDelete` inside, release in `finally`; 409+`Retry-After` on contention. Add `BuilderBusyError` (plain class) in `builder.ts`.
- [ ] **S6-4** Capture `if-match`/`idempotency-key` SYNC at the top of PUT (`:986`) and DELETE (`:1003`), before `gate`. Add 428 (no If-Match AND no `body.version`) after parseBody (pre-mutex, terminal). Inside the mutex: defensive version init, 412 `{currentVersion}` on mismatch (+ETag). Keep DELETE's `allowDestructive!==true` → 409 before the mutex. Move `pruneIdempotency` to AFTER mutex acquire.
- [ ] **S6-5** `ensureIdempotencyTable` in `migrate.ts` (after `:278`), ensured once at boot. Idempotency persistence is ADAPTER-SIDE (NOT in the migrate tx — HIGH-1/HIGH-2): `idempotencyLookup`/replay inside the mutex (replay returns the STORED envelope's own `version`); `reconcileIdemRow` writes the COMPLETE final envelope (correct version) after the post-apply recompute, covering migrating AND no-op applies; `persistTerminalIdem` writes terminal-4xx (422/409-requires-destructive) in its own short tx; never persist transient 409-busy/409-lock/412/428; TTL prune OUTSIDE the apply (after mutex acquire), only when keyed. `migrate`/`applyChangeSet`/`reconcileApplied` signatures UNCHANGED (no `idem` threading).
- [ ] **S6-6** `migrate.ts:374` `'5s'`→`'1500ms'`. Replace `applyResolvedPlan`'s try/catch (`builder.ts:178-185`) with the 3-attempt 55P03-only retry (keep `tmp` across attempts, single final unlink) throwing `SchemaChangeConflictError`. Import `SchemaChangeConflictError` into `builder.ts` AND `uws.adapter.ts`; map it → 409+`Retry-After` in `builderError`.
- [ ] **S6-7** Convert GET collection (`:935`) to `(res, req)` + read `if-none-match`; add bodyless-304 (zero-length body + ETag), ETag, and `version` to both GETs (`:935`, `:949`). Add the bodyless-304 path to `writeResponse`/`corkSend`.
- [ ] **S6-8** Add `POST /builder/reload` (gated, same mutex with busy-check-first, FULLY cache-busted `loadTypesCacheBusted` for schema AND hooks, `swapFromIR(...,[],...)`, NO migrate, recompute `currentVersion`). Document that reload swaps registry+hooks+relations but rebuilds no per-type storage.
- [ ] **S6-9** Lift `signUp`/`userIdOf`/`grantRole` into `helpers.ts` via `startTestServerFromFilesWithAuth` (auth-stack construction order; teardown `sessionCache.stop()` + `closeAuth()`). Privileged tests explicitly `grantRole(..., 'super-admin')`; add a setup assertion that the privileged cookie resolves `builder.manage`.
- [ ] **S6-10** Write `builder-concurrency.e2e.test.ts` (tests #12, #14–#22, incl the keyed-no-op replay and the IR-visible-but-non-migratable #20 attribute, with the #20 pre-step verification); `beforeEach` drops `_schema_applied` + `_builder_idempotency` + `rm(genDir)`; unique emails per test; test #19 bound `< 6s`; make green.

**Files touched:** `packages/api/src/compose/catalog-version.ts` (new), `packages/api/src/compose/builder.ts` (retry loop, `BuilderBusyError`, `SchemaChangeConflictError` import), `packages/api/src/db/schema/migrate.ts` (lock_timeout, `ensureIdempotencyTable` — NO signature changes), `packages/api/src/http/uws.adapter.ts` (mutex, eager version cache, headers/412/428/409/bodyless-304, reload, `okEnvelope`, `builderError`, adapter-side idempotency reconcile/lookup/terminal-persist, `loadTypesCacheBusted`), `packages/api/test/helpers.ts` (auth harness lift), `packages/api/test/builder-concurrency.e2e.test.ts` (new). Invariants honored: `erasableSyntaxOnly` (plain error classes, no enums/param-props), `exactOptionalPropertyTypes` (idem/version/headers set only when present), single-instance (boolean mutex, opportunistic TTL, no Redis), byte-identical reads (data-read path sets no headers; version is on-disk metadata only).
