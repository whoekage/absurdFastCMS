import type { Sql } from 'postgres';
import type { Engine } from '../store/engine.ts';
import type { Registry, ContentTypeDef } from '../store/registry.ts';
import { loadType, rebuildType, loadAllRelations } from '../db/engine.loader.ts';
import {
  createContentType,
  addField,
  renameField,
  changeFieldType,
  dropField,
  dropContentType,
  addRelation,
  type FieldSpec,
  type RelationSpec,
} from '../db/content-type.repository.ts';
import {
  ContentTypeExistsError,
  ContentTypeNotFoundError,
  FieldExistsError,
  FieldNotFoundError,
  InvalidIdentifierError,
  IdentifierTooLongError,
  ReservedFieldNameError,
  ReservedTableNameError,
  DuplicateFieldError,
  TypeChangeForbiddenError,
  TypeChangeFailedError,
  SchemaChangeConflictError,
  DefaultTypeError,
  DependentTypesError,
  UnknownRelationKindError,
  type RelationKind,
} from '../db/ddl.ts';
import { UnknownCmsTypeError, TypeOptionError, EnumValueError, type CmsType, type FieldOptions } from '../db/type.catalog.ts';
import { JSON_CT, errorResponse, type CoreResponse } from './read.router.ts';

/**
 * STEP 5 — the CONTENT-TYPE BUILDER HTTP core, the async counterpart to the read {@link handleRequest}
 * and the data-write {@link handleWrite}. It is framework-agnostic (a pure `(ctx, req) -> CoreResponse`
 * over a real `Sql`), so the whole typed-error -> HTTP table and the per-type live-sync are testable
 * in-process with no socket and no mock.
 *
 * COMMIT-THEN-SYNC: every mutation FIRST commits to Postgres via the validating repo (createContentType
 * / addField / renameField / changeFieldType / dropField / dropContentType — each ONE atomic tx that
 * validates the api_id + field name BEFORE any DDL), and ONLY on success syncs RAM PER-TYPE (registry +
 * engine), never the whole engine. A rolled-back repo op throws -> zero RAM mutation -> RAM stays
 * consistent with the unchanged DB.
 *
 * SECURITY — IDENTIFIERS NEVER BUILT HERE: this layer passes the RAW api_id / field name / cms_type /
 * options straight to the repo, which runs the step-2 allowlist + 63-byte + reserved-name gate before
 * any DDL. The HTTP layer NEVER concatenates SQL or derives a table name. An injection payload like
 * apiId `"; DROP TABLE content_types;--` or field `a"; DROP ...` is rejected 400 with nothing executed.
 *
 * ⚠️ UNAUTHENTICATED: every route here lets ANY client CREATE/ALTER/DROP content-types (runtime DDL,
 * incl. DROP TABLE via DELETE). No auth exists project-wide yet. Gating behind authn/authz (an admin
 * scope) + a dedicated short-lived max:1 schema-change connection (so a DDL lock never starves the
 * shared read/write pool) is a REQUIRED follow-up before any untrusted exposure — do not invent it here.
 */

/** The builder's dependencies: the source-of-truth handle + live engine/registry accessors. */
export interface ContentTypeContext {
  sql: Sql;
  engine(): Engine;
  registry(): Registry;
}

/** A transport-agnostic builder request — params read synchronously by the adapter, body pre-parsed. */
export interface ContentTypeRequest {
  /** Upper- or lower-case HTTP method; compared case-insensitively. */
  method: string;
  /** getParameter(0) for `/content-types/:apiId*`; `undefined` for the `/content-types` collection. */
  apiId?: string;
  /** getParameter(1) for `.../fields/:name`; `undefined` for the `.../fields` collection. */
  fieldName?: string;
  /** The literal segment after `:apiId` (`'fields'`), or `undefined` for the item route. */
  sub?: string;
  /** Parsed JSON body (`undefined` when the request carried no body). */
  body: unknown;
}

/**
 * Project a registry def to the ONE public JSON shape every 2xx body uses: `apiId` + ordered fields
 * (system id/created_at/updated_at first, then user fields by `sort` — guaranteed by buildDef). Sourced
 * from the registry def, NOT raw rows, so no physical detail (tableName / pg_type / content_type_id /
 * default_value) ever leaks.
 */
function projectDef(def: ContentTypeDef): unknown {
  return {
    apiId: def.apiId,
    fields: def.fields.map((f) => ({
      name: f.name,
      cmsType: f.cmsType,
      nullable: f.nullable,
      system: f.system,
      ...(f.enumValues !== undefined ? { enumValues: f.enumValues } : {}),
      ...(f.length !== undefined ? { length: f.length } : {}),
      ...(f.scale !== undefined ? { scale: f.scale } : {}),
      ...(f.precision !== undefined ? { precision: f.precision } : {}),
    })),
    // Relations are physical-detail-free (no linkTable, no content_type_id): each entry carries the
    // owner-side field key, its cardinality kind, the target api_id, whether THIS side owns the link
    // table, and (two-way only) the partner field. A scalar-only type returns `relations: []` — no
    // shape drift for existing consumers (the key is always present, just empty).
    relations: def.relations.map((r) => ({
      field: r.field,
      kind: r.kind,
      target: r.targetApiId,
      owner: r.isOwner,
      ...(r.inverseField !== undefined ? { inverseField: r.inverseField } : {}),
    })),
    // Draft & Publish flag. CONDITIONAL key: emitted ONLY for a D&P type, so a non-D&P type's projected
    // def stays BYTE-IDENTICAL to before this feature — the entire existing builder suite is unaffected
    // with zero edits, and only NEW D&P tests assert the key. (admin reads this to show the D&P toggle.)
    ...(def.draftPublish ? { draftPublish: true } : {}),
  };
}

/** Build a 2xx JSON response Buffer. */
function ok(status: number, payload: unknown): CoreResponse {
  return { status, contentType: JSON_CT, body: Buffer.from(JSON.stringify(payload), 'utf8') };
}

/** A non-null, non-array object (the required shape for a POST/PUT body). */
function isObj(b: unknown): b is Record<string, unknown> {
  return typeof b === 'object' && b !== null && !Array.isArray(b);
}

/**
 * Map a thrown error to a clean `{ error }` CoreResponse. Switches on the error CLASS (never echoes a
 * raw PG / constraint detail). An unexpected throw (incl. RegistryError from a post-commit rebuild
 * racing a drop) is rethrown so the adapter emits a fixed `500 'internal error'` with no message leak.
 */
function mapError(e: unknown): CoreResponse {
  if (e instanceof ContentTypeExistsError || e instanceof FieldExistsError || e instanceof DependentTypesError) return errorResponse(409, e.message);
  if (e instanceof ContentTypeNotFoundError || e instanceof FieldNotFoundError) return errorResponse(404, e.message);
  if (
    e instanceof InvalidIdentifierError ||
    e instanceof IdentifierTooLongError ||
    e instanceof ReservedFieldNameError ||
    e instanceof ReservedTableNameError ||
    e instanceof DuplicateFieldError ||
    e instanceof UnknownCmsTypeError ||
    e instanceof UnknownRelationKindError ||
    e instanceof TypeOptionError ||
    e instanceof EnumValueError ||
    e instanceof DefaultTypeError ||
    e instanceof TypeChangeForbiddenError ||
    e instanceof TypeChangeFailedError
  ) {
    return errorResponse(400, e.message);
  }
  // Retryable conflict (lock_timeout / sort race). Normalize to a fixed leak-free message (the typed
  // error's own message names the ct_ table; do not echo it).
  if (e instanceof SchemaChangeConflictError) return errorResponse(409, 'schema change conflicted; retry');
  throw e; // RegistryError / any unexpected -> adapter maps to 500 'internal error'.
}

// --- per-type live-sync (commit-then-sync) -----------------------------------------------------

/**
 * Create sync: registry FIRST (so the data write core's `registry.get` gate passes), THEN engine load.
 * `loadType` registers the eq index on `id` (respondById invariant) + warms — a bare `engine.define`
 * would not. `rebuildType(sql, apiId)` re-reads meta via getContentType so the key is the canonical
 * stored api_id.
 */
async function syncCreate(ctx: ContentTypeContext, apiId: string): Promise<ContentTypeDef> {
  const def = await ctx.registry().rebuildType(ctx.sql, apiId);
  await loadType(ctx.sql, ctx.engine(), def); // define + index + stream(empty) + warm.
  return def;
}

/**
 * Schema-change sync (add / rename / changeType / drop-field): a FRESH def (new fieldDefs + indexPlan)
 * then a per-type re-stream + atomic swap. `load.rebuildType` builds a DetachedTable from the NEW column
 * set, re-streams every row under the new def, and `engine.replaceType` swaps Table+arena+hasRawField +
 * invalidates this type's cache. Handles a changed column set entirely — no `engine.define` (which would
 * throw on the existing type) is ever called here.
 */
async function syncSchema(ctx: ContentTypeContext, apiId: string): Promise<ContentTypeDef> {
  const def = await ctx.registry().rebuildType(ctx.sql, apiId);
  await rebuildType(ctx.sql, ctx.engine(), def, ctx.registry());
  return def;
}

/**
 * Relation-declaration sync. A relation declaration emits NO ct_ column on either side (the edges live
 * in a link table), so the owner's read arena is byte-identical — but the owner's def MUST be rebuilt so
 * its `relations`/`relationsByField` reflect the new row, and `rebuildType`'s `loadAllRelations` re-derives
 * EVERY relation's edges (incl. this new one + its inverse) against the live Tables, going LIVE for both
 * filtering and populate with no read-path change.
 *
 * For a TWO-WAY relation whose target differs from the owner, the INVERSE meta row lands on the TARGET's
 * `content_type_relations`. `loadAllRelations` only walks `registry.all()`, so the target's registry def
 * must also be rebuilt — otherwise the inverse Relation is never re-derived AND a later
 * `GET /content-types/:target` would not show the inverse. We rebuild the target FIRST so the single
 * `loadAllRelations` inside the owner's `rebuildType` sees the inverse row too.
 */
async function syncRelation(ctx: ContentTypeContext, ownerApiId: string, spec: RelationSpec): Promise<ContentTypeDef> {
  const twoWay = spec.inverseField !== undefined;
  const selfRef = spec.target.toLowerCase() === ownerApiId.toLowerCase();
  if (twoWay && !selfRef) await ctx.registry().rebuildType(ctx.sql, spec.target); // refresh target's relations[] before re-derive.
  return syncSchema(ctx, ownerApiId); // rebuilds owner def + loadAllRelations (edges go live).
}

/** Drop sync: engine then registry, synchronously adjacent (no await between -> no torn membership). */
function syncDrop(ctx: ContentTypeContext, apiId: string): void {
  ctx.engine().dropType(apiId); // has()===false immediately + cache invalidate.
  ctx.registry().removeType(apiId);
}

// --- the dispatcher ----------------------------------------------------------------------------

/**
 * The builder core. Routes verb × template, runs the validating repo op, then syncs RAM per-type, and
 * returns the projected def (or a clean error). One try/catch funnels every typed error through
 * {@link mapError}; an unexpected throw propagates to the adapter (500).
 */
export async function handleContentTypeRequest(ctx: ContentTypeContext, req: ContentTypeRequest): Promise<CoreResponse> {
  const method = req.method.toUpperCase();
  const { apiId, fieldName, sub, body } = req;
  try {
    // /content-types  (the collection)
    if (apiId === undefined) {
      if (method === 'GET') return ok(200, ctx.registry().all().map(projectDef));
      if (method === 'POST') {
        if (!isObj(body)) return errorResponse(400, 'request body must be a JSON object');
        if (!Array.isArray(body.fields)) return errorResponse(400, 'fields must be an array');
        // Optional create-time relations: same RAW pass-through; the repo validates each spec + the
        // owner ct_ table is created BEFORE any (possibly self-referential) link-table FK. A non-array
        // `relations` is a 400.
        if (body.relations !== undefined && !Array.isArray(body.relations)) return errorResponse(400, 'relations must be an array');
        // Draft & Publish opt-in flag: validate it is a boolean if present (else 400). RAW pass-through
        // doctrine — no SQL is built here; the conditional `published_at` DDL lives in compileCreateTable.
        if (body.draftPublish !== undefined && typeof body.draftPublish !== 'boolean') return errorResponse(400, 'draftPublish must be a boolean');
        const relations = body.relations as RelationSpec[] | undefined;
        // RAW pass-through to the validating repo — the api_id + every field name are validated there
        // BEFORE any DDL. The HTTP layer never derives a table name or builds SQL.
        const ct = await createContentType(ctx.sql, {
          apiId: body.apiId as string,
          fields: body.fields as FieldSpec[],
          ...(relations !== undefined ? { relations } : {}),
          ...(body.draftPublish !== undefined ? { draftPublish: body.draftPublish as boolean } : {}),
        });
        // Create-time relations may target OTHER existing types; if any is two-way, its inverse row
        // landed on a target type, so rebuild every distinct two-way target's def before the owner load
        // so loadAllRelations (inside syncCreate's loader) re-derives those inverses too.
        const twoWayTargets = new Set<string>();
        for (const r of relations ?? []) {
          if (r.inverseField !== undefined && r.target.toLowerCase() !== ct.api_id.toLowerCase()) twoWayTargets.add(r.target);
        }
        for (const t of twoWayTargets) await ctx.registry().rebuildType(ctx.sql, t);
        const def = await syncCreate(ctx, ct.api_id); // canonical stored casing; define + index + stream.
        // loadType does NOT load relation edges; if any were declared at create time, derive them now so
        // the new type's relations go LIVE (Relation objects + inverse on each two-way target).
        if ((relations ?? []).length > 0) await loadAllRelations(ctx.sql, ctx.engine(), ctx.registry());
        return ok(201, projectDef(def));
      }
      return errorResponse(405, `method ${req.method} not allowed`);
    }

    // /content-types/:apiId/fields  and  /content-types/:apiId/fields/:name
    if (sub === 'fields') {
      if (fieldName === undefined) {
        // .../fields  (the field collection)
        if (method === 'POST') {
          if (!isObj(body)) return errorResponse(400, 'request body must be a JSON object');
          await addField(ctx.sql, apiId, {
            name: body.name as string,
            cmsType: body.cmsType as CmsType,
            options: body.options as FieldOptions | undefined,
          });
          const def = await syncSchema(ctx, apiId);
          return ok(201, projectDef(def));
        }
        return errorResponse(405, `method ${req.method} not allowed`);
      }
      // .../fields/:name
      if (method === 'PUT') {
        if (!isObj(body)) return errorResponse(400, 'request body must be a JSON object');
        const hasRename = typeof body.newName === 'string';
        const hasType = body.cmsType !== undefined;
        if (!hasRename && !hasType) return errorResponse(400, 'no change specified (provide newName and/or cmsType)');
        // Rename FIRST, then change type on the NEW name (two atomic txns). If change-type throws after
        // the rename committed, the rename stays in the DB; we run syncSchema before surfacing the error
        // so the committed rename goes live in RAM (the partial apply is durable + reflected, not lost).
        let target = fieldName;
        let captured: unknown;
        let committed = false;
        try {
          if (hasRename) {
            await renameField(ctx.sql, apiId, fieldName, body.newName as string);
            target = body.newName as string;
            committed = true;
          }
          if (hasType) {
            await changeFieldType(ctx.sql, apiId, target, body.cmsType as CmsType, body.options as FieldOptions | undefined);
            committed = true;
          }
        } catch (e) {
          captured = e;
        }
        if (committed) await syncSchema(ctx, apiId); // reflect whatever committed before mapping the error.
        if (captured !== undefined) return mapError(captured);
        return ok(200, projectDef(ctx.registry().get(apiId)!));
      }
      if (method === 'DELETE') {
        await dropField(ctx.sql, apiId, fieldName);
        const def = await syncSchema(ctx, apiId);
        return ok(200, projectDef(def));
      }
      return errorResponse(405, `method ${req.method} not allowed`);
    }

    // /content-types/:apiId/relations  (declare a relation on the owner type)
    if (sub === 'relations') {
      if (fieldName === undefined) {
        if (method === 'POST') {
          if (!isObj(body)) return errorResponse(400, 'request body must be a JSON object');
          // RAW pass-through to the validating repo: field/kind/target identifiers + collisions are all
          // checked there (one advisory-locked schema tx), never here. `inverseField` present => two-way.
          const spec: RelationSpec = {
            field: body.field as string,
            kind: body.kind as RelationKind,
            target: body.target as string,
            ...(body.inverseField !== undefined ? { inverseField: body.inverseField as string } : {}),
          };
          await addRelation(ctx.sql, apiId, spec);
          const def = await syncRelation(ctx, apiId, spec); // re-derives edges -> filter + populate go live.
          return ok(201, projectDef(def));
        }
        return errorResponse(405, `method ${req.method} not allowed`);
      }
      return errorResponse(405, `method ${req.method} not allowed`);
    }

    // /content-types/:apiId  (the item)
    if (method === 'GET') {
      const def = ctx.registry().get(apiId);
      return def === undefined ? errorResponse(404, `content-type "${apiId}" not found`) : ok(200, projectDef(def));
    }
    if (method === 'DELETE') {
      await dropContentType(ctx.sql, apiId); // throws ContentTypeNotFoundError if absent -> 404.
      syncDrop(ctx, apiId);
      return ok(200, { apiId, dropped: true });
    }
    return errorResponse(405, `method ${req.method} not allowed`);
  } catch (e) {
    return mapError(e);
  }
}
