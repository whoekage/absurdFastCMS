import type { Sql } from 'postgres';
import type { Registry, ComponentDef } from '../db/registry.ts';
import {
  createComponentType,
  addComponentField,
  dropComponentField,
  dropComponentType,
  ComponentTypeExistsError,
  ComponentTypeNotFoundError,
  ComponentCycleError,
  ComponentInUseError,
  RelationTargetNotFoundError,
  type ComponentFieldSpec,
} from '../db/component-type.repository.ts';
import {
  ContentTypeExistsError,
  FieldExistsError,
  FieldNotFoundError,
  InvalidIdentifierError,
  IdentifierTooLongError,
  ReservedFieldNameError,
  ReservedTableNameError,
  DuplicateFieldError,
  SchemaChangeConflictError,
} from '../db/ddl.ts';
import { UnknownCmsTypeError, TypeOptionError, EnumValueError, ComponentFieldError, type CmsType, type ComponentFieldKind, type FieldOptions } from '../db/type.catalog.ts';
import { JSON_CT, errorResponse, type CoreResponse } from './read.router.ts';

/**
 * be-05 — the COMPONENT-TYPE BUILDER HTTP core, the meta-only sibling of the content-type controller.
 * A component type is a reusable field group with NO physical table / NO engine presence, so every
 * mutation is a pure META change (no DDL); on success it syncs ONLY the registry's component store (the
 * engine is never touched). Same RAW pass-through doctrine: the api_id + every field name are validated
 * in the repo BEFORE any write; this layer never builds SQL.
 *
 * Routes:
 *   POST   /component-types                       create
 *   GET    /component-types                       list
 *   GET    /component-types/:apiId                get one
 *   DELETE /component-types/:apiId                drop (refused if referenced)
 *   POST   /component-types/:apiId/fields         add a field
 *   DELETE /component-types/:apiId/fields/:name   drop a field
 *
 * ⚠️ UNAUTHENTICATED (same caveat as the content-type builder): gating behind authn/authz is a required
 * follow-up before untrusted exposure.
 */

/** The builder's dependencies: the source-of-truth handle + the live registry accessor. */
export interface ComponentTypeContext {
  sql: Sql;
  registry(): Registry;
}

/** A transport-agnostic builder request (params read synchronously by the adapter, body pre-parsed). */
export interface ComponentTypeRequest {
  method: string;
  /** getParameter(0) for `/component-types/:apiId*`; undefined for the collection. */
  apiId?: string;
  /** getParameter(1) for `.../fields/:name`; undefined for the `.../fields` collection. */
  fieldName?: string;
  /** The literal segment after `:apiId` (`'fields'`), or undefined for the item route. */
  sub?: string;
  body: unknown;
}

/**
 * Project a component def to the public JSON shape: `apiId` + ordered fields. A component field carries
 * the SAME conditional metadata keys as a content-type field's projection (enumValues/length/scale/
 * precision/multiple) PLUS the component/components keys for a nested component / dynamiczone field.
 */
function projectComponentDef(def: ComponentDef): unknown {
  return {
    apiId: def.apiId,
    fields: def.fields.map((f) => ({
      name: f.name,
      cmsType: f.cmsType,
      nullable: f.nullable,
      ...(f.enumValues !== undefined ? { enumValues: f.enumValues } : {}),
      ...(f.length !== undefined ? { length: f.length } : {}),
      ...(f.scale !== undefined ? { scale: f.scale } : {}),
      ...(f.precision !== undefined ? { precision: f.precision } : {}),
      ...(f.media !== undefined ? { multiple: f.media.multiple } : {}),
      ...(f.component !== undefined
        ? {
            ...(f.component.component !== undefined ? { component: f.component.component } : {}),
            ...(f.component.components !== undefined ? { components: f.component.components } : {}),
          }
        : {}),
    })),
  };
}

/** Build a 2xx JSON response Buffer. */
function ok(status: number, payload: unknown): CoreResponse {
  return { status, contentType: JSON_CT, body: Buffer.from(JSON.stringify(payload), 'utf8') };
}

/** A non-null, non-array object (the required shape for a POST body). */
function isObj(b: unknown): b is Record<string, unknown> {
  return typeof b === 'object' && b !== null && !Array.isArray(b);
}

/** Map a thrown error to a clean `{ error }` CoreResponse (switch on CLASS; never echo raw PG detail). */
function mapError(e: unknown): CoreResponse {
  if (e instanceof ComponentTypeExistsError || e instanceof ContentTypeExistsError || e instanceof FieldExistsError || e instanceof ComponentInUseError) return errorResponse(409, e.message);
  if (e instanceof ComponentTypeNotFoundError || e instanceof FieldNotFoundError) return errorResponse(404, e.message);
  if (
    e instanceof InvalidIdentifierError ||
    e instanceof IdentifierTooLongError ||
    e instanceof ReservedFieldNameError ||
    e instanceof ReservedTableNameError ||
    e instanceof DuplicateFieldError ||
    e instanceof UnknownCmsTypeError ||
    e instanceof TypeOptionError ||
    e instanceof EnumValueError ||
    e instanceof ComponentFieldError ||
    e instanceof ComponentCycleError ||
    e instanceof RelationTargetNotFoundError
  ) {
    return errorResponse(400, e.message);
  }
  if (e instanceof SchemaChangeConflictError) return errorResponse(409, 'schema change conflicted; retry');
  throw e; // RegistryError / any unexpected -> adapter maps to 500.
}

/** The component-type builder core. Routes verb × template, runs the repo op, syncs the registry. */
export async function handleComponentTypeRequest(ctx: ComponentTypeContext, req: ComponentTypeRequest): Promise<CoreResponse> {
  const method = req.method.toUpperCase();
  const { apiId, fieldName, sub, body } = req;
  try {
    // /component-types  (the collection)
    if (apiId === undefined) {
      if (method === 'GET') return ok(200, ctx.registry().allComponents().map(projectComponentDef));
      if (method === 'POST') {
        if (!isObj(body)) return errorResponse(400, 'request body must be a JSON object');
        if (!Array.isArray(body.fields)) return errorResponse(400, 'fields must be an array');
        const cmp = await createComponentType(ctx.sql, { apiId: body.apiId as string, fields: body.fields as ComponentFieldSpec[] });
        const def = await ctx.registry().rebuildComponent(ctx.sql, cmp.api_id);
        return ok(201, projectComponentDef(def));
      }
      return errorResponse(405, `method ${req.method} not allowed`);
    }

    // /component-types/:apiId/fields  and  /component-types/:apiId/fields/:name
    if (sub === 'fields') {
      if (fieldName === undefined) {
        if (method === 'POST') {
          if (!isObj(body)) return errorResponse(400, 'request body must be a JSON object');
          await addComponentField(ctx.sql, apiId, {
            name: body.name as string,
            cmsType: body.cmsType as CmsType | ComponentFieldKind,
            options: body.options as FieldOptions | undefined,
          });
          const def = await ctx.registry().rebuildComponent(ctx.sql, apiId);
          return ok(201, projectComponentDef(def));
        }
        return errorResponse(405, `method ${req.method} not allowed`);
      }
      if (method === 'DELETE') {
        await dropComponentField(ctx.sql, apiId, fieldName);
        const def = await ctx.registry().rebuildComponent(ctx.sql, apiId);
        return ok(200, projectComponentDef(def));
      }
      return errorResponse(405, `method ${req.method} not allowed`);
    }

    // /component-types/:apiId  (the item)
    if (method === 'GET') {
      const def = ctx.registry().getComponent(apiId);
      return def === undefined ? errorResponse(404, `component-type "${apiId}" not found`) : ok(200, projectComponentDef(def));
    }
    if (method === 'DELETE') {
      await dropComponentType(ctx.sql, apiId); // throws ComponentTypeNotFoundError if absent -> 404.
      ctx.registry().removeComponent(apiId);
      return ok(200, { apiId, dropped: true });
    }
    return errorResponse(405, `method ${req.method} not allowed`);
  } catch (e) {
    return mapError(e);
  }
}
