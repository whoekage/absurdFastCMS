import type { ColumnType } from '../store/column.ts';

/**
 * The SINGLE source of the `cms_type -> { pgType, engineType, params }` mapping. Both the DDL
 * generator (src/db/ddl.ts) and the meta writer (src/db/content-type-repo.ts) derive every per-type
 * decision from here, so the rendered Postgres column and the `content_type_fields` row can never
 * diverge. This module renders a pg TYPE LITERAL string (e.g. `numeric(10,2)`) that the Kysely
 * builder drops in via its `sql\`\`` escape hatch — it never speaks SQL itself, and never touches a
 * connection.
 *
 * postgres.js parsing contract this catalog relies on (do NOT add a global type parser): int8 /
 * numeric / uuid come back as STRING, timestamptz as Date, date as STRING `YYYY-MM-DD`, jsonb as a
 * parsed JS value. The intent-only engine strings (`i64`/`decimal`/`json`) are NEVER passed to the
 * engine's `createColumn` — they describe how a LATER step will ingest the column.
 */

/** The closed set of CMS field types a user may define. Relation/media/component/etc. are NOT here. */
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
 * The engine INTENT recorded in `content_type_fields.engine_type`: the six real {@link ColumnType}s
 * PLUS three intent-only strings (`i64`/`decimal`/`json`) kept deliberately SEPARATE from the engine
 * union. The intent-only strings are never fed to `createColumn`/`engine.define` in this step (a
 * guard test asserts it); they exist so a later ingest step knows a `bigint` must be read with
 * `BigInt` not `Number`, a `numeric` kept as an exact string, and a `jsonb` re-stringified.
 */
export type EngineTypeIntent = ColumnType | 'i64' | 'decimal' | 'json';

/** The three intent-only engine strings that must NEVER reach the engine column factory. */
export const INTENT_ONLY_ENGINE_TYPES: ReadonlySet<EngineTypeIntent> = new Set<EngineTypeIntent>(['i64', 'decimal', 'json']);

/** Per-field options the caller may supply; each cms_type validates only the keys it cares about. */
export interface FieldOptions {
  /** varchar length (char count) for string/email/uid/enumeration sizing. */
  length?: number;
  /** numeric total digits (decimal). */
  precision?: number;
  /** numeric fractional digits (decimal). */
  scale?: number;
  /** allowed members for `enumeration` (non-empty, distinct). */
  values?: string[];
  /** whether the column accepts NULL (defaults to true; see `nullable` in the resolved field). */
  nullable?: boolean;
  /** constant default value (volatile defaults like now()/gen_random_uuid() are rejected upstream). */
  default?: unknown;
}

/** A cms_type resolved against the catalog: the pg literal, the engine intent, and recorded params. */
export interface ResolvedType {
  cmsType: CmsType;
  pgType: string;
  engineType: EngineTypeIntent;
  params: Record<string, unknown>;
}

/** Thrown for any cms_type off the closed {@link CmsType} set (relation/media/component/dynamiczone). */
export class UnknownCmsTypeError extends Error {
  readonly cmsType: unknown;
  constructor(cmsType: unknown) {
    super(`unknown or unsupported content-type field type: ${String(cmsType)}`);
    this.name = 'UnknownCmsTypeError';
    this.cmsType = cmsType;
  }
}

/** Thrown for an out-of-bounds varchar/numeric option (length, precision, scale). */
export class TypeOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TypeOptionError';
  }
}

/** Thrown for an empty / duplicate / non-string `enumeration` value set. */
export class EnumValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnumValueError';
  }
}

// --- bounds (documented, never hard-coded at a call site) --------------------------------------

/** PG varchar(n) char-count ceiling (`character varying` max), and our minimum of 1. */
const VARCHAR_MAX = 10485760;
const DEFAULT_STRING_LENGTH = 255;
const DEFAULT_EMAIL_LENGTH = 254;
const DEFAULT_UID_LENGTH = 255;
/** Hard numeric ceilings from PG, plus our scaled-i64 cap so a `decimal` round-trips through int64. */
const NUMERIC_MAX_PRECISION = 1000;
export const DECIMAL_MAX_SAFE_PRECISION = 18;

/**
 * Volatile default expressions that force a table rewrite (and a non-deterministic baked value):
 * rejected in Step 2 — only CONSTANT defaults are allowed. Matched case-insensitively against the
 * function name, with or without a trailing `()`.
 */
export const VOLATILE_DEFAULT_NAMES: ReadonlySet<string> = new Set(['now', 'current_timestamp', 'gen_random_uuid', 'uuid_generate_v4', 'random', 'nextval', 'clock_timestamp', 'statement_timestamp', 'transaction_timestamp']);

/** Validate a positive integer option in `[min, max]`, else throw {@link TypeOptionError}. */
function intOption(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new TypeOptionError(`${name} must be an integer, got ${String(value)}`);
  if (value < min || value > max) throw new TypeOptionError(`${name} ${value} out of range [${min}, ${max}]`);
  return value;
}

/** Validate + dedup the `enumeration` value set; returns the distinct values and the longest length. */
function resolveEnum(options: FieldOptions | undefined): { values: string[]; maxLen: number } {
  const values = options?.values;
  if (!Array.isArray(values) || values.length === 0) throw new EnumValueError('enumeration requires a non-empty values[] array');
  const seen = new Set<string>();
  let maxLen = 1;
  for (const v of values) {
    if (typeof v !== 'string' || v.length === 0) throw new EnumValueError(`enumeration values must be non-empty strings, got ${String(v)}`);
    if (seen.has(v)) throw new EnumValueError(`duplicate enumeration value: ${v}`);
    seen.add(v);
    if (v.length > maxLen) maxLen = v.length;
  }
  return { values: [...seen], maxLen };
}

/**
 * The exhaustive mapper: every {@link CmsType} resolves here. The record `RESOLVERS` is constrained
 * with `satisfies Record<CmsType, ...>` so the compiler flags any unmapped member; an unknown value
 * throws {@link UnknownCmsTypeError} before any DDL string is built.
 */
const RESOLVERS = {
  string: (o) => ({ pgType: `varchar(${intOption(o?.length, 'length', 1, VARCHAR_MAX, DEFAULT_STRING_LENGTH)})`, engineType: 'string', params: { length: intOption(o?.length, 'length', 1, VARCHAR_MAX, DEFAULT_STRING_LENGTH) } }),
  text: () => ({ pgType: 'text', engineType: 'text', params: {} }),
  email: (o) => ({ pgType: `varchar(${intOption(o?.length, 'length', 1, VARCHAR_MAX, DEFAULT_EMAIL_LENGTH)})`, engineType: 'string', params: { length: intOption(o?.length, 'length', 1, VARCHAR_MAX, DEFAULT_EMAIL_LENGTH) } }),
  uid: (o) => ({ pgType: `varchar(${intOption(o?.length, 'length', 1, VARCHAR_MAX, DEFAULT_UID_LENGTH)})`, engineType: 'string', params: { length: intOption(o?.length, 'length', 1, VARCHAR_MAX, DEFAULT_UID_LENGTH) } }),
  enumeration: (o) => {
    const { values, maxLen } = resolveEnum(o);
    // varchar sized >= the longest value char length (so a member never trips 22001), CHECK added by ddl.
    const length = intOption(o?.length, 'length', maxLen, VARCHAR_MAX, maxLen);
    if (length < maxLen) throw new TypeOptionError(`enumeration length ${length} is shorter than the longest value (${maxLen})`);
    return { pgType: `varchar(${length})`, engineType: 'string', params: { values, length } };
  },
  integer: () => ({ pgType: 'integer', engineType: 'i32', params: {} }),
  biginteger: () => ({ pgType: 'bigint', engineType: 'i64', params: {} }),
  float: () => ({ pgType: 'double precision', engineType: 'f64', params: {} }),
  decimal: (o) => {
    const precision = intOption(o?.precision, 'precision', 1, NUMERIC_MAX_PRECISION, 10);
    const scale = intOption(o?.scale, 'scale', 0, precision, 2);
    if (scale > precision) throw new TypeOptionError(`decimal scale ${scale} exceeds precision ${precision}`);
    if (precision > DECIMAL_MAX_SAFE_PRECISION) throw new TypeOptionError(`decimal precision ${precision} exceeds the scaled-i64 cap (${DECIMAL_MAX_SAFE_PRECISION})`);
    return { pgType: `numeric(${precision},${scale})`, engineType: 'decimal', params: { precision, scale } };
  },
  boolean: () => ({ pgType: 'boolean', engineType: 'bool', params: {} }),
  date: () => ({ pgType: 'date', engineType: 'date', params: {} }),
  datetime: () => ({ pgType: 'timestamptz', engineType: 'date', params: {} }),
  time: () => ({ pgType: 'time', engineType: 'i32', params: {} }),
  json: () => ({ pgType: 'jsonb', engineType: 'json', params: {} }),
  array: () => ({ pgType: 'jsonb', engineType: 'json', params: {} }),
  uuid: () => ({ pgType: 'uuid', engineType: 'string', params: {} }),
} satisfies Record<CmsType, (o?: FieldOptions) => { pgType: string; engineType: EngineTypeIntent; params: Record<string, unknown> }>;

/**
 * Resolve a cms_type (+ options) into the pg literal, engine intent, and recorded params. Throws
 * {@link UnknownCmsTypeError} for any value off the closed set, {@link TypeOptionError} for bad
 * varchar/numeric options, {@link EnumValueError} for a bad enum set. Renders NO SQL — `pgType` is a
 * plain literal the DDL builder drops into a `sql\`\`` escape hatch.
 */
export function resolveType(cmsType: CmsType, options?: FieldOptions): ResolvedType {
  const resolver = (RESOLVERS as Record<string, ((o?: FieldOptions) => { pgType: string; engineType: EngineTypeIntent; params: Record<string, unknown> }) | undefined>)[cmsType as string];
  if (resolver === undefined) throw new UnknownCmsTypeError(cmsType);
  const r = resolver(options);
  return { cmsType, pgType: r.pgType, engineType: r.engineType, params: r.params };
}

/**
 * Classify a type transition for the rewrite-aware future step. `metadata-only` = binary-coercible /
 * widening (no table rewrite, e.g. varchar grow, varchar -> text). `rewrite` = a full table rewrite
 * or a lossy/narrowing cast (int4 -> int8, numeric scale change, text -> int, varchar shrink,
 * timestamptz precision narrow). `forbidden` = the engine intent itself changed in a way Step 2 will
 * never attempt. STEP 2 CALLERS REJECT both `rewrite` AND `forbidden`; the signal exists for later.
 */
export function classifyTypeChange(from: ResolvedType, to: ResolvedType): 'metadata-only' | 'rewrite' | 'forbidden' {
  // CHECK / semantics guard (runs BEFORE the pgType-equality shortcut): an identical rendered pgType
  // does NOT make a change metadata-only when the enum CHECK members or the cms_type semantics differ.
  // A plain ALTER COLUMN TYPE never touches the existing CHECK constraint, so any transition that
  // would require adding/dropping/rebuilding the enum CHECK — or that flips the cms_type while sharing
  // a pgType (json<->array, string<->uid/email, string<->enumeration) — is a 'rewrite' in Step 2 and
  // is rejected up front. Only a genuine binary-coercible widening of the SAME cms_type is metadata-only.
  const fromEnum = isEnum(from);
  const toEnum = isEnum(to);
  if (fromEnum || toEnum) {
    // Either side carries (or would carry) a CHECK; only an identical enum value-set is metadata-only.
    if (fromEnum && toEnum && sameValues(from, to)) {
      // same members: a pure varchar grow of the same enum set is still metadata-only.
      if (from.pgType === to.pgType) return 'metadata-only';
    }
    return 'rewrite';
  }
  if (from.cmsType !== to.cmsType && from.pgType === to.pgType) return 'rewrite';

  if (from.pgType === to.pgType) return 'metadata-only';

  const fromLen = lengthOf(from);
  const toLen = lengthOf(to);

  // varchar family widening / varchar -> text is binary-coercible (metadata-only).
  const fromVarchar = from.pgType.startsWith('varchar');
  const toVarchar = to.pgType.startsWith('varchar');
  if (fromVarchar && to.pgType === 'text') return 'metadata-only';
  if (fromVarchar && toVarchar) {
    if (fromLen !== null && toLen !== null && toLen >= fromLen) return 'metadata-only';
    return 'rewrite'; // varchar shrink truncates -> rewrite/lossy.
  }

  // int4 -> int8 is NOT binary-coercible (a full rewrite); numeric scale/precision changes rewrite.
  if (from.pgType === 'integer' && to.pgType === 'bigint') return 'rewrite';
  if (from.pgType.startsWith('numeric') && to.pgType.startsWith('numeric')) return 'rewrite';
  if (from.pgType === 'timestamptz' && to.pgType.startsWith('timestamp')) return 'rewrite';

  // Categorically-impossible casts (no USING expression PG would accept) are 'forbidden', distinct
  // from a coercible-but-lossy 'rewrite'. jsonb <-> numeric/temporal and boolean <-> temporal/numeric
  // have no built-in cast; the rewrite-aware step must reject these outright rather than attempt them.
  if (isImpossibleCast(from.pgType, to.pgType) || isImpossibleCast(to.pgType, from.pgType)) return 'forbidden';

  // text -> integer (and any other engine-intent change) is a coercible-but-lossy rewrite.
  if (from.engineType !== to.engineType) return 'rewrite';
  return 'rewrite';
}

/** A pg-type family with no built-in cast path to the other (a categorically-impossible conversion). */
function isImpossibleCast(a: string, b: string): boolean {
  const isJson = a === 'jsonb';
  const bNumeric = b === 'integer' || b === 'bigint' || b === 'double precision' || b.startsWith('numeric');
  const bTemporal = b === 'date' || b === 'time' || b.startsWith('timestamp');
  const bBool = b === 'boolean';
  if (isJson && (bNumeric || bTemporal || bBool)) return true;
  if (a === 'boolean' && (bTemporal || b.startsWith('numeric') || b === 'double precision')) return true;
  return false;
}

/** Whether a resolved type is an enumeration (carries a CHECK-backing `values` member set). */
function isEnum(t: ResolvedType): boolean {
  return Array.isArray(t.params['values']);
}

/** Whether two enum value-sets are identical as sets (order-insensitive, exact membership). */
function sameValues(a: ResolvedType, b: ResolvedType): boolean {
  const av = a.params['values'] as string[];
  const bv = b.params['values'] as string[];
  if (av.length !== bv.length) return false;
  const set = new Set(av);
  return bv.every((v) => set.has(v));
}

/** Pull a varchar(n) length out of a resolved type, or null when it has none. */
function lengthOf(t: ResolvedType): number | null {
  const len = t.params['length'];
  return typeof len === 'number' ? len : null;
}
