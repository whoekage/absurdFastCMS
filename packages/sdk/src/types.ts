// @conti/sdk — CONTRACT TYPES (Slice 1).
//
// These are the shared vocabulary mirroring what `@conti/api` exposes over HTTP.
//
// ⚠️ HAND-WRITTEN ON PURPOSE — never `import ... from '@conti/api'`. The api package pulls
// postgres.js / uWebSockets.js into the module graph; importing its types would drag those into a
// browser bundle. These declarations are kept byte-faithful to the api shapes by READING the api
// source (type.catalog.ts, module.controller.ts#projectDef, engine.ts pagination meta), not by
// importing it. When the api contract changes, update these here.

// === 1.1 — type, field options, field spec =================================================

/**
 * The closed set of CMS field types a user may define on a module field. Mirror of
 * `CmsType` in `@conti/api` (packages/api/src/db/type.catalog.ts). `media` (be-04) IS here — a
 * reference to an uploaded asset in the `files` library (single int4 id / multiple jsonb id array; see
 * {@link FileAsset} + `client.upload`). Relation / component / dynamiczone are NOT here.
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
  | 'uuid'
  | 'media';

/**
 * be-05 — the three STRUCTURED-CONTENT field kinds (reusable components + dynamic zones). Mirror of
 * `ComponentFieldKind` in `@conti/api` (packages/api/src/db/type.catalog.ts). Like {@link RelationKind}
 * these are a SEPARATE closed union, NOT a {@link CmsType}: each is physically a jsonb column whose value
 * is the inline component instance tree, with params carrying the referenced component api_id(s).
 *
 *   component            — ONE instance of a component type ({@link FieldOptions.component}).
 *   component-repeatable — an ordered ARRAY of instances of one component ({@link FieldOptions.component}).
 *   dynamiczone          — an ordered ARRAY of instances tagged `__component`, from an allowed-set
 *                          ({@link FieldOptions.components}).
 *   relation             — be-05b: an INLINE id ref (or array of ids, via {@link FieldOptions.multiple}) to a
 *                          TARGET module ({@link FieldOptions.target}), resolved on read. This is
 *                          ONLY valid INSIDE a component (it has no top-level form). It is SEMANTICALLY
 *                          DISTINCT from a top-level (be-01) {@link RelationKind}: an inline ref is stored
 *                          by-value in the component json (NO link table, NO inverse side, NOT independently
 *                          queryable) — a default `GET /:type/:id?populate=<field>` resolves it (published-
 *                          only for a draft/publish target, default-locale for an i18n target).
 */
export type ComponentFieldKind = 'component' | 'component-repeatable' | 'dynamiczone' | 'relation';

/**
 * Per-field options the caller may supply when defining a field; each `type` validates only the
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
  /**
   * be-04 MEDIA only: `false` (default) => a SINGLE asset reference (one `files.id`); `true` => MULTIPLE
   * (an ordered array of `files.id`s). Ignored for non-media types.
   */
  multiple?: boolean;
  /** be-05 `component` / `component-repeatable` only: the referenced component-type api_id. */
  component?: string;
  /** be-05 `dynamiczone` only: the allowed component-type api_ids (the zone's allowed-set). */
  components?: string[];
  /**
   * be-05b `relation` (INSIDE a component) only: the TARGET module api_id an inline ref points at.
   * `multiple` (reused from above) selects single-id vs array-of-ids cardinality. The target must already
   * exist (checked at component-type definition). Distinct from a top-level (be-01) link-table relation.
   */
  target?: string;
  /** lower bound — char-length (string/email/uid) or VALUE; STRING for biginteger/decimal. */
  min?: number | string;
  /** upper VALUE bound; STRING for biginteger/decimal. Strings use `length` for their char max. */
  max?: number | string;
  /** admin editor layout width: 'full' (default) or 'half'. Metadata only. */
  editorWidth?: 'full' | 'half';
  /** admin conditional visibility ("show/hide when …"). Metadata only. */
  condition?: FieldCondition;
  /** emit a single-column UNIQUE constraint (not for text/boolean/json/array/media). */
  unique?: boolean;
  /** `array` only: forbid duplicate items. */
  uniqueItems?: boolean;
  /** `array` only: item-count bounds. */
  minItems?: number;
  maxItems?: number;
}

/** A field's admin conditional-visibility rule. Metadata only (mirrors the api's FieldCondition). */
export interface FieldCondition {
  field: string;
  op: 'eq' | 'ne';
  value: string | number | boolean;
  action: 'show' | 'hide';
}

/**
 * A field the caller wants to define: the user name, its type, and per-type options. Mirror of
 * `FieldSpec` in the api module repository — the body shape for create / add-field requests. A
 * `type` may be a scalar {@link CmsType} OR a be-05 {@link ComponentFieldKind} (in which case
 * `options.component` / `options.components` names the referenced component-type(s)).
 */
export interface FieldSpec {
  name: string;
  type: CmsType | ComponentFieldKind;
  options?: FieldOptions;
  /**
   * i18n: whether this field is LOCALIZED (per-locale-variant value) or SHARED across the document's
   * locale variants. Defaults to `true` (localized) server-side. Only meaningful on an `i18n: true` type
   * (ignored otherwise). A shared field's value is kept in sync across every variant by the write path.
   */
  localized?: boolean;
}

// === 1.2 — module definition (the `projectDef` shape) ====================================

/**
 * A single field as PROJECTED by the api's module builder (`projectDef` in
 * packages/api/src/http/module.controller.ts). This is the ONE public JSON shape every 2xx
 * builder body uses — physical detail (tableName / pg_type / content_type_id / default_value) never
 * leaks. The optional keys appear only when present on the field (e.g. `enumValues` for enumeration,
 * `scale`/`precision` for decimal, `length` for varchar-backed types).
 */
export interface FieldDefinition {
  name: string;
  /** A scalar {@link CmsType} OR a be-05 {@link ComponentFieldKind} for a component / dynamic-zone field. */
  type: CmsType | ComponentFieldKind;
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
  /**
   * Constant default value for the field, if the builder projects one. The core `projectDef` does
   * not currently leak physical `default_value`, so this is usually absent; when present (forward-
   * compatible) the admin create form prefills the control from it. Kept `unknown` — it is a wire
   * value (string/number/boolean/JSON), not a form-shaped value.
   */
  default?: unknown;
  /**
   * be-04 MEDIA: the cardinality of a `type: 'media'` field — `false` = single asset reference,
   * `true` = multiple. PROJECTED only for a media field (a conditional wire key; every non-media field
   * omits it). The admin reads it to pick a single-asset picker vs a multi-asset gallery widget.
   */
  multiple?: boolean;
  /**
   * be-05: a `component` / `component-repeatable` field's referenced component-type api_id. PROJECTED
   * only for those kinds (a conditional wire key; every other field omits it). The admin reads it to
   * render the nested single/repeatable component editor.
   */
  component?: string;
  /**
   * be-05: a `dynamiczone` field's allowed component-type api_ids. PROJECTED only for a dynamic-zone
   * field (a conditional wire key). The admin reads it to offer the allowed block types in the zone editor.
   */
  components?: string[];
  /**
   * i18n per-field localized flag, PROJECTED only for an `i18n: true` type (a non-i18n type omits this
   * key — a conditional wire key). `true` => the field is per-variant; `false` => shared across the
   * document's locale variants (write-side kept in sync). The synthesized system fields `document_id`
   * and `locale` are projected as `localized: false`. The admin reads this to show the per-field toggle.
   */
  localized?: boolean;
}

/**
 * The closed set of relation cardinalities a relation may declare. Mirror of `RelationKind` in
 * `@conti/api` (packages/api/src/db/ddl.ts) — a SEPARATE closed union, NOT a {@link CmsType} (relations
 * never touch the scalar type catalog). The owning side's kind drives the physical link-table UNIQUEs;
 * the inverse side stores the inverse cardinality (oneToMany↔manyToOne; oneToOne/manyToMany self-inverse).
 */
export type RelationKind = 'oneToOne' | 'oneToMany' | 'manyToOne' | 'manyToMany';

/**
 * One relation as PROJECTED by the api's module builder (`projectDef` relations entry). Physical
 * detail (the link-table name, content_type_id) never leaks. `owner` is true on the side that emitted
 * the link-table DDL; `inverseField` is present ONLY for a two-way relation (the partner field on the
 * target). A one-way relation omits `inverseField`.
 */
export interface RelationDefinition {
  /** The relation field / API key on THIS side. */
  field: string;
  kind: RelationKind;
  /** The target module name (may equal `name` for a self-referential relation). */
  target: string;
  /** true => this side owns the link table (emitted its DDL); false => the inverse side. */
  owner: boolean;
  /** The partner field on the target — present only for a two-way relation. */
  inverseField?: string;
  /** Which target field the relation picker shows/searches (admin metadata, read-side only). */
  displayField?: string;
}

/**
 * A module as projected by the builder: its `name`, optional human `label`, ordered fields (system
 * id/created_at/updated_at first, then user fields), and declared relations (in `sort` order).
 * `relations` is ALWAYS present — a scalar-only type returns `relations: []` (no shape drift). Returned by
 * every 2xx builder route.
 */
export interface ModuleDefinition {
  name: string;
  /** Editable human display name; `label ?? name` is what the admin shows. */
  label?: string;
  fields: FieldDefinition[];
  relations: RelationDefinition[];
  /**
   * Draft & Publish opt-in. Present and `true` ONLY for a type that enabled Draft & Publish (a
   * conditional wire key — a non-D&P type omits it). When true, the type has a `published_at` system
   * field and the lifecycle endpoints (`publish`/`unpublish`) + the `status` read param apply.
   */
  draftPublish?: boolean;
  /**
   * i18n opt-in. Present and `true` ONLY for a type that enabled localization (a conditional wire key —
   * a non-i18n type omits it). When true, the type has `document_id` + `locale` system fields, a read
   * accepts the `locale` param (default {@link AbsurdClientOptions.defaultLocale} server-side), and
   * `createVariant` adds a new locale of an existing document.
   */
  i18n?: boolean;
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
 * One entry (row) of a module. The SDK does not know the column set of a runtime-defined type
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

// === be-04 — media / asset library ==============================================================

/**
 * One asset record from the media library (`files` registry), as returned by the asset endpoints
 * (`POST/GET/DELETE /_files...`) AND inlined into an entry by a media-field POPULATE. Mirror of
 * `FileAsset` in `@conti/api` (packages/api/src/db/file.repository.ts). `width`/`height` are `null`
 * for a non-image upload; `url` is the public URL for the bytes (provider-derived; may be null).
 */
export interface FileAsset {
  id: number;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  hash: string;
  /** Which storage backend holds the bytes: `'local'` | `'s3'`. */
  provider: string;
  /** The opaque content-addressed key inside that provider (`ab/cd/<sha256>.<ext>`). */
  storageKey: string;
  url: string | null;
  createdAt: string;
}

/**
 * The value a MEDIA field accepts in a write body. SINGLE: one positive `files.id` (or `null` to clear).
 * MULTIPLE: an array of `files.id`s (`[]` clears). Ids must be positive int4 AND reference an existing
 * asset (a non-existent id is a 400 — the write tx rolls back). Upload first with {@link AbsurdClient.upload}
 * to obtain an id. UN-POPULATED reads echo the raw id / id[]; a `populate` read inlines {@link FileAsset}(s).
 */
export type MediaInput = number | number[] | null;

/** The list-response envelope for `GET /_files` (offset-paginated asset library page). */
export interface FileListResponse {
  data: FileAsset[];
  meta: { pagination: { start: number; limit: number; total: number } };
}

/** Optional paging for {@link AbsurdClient.assets}.list — `start` (offset, default 0) + `limit` (1..100, default 25). */
export interface FileListParams {
  start?: number;
  limit?: number;
}

// === 6 — module builder inputs ===========================================================
//
// NOTE (legacy-meta teardown): the Builder request/response shapes (CreateModuleInput, UpdateFieldInput,
// DeclareRelationInput, DropResult, ComponentTypeDefinition, ComponentFieldDefinition,
// CreateComponentTypeInput) were REMOVED with the runtime-DDL routes. Schema is files-first now; the SDK
// keeps only the READ-side projections (ModuleDefinition/FieldDefinition/RelationDefinition) used by decode.

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
