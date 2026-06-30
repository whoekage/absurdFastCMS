import type uWS from 'uWebSockets.js';
import type { Sql } from 'postgres';
import { HookRegistry } from '../db/schema/hooks.ts';
import { applySchemaEdit, applySchemaDelete, BuilderBusyError, type ModuleDraft, type SchemaEditResult } from '../compose/builder.ts';
import { swapFromIR } from '../db/engine.swap.ts';
import { loadTypes, loadTypesCacheBusted } from '../db/schema/load.ts';
import type { ComponentSchema } from '../db/schema/model.ts';
import { readAppliedSchemas, ensureAppliedTable } from '../db/schema/migrate.ts';
import { SchemaChangeConflictError } from '../db/ddl.ts';
import type { Locale } from '../errors/index.ts';
import { computeCatalogVersion } from '../compose/catalog-version.ts';
import { ensureIdempotencyTable, idempotencyLookup, recordIdempotency, pruneIdempotency } from '../compose/builder-idempotency.ts';
import { corkSend, builderJson, builderErrorFields, builderError } from './responders.ts';
import type { LiveCell } from './context.ts';

/** The precondition bundle every builder mutation carries (If-Match / body version / idempotency key). */
interface MutationPre {
  ifMatch: string;
  bodyVersion: string | undefined;
  idemKey: string;
  requestHash: string;
}

/**
 * The schema-write CORE — the single owner of the per-server `currentVersion` (sha256 catalog version) +
 * `writerBusy` (single-writer mutex) cell. They stay ordinary closure `let`s here (NEVER module-scope: two
 * test servers must not share), so the builder route module mutates them ONLY by calling these methods —
 * it never sees the raw bindings. `version()` reads the LIVE value (the builder GET routes read it at the
 * exact same points as the old inline code, preserving the read-after-await semantics byte-for-byte).
 */
export interface ApplyCore {
  /** Lazily compute the catalog version if unset; returns the current value. */
  ensureVersion(): Promise<string>;
  /** Read the live `currentVersion` (after an ensureVersion / a mutation bump). */
  version(): string;
  /** Read the applied catalog, tolerating a not-yet-created `_schema_applied`. */
  readApplied(): Promise<Awaited<ReturnType<typeof readAppliedSchemas>>>;
  /** Apply a module CREATE/UPDATE/RENAME (file + migrate) and swap; the caller holds the mutex. */
  runEdit(draft: ModuleDraft, opts?: { allowDestructive?: boolean }): Promise<SchemaEditResult>;
  /** Drop a module (file + migrate) and swap; the caller holds the mutex. */
  runDelete(name: string): Promise<SchemaEditResult>;
  /** Cache-busted re-import + swap (registry/hooks/relations/components), NO migrate. */
  reloadFromDisk(): Promise<void>;
  /** The shared PUT/DELETE module flow: mutex → idempotency replay → version precheck → exec → bump. */
  runMutation(res: uWS.HttpResponse, aborted: () => boolean, pre: MutationPre, exec: () => Promise<SchemaEditResult>, locale: Locale): void;
  /** The migrate-free component analog of {@link runMutation}. */
  runComponentMutation(res: uWS.HttpResponse, aborted: () => boolean, pre: MutationPre, exec: () => Promise<{ component?: ComponentSchema }>, locale: Locale): void;
  /** POST /builder/reload: mutex → reloadFromDisk → version bump → envelope. */
  runReload(res: uWS.HttpResponse, aborted: () => boolean, locale: Locale): void;
  /** Programmatic entry (srv.applyEdit): serialize via the SAME mutex; a contended call THROWS. */
  applyEdit(draft: ModuleDraft, opts?: { allowDestructive?: boolean }): Promise<SchemaEditResult>;
}

/** Build the schema-write core over the live cell + the PG handle + the modules dir. */
export function createApplyCore(opts: { live: LiveCell; sql: Sql; dir: string }): ApplyCore {
  const { live, sql, dir } = opts;

  // S6 per-server state: the on-disk catalog version (sha256) + the single-writer mutex flag. Warm both
  // best-effort lazily; a defensive recompute covers a request that races the warm.
  let currentVersion = '';
  let writerBusy = false;
  // Ensure the on-demand bookkeeping tables EXACTLY ONCE per server (memoized) — never a fire-and-forget
  // warm: a `CREATE TABLE IF NOT EXISTS` racing a concurrent one trips pg_type's unique index. Memoizing
  // collapses concurrent first-callers onto one promise; the ensure helpers also swallow the race defensively.
  let tablesReady: Promise<void> | undefined;
  const ensureTables = (): Promise<void> =>
    (tablesReady ??= (async () => { await ensureAppliedTable(sql); await ensureIdempotencyTable(sql); })());
  const ensureVersion = async (): Promise<string> => {
    if (currentVersion === '') currentVersion = await computeCatalogVersion(dir);
    return currentVersion;
  };
  // Read the applied catalog, tolerating a not-yet-created _schema_applied (a GET before any apply).
  const readApplied = async (): Promise<Awaited<ReturnType<typeof readAppliedSchemas>>> => {
    await ensureTables();
    return readAppliedSchemas(sql);
  };

  // The apply core (no mutex — the caller holds it). Re-loads hooks (a NEW type's hooks.ts is merged;
  // ESM-cache invariant: an existing type's cached hooks.ts is correct; an out-of-band hooks.ts edit needs
  // a restart), then swaps. A blocked / no-op result returns without swapping.
  const swapAfter = async (result: SchemaEditResult): Promise<SchemaEditResult> => {
    if (!result.ok || result.next === undefined || (result.applied?.length ?? 0) === 0) return result;
    // Re-load hooks AND component definitions so the rebuilt registry keeps both — without the components a
    // module that uses one would lose its component field on the swap. (A project with none passes [].)
    const { hooks: nextHooks, components: nextComponents } = await loadTypes(dir);
    await swapFromIR(sql, live, result.next, result.applied!, new HookRegistry(nextHooks), nextComponents);
    return result;
  };
  const runEdit = async (draft: ModuleDraft, opts2?: { allowDestructive?: boolean }): Promise<SchemaEditResult> =>
    swapAfter(await applySchemaEdit(sql, dir, draft, opts2 ?? {}));
  const runDelete = async (name: string): Promise<SchemaEditResult> => swapAfter(await applySchemaDelete(sql, dir, name));

  // Re-import the catalog (cache-busted) and swap the live registry/hooks/relations/components from disk —
  // NO migrate. Shared by POST /builder/reload and the component routes (a component edit changes no table,
  // so its only effect is a registry rebuild that picks up the new/edited/removed component file).
  const reloadFromDisk = async (): Promise<void> => {
    const { schemas, hooks, components } = await loadTypesCacheBusted(dir, `reload:${process.pid}:${Date.now()}`);
    await swapFromIR(sql, live, schemas, [], new HookRegistry(hooks), components);
  };

  // Programmatic entry (srv.applyEdit): serialize via the SAME mutex; a contended call THROWS (it cannot
  // return a CoreResponse). The HTTP path calls runEdit DIRECTLY from inside its own held mutex (no double-acquire).
  const applyEdit = async (draft: ModuleDraft, opts2?: { allowDestructive?: boolean }): Promise<SchemaEditResult> => {
    if (writerBusy) throw new BuilderBusyError('builder busy');
    writerBusy = true;
    try { return await runEdit(draft, opts2); } finally { writerBusy = false; }
  };

  // The success envelope FIELDS (also the stored idempotency body). `applied`/`blocked` always present.
  const successFields = (r: SchemaEditResult): Record<string, unknown> =>
    ({ ok: true, version: currentVersion, applied: r.applied ?? [], blocked: [], live: true, ...(r.schema !== undefined ? { schema: r.schema } : {}) });

  // The shared mutating flow (PUT/DELETE): acquire-FIRST (zero awaits before set) → version precheck →
  // idempotency lookup/replay → exec → recompute version → record idempotency → envelope. Release in finally.
  const runMutation = (
    res: uWS.HttpResponse, aborted: () => boolean,
    pre: MutationPre,
    exec: () => Promise<SchemaEditResult>,
    locale: Locale,
  ): void => {
    void (async () => {
      if (writerBusy) return corkSend(res, aborted, builderJson(409, { ok: false, error: 'builder busy' }, { 'Retry-After': '1' }));
      writerBusy = true;
      try {
        await ensureTables();
        // Idempotency replay FIRST (before the version precheck): a lost-response retry resends the
        // ORIGINAL If-Match, so checking the version first would 412 a request whose result we already have.
        // A keyed replay is unconditional — it returns the stored outcome regardless of the current version.
        if (pre.idemKey !== '') {
          await pruneIdempotency(sql).catch(() => {});
          const hit = await idempotencyLookup(sql, pre.idemKey);
          if (hit !== undefined) {
            if (hit.requestHash !== pre.requestHash) return corkSend(res, aborted, builderJson(422, { ok: false, error: 'idempotency key reused for a different request' }));
            const etag = hit.status === 200 ? { ETag: String((hit.response as { version?: string }).version ?? '') } : undefined;
            return corkSend(res, aborted, builderJson(hit.status, hit.response, etag));
          }
        }
        await ensureVersion();
        const expected = pre.ifMatch !== '' ? pre.ifMatch : pre.bodyVersion;
        if (expected !== currentVersion) return corkSend(res, aborted, builderJson(412, { ok: false, error: 'stale version', currentVersion }, { ETag: currentVersion }));
        let r: SchemaEditResult;
        try {
          r = await exec();
        } catch (e) {
          if (pre.idemKey !== '') {
            const { status, fields } = builderErrorFields(e, locale);
            if (status >= 400 && status < 500 && !(e instanceof SchemaChangeConflictError)) await recordIdempotency(sql, pre.idemKey, pre.requestHash, status, fields).catch(() => {});
          }
          throw e;
        }
        if (!r.ok) { // blocked: requires allowDestructive (deterministic terminal → 409, idempotent)
          const fields = { ok: false, applied: [], blocked: r.blocked ?? [], error: 'requires allowDestructive' };
          if (pre.idemKey !== '') await recordIdempotency(sql, pre.idemKey, pre.requestHash, 409, fields).catch(() => {});
          return corkSend(res, aborted, builderJson(409, fields));
        }
        if ((r.applied?.length ?? 0) > 0) currentVersion = await computeCatalogVersion(dir); // skip on no-op
        const fields = successFields(r);
        if (pre.idemKey !== '') await recordIdempotency(sql, pre.idemKey, pre.requestHash, 200, fields).catch(() => {});
        corkSend(res, aborted, builderJson(200, fields, { ETag: currentVersion }));
      } catch (e) {
        corkSend(res, aborted, builderError(e, locale)); // SchemaChangeConflictError → 409+Retry-After
      } finally {
        writerBusy = false; // runs on EVERY path incl client abort; the 409-busy loser never entered this try
      }
    })();
  };

  // The component-edit concurrency wrapper — mirrors runMutation (busy mutex, idempotency replay, If-Match
  // version precheck, version bump) but for the migrate-free component path: exec resolves+writes the
  // component file and swaps the registry, then the catalog version advances (a component edit always
  // changes the catalog). Success carries the resolved component + the new version.
  const runComponentMutation = (
    res: uWS.HttpResponse,
    aborted: () => boolean,
    pre: MutationPre,
    exec: () => Promise<{ component?: ComponentSchema }>,
    locale: Locale,
  ): void => {
    void (async () => {
      if (writerBusy) return corkSend(res, aborted, builderJson(409, { ok: false, error: 'builder busy' }, { 'Retry-After': '1' }));
      writerBusy = true;
      try {
        await ensureTables();
        if (pre.idemKey !== '') {
          await pruneIdempotency(sql).catch(() => {});
          const hit = await idempotencyLookup(sql, pre.idemKey);
          if (hit !== undefined) {
            if (hit.requestHash !== pre.requestHash) return corkSend(res, aborted, builderJson(422, { ok: false, error: 'idempotency key reused for a different request' }));
            const etag = hit.status === 200 ? { ETag: String((hit.response as { version?: string }).version ?? '') } : undefined;
            return corkSend(res, aborted, builderJson(hit.status, hit.response, etag));
          }
        }
        await ensureVersion();
        const expected = pre.ifMatch !== '' ? pre.ifMatch : pre.bodyVersion;
        if (expected !== currentVersion) return corkSend(res, aborted, builderJson(412, { ok: false, error: 'stale version', currentVersion }, { ETag: currentVersion }));
        let r: { component?: ComponentSchema };
        try {
          r = await exec();
        } catch (e) {
          if (pre.idemKey !== '') {
            const { status, fields } = builderErrorFields(e, locale);
            if (status >= 400 && status < 500 && !(e instanceof SchemaChangeConflictError)) await recordIdempotency(sql, pre.idemKey, pre.requestHash, status, fields).catch(() => {});
          }
          throw e;
        }
        currentVersion = await computeCatalogVersion(dir);
        const fields = { ok: true as const, ...(r.component !== undefined ? { component: r.component } : {}), version: currentVersion };
        if (pre.idemKey !== '') await recordIdempotency(sql, pre.idemKey, pre.requestHash, 200, fields).catch(() => {});
        corkSend(res, aborted, builderJson(200, fields, { ETag: currentVersion }));
      } catch (e) {
        corkSend(res, aborted, builderError(e, locale));
      } finally {
        writerBusy = false;
      }
    })();
  };

  // POST reload — operator escape hatch: cache-busted re-import + swap (registry/hooks/relations), NO
  // migrate; advances the version so a pre-reload PUT carrying the old version fails 412. Mutex-serialized.
  const runReload = (res: uWS.HttpResponse, aborted: () => boolean, locale: Locale): void => {
    void (async () => {
      if (writerBusy) return corkSend(res, aborted, builderJson(409, { ok: false, error: 'builder busy' }, { 'Retry-After': '1' }));
      writerBusy = true;
      try {
        await reloadFromDisk(); // applied=[] → swaps registry/hooks/relations/components, no per-type rebuild
        currentVersion = await computeCatalogVersion(dir);
        corkSend(res, aborted, builderJson(200, { ok: true, version: currentVersion }, { ETag: currentVersion }));
      } catch (e) { corkSend(res, aborted, builderError(e, locale)); }
      finally { writerBusy = false; }
    })();
  };

  return {
    ensureVersion,
    version: () => currentVersion,
    readApplied,
    runEdit,
    runDelete,
    reloadFromDisk,
    runMutation,
    runComponentMutation,
    runReload,
    applyEdit,
  };
}
