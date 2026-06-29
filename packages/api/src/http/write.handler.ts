import type { Sql, TransactionSql } from 'postgres';
import type { Engine } from '../store/engine.ts';
import type { Registry, ModuleDef, ComponentDef } from '../db/registry.ts';
import { validateBody, BodyParseError } from '../db/body.parser.ts';
import { insertEntry, updateEntry, deleteEntry, publishEntry, unpublishEntry, readSiblingForVariant, serializeEntry, missingEntryIds, EntryWriteError } from '../db/entry.repository.ts';
import { applyRelationOps } from '../db/relation.repository.ts';
import { missingFileIds } from '../db/file.repository.ts';
import { RawJson } from '../store/column.ts';
import { validateLocale, QueryParseError } from '../store/query.parser.ts';
import { config } from '../config.ts';
import { HookError, type HookRegistry } from '../db/schema/hooks.ts';
import { CANONICAL_INT, JSON_CT, errorResponse, appErrorResponse, type CoreResponse } from './read.router.ts';
import type { Locale } from '../errors/index.ts';

/**
 * The Postgres int4 serial PK range upper bound. CANONICAL_INT accepts arbitrarily long digit runs, so
 * an id above this (or beyond a safe JS integer) can never name an existing row — it is uniformly a 404,
 * resolved BEFORE any SQL, so a caller can't distinguish "out of int4 range" (would be a 22003 -> 400)
 * from "id not present" (404).
 */
const MAX_INT4 = 2147483647;

/** Parse the `:id` path segment to an in-range int4, or `null` (treated as a 404 — no such row). */
function parseId(idRaw: string): number | null {
  if (!CANONICAL_INT.test(idRaw)) return null;
  const id = Number(idRaw);
  if (!Number.isSafeInteger(id) || id > MAX_INT4) return null;
  return id;
}

/**
 * The WRITE core — the async counterpart to the pure read {@link handleRequest}. Postgres is the
 * source of truth, so each verb: validates the body against the type's REGISTRY def, commits ONE
 * Postgres statement, then asks the caller to {@link WriteContext.rebuild} ONLY this type's RAM storage
 * (per-type rebuild + per-type cache invalidation — sibling types stay hot) so subsequent reads reflect
 * the write.
 *
 *   POST   /:type      -> 201 { data }   (create; body validated as a full create)
 *   PUT    /:type/:id  -> 200 { data }   (partial update, Strapi semantics; 404 if no such id)
 *   DELETE /:type/:id  -> 200 { data }   (returns the deleted row; 404 if no such id)
 *
 * Errors mirror the read core: {@link BodyParseError}/{@link EntryWriteError} -> 400, unknown type /
 * unknown id -> 404, a non-validation throw propagates (the server maps it to 500). No SQL/constraint
 * detail is ever echoed.
 */
export interface WriteContext {
  /** The CURRENT engine (read live each call — its per-type storage is swapped by {@link rebuild}). */
  engine(): Engine;
  /** The runtime registry (resolves the validated def for `:type`). */
  registry(): Registry;
  /** The postgres.js handle (source of truth) for the write statement. */
  sql: Sql;
  /** Refresh + rebuild ONLY this type's RAM storage from Postgres after a committed write. */
  rebuild(type: string): Promise<void>;
  /**
   * The publish-time clock. Production returns `new Date()`; tests inject a FIXED Date so a published_at
   * fixture is byte-deterministic (the publish timestamp is caller-supplied, NOT a SQL `now()`).
   */
  publishClock(): Date;
  /**
   * Content lifecycle hooks. `before*` run INSIDE the write tx (transform/veto → rollback); `after*` run
   * AFTER {@link rebuild} (post-commit side-effects). Read via a LIVE getter in the server (S4) so a
   * schema-edit swap installing a new type's hooks.ts is seen immediately. ALWAYS present now (the server
   * always wires a HookRegistry — possibly empty, whose runBefore/runAfter are no-ops).
   */
  hooks: HookRegistry;
}

export interface WriteRequest {
  method: string;
  type: string;
  /** The `:id` path segment for PUT/DELETE/publish (empty for a plain POST create). */
  idRaw: string;
  /** The parsed JSON body (`undefined` when the request carried no body). */
  body: unknown;
  /**
   * Draft & Publish action sub-route (`POST /:type/:id/actions/:action`): `publish`/`unpublish` when on
   * that route, otherwise undefined (a plain create/update/delete). The server validates the literal
   * token before setting this; an unknown token never reaches here.
   */
  action?: 'publish' | 'unpublish';
  /**
   * i18n VARIANT-CREATE sub-route (`POST /:type/:id/locales/:locale`): the target locale slug when on that
   * route (the `:id` addresses an existing sibling row whose document the new variant joins), otherwise
   * undefined. The server passes the RAW slug; this handler validates its shape (a malformed slug -> 400).
   */
  variantLocale?: string;
  /**
   * The resolved UI {@link Locale} for error-message localization (from `Accept-Language` at the transport
   * edge) — DISTINCT from {@link variantLocale} (a data-locale slug). Absent → `'en'` (byte-identical).
   */
  locale?: Locale;
}

/**
 * be-04 MEDIA — assert every `files.id` a write body references actually exists, INSIDE the caller's tx
 * (so the existence check + the row insert/update commit atomically). The body parser already validated
 * shape + cardinality + positive-int4; here we gather the referenced ids from the COERCED `data` (single
 * media field => a number value; multiple => a number[] value) and reject (a 400 via EntryWriteError) any
 * id that names no asset. No-op when the type declares no media field, or none were supplied (no query).
 *
 * i18n NOTE: on a variant-create the SHARED copies come from {@link readSiblingForVariant}, which wraps
 * every jsonb column (so a MULTIPLE media field) in a {@link RawJson} whose `.raw` is the verbatim JSON
 * text (e.g. `[1,2,3]`). That class is NOT iterable, so we unwrap+parse it back to a `number[]` here
 * (those ids were already validated at the sibling's own create; re-checking them is cheap + correct).
 */
async function assertMediaRefsExist(tx: Sql | TransactionSql, def: ModuleDef, data: Record<string, unknown>, registry: Registry): Promise<void> {
  if (def.mediaFields.size === 0 && def.componentFields.size === 0) return;
  const ids: number[] = [];
  for (const [name, { multiple }] of def.mediaFields) {
    const v = data[name];
    if (v === undefined || v === null) continue; // not in this write, or explicitly cleared.
    if (multiple) {
      // A freshly-supplied overlay is a coerced number[]; a shared sibling copy is a RawJson(`[…]`).
      const arr = v instanceof RawJson ? (JSON.parse(v.raw) as number[]) : (v as number[]);
      for (const id of arr) ids.push(id);
    } else {
      ids.push(v as number);
    }
  }
  // be-05 COMPONENT: walk the coerced component / dynamiczone trees for INLINE media id refs. The body
  // parser already produced a plain JS tree (component arrays/objects) whose inline media values are a
  // number / number[] (validated positive-int4), guided by the nested {@link ComponentDef} schemas — so
  // the existence check is the SAME `files` lookup as a top-level media field, just gathered recursively.
  for (const [name, cmeta] of def.componentFields) {
    const v = data[name];
    if (v === undefined || v === null) continue;
    // A shared-sibling copy of a component column is a RawJson(verbatim text); parse it back to walk it.
    const tree = v instanceof RawJson ? JSON.parse(v.raw) : v;
    collectComponentMediaIds(registry, cmeta, tree, ids);
  }
  if (ids.length === 0) return;
  const missing = await missingFileIds(tx, ids);
  if (missing.length > 0) {
    throw new EntryWriteError(`media reference to unknown file id(s): ${missing.join(', ')}`);
  }
}

/**
 * be-05 COMPONENT — recursively gather every INLINE media `files.id` referenced inside a coerced component
 * / component-repeatable / dynamiczone value, guided by the registry's {@link ComponentDef} schemas. Mirrors
 * the read-side populate walk's collect step: for a single component recurse into the named component; for a
 * repeatable recurse each entry; for a dynamiczone pick the schema per block's `__component`. A null/absent
 * branch contributes nothing. Defensive against a non-conforming shape (a coerced tree is well-formed; a
 * shared-sibling RawJson re-parse is canonical) — anything unexpected is simply skipped (the body parser
 * already rejected an invalid write; this is the existence gate, not a re-validation).
 */
function collectComponentMediaIds(
  registry: Registry,
  meta: { kind: string; component?: string; components?: readonly string[] },
  value: unknown,
  into: number[],
): void {
  if (value === null || value === undefined) return;
  if (meta.kind === 'component') {
    if (meta.component !== undefined) collectInstanceMediaIds(registry, meta.component, value, into);
  } else if (meta.kind === 'component-repeatable') {
    if (Array.isArray(value) && meta.component !== undefined) {
      for (const entry of value) collectInstanceMediaIds(registry, meta.component, entry, into);
    }
  } else if (meta.kind === 'dynamiczone') {
    if (Array.isArray(value)) {
      for (const block of value) {
        if (typeof block === 'object' && block !== null && typeof (block as Record<string, unknown>)['__component'] === 'string') {
          collectInstanceMediaIds(registry, (block as Record<string, unknown>)['__component'] as string, block, into);
        }
      }
    }
  }
}

/** Gather inline media ids from ONE component instance object (recursing nested component fields). */
function collectInstanceMediaIds(registry: Registry, name: string, obj: unknown, into: number[]): void {
  if (typeof obj !== 'object' || obj === null) return;
  const cdef: ComponentDef | undefined = registry.getComponent(name);
  if (cdef === undefined) return;
  const o = obj as Record<string, unknown>;
  for (const [fname, { multiple }] of cdef.mediaFields) {
    const v = o[fname];
    if (v === undefined || v === null) continue;
    if (multiple) {
      if (Array.isArray(v)) for (const id of v) if (typeof id === 'number') into.push(id);
    } else if (typeof v === 'number') {
      into.push(v);
    }
  }
  for (const [fname, cmeta] of cdef.componentFields) {
    collectComponentMediaIds(registry, cmeta, o[fname], into);
  }
}

/**
 * be-05b RELATION-INSIDE-COMPONENT — assert every inline relation-ref id a write body references actually
 * exists in its TARGET module, INSIDE the caller's tx (so the existence check + the row insert/update
 * commit atomically). Sibling of {@link assertMediaRefsExist}: the body parser already validated shape +
 * cardinality + positive-int4; here we gather the referenced ids from the COERCED component trees, BINNED
 * BY TARGET name (different relation fields point at different modules), then per-target reject (a
 * 400 via EntryWriteError) any id that names no row. A relation ref can ONLY live inside a component, so the
 * gate is `def.componentFields.size === 0` (a type with no component field is a byte-identical no-op).
 *
 * VISIBILITY NOTE: existence is checked against the WHOLE target table regardless of draft/publish or
 * locale — referential existence is independent of publish state / locale visibility (a write stores the
 * id; the READ path applies default-published + default-locale visibility). This mirrors how a media id is
 * stored regardless of any asset-level state. The variant-create RawJson unwrap is reused identically.
 */
async function assertRelationRefsExist(tx: Sql | TransactionSql, def: ModuleDef, data: Record<string, unknown>, registry: Registry): Promise<void> {
  if (def.componentFields.size === 0) return;
  const byTarget = new Map<string, number[]>();
  for (const [name, cmeta] of def.componentFields) {
    const v = data[name];
    if (v === undefined || v === null) continue;
    const tree = v instanceof RawJson ? JSON.parse(v.raw) : v;
    collectComponentRelationRefs(registry, cmeta, tree, byTarget);
  }
  for (const [target, ids] of byTarget) {
    if (ids.length === 0) continue;
    const targetDef = registry.get(target);
    // A relation target that vanished AFTER the component was defined (no dropContentType guard this slice)
    // -> the write cannot verify the ref, so reject it cleanly rather than store an unverifiable id.
    if (targetDef === undefined) throw new EntryWriteError(`relation reference to unknown module "${target}"`);
    const missing = await missingEntryIds(tx, targetDef, ids);
    if (missing.length > 0) {
      throw new EntryWriteError(`relation reference to unknown ${target} id(s): ${missing.join(', ')}`);
    }
  }
}

/**
 * be-05b — recursively gather every INLINE relation-ref id inside a coerced component / component-repeatable
 * / dynamiczone value, binned BY TARGET module name, guided by the registry's {@link ComponentDef}
 * schemas. Mirrors {@link collectComponentMediaIds} (the same component-tree walk), but reads
 * `cdef.relationRefFields` instead of `cdef.mediaFields` and keys ids by their declared target.
 */
function collectComponentRelationRefs(
  registry: Registry,
  meta: { kind: string; component?: string; components?: readonly string[] },
  value: unknown,
  into: Map<string, number[]>,
): void {
  if (value === null || value === undefined) return;
  if (meta.kind === 'component') {
    if (meta.component !== undefined) collectInstanceRelationRefs(registry, meta.component, value, into);
  } else if (meta.kind === 'component-repeatable') {
    if (Array.isArray(value) && meta.component !== undefined) {
      for (const entry of value) collectInstanceRelationRefs(registry, meta.component, entry, into);
    }
  } else if (meta.kind === 'dynamiczone') {
    if (Array.isArray(value)) {
      for (const block of value) {
        if (typeof block === 'object' && block !== null && typeof (block as Record<string, unknown>)['__component'] === 'string') {
          collectInstanceRelationRefs(registry, (block as Record<string, unknown>)['__component'] as string, block, into);
        }
      }
    }
  }
}

/** Gather inline relation-ref ids (by target) from ONE component instance (recursing nested components). */
function collectInstanceRelationRefs(registry: Registry, name: string, obj: unknown, into: Map<string, number[]>): void {
  if (typeof obj !== 'object' || obj === null) return;
  const cdef: ComponentDef | undefined = registry.getComponent(name);
  if (cdef === undefined) return;
  const o = obj as Record<string, unknown>;
  for (const [fname, { target, multiple }] of cdef.relationRefFields) {
    const v = o[fname];
    if (v === undefined || v === null) continue;
    const bin = into.get(target) ?? [];
    if (multiple) {
      if (Array.isArray(v)) for (const id of v) if (typeof id === 'number') bin.push(id);
    } else if (typeof v === 'number') {
      bin.push(v);
    }
    if (bin.length > 0) into.set(target, bin);
  }
  for (const [fname, cmeta] of cdef.componentFields) {
    collectComponentRelationRefs(registry, cmeta, o[fname], into);
  }
}

/** Build the write response Buffer: `{"data":<serialized row>,"meta":{}}`, byte-consistent with GET. */
function writeOk(status: number, def: ModuleDef, row: Record<string, unknown>): CoreResponse {
  return {
    status,
    contentType: JSON_CT,
    body: Buffer.from(`{"data":${serializeEntry(def, row)},"meta":{}}`, 'utf8'),
  };
}

export async function handleWrite(ctx: WriteContext, req: WriteRequest): Promise<CoreResponse> {
  const { method, type, idRaw, body, action, variantLocale } = req;
  // Registry membership === engine membership (same canonical name). Gate BEFORE any SQL.
  const def = ctx.registry().get(type);
  if (def === undefined || !ctx.engine().has(type)) return errorResponse(404, `unknown module "${type}"`);

  try {
    // i18n VARIANT-CREATE sub-route (POST /:type/:id/locales/:locale). Gated FIRST so it never collides
    // with the plain POST-create branch. Creates a NEW row that joins the addressed sibling's document
    // (reusing its document_id), COPIES every shared field from the sibling, OVERLAYS the request's
    // localized fields, and server-sets `locale`. UNIQUE(document_id, locale) rejects a duplicate locale.
    if (variantLocale !== undefined) {
      if (method !== 'POST') return errorResponse(405, `method ${method} not allowed`);
      if (!def.i18n) return errorResponse(400, 'module does not support i18n');
      const locale = validateLocale(variantLocale); // QueryParseError -> 400 (caught below).
      const id = parseId(idRaw);
      if (id === null) return errorResponse(404, 'not found');
      // Validate the request body in 'update' mode (type-checks + coerces each present field; rejects
      // unknown/system keys) — but a variant whose fields are ALL shared may legitimately carry NO body,
      // so an empty body is allowed here (the 'update' "at least one field" rule does NOT apply to a
      // create). We then re-check that every required LOCALIZED field is present (shared required fields
      // are satisfied by the copy from the sibling).
      const { data, relationOps } = validateBody(def, body ?? {}, 'variant', ctx.registry());
      for (const reqName of def.requiredOnCreate) {
        const f = def.writableByName.get(reqName)!;
        if (f.localized && !(reqName in data)) return errorResponse(400, `missing required field "${reqName}"`);
      }
      const row = await ctx.sql.begin(async (tx) => {
        const sib = await readSiblingForVariant(tx, def, id);
        if (sib === null) return null; // no such sibling row -> 404.
        // Merge: shared fields from the sibling FIRST, then overlay the request's localized fields. The
        // request can only carry localized fields here (a shared key in the body would overwrite the copy
        // for THIS variant only, diverging siblings); reject a shared key to keep S1 consistency intact.
        for (const key of Object.keys(data)) {
          if (!def.writableByName.get(key)!.localized) {
            throw new BodyParseError(`field "${key}" is shared across locales and cannot be set on a variant create`);
          }
        }
        const merged = { ...sib.shared, ...data };
        await assertMediaRefsExist(tx, def, merged, ctx.registry()); // be-04/05: any media id (top-level or inline) must exist.
        await assertRelationRefsExist(tx, def, merged, ctx.registry()); // be-05b: any inline relation-ref id must exist in its target.
        const r = await insertEntry(tx, def, merged, { documentId: sib.documentId, locale });
        // Per §7 relations are PER-VARIANT (link rows key the physical row id), so any relation ops apply
        // to the NEW row only — exactly the same applyRelationOps seam as a plain create.
        await applyRelationOps(tx, def, Number(r['id']), relationOps);
        return r;
      });
      if (row === null) return errorResponse(404, 'not found');
      await ctx.rebuild(type);
      return writeOk(201, def, row);
    }

    // Draft & Publish action sub-route (POST /:type/:id/actions/publish|unpublish). Gated FIRST so it
    // never collides with the plain POST-create branch (a create has no `action`).
    if (action !== undefined) {
      if (method !== 'POST') return errorResponse(405, `method ${method} not allowed`);
      if (!def.draftPublish) return errorResponse(400, 'module does not support draft & publish');
      const id = parseId(idRaw);
      if (id === null) return errorResponse(404, 'not found');
      // ONE statement, wrapped in a tx for symmetry with the other verbs. published_at is set to the
      // caller-supplied clock (deterministic) on publish, NULL on unpublish.
      const row = await ctx.sql.begin((tx) =>
        action === 'publish' ? publishEntry(tx, def, id, ctx.publishClock()) : unpublishEntry(tx, def, id),
      );
      if (row === null) return errorResponse(404, 'not found');
      // Per-type rebuild + per-type cache invalidation (exactly like the other verbs): the publish
      // immediately changes which rows the default status=published list returns.
      await ctx.rebuild(type);
      return writeOk(200, def, row);
    }

    if (method === 'POST') {
      const { data, relationOps } = validateBody(def, body, 'create', ctx.registry());
      // i18n: a plain create starts a NEW document (fresh document_id via nextval) in the DEFAULT_LOCALE
      // — the (NOT NULL) `locale` column is server-set here (the body can't carry it). A new locale of an
      // EXISTING document goes through the variant-create verb above. Non-i18n => opts omitted (unchanged).
      const opts = def.i18n ? { locale: config.defaultLocale } : undefined;
      // ONE tx: INSERT scalars RETURNING id, then apply the relation ops with that id. A FK 23503 on a
      // non-existent related id rolls the WHOLE tx back -> no orphan ct_ row, no partial link write.
      const row = await ctx.sql.begin(async (tx) => {
        // before-hook (transform/veto) INSIDE the tx: a throw rolls the create back. It returns the data to persist.
        const hooked = ctx.hooks ? await ctx.hooks.runBefore(type, 'create', data) : data;
        await assertMediaRefsExist(tx, def, hooked, ctx.registry()); // be-04/05: media id(s) must reference real assets (400 else).
        await assertRelationRefsExist(tx, def, hooked, ctx.registry()); // be-05b: any inline relation-ref id must exist in its target.
        const r = await insertEntry(tx, def, hooked, opts);
        await applyRelationOps(tx, def, Number(r['id']), relationOps);
        return r;
      });
      await ctx.rebuild(type); // AFTER commit: re-derive the CSR so reads (both directions) reflect the edges.
      if (ctx.hooks) await ctx.hooks.runAfter(type, 'create', row); // post-commit side-effects (isolated)
      return writeOk(201, def, row);
    }

    if (method === 'PUT') {
      const id = parseId(idRaw);
      if (id === null) return errorResponse(404, 'not found');
      const { data, relationOps } = validateBody(def, body, 'update', ctx.registry());
      // ONE tx: update scalars (also confirms the row exists), then apply relation ops on the URL id.
      const row = await ctx.sql.begin(async (tx) => {
        const hooked = ctx.hooks ? await ctx.hooks.runBefore(type, 'update', data) : data;
        const r = await updateEntry(tx, def, id, hooked);
        if (r === null) return null; // missing owner -> abort the tx, do NO link work.
        await assertMediaRefsExist(tx, def, hooked, ctx.registry()); // be-04/05: any media id(s) in this update must exist (400 else).
        await assertRelationRefsExist(tx, def, hooked, ctx.registry()); // be-05b: any inline relation-ref id must exist in its target.
        await applyRelationOps(tx, def, id, relationOps);
        return r;
      });
      if (row === null) return errorResponse(404, 'not found');
      await ctx.rebuild(type);
      if (ctx.hooks) await ctx.hooks.runAfter(type, 'update', row);
      return writeOk(200, def, row);
    }

    if (method === 'DELETE') {
      const id = parseId(idRaw);
      if (id === null) return errorResponse(404, 'not found');
      // Single statement; ON DELETE CASCADE prunes this owner's link rows. Wrap for symmetry.
      const row = await ctx.sql.begin(async (tx) => {
        // before-delete is veto-only (no data to transform) — a throw rolls the delete back.
        if (ctx.hooks) await ctx.hooks.runBefore(type, 'delete', { id });
        return deleteEntry(tx, def, id);
      });
      if (row === null) return errorResponse(404, 'not found');
      await ctx.rebuild(type);
      if (ctx.hooks) await ctx.hooks.runAfter(type, 'delete', row);
      return writeOk(200, def, row);
    }

    return errorResponse(405, `method ${method} not allowed`);
  } catch (e) {
    // HookError (before-hook veto) / BodyParseError / EntryWriteError / QueryParseError (malformed variant
    // locale slug) all map to 400; their `error` string is preserved and `code` is the only added field.
    // Rendered in the caller's UI locale (Accept-Language, threaded onto WriteRequest); absent → 'en'.
    if (
      e instanceof HookError ||
      e instanceof BodyParseError ||
      e instanceof EntryWriteError ||
      e instanceof QueryParseError
    ) {
      return appErrorResponse(e, req.locale ?? 'en');
    }
    throw e; // server bug / DB error -> mapped to 500
  }
}
