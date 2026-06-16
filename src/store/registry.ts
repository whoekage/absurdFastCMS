import type { Sql } from 'postgres';
import type { ColumnType } from './column.ts';
import type { FieldDef } from './table.ts';
import { deriveTableName, validateIdentifier } from '../db/ddl.ts';
import {
  listContentTypes,
  getContentType,
  getFields,
  type ContentTypeRow,
  type FieldRow,
} from '../db/content-type-repo.ts';
import type { CmsType } from '../db/type-catalog.ts';

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

const SYSTEM_COLUMN_NAMES: ReadonlySet<string> = new Set(['id', 'created_at', 'updated_at']);

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
}

/** A positional coercion descriptor (parallel to {@link ContentTypeDef.fields}) for the loader hot path. */
export interface ColumnDescriptor {
  name: string;
  kind: 'id' | 'i64' | 'decimal' | 'date' | 'json' | 'passthrough';
  scale?: number;
  precision?: number;
}

/** The index plan: eq-indexed fields and sorted-indexed fields (a pure function of the schema). */
export interface IndexPlan {
  eq: string[];
  sorted: string[];
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

/** Assemble a full {@link ContentTypeDef} from a content_types row + its user field rows. */
function buildDef(ct: ContentTypeRow, fieldRows: FieldRow[]): ContentTypeDef {
  // Re-derive the table name (re-validates the api_id identifier — defense-in-depth) rather than
  // trusting the stored table_name verbatim.
  const tableName = deriveTableName(ct.api_id);

  const fields: RegistryField[] = SYSTEM_FIELDS.map(systemField);
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
  };
}

/**
 * The content-type registry: O(1) lookup by api_id, built from meta with exactly two query CLASSES
 * (listContentTypes + getFields-per-type) and per-type rebuild on a schema change / write.
 */
export class Registry {
  private readonly byApiId = new Map<string, ContentTypeDef>();

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

  /** Build the WHOLE registry from meta. Empty catalog is valid (an empty registry). */
  static async build(sql: Sql): Promise<Registry> {
    const reg = new Registry();
    const types = await listContentTypes(sql);
    for (const ct of types) {
      const fieldRows = await getFields(sql, ct.id);
      reg.byApiId.set(ct.api_id, buildDef(ct, fieldRows));
    }
    return reg;
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
    const def = buildDef(ct, fieldRows);
    this.byApiId.set(def.apiId, def);
    return def;
  }

  /** Remove ONE type's def (the drop hook). Returns whether it was present (false signals a desync). */
  removeType(apiId: string): boolean {
    return this.byApiId.delete(apiId);
  }
}
