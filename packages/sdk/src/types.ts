// @absurd/sdk — CONTRACT TYPES (Slice 1).
//
// These are the shared vocabulary mirroring what `@absurd/api` exposes over HTTP.
//
// ⚠️ HAND-WRITTEN ON PURPOSE — never `import ... from '@absurd/api'`. The api package pulls
// postgres.js / uWebSockets.js into the module graph; importing its types would drag those into a
// browser bundle. These declarations are kept byte-faithful to the api shapes by READING the api
// source (type.catalog.ts, content-type.controller.ts#projectDef, engine.ts pagination meta), not by
// importing it. When the api contract changes, update these here.

// === 1.1 — cms_type, field options, field spec =================================================

/**
 * The closed set of CMS field types a user may define on a content-type field. Mirror of
 * `CmsType` in `@absurd/api` (packages/api/src/db/type.catalog.ts) — 14 members.
 * Relation / media / component / dynamiczone are NOT here.
 */
export type CmsType =
  | 'string'
  | 'text'
  | 'email'
  | 'uid'
  | 'enumeration'
  | 'integer'
  | 'biginteger'
  | 'float'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'time'
  | 'json'
  | 'array'
  | 'uuid';

/**
 * Per-field options the caller may supply when defining a field; each `cmsType` validates only the
 * keys it cares about (server-side). Mirror of `FieldOptions` in the api type catalog.
 */
export interface FieldOptions {
  /** varchar length (char count) for string/email/uid/enumeration sizing. */
  length?: number;
  /** numeric total digits (decimal). */
  precision?: number;
  /** numeric fractional digits (decimal). */
  scale?: number;
  /** allowed members for `enumeration` (non-empty, distinct). */
  values?: string[];
  /** whether the column accepts NULL (defaults to true). */
  nullable?: boolean;
  /** constant default value (volatile defaults like now()/gen_random_uuid() are rejected upstream). */
  default?: unknown;
}

/**
 * A field the caller wants to define: the user name, its cms_type, and per-type options. Mirror of
 * `FieldSpec` in the api content-type repository — the body shape for create / add-field requests.
 */
export interface FieldSpec {
  name: string;
  cmsType: CmsType;
  options?: FieldOptions;
}

// === 1.2 — content-type definition (the `projectDef` shape) ====================================

/**
 * A single field as PROJECTED by the api's content-type builder (`projectDef` in
 * packages/api/src/http/content-type.controller.ts). This is the ONE public JSON shape every 2xx
 * builder body uses — physical detail (tableName / pg_type / content_type_id / default_value) never
 * leaks. The optional keys appear only when present on the field (e.g. `enumValues` for enumeration,
 * `scale`/`precision` for decimal, `length` for varchar-backed types).
 */
export interface FieldDefinition {
  name: string;
  cmsType: CmsType;
  nullable: boolean;
  /** id/created_at/updated_at → true: loaded + materialized, NEVER writable. */
  system: boolean;
  /** enumeration members, if present. */
  enumValues?: readonly string[];
  /** varchar length, if present. */
  length?: number;
  /** decimal fractional digits, if present. */
  scale?: number;
  /** decimal total digits, if present. */
  precision?: number;
}

/**
 * A content-type as projected by the builder: its api_id and ordered fields (system id/created_at/
 * updated_at first, then user fields). Returned by the content-type builder routes.
 */
export interface ContentTypeDefinition {
  apiId: string;
  fields: FieldDefinition[];
}

// === 1.6 — wire-format note ====================================================================
//
// Document wire-format (anti precision-loss): a `biginteger` (pg int8) and a `decimal` (pg numeric)
// arrive over the wire as QUOTED STRINGS — `JSON.parse` keeps them as the strings they are on the
// wire, so a value above 2^53 (or with a fixed scale) is never silently rounded. They are therefore
// typed as `string`. A `json` field arrives as an already-parsed JS value of unknown shape →
// `unknown`. Schema-aware (de)serialization into richer JS types is a later slice (Slice 7).

/** A `biginteger` (pg int8) field value as it arrives on the wire: a quoted decimal string. */
export type BigIntegerValue = string;

/** A `decimal` (pg numeric) field value as it arrives on the wire: a quoted decimal string. */
export type DecimalValue = string;

/** A `json` field value: an already-parsed JS value of unknown shape. */
export type JsonValue = unknown;

// === 1.3 — response envelope ===================================================================

/**
 * One entry (row) of a content-type. The SDK does not know the column set of a runtime-defined type
 * at compile time, so the default entry is an open record; callers may pass a concrete `T`.
 */
export type Entry = Record<string, unknown>;

/** The list (collection) response envelope — Strapi v5 flat shape: `{ data, meta: { pagination } }`. */
export interface ListResponse<T = Entry> {
  data: T[];
  meta: {
    pagination: PaginationMeta;
  };
}

/** The single (item) response envelope — `meta` is an empty object for item routes. */
export interface SingleResponse<T = Entry> {
  data: T;
  meta: Record<string, never>;
}

// === 1.4 — pagination meta + guard =============================================================

/**
 * Offset (page) pagination meta. `page`/`pageSize`/`pageCount`/`total` describe the whole result
 * set. Mirror of `PaginationMeta` in packages/api/src/store/engine.ts.
 */
export interface OffsetPaginationMeta {
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
}

/**
 * Keyset (cursor) pagination meta. `total`/`pageCount` are present ONLY when `withCount` was
 * requested. `nextCursor`/`prevCursor` are opaque tokens (null when no further / preceding page).
 * Mirror of `KeysetPaginationMeta` in packages/api/src/store/engine.ts.
 */
export interface KeysetPaginationMeta {
  pageSize: number;
  total?: number;
  pageCount?: number;
  nextCursor: string | null;
  prevCursor: string | null;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/** Either pagination shape a list response may carry, discriminated by {@link isKeysetPagination}. */
export type PaginationMeta = OffsetPaginationMeta | KeysetPaginationMeta;

/**
 * Runtime narrowing guard: `true` when `m` is keyset (cursor) meta rather than offset (page) meta.
 * Distinguishes on the keyset-only `hasNextPage` flag (offset meta carries `page`, never that flag).
 */
export function isKeysetPagination(m: PaginationMeta): m is KeysetPaginationMeta {
  return 'hasNextPage' in m;
}

// === 5.4 — write body (scalar fields + relation ops) ===========================================
//
// The request body for both create (POST /:type) and update (PUT /:type/:id) is ONE flat JSON object
// — NOT a Strapi `{ data: {...} }` envelope; the object itself IS the body. Each top-level key is
// either a writable SCALAR field or a RELATION field, distinguished server-side; they coexist as
// sibling keys. `id` and system columns (created_at/updated_at/...) are rejected. Mirror of
// validateBody / parseRelationValue in packages/api/src/store/body.parser.ts.

/** A related-row primary key as accepted by a relation op: a positive int4 integer (`> 0`, `<= 2147483647`). */
export type RelationId = number;

/**
 * The value of a RELATION field in a write body. Three accepted forms (parseRelationValue):
 *
 *  - shorthand `set`: a bare id or array of ids — `"author": 7` / `"tags": [1, 2, 3]`;
 *  - an explicit `{ set }` op — REPLACES the owner's whole related set (`{ set: [] }` clears it);
 *    `set` is MUTUALLY EXCLUSIVE with `connect`/`disconnect`;
 *  - a `{ connect?, disconnect? }` op — `connect` ADDS edges, `disconnect` REMOVES edges; the two are
 *    combinable (server applies disconnect-THEN-connect, so a connect wins an overlapping id).
 *
 * Each op value is itself an id or array of ids. Ids are deduped (first-seen order kept). For a to-one
 * relation, `set`/`connect` accept at most one id. `null` is rejected — clear with `{ set: [] }`.
 */
export type RelationInput =
  | RelationId
  | RelationId[]
  | { set: RelationId | RelationId[] }
  | {
      connect?: RelationId | RelationId[];
      disconnect?: RelationId | RelationId[];
    };

/**
 * A create/update body: a flat record of writable SCALAR fields plus RELATION-op fields side by side.
 * Untyped by default (the SDK does not know a runtime type's column set at compile time); pass a
 * concrete `T` to type the scalar fields — relation fields then also accept a {@link RelationInput}.
 *
 * Scalar wire forms (coerce): `i32`→integer, `f64`→finite number, `bool`→boolean, `string`/`text`→
 * string, `date`→ISO-8601 string or epoch-ms number, `i64`(biginteger)→integer string (or safe
 * number), `decimal`→string (or number), `json`→any JSON value or JSON-text string. `null` is allowed
 * only on a nullable field.
 */
export type WriteBody<T = Entry> = { [K in keyof T]?: T[K] | RelationInput } & {
  [field: string]: unknown;
};

// === 6 — content-type builder inputs ===========================================================
//
// The request body shapes for the content-type builder routes (Slice 6). Mirror of the body shapes
// the api's content-type controller reads (packages/api/src/http/content-type.controller.ts) +
// validates via the content-type repository (createContentType / addField / renameField /
// changeFieldType). The RESPONSE of every 2xx builder route is a {@link ContentTypeDefinition}
// (the `projectDef` shape) — except a type DROP, which returns {@link DropResult}.

/**
 * The body for `contentTypes.create` — `POST /content-types`. The `apiId` + every field name are
 * validated server-side (allowlist + 63-byte + reserved-name gate) BEFORE any DDL. The stored api_id
 * is canonicalised by the repo and reflected back on the returned {@link ContentTypeDefinition}.
 */
export interface CreateContentTypeInput {
  apiId: string;
  fields: FieldSpec[];
}

/**
 * The body for `contentTypes.updateField` — `PUT /content-types/:apiId/fields/:name`. At least one of
 * `newName` / `cmsType` must be supplied (an all-empty change is a 400). The server applies a rename
 * FIRST, then a type change on the new name (two atomic txns); `options` accompanies a `cmsType` change
 * (e.g. enum `values`, decimal `precision`/`scale`).
 */
export interface UpdateFieldInput {
  /** Rename the field to this identifier. */
  newName?: string;
  /** Change the field's cms_type (validated against the allowed type-change matrix). */
  cmsType?: CmsType;
  /** Options for the new cms_type (enum `values`, varchar `length`, decimal `precision`/`scale`, ...). */
  options?: FieldOptions;
}

/** The response of a content-type DROP (`DELETE /content-types/:apiId`): the dropped api_id + a flag. */
export interface DropResult {
  apiId: string;
  dropped: true;
}

// === 1.5 — filter operators ====================================================================

/**
 * The complete set of Strapi filter operator tokens the api parser whitelists (21). Mirror of the
 * `OP_MAP` keys in packages/api/src/store/query.parser.ts. `*i` variants are case-insensitive.
 *
 *   value comparison: $eq $ne $gt $gte $lt $lte $eqi $nei
 *   set / range:      $between $in $notIn
 *   null presence:    $null $notNull
 *   text (string/text fields only): $contains $containsi $notContains $notContainsi
 *                                   $startsWith $startsWithi $endsWith $endsWithi
 */
export type FilterOperator =
  | '$eq'
  | '$ne'
  | '$gt'
  | '$gte'
  | '$lt'
  | '$lte'
  | '$between'
  | '$in'
  | '$notIn'
  | '$null'
  | '$notNull'
  | '$eqi'
  | '$nei'
  | '$contains'
  | '$containsi'
  | '$notContains'
  | '$notContainsi'
  | '$startsWith'
  | '$startsWithi'
  | '$endsWith'
  | '$endsWithi';
