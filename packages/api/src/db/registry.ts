import type { Sql } from 'postgres';
import type { ColumnType } from '../store/column.ts';
import type { FieldDef } from '../store/table.ts';
import { deriveTableName, validateIdentifier, RELATION_KINDS, type RelationKind } from './ddl.ts';
import {
  listContentTypes,
  getContentType,
  getFields,
  getRelations,
  type ContentTypeRow,
  type FieldRow,
  type RelationRow,
} from './content-type.repository.ts';
import {
  listComponentTypes,
  getComponentType,
  getComponentFields,
  type ComponentTypeRow,
  type ComponentFieldRow,
} from './component-type.repository.ts';
import { isComponentFieldKind, type CmsType, type ComponentFieldKind } from './type.catalog.ts';

/**
 * THE RAM SOURCE OF TRUTH at runtime. Built at boot from `content_types` + `content_type_fields`, the
 * {@link Registry} holds a per-type {@link ContentTypeDef} that drives EVERYTHING downstream — the
 * engine `define`, the loader's typed coercion, the body validator, and the write repo — so they can
 * never diverge from the DB schema. Every SQL identifier those modules use (table + column names)
 * comes ONLY from a def built here (validated at create time, re-validated here), never from client
 * input.
 *
 * Each def's field order is the BYTE-IDENTICAL contract: the three system columns (id/created_at/
 * updated_at, mirroring `ddl.ts` compileCreateTable) first, then user fields in `sort` order.
 */

/** The three system columns the DDL generator always prepends — synthesized here in the SAME order. */
export const SYSTEM_FIELDS: readonly FieldDef[] = [
  { name: 'id', type: 'i32' },
  { name: 'created_at', type: 'date' },
  { name: 'updated_at', type: 'date' },
];

// The physical system columns a write body may NOT spoof. NOTE: distinct from SYSTEM_FIELDS above —
// document_id is a physical column + body-reject only, deliberately NOT a projected field (loader-skip).
// `published_at` (Draft & Publish): reject it in a public write body on EVERY type (uniform mass-assignment
// guard) so a client can never spoof publish state through POST/PUT — only the publish/unpublish endpoints
// set it. Distinct from the article seed's USER field `publishedAt` (camelCase), which stays writable.
// `locale` (i18n system column): reject it in a public write body on EVERY type so a client can never
// spoof a variant's locale through POST/PUT — only the variant-create verb (a later slice) sets it.
const SYSTEM_COLUMN_NAMES: ReadonlySet<string> = new Set(['id', 'document_id', 'created_at', 'updated_at', 'published_at', 'locale']);

/** The closed set of valid engine column types (engine_type IS a ColumnType 1:1, validated against this). */
const KNOWN_COLUMN_TYPES: ReadonlySet<string> = new Set<ColumnType>([
  'i32',
  'f64',
  'bool',
  'string',
  'date',
  'text',
  'i64',
  'decimal',
  'json',
]);

/** Re-exported so callers can guard on a system column name without re-deriving the set. */
export { SYSTEM_COLUMN_NAMES };

/**
 * A typed, field-scoped registry error. References the api_id + offending field NAME only — never any
 * SQL / Postgres detail — so corrupt / forward-incompatible meta fails LOUD at boot without a leak.
 */
export class RegistryError extends Error {
  readonly apiId: string;
  readonly field: string;
  constructor(apiId: string, field: string, reason: string) {
    super(`content-type "${apiId}" field "${field}": ${reason}`);
    this.name = 'RegistryError';
    this.apiId = apiId;
    this.field = field;
  }
}

/** One field of a content-type, fully resolved for load / validate / write. */
export interface RegistryField {
  /** Engine field name == Postgres column name (verbatim, no snake_case map). */
  name: string;
  /** The physical Postgres column name (=== name; carried explicitly so no caller assumes equality). */
  column: string;
  /** Engine ColumnType (built directly from the validated engine_type). */
  type: ColumnType;
  cmsType: CmsType;
  nullable: boolean;
  /** id/created_at/updated_at -> true: loaded + materialized, NEVER writable. */
  system: boolean;
  /** A DB default exists (default_value present, OR a system column with a DDL DEFAULT/serial). */
  hasDefault: boolean;
  /** decimal only. */
  scale?: number;
  precision?: number;
  /** enumeration members (params.values), if present. */
  enumValues?: readonly string[];
  /** varchar length (params.length), for the clean-400 length guard. */
  length?: number;
  /** type === 'json' (drives the `::text` SELECT cast on both load and RETURNING). */
  json: boolean;
  /**
   * be-04 MEDIA: present iff `cmsType === 'media'` — the field references the system `files` table by id.
   * `multiple:false` => SINGLE (an int4 column holding ONE positive files.id); `multiple:true` => MULTIPLE
   * (a jsonb array of ids). Absent for every non-media field. The body parser reads it (positive-int4 +
   * cardinality check), and the media-populate post-step reads it (resolve the id(s) against `files`).
   */
  media?: { multiple: boolean };
  /**
   * be-05 COMPONENT: present iff `cmsType` is a component kind (component / component-repeatable /
   * dynamiczone). The field IS a plain `json` column in `fields`/`fieldDefs`/`writable` (the inline
   * component tree, emitted verbatim un-populated) — `field.json` is already true. This only records the
   * structural intent the recursive write validator + the read populate post-step (next phases) read:
   * `kind` selects single-vs-array-vs-dynamiczone, `component` is the single ref, `components` the
   * dynamic-zone allowed-set. Absent for every non-component field.
   */
  component?: { kind: ComponentFieldKind; component?: string; components?: readonly string[] };
  /**
   * be-05b RELATION-INSIDE-COMPONENT: present iff `cmsType === 'relation'` (a component field only) — an
   * INLINE id ref to a target content-type. The field IS a plain `json` column (`field.json===true`),
   * emitted verbatim un-populated. `target` is the referenced content-type api_id; `multiple` selects
   * single-id vs array-of-ids cardinality. The body parser reads it (positive-int4 + cardinality), the
   * write existence-check reads it (the id(s) must exist in the TARGET ct_ table), and the read populate
   * post-step reads it (resolve the id(s) via the engine, applying target draft/publish + locale
   * visibility). Absent for every non-relation field. NOTE this is NOT a be-01 link-table relation.
   */
  relationRef?: { target: string; multiple: boolean };
  /**
   * i18n: true => the field is localized (each locale variant carries its own value); false => shared
   * across the document's locale variants (write-side fan-out keeps siblings in sync — a later slice).
   * Always true for a user field on a non-i18n type (no variants exist, so it is moot); system fields
   * (incl. the synthesized `locale` itself) are never per-field-localized => false.
   */
  localized: boolean;
}

/** A positional coercion descriptor (parallel to {@link ContentTypeDef.fields}) for the loader hot path. */
export interface ColumnDescriptor {
  name: string;
  kind: 'id' | 'i64' | 'decimal' | 'date' | 'json' | 'passthrough';
  scale?: number | undefined;
  precision?: number | undefined;
}

/** The index plan: eq-indexed fields and sorted-indexed fields (a pure function of the schema). */
export interface IndexPlan {
  eq: string[];
  sorted: string[];
}

/**
 * One relation declared on this content-type SIDE — METADATA ONLY (this slice). The edge data lives in
 * `linkTable`; loading edges into the CSR / building Relation objects is the NEXT slice. The read arena
 * is byte-identical with or without relations (a relation emits NO ct_ column and NO FieldDef).
 */
export interface RelationMeta {
  /** API key on this side. */
  field: string;
  kind: RelationKind;
  targetApiId: string;
  /** true => this side emitted the link-table DDL. */
  isOwner: boolean;
  /** present => two-way (the partner field on the target). */
  inverseField?: string;
  /** the resolved physical link-table name (read verbatim from meta, never re-derived). */
  linkTable: string;
  sort: number;
}

/** A content-type fully resolved for the runtime — the unit the registry hands to every consumer. */
export interface ContentTypeDef {
  /** The canonical stored api_id (the engine + registry key). */
  apiId: string;
  /** 'ct_'+apiId (re-validated via deriveTableName at build). */
  tableName: string;
  /** SYSTEM_FIELDS first, then user fields by sort. */
  fields: RegistryField[];
  /** Projection for engine.define (name, type, scale?, precision?), in `fields` order. */
  fieldDefs: FieldDef[];
  /** User (writable) fields only. */
  writable: RegistryField[];
  writableByName: Map<string, RegistryField>;
  /** Writable field names that accept NULL. */
  nullableNames: ReadonlySet<string>;
  /** User fields that MUST be present on create (NOT NULL && no default). */
  requiredOnCreate: readonly string[];
  /** Positional coercion plan, parallel to `fields`. */
  columnPlan: ColumnDescriptor[];
  indexPlan: IndexPlan;
  /**
   * Relations declared on this type, in `sort` order — METADATA ONLY (no edges loaded, no Relation
   * objects built this slice). NOT folded into fields/fieldDefs/columnPlan/writable: the read arena stays
   * byte-identical. NOTE (deferred): `schemaVersion` (engine trackSchema) intentionally does NOT bump on
   * a relation declaration in this slice — relations emit no FieldDef / no ct_ column, so the unpopulated
   * read arena, sort, and keyset cursors are unchanged and plain cursors stay valid. TODO slice 4/5
   * (populate + relational filtering): fold the relation set into the schema-shape hash / populated-
   * response cache key so a relation add/drop invalidates populated cursors / cached envelopes.
   */
  relations: RelationMeta[];
  /** O(1) relation lookup by this side's field name. */
  relationsByField: Map<string, RelationMeta>;
  /**
   * be-04 MEDIA: O(1) lookup of this type's media fields by field name -> cardinality. A media field IS
   * a plain scalar column in `fields`/`fieldDefs`/`writable` (an int4 single / jsonb-array multiple) — it
   * is NOT excluded from the engine like a relation. This map is the seam the body parser uses (positive-
   * int4 + cardinality validation) and the read-path media-populate post-step uses (which fields to
   * resolve against `files`, and whether to inline ONE object or an ARRAY). Empty for a type with no
   * media field => the populate post-step is skipped entirely (byte-identical read path).
   */
  mediaFields: Map<string, { multiple: boolean }>;
  /**
   * be-05 COMPONENT: O(1) lookup of this type's component / component-repeatable / dynamiczone fields by
   * field name -> structural intent. A component field IS a plain json column in `fields`/`writable`, so
   * this is purely the seam the recursive write validator + read populate post-step (next phases) use to
   * decide which fields carry inline component trees + against which component schema(s) to validate /
   * populate. Empty for a type with no component field => that machinery is skipped (byte-identical read).
   */
  componentFields: Map<string, { kind: ComponentFieldKind; component?: string; components?: readonly string[] }>;
  /**
   * Model A Draft & Publish opt-in (per-type). When true, a synthesized nullable `published_at` system
   * field is appended to `fields` (after the 3 base system fields, before user fields — matching the DDL
   * column order), and the read path defaults to published-only. When false, NO `published_at` field is
   * synthesized => no FieldDef/column/SELECT/wire key/index — the read arena is BYTE-IDENTICAL to today.
   */
  draftPublish: boolean;
  /**
   * i18n opt-in (per-type). When true, the synthesized `document_id` (i32) + `locale` (string) system
   * fields are appended to `fields` (so document_id un-skips from the be-02b loader-skip: it loads as a
   * queryable i32 column + eq-index + wire-emitted, and locale loads + eq-indexes + emits), and the read
   * path supports a `locale` filter (default DEFAULT_LOCALE). When false, NEITHER is synthesized => no
   * FieldDef/column/SELECT/wire key/index for them — the read arena is BYTE-IDENTICAL to today (the
   * be-02b document_id loader-skip stays in force).
   */
  i18n: boolean;
}

/** Map a positive number out of a jsonb `params` object, or undefined (presence check; 0 is valid). */
function numberParam(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Build the {@link RegistryField} for one user field row, validating engine_type + decimal params and
 * re-validating the identifier (defense-in-depth). Throws {@link RegistryError} on anything corrupt.
 */
function buildUserField(apiId: string, row: FieldRow): RegistryField {
  // Belt-and-suspenders: a field NAME that somehow slipped past create-time validation is rejected here
  // before it ever becomes a SQL identifier.
  try {
    validateIdentifier(row.name);
  } catch {
    throw new RegistryError(apiId, String(row.name), 'invalid identifier');
  }
  if (!KNOWN_COLUMN_TYPES.has(row.engine_type)) {
    throw new RegistryError(apiId, row.name, `unknown engine_type "${row.engine_type}"`);
  }
  const type = row.engine_type as ColumnType;
  const cmsType = row.cms_type as CmsType;

  // `time` resolves to engineType i32, but postgres.js returns a STRING for a `time` column — feeding
  // that string into an Int32Array would silently NaN. Fail LOUD: this load path does not support it.
  if (cmsType === 'time') {
    throw new RegistryError(apiId, row.name, 'time is not supported on the load path');
  }

  const params = (row.params ?? {}) as Record<string, unknown>;
  const field: RegistryField = {
    name: row.name,
    column: row.name,
    type,
    cmsType,
    nullable: row.nullable,
    system: false,
    hasDefault: row.default_value !== null,
    json: type === 'json',
    localized: row.localized,
  };

  if (type === 'decimal') {
    const scale = numberParam(params, 'scale');
    if (scale === undefined) throw new RegistryError(apiId, row.name, 'decimal field is missing scale');
    // Bound-check before it reaches the I64Column ctor (scale must be 0..18) so corrupt / forward-
    // incompatible meta fails LOUD here as a typed, field-scoped RegistryError, never as a raw column error.
    if (!Number.isInteger(scale) || scale < 0 || scale > 18) {
      throw new RegistryError(apiId, row.name, 'decimal scale out of range');
    }
    field.scale = scale;
    const precision = numberParam(params, 'precision');
    if (precision !== undefined) {
      if (!Number.isInteger(precision) || precision < 1 || precision < scale) {
        throw new RegistryError(apiId, row.name, 'decimal precision out of range');
      }
      field.precision = precision;
    }
  }
  const values = params['values'];
  if (Array.isArray(values)) field.enumValues = values as string[];
  const length = numberParam(params, 'length');
  if (length !== undefined) {
    if (!Number.isInteger(length) || length < 1) {
      throw new RegistryError(apiId, row.name, 'length out of range');
    }
    field.length = length;
  }
  // be-04 MEDIA: tag the field as a media reference (single int4 / multiple jsonb) from its catalog
  // params. The engine_type already drove `type` (i32 or json) above — this only adds the cardinality
  // flag the body parser + populate post-step read. A multiple-media field IS a json column, so
  // `field.json` is already true (RETURNING/SELECT ::text cast applies) — correct, no special-case.
  if (cmsType === 'media') {
    field.media = { multiple: params['multiple'] === true };
  }
  // be-05b RELATION-INSIDE-COMPONENT: tag an inline relation ref from its catalog params. engine_type is
  // `json` (set above) so the column loads/serializes as RawJson verbatim — exactly like a media-multiple
  // / component field. Checked BEFORE the component arm because `relation` IS a ComponentFieldKind, but it
  // is NOT a structural component (no nested instance tree) so it must NOT populate `field.component`.
  if (row.cms_type === 'relation') {
    field.relationRef = { target: params['target'] as string, multiple: params['multiple'] === true };
  } else if (isComponentFieldKind(row.cms_type)) {
    // be-05 COMPONENT: tag the field with its structural intent from the catalog params. engine_type is
    // `json` (set above), so `type==='json'` + `field.json===true` already — the column loads/serializes as
    // RawJson verbatim with NO engine change. This only records kind + the referenced component api_id(s).
    const kind = row.cms_type as ComponentFieldKind;
    const c: { kind: ComponentFieldKind; component?: string; components?: readonly string[] } = { kind };
    if (typeof params['component'] === 'string') c.component = params['component'];
    if (Array.isArray(params['components'])) c.components = params['components'] as string[];
    field.component = c;
  }

  return field;
}

/** The synthesized system field (always present, never writable, always has a DB default). */
function systemField(def: FieldDef): RegistryField {
  return {
    name: def.name,
    column: def.name,
    type: def.type,
    cmsType: def.name === 'id' ? 'integer' : 'datetime',
    nullable: false,
    system: true,
    hasDefault: true,
    json: false,
    localized: false,
  };
}

/**
 * The synthesized Draft & Publish `published_at` system field. UNLIKE {@link systemField} it is
 * NULLABLE (NULL = draft) and carries `hasDefault:true` (kept out of requiredOnCreate) + `system:true`
 * (kept out of `writable`, so the body parser never accepts it and create never requires it). Engine
 * type `date` => it loads, coerces, and serializes (ISO-or-null) exactly like created_at/updated_at.
 */
function publishedAtField(): RegistryField {
  return {
    name: 'published_at',
    column: 'published_at',
    type: 'date',
    cmsType: 'datetime',
    nullable: true,
    system: true,
    hasDefault: true,
    json: false,
    localized: false,
  };
}

/**
 * The synthesized i18n `document_id` system field (i18n types ONLY). UN-SKIPS the be-02b loader-skip:
 * for an i18n type document_id loads as a queryable i32 column, is eq-indexed (variant grouping
 * `WHERE document_id = X` is O(1)), and is emitted on the wire as a plain JSON NUMBER. `system:true`
 * (never writable / never required on create), `hasDefault:true` (the column DEFAULTs to
 * nextval('document_id_seq')). `localized:false` — document_id is the SHARED grouping key across variants.
 * For a non-i18n type this field is NOT synthesized => document_id stays loader-skipped (byte-identical).
 */
function documentIdField(): RegistryField {
  return {
    name: 'document_id',
    column: 'document_id',
    type: 'i32',
    cmsType: 'integer',
    nullable: false,
    system: true,
    hasDefault: true,
    json: false,
    localized: false,
  };
}

/**
 * The synthesized i18n `locale` system field (i18n types ONLY). NOT NULL, server-controlled (the write
 * path sets it; `system:true` keeps it out of `writable`, and SYSTEM_COLUMN_NAMES rejects it in a body).
 * Loaded as a string column, eq-indexed (so the `locale` filter is index-backed), emitted on the wire.
 * `hasDefault:false` — the server always supplies a locale (a plain create uses the request/default
 * locale, a variant create the addressed locale); it is never auto-defaulted by the DB.
 */
function localeField(): RegistryField {
  return {
    name: 'locale',
    column: 'locale',
    type: 'string',
    cmsType: 'string',
    nullable: false,
    system: true,
    hasDefault: false,
    json: false,
    localized: false,
    length: 35,
  };
}

/** Build the positional {@link ColumnDescriptor} for a resolved field (lockstep with `fields`). */
function descriptorFor(f: RegistryField): ColumnDescriptor {
  if (f.system && f.name === 'id') return { name: f.name, kind: 'id' };
  if (f.type === 'i64') return { name: f.name, kind: 'i64' };
  if (f.type === 'decimal') return { name: f.name, kind: 'decimal', scale: f.scale, precision: f.precision };
  if (f.type === 'json') return { name: f.name, kind: 'json' };
  if (f.type === 'date') return { name: f.name, kind: 'date' };
  return { name: f.name, kind: 'passthrough' };
}

/**
 * The index policy — a PURE function of engineType + enum/length flags:
 *   - eq ALWAYS on `id` (respondById invariant).
 *   - eq on `bool` fields and on `string` fields that are enumerations (params.values present).
 *   - sorted on i32/f64/date/i64/decimal.
 *   - NEVER index json; plain string/text/uuid (non-enum) are unindexed (dictionary scan).
 */
function buildIndexPlan(fields: RegistryField[]): IndexPlan {
  const eq: string[] = [];
  const sorted: string[] = [];
  for (const f of fields) {
    if (f.name === 'id') {
      eq.push(f.name);
      continue;
    }
    // Draft & Publish status filtering is purely `published_at IS [NOT] NULL`, resolved DIRECTLY from
    // the per-column null bitset (table.ts fillPredicate) — O(words), no scan, no eq/sorted index. A
    // sorted index on `published_at` would only help sort/range queries the status path never issues, so
    // skip indexing it (mirrors the json skip). Flip to `sorted` here if a future product wants sort-by-
    // publish-date; the status predicate stays bitset-served either way.
    if (f.name === 'published_at') continue;
    // i18n: `document_id` is the variant-grouping key — eq-index it so `WHERE document_id = X` is O(1)
    // (write-side fan-out + variant create lean on it). `locale` is eq-filtered by the read router — eq-
    // index it so the locale predicate is index-backed (not a dictionary scan). Both ONLY exist in
    // `fields` for an i18n type, so a non-i18n type's index plan never sees them (byte-identical).
    if (f.name === 'document_id') {
      eq.push(f.name);
      continue;
    }
    if (f.name === 'locale') {
      eq.push(f.name);
      continue;
    }
    if (f.type === 'json') continue;
    if (f.type === 'bool' || (f.type === 'string' && f.enumValues !== undefined)) {
      eq.push(f.name);
      continue;
    }
    if (f.type === 'i32' || f.type === 'f64' || f.type === 'date' || f.type === 'i64' || f.type === 'decimal') {
      sorted.push(f.name);
    }
  }
  return { eq, sorted };
}

/**
 * Build a {@link RelationMeta} from a relation row, re-validating identifiers + kind (defense-in-depth,
 * fail LOUD via {@link RegistryError}). NO edges loaded, NO Relation object built.
 */
function buildRelation(apiId: string, row: RelationRow): RelationMeta {
  try {
    validateIdentifier(row.field_name);
  } catch {
    throw new RegistryError(apiId, String(row.field_name), 'invalid relation field identifier');
  }
  try {
    validateIdentifier(row.link_table);
  } catch {
    throw new RegistryError(apiId, row.field_name, 'invalid link_table identifier');
  }
  if (!RELATION_KINDS.has(row.kind)) {
    throw new RegistryError(apiId, row.field_name, `unknown relation kind "${row.kind}"`);
  }
  const meta: RelationMeta = {
    field: row.field_name,
    kind: row.kind as RelationKind,
    targetApiId: row.target_api_id,
    isOwner: row.is_owner,
    linkTable: row.link_table,
    sort: row.sort,
  };
  if (row.inverse_field !== null) meta.inverseField = row.inverse_field;
  return meta;
}

/** Assemble a full {@link ContentTypeDef} from a content_types row + its user field rows + relation rows. */
function buildDef(ct: ContentTypeRow, fieldRows: FieldRow[], relationRows: RelationRow[]): ContentTypeDef {
  // Re-derive the table name (re-validates the api_id identifier — defense-in-depth) rather than
  // trusting the stored table_name verbatim.
  const tableName = deriveTableName(ct.api_id);

  const fields: RegistryField[] = SYSTEM_FIELDS.map(systemField);
  // i18n opt-in: un-skip the synthesized `document_id` system field (be-02b loader-skip becomes
  // conditional) BEFORE the published_at push. For a non-i18n type NO document_id field is pushed => it
  // stays loader-skipped (not loaded/indexed/emitted) — the read arena is byte-identical.
  if (ct.i18n) fields.push(documentIdField());
  // D&P opt-in: append the synthesized `published_at` system field AFTER the base system fields and
  // BEFORE user fields — matching the physical DDL column order. For a non-D&P type NO field is pushed.
  if (ct.draft_publish) fields.push(publishedAtField());
  // i18n opt-in: append the synthesized `locale` system field after published_at, before user fields
  // (matching the DDL column order). For a non-i18n type NO locale field is pushed (byte-identical).
  if (ct.i18n) fields.push(localeField());
  for (const row of fieldRows) fields.push(buildUserField(ct.api_id, row));

  const fieldDefs: FieldDef[] = fields.map((f) => ({
    name: f.name,
    type: f.type,
    ...(f.scale !== undefined ? { scale: f.scale } : {}),
    ...(f.precision !== undefined ? { precision: f.precision } : {}),
  }));

  const writable = fields.filter((f) => !f.system);
  const writableByName = new Map<string, RegistryField>(writable.map((f) => [f.name, f]));
  const nullableNames = new Set<string>(writable.filter((f) => f.nullable).map((f) => f.name));
  const requiredOnCreate = writable.filter((f) => !f.nullable && !f.hasDefault).map((f) => f.name);
  const columnPlan = fields.map(descriptorFor);
  const indexPlan = buildIndexPlan(fields);

  // Relations are METADATA ONLY here: built from meta (already sort-ordered by getRelations), NOT folded
  // into fields/fieldDefs/columnPlan/writable — the read arena stays byte-identical.
  const relations = relationRows.map((r) => buildRelation(ct.api_id, r));
  const relationsByField = new Map<string, RelationMeta>(relations.map((r) => [r.field, r]));

  // be-04 MEDIA: index the media fields (a SUBSET of `writable`, since a media field is a real column).
  const mediaFields = new Map<string, { multiple: boolean }>();
  for (const f of writable) if (f.media !== undefined) mediaFields.set(f.name, f.media);

  // be-05 COMPONENT: index the component fields (a SUBSET of `writable`; each IS a json column).
  const componentFields = new Map<string, { kind: ComponentFieldKind; component?: string; components?: readonly string[] }>();
  for (const f of writable) if (f.component !== undefined) componentFields.set(f.name, f.component);

  return {
    apiId: ct.api_id,
    tableName,
    fields,
    fieldDefs,
    writable,
    writableByName,
    nullableNames,
    requiredOnCreate,
    columnPlan,
    indexPlan,
    relations,
    relationsByField,
    mediaFields,
    componentFields,
    draftPublish: ct.draft_publish,
    i18n: ct.i18n,
  };
}

/**
 * be-05 — a COMPONENT type resolved for the runtime: its api_id + its fields (each a {@link RegistryField},
 * reusing the same builder as a content-type user field). A component has NO physical table / NO engine
 * presence, so a {@link ComponentDef} carries NO fieldDefs/columnPlan/indexPlan — only the field SHAPE the
 * recursive write validator + read populate post-step (next phases) walk. `requiredOnCreate` mirrors a
 * content-type's: a NOT-NULL field with no default must be present in a component instance.
 */
export interface ComponentDef {
  apiId: string;
  fields: RegistryField[];
  fieldsByName: Map<string, RegistryField>;
  nullableNames: ReadonlySet<string>;
  requiredOnCreate: readonly string[];
  /** Component / dynamiczone fields nested INSIDE this component (the recursion seam). */
  componentFields: Map<string, { kind: ComponentFieldKind; component?: string; components?: readonly string[] }>;
  /** Media fields inside this component (inline id refs; the populate seam). */
  mediaFields: Map<string, { multiple: boolean }>;
  /**
   * be-05b: relation-ref fields inside this component (inline content-type id refs; the write existence-
   * check + read populate seam). Empty for a component with no relation field => those walks are no-ops.
   */
  relationRefFields: Map<string, { target: string; multiple: boolean }>;
}

/** Assemble a {@link ComponentDef} from a component_types row + its field rows (reuses buildUserField). */
function buildComponentDef(cmp: ComponentTypeRow, fieldRows: ComponentFieldRow[]): ComponentDef {
  // A component field row has no pg_type/engine_type column; buildUserField reads `engine_type`, so adapt:
  // a scalar's engine intent is re-derived nowhere here — instead we build a FieldRow-shaped object whose
  // engine_type is `json` for a component/media-multiple field and otherwise resolved from the catalog.
  const fields = fieldRows.map((r) => buildUserField(cmp.api_id, componentRowToFieldRow(r)));
  const fieldsByName = new Map<string, RegistryField>(fields.map((f) => [f.name, f]));
  const nullableNames = new Set<string>(fields.filter((f) => f.nullable).map((f) => f.name));
  const requiredOnCreate = fields.filter((f) => !f.nullable && !f.hasDefault).map((f) => f.name);
  const componentFields = new Map<string, { kind: ComponentFieldKind; component?: string; components?: readonly string[] }>();
  for (const f of fields) if (f.component !== undefined) componentFields.set(f.name, f.component);
  const mediaFields = new Map<string, { multiple: boolean }>();
  for (const f of fields) if (f.media !== undefined) mediaFields.set(f.name, f.media);
  const relationRefFields = new Map<string, { target: string; multiple: boolean }>();
  for (const f of fields) if (f.relationRef !== undefined) relationRefFields.set(f.name, f.relationRef);
  return { apiId: cmp.api_id, fields, fieldsByName, nullableNames, requiredOnCreate, componentFields, mediaFields, relationRefFields };
}

/**
 * Adapt a {@link ComponentFieldRow} (no pg_type/engine_type) to the {@link FieldRow} shape buildUserField
 * expects. The engine_type is re-derived from the catalog: a component kind / media-multiple / json is
 * `json`; otherwise the scalar's resolved engine intent. A component field never has a constant default.
 */
function componentRowToFieldRow(r: ComponentFieldRow): FieldRow {
  const engineType = componentEngineType(r);
  return {
    id: r.id,
    content_type_id: r.component_type_id,
    name: r.name,
    cms_type: r.cms_type,
    pg_type: 'jsonb',
    engine_type: engineType,
    nullable: r.nullable,
    sort: r.sort,
    default_value: null,
    params: r.params ?? {},
    localized: false,
  };
}

/** The engine_type for a component field (so buildUserField's KNOWN_COLUMN_TYPES gate passes). */
function componentEngineType(r: ComponentFieldRow): string {
  if (isComponentFieldKind(r.cms_type)) return 'json';
  // media multiple -> json; media single -> i32 (mirrors the catalog).
  if (r.cms_type === 'media') return (r.params?.['multiple'] === true ? 'json' : 'i32');
  const m: Record<string, string> = {
    string: 'string', email: 'string', uid: 'string', enumeration: 'string', uuid: 'string',
    text: 'text', integer: 'i32', biginteger: 'i64', float: 'f64', decimal: 'decimal',
    boolean: 'bool', date: 'date', datetime: 'date', time: 'i32', json: 'json', array: 'json',
  };
  return m[r.cms_type] ?? 'json';
}

/**
 * The content-type registry: O(1) lookup by api_id, built from meta with exactly two query CLASSES
 * (listContentTypes + getFields-per-type) and per-type rebuild on a schema change / write.
 */
export class Registry {
  private readonly byApiId = new Map<string, ContentTypeDef>();
  /** be-05: the parallel component-type store (no engine presence; pure schema for write/populate walks). */
  private readonly components = new Map<string, ComponentDef>();

  /** Is a content-type by this api_id known? (mirrors engine.has — same canonical key). */
  has(apiId: string): boolean {
    return this.byApiId.has(apiId);
  }

  /** O(1) def lookup, or undefined. */
  get(apiId: string): ContentTypeDef | undefined {
    return this.byApiId.get(apiId);
  }

  /** Every def, in build order. */
  all(): ContentTypeDef[] {
    return [...this.byApiId.values()];
  }

  /** be-05: O(1) component def lookup by api_id, or undefined. */
  getComponent(apiId: string): ComponentDef | undefined {
    return this.components.get(apiId);
  }

  /** be-05: is a component type by this api_id known? */
  hasComponent(apiId: string): boolean {
    return this.components.has(apiId);
  }

  /** be-05: every component def, in build order. */
  allComponents(): ComponentDef[] {
    return [...this.components.values()];
  }

  /** Build the WHOLE registry from meta. Empty catalog is valid (an empty registry). */
  static async build(sql: Sql): Promise<Registry> {
    const reg = new Registry();
    // be-05: build component defs FIRST so a content-type / component referencing one can resolve it.
    const components = await listComponentTypes(sql);
    for (const cmp of components) {
      const fieldRows = await getComponentFields(sql, cmp.id);
      reg.components.set(cmp.api_id, buildComponentDef(cmp, fieldRows));
    }
    const types = await listContentTypes(sql);
    for (const ct of types) {
      const fieldRows = await getFields(sql, ct.id);
      const relationRows = await getRelations(sql, ct.id);
      reg.byApiId.set(ct.api_id, buildDef(ct, fieldRows, relationRows));
    }
    return reg;
  }

  /**
   * be-05: rebuild ONE component def fresh from the DB (the per-component create/addField/dropField hook)
   * and replace the map entry. Throws {@link RegistryError} if the component vanished.
   */
  async rebuildComponent(sql: Sql, apiId: string): Promise<ComponentDef> {
    const cmp = await getComponentType(sql, apiId);
    if (cmp === null) throw new RegistryError(apiId, '', 'component-type not found on rebuild');
    const fieldRows = await getComponentFields(sql, cmp.id);
    const def = buildComponentDef(cmp, fieldRows);
    this.components.set(def.apiId, def);
    return def;
  }

  /** be-05: remove ONE component def (the drop hook). Returns whether it was present. */
  removeComponent(apiId: string): boolean {
    return this.components.delete(apiId);
  }

  /**
   * Rebuild ONE type's def fresh from the DB (the per-type schema-change / write hook) and replace the
   * map entry. Re-reads getContentType + getFields so a rename / drop / type change reflects fresh,
   * never patched in place. Throws {@link RegistryError} if the type vanished.
   */
  async rebuildType(sql: Sql, apiId: string): Promise<ContentTypeDef> {
    const ct = await getContentType(sql, apiId);
    if (ct === null) throw new RegistryError(apiId, '', 'content-type not found on rebuild');
    const fieldRows = await getFields(sql, ct.id);
    const relationRows = await getRelations(sql, ct.id);
    const def = buildDef(ct, fieldRows, relationRows);
    this.byApiId.set(def.apiId, def);
    return def;
  }

  /** Remove ONE type's def (the drop hook). Returns whether it was present (false signals a desync). */
  removeType(apiId: string): boolean {
    return this.byApiId.delete(apiId);
  }
}
