import type { ColumnType } from '../store/column.ts';
import { DECIMAL_MAX_SAFE_PRECISION } from '../store/decimal.const.ts';

/**
 * The SINGLE source of the `type -> { pgType, engineType, params }` mapping. Both the DDL
 * generator (src/db/ddl.ts) and the meta writer (src/db/module.fields.ts) derive every per-type
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

/**
 * The closed set of CMS field types a user may define. Relation/component/dynamiczone are NOT here
 * (relations ride their own link-table plumbing). `media` (be-04) IS here: unlike a relation, a media
 * field is a PLAIN SCALAR COLUMN on the ct_ table — `media` (single) -> a positive int4 `files.id`
 * reference (engine `i32`), `media` + `{ multiple: true }` -> a jsonb array of ids (engine `json`). It
 * needs ZERO engine/loader/keyset surgery: it is just another scalar column that the read path emits
 * byte-identically (raw id(s) un-populated); reads POPULATE the asset(s) via a post-step that resolves
 * the id(s) against the system `files` table (see http/media.populate.ts), NOT via the CSR relation path.
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
 * The engine INTENT recorded in `content_type_fields.engine_type`. NOTE: as of step 4 the names
 * `i64`/`decimal`/`json` ARE genuine {@link ColumnType}s and ARE now fed to `createColumn` /
 * `engine.define` via the runtime registry (the loader builds a {@link import('../store/table.ts').FieldDef}
 * directly from `engine_type`). The `INTENT_ONLY_ENGINE_TYPES` set below is retained only as
 * documentation of the step-3 boundary (no code path / test depends on it any longer).
 */
export type EngineTypeIntent = ColumnType | 'i64' | 'decimal' | 'json';

/** The three intent-only engine strings that must NEVER reach the engine column factory. */
export const INTENT_ONLY_ENGINE_TYPES: ReadonlySet<EngineTypeIntent> = new Set<EngineTypeIntent>(['i64', 'decimal', 'json']);

/**
 * A field's conditional-visibility rule in the admin entry editor ("show/hide when <field> <op> <value>").
 * METADATA ONLY — the engine stores every column regardless; this drives admin-form visibility, not storage.
 */
export interface FieldCondition {
  /** The sibling field (name) this one's visibility depends on. */
  field: string;
  op: 'eq' | 'ne';
  value: string | number | boolean;
  action: 'show' | 'hide';
}

/** Per-field options the caller may supply; each type validates only the keys it cares about. */
export interface FieldOptions {
  /** varchar length (char count) for string/email/uid/enumeration sizing. */
  length?: number;
  /**
   * lower bound — CONTEXTUAL: min char-length for string/email/uid (number); min VALUE for integer/float
   * (number, ≤2^53 safe); min VALUE for biginteger/decimal as a STRING (BigInt/scaled-BigInt compared, never
   * coerced to a lossy JS number); earliest date/datetime as an absolute ISO-8601 string OR a relative
   * `$now(±N unit)` token (resolved per-request at write time). Write-time guard.
   */
  min?: number | string;
  /** upper bound — VALUE max (mirrors {@link min}: number for integer/float, STRING for biginteger/decimal, ISO/`$now` for date/datetime). */
  max?: number | string;
  /** `array` only: forbid duplicate items (scalar equality). Write-time guard. */
  uniqueItems?: boolean;
  /** `array` only: minimum item count. */
  minItems?: number;
  /** `array` only: maximum item count. */
  maxItems?: number;
  /** admin editor layout width: 'full' (default, own row) or 'half' (two fields side-by-side). Metadata only. */
  editorWidth?: 'full' | 'half';
  /** admin conditional visibility. Metadata only (see {@link FieldCondition}). */
  condition?: FieldCondition;
  /** emit a single-column UNIQUE constraint. Applicability-gated in resolveFields (no text/boolean/json/array/media). */
  unique?: boolean;
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
  /** `media` only: false (default) -> a single int4 file id column; true -> a jsonb array of file ids. */
  multiple?: boolean;
  /** be-05 component / component-repeatable only: the referenced component-type name. */
  component?: string;
  /** be-05 dynamiczone only: the allowed component-type api_ids (the zone's allowed-set). */
  components?: string[];
  /**
   * be-05b RELATION-INSIDE-COMPONENT only: the target module name an inline ref points at. NOTE
   * this is semantically DISTINCT from a top-level (be-01) relation: a relation field INSIDE a component
   * stores inline id ref(s) IN the component json (set-by-value, resolved-on-read, NOT independently
   * queryable) — there is NO link table, NO CSR, NO inverse side. The `multiple` flag above is reused for
   * cardinality (single ref vs many refs), exactly mirroring a media field.
   */
  target?: string;
}

/** A type resolved against the catalog: the pg literal, the engine intent, and recorded params. */
export interface ResolvedType {
  type: CmsType;
  pgType: string;
  engineType: EngineTypeIntent;
  params: Record<string, unknown>;
}

/** Thrown for any type off the closed {@link CmsType} set (relation/media/component/dynamiczone). */
export class UnknownCmsTypeError extends Error {
  readonly type: unknown;
  constructor(type: unknown) {
    super(`unknown or unsupported module field type: ${String(type)}`);
    this.name = 'UnknownCmsTypeError';
    this.type = type;
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

/**
 * Volatile default expressions that force a table rewrite (and a non-deterministic baked value):
 * rejected in Step 2 — only CONSTANT defaults are allowed. Matched case-insensitively against the
 * function name, with or without a trailing `()`.
 */
const VOLATILE_DEFAULT_NAMES: ReadonlySet<string> = new Set(['now', 'current_timestamp', 'gen_random_uuid', 'uuid_generate_v4', 'random', 'nextval', 'clock_timestamp', 'statement_timestamp', 'transaction_timestamp']);

/** Validate a positive integer option in `[min, max]`, else throw {@link TypeOptionError}. */
function intOption(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new TypeOptionError(`${name} must be an integer, got ${String(value)}`);
  if (value < min || value > max) throw new TypeOptionError(`${name} ${value} out of range [${min}, ${max}]`);
  return value;
}

/** varchar params (length + optional validated `min` lower bound). `min` is a write-time char-count floor. */
function varcharParams(o: FieldOptions | undefined, length: number): Record<string, unknown> {
  const params: Record<string, unknown> = { length };
  if (o?.min !== undefined) params.min = intOption(o.min, 'min', 0, length, 0);
  return params;
}

/** Numeric value bounds (min/max) for integer/float — recorded as write-time guards (no DDL effect). */
function numBounds(o: FieldOptions | undefined): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (o?.min !== undefined) {
    if (typeof o.min !== 'number' || !Number.isFinite(o.min)) throw new TypeOptionError(`min must be a finite number, got ${String(o.min)}`);
    p.min = o.min;
  }
  if (o?.max !== undefined) {
    if (typeof o.max !== 'number' || !Number.isFinite(o.max)) throw new TypeOptionError(`max must be a finite number, got ${String(o.max)}`);
    if (o.min !== undefined && o.max < (o.min as number)) throw new TypeOptionError(`max ${o.max} is less than min ${o.min}`);
    p.max = o.max;
  }
  return p;
}

const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;

/** Parse a biginteger bound (number must be integer; string must be digits) → bigint, int8-range-checked. */
function toI64Bound(v: number | string, label: string): bigint {
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new TypeOptionError(`${label} must be a whole number, got ${v}`);
    return BigInt(v);
  }
  const s = v.trim();
  if (!/^-?\d+$/.test(s)) throw new TypeOptionError(`${label} must be an integer string, got ${JSON.stringify(v)}`);
  return BigInt(s);
}

/** biginteger value bounds — stored as canonical digit STRINGS (BigInt-compared at write, never as a JS number). */
function i64Bounds(o: FieldOptions | undefined): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  let min: bigint | undefined;
  if (o?.min !== undefined) {
    min = toI64Bound(o.min, 'min');
    if (min < INT64_MIN || min > INT64_MAX) throw new TypeOptionError(`min ${min} is out of bigint range`);
    p.min = min.toString();
  }
  if (o?.max !== undefined) {
    const max = toI64Bound(o.max, 'max');
    if (max < INT64_MIN || max > INT64_MAX) throw new TypeOptionError(`max ${max} is out of bigint range`);
    if (min !== undefined && max < min) throw new TypeOptionError(`max ${max} is less than min ${min}`);
    p.max = max.toString();
  }
  return p;
}

/** Validate one decimal bound fits the column's precision/scale; returns the canonical fixed-point string. */
function decimalBound(v: number | string, precision: number, scale: number, label: string): string {
  const text = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : null;
  if (text === null) throw new TypeOptionError(`${label} must be a numeric string/number, got ${String(v)}`);
  const frac = text.split('.')[1] ?? '';
  if (frac.length > scale) throw new TypeOptionError(`${label} ${text} exceeds scale ${scale}`);
  const intDigits = text.replace('-', '').split('.')[0]!.replace(/^0+(?=\d)/, '').length;
  if (intDigits > precision - scale) throw new TypeOptionError(`${label} ${text} exceeds precision ${precision} (max ${precision - scale} integer digits)`);
  return text;
}

/** decimal value bounds — stored as canonical strings (scaled-BigInt compared at write). */
function decimalBounds(o: FieldOptions | undefined, precision: number, scale: number): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (o?.min !== undefined) p.min = decimalBound(o.min, precision, scale, 'min');
  if (o?.max !== undefined) {
    p.max = decimalBound(o.max, precision, scale, 'max');
    if (p.min !== undefined && Number(p.max) < Number(p.min)) throw new TypeOptionError(`max ${p.max} is less than min ${p.min}`);
  }
  return p;
}

/**
 * A relative-date token: `$now`, `$now(-7 days)`, `$now(+1 year)`. The sign is REQUIRED so the offset is
 * unambiguous; the unit may be singular or plural. Resolved against the request's `now` at write time
 * (body.parser.resolveDateBound) — stored verbatim here so a relative bound stays relative across reboots.
 */
const NOW_TOKEN_RE = /^\$now(?:\(\s*([+-]\d+)\s+(second|minute|hour|day|week|month|year)s?\s*\))?$/;
/** An absolute ISO-8601 date (`YYYY-MM-DD`) or datetime, with optional time/zone. Date.parse confirms validity. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Validate one date/datetime bound: an absolute ISO-8601 string OR a `$now(±N unit)` token. Returns it verbatim. */
function dateBound(v: number | string, label: string): string {
  if (typeof v !== 'string') throw new TypeOptionError(`${label} must be an ISO-8601 date string or a $now token, got ${String(v)}`);
  const s = v.trim();
  if (NOW_TOKEN_RE.test(s)) return s;
  if (ISO_DATE_RE.test(s) && !Number.isNaN(Date.parse(s))) return s;
  throw new TypeOptionError(`${label} must be an ISO-8601 date string or a $now token, got ${JSON.stringify(v)}`);
}

/**
 * date/datetime value bounds (min/max) — recorded as write-time guards (no DDL effect). Stored as verbatim
 * strings (absolute ISO or relative `$now` token); resolved against the request instant at write time. Two
 * ABSOLUTE bounds are order-checked here; a relative bound can't be statically ordered (resolved per-request).
 */
function dateBounds(o: FieldOptions | undefined): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (o?.min !== undefined) p.min = dateBound(o.min, 'min');
  if (o?.max !== undefined) p.max = dateBound(o.max, 'max');
  const min = p.min as string | undefined;
  const max = p.max as string | undefined;
  if (min !== undefined && max !== undefined && !NOW_TOKEN_RE.test(min) && !NOW_TOKEN_RE.test(max) && Date.parse(max) < Date.parse(min)) {
    throw new TypeOptionError(`max ${max} is before min ${min}`);
  }
  return p;
}

/** `array` item guards (uniqueItems / minItems / maxItems) — write-time only, recorded in params. */
function arrayParams(o: FieldOptions | undefined): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (o?.uniqueItems === true) p.uniqueItems = true;
  const item = (v: number | undefined, label: string): number | undefined => {
    if (v === undefined) return undefined;
    if (!Number.isInteger(v) || v < 0) throw new TypeOptionError(`${label} must be a non-negative integer, got ${String(v)}`);
    return v;
  };
  const minItems = item(o?.minItems, 'minItems');
  if (minItems !== undefined) p.minItems = minItems;
  const maxItems = item(o?.maxItems, 'maxItems');
  if (maxItems !== undefined) {
    if (minItems !== undefined && maxItems < minItems) throw new TypeOptionError(`maxItems ${maxItems} is less than minItems ${minItems}`);
    p.maxItems = maxItems;
  }
  return p;
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
  string: (o) => { const length = intOption(o?.length, 'length', 1, VARCHAR_MAX, DEFAULT_STRING_LENGTH); return { pgType: `varchar(${length})`, engineType: 'string', params: varcharParams(o, length) }; },
  text: () => ({ pgType: 'text', engineType: 'text', params: {} }),
  email: (o) => { const length = intOption(o?.length, 'length', 1, VARCHAR_MAX, DEFAULT_EMAIL_LENGTH); return { pgType: `varchar(${length})`, engineType: 'string', params: varcharParams(o, length) }; },
  uid: (o) => { const length = intOption(o?.length, 'length', 1, VARCHAR_MAX, DEFAULT_UID_LENGTH); return { pgType: `varchar(${length})`, engineType: 'string', params: varcharParams(o, length) }; },
  enumeration: (o) => {
    const { values, maxLen } = resolveEnum(o);
    // varchar sized >= the longest value char length (so a member never trips 22001), CHECK added by ddl.
    const length = intOption(o?.length, 'length', maxLen, VARCHAR_MAX, maxLen);
    if (length < maxLen) throw new TypeOptionError(`enumeration length ${length} is shorter than the longest value (${maxLen})`);
    return { pgType: `varchar(${length})`, engineType: 'string', params: { values, length } };
  },
  integer: (o) => ({ pgType: 'integer', engineType: 'i32', params: numBounds(o) }),
  biginteger: (o) => ({ pgType: 'bigint', engineType: 'i64', params: i64Bounds(o) }),
  float: (o) => ({ pgType: 'double precision', engineType: 'f64', params: numBounds(o) }),
  decimal: (o) => {
    const precision = intOption(o?.precision, 'precision', 1, NUMERIC_MAX_PRECISION, 10);
    const scale = intOption(o?.scale, 'scale', 0, precision, 2);
    if (scale > precision) throw new TypeOptionError(`decimal scale ${scale} exceeds precision ${precision}`);
    if (precision > DECIMAL_MAX_SAFE_PRECISION) throw new TypeOptionError(`decimal precision ${precision} exceeds the scaled-i64 cap (${DECIMAL_MAX_SAFE_PRECISION})`);
    return { pgType: `numeric(${precision},${scale})`, engineType: 'decimal', params: { precision, scale, ...decimalBounds(o, precision, scale) } };
  },
  boolean: () => ({ pgType: 'boolean', engineType: 'bool', params: {} }),
  date: (o) => ({ pgType: 'date', engineType: 'date', params: dateBounds(o) }),
  datetime: (o) => ({ pgType: 'timestamptz', engineType: 'date', params: dateBounds(o) }),
  time: () => ({ pgType: 'time', engineType: 'i32', params: {} }),
  json: () => ({ pgType: 'jsonb', engineType: 'json', params: {} }),
  array: (o) => ({ pgType: 'jsonb', engineType: 'json', params: arrayParams(o) }),
  uuid: () => ({ pgType: 'uuid', engineType: 'string', params: {} }),
  // be-04 MEDIA — a reference to the system `files` table, by id. SINGLE: a plain int4 column (engine
  // `i32`), holding ONE positive `files.id`; emitted as a bare number un-populated, exactly like a
  // relation id. MULTIPLE: a jsonb array of ids (engine `json`), emitted as a JSON array un-populated.
  // No FK to `files`: the engine is a RAM rebuild from PG and `multiple` could never carry a column FK
  // anyway — referential integrity is a WRITE-TIME existence check (write.handler) + populate-skip of a
  // deleted asset, mirroring how a relation id may dangle. `params.multiple` is the load/validate/
  // populate switch (registry reads it to size cardinality + pick the i32-vs-json populate shape).
  media: (o) => (o?.multiple === true
    ? { pgType: 'jsonb', engineType: 'json', params: { multiple: true } }
    : { pgType: 'integer', engineType: 'i32', params: { multiple: false } }),
} satisfies Record<CmsType, (o?: FieldOptions) => { pgType: string; engineType: EngineTypeIntent; params: Record<string, unknown> }>;

/**
 * Resolve a type (+ options) into the pg literal, engine intent, and recorded params. Throws
 * {@link UnknownCmsTypeError} for any value off the closed set, {@link TypeOptionError} for bad
 * varchar/numeric options, {@link EnumValueError} for a bad enum set. Renders NO SQL — `pgType` is a
 * plain literal the DDL builder drops into a `sql\`\`` escape hatch.
 */
export function resolveType(type: CmsType, options?: FieldOptions): ResolvedType {
  const resolver = (RESOLVERS as Record<string, ((o?: FieldOptions) => { pgType: string; engineType: EngineTypeIntent; params: Record<string, unknown> }) | undefined>)[type as string];
  if (resolver === undefined) throw new UnknownCmsTypeError(type);
  const r = resolver(options);
  return { type, pgType: r.pgType, engineType: r.engineType, params: r.params };
}

// --- be-05 COMPONENT field kinds (a CLOSED set; like RELATION_KINDS they are NOT scalar CmsTypes) -----

/**
 * The three structured-content field kinds a module (or another component) may attach. They are
 * NOT members of {@link CmsType}: each PHYSICALLY resolves to a single `jsonb` column (no link table, no
 * per-kind RESOLVERS arm — keeping the `satisfies Record<CmsType,...>` exhaustiveness guard intact), but
 * their `params` SHAPE differs from `media` (a component/dynamiczone carries the referenced component
 * name(s), not a cardinality flag). The component INSTANCE tree is stored INLINE in the jsonb column.
 *
 *   component            — ONE instance of a component type (`params.component = "<name>"`).
 *   component-repeatable — an ORDERED ARRAY of instances of one component (`params.component`).
 *   dynamiczone          — an ORDERED ARRAY of instances, each tagged `__component`, drawn from an
 *                          allowed-set (`params.components = ["a","b",...]`).
 *   relation             — be-05b: an INLINE id ref (or array of ids) to a TARGET module
 *                          (`params.target = "<name>"`, `params.multiple`). It rides the SAME json-column
 *                          plumbing as a multiple-media field — set-by-value, existence-checked on write,
 *                          resolved by the read populate-walk. It is NOT a be-01 link-table relation (no
 *                          link table, no CSR, no inverse side, not independently queryable).
 */
export type ComponentFieldKind = 'component' | 'component-repeatable' | 'dynamiczone' | 'relation';
const COMPONENT_FIELD_KINDS: ReadonlySet<string> = new Set<ComponentFieldKind>(['component', 'component-repeatable', 'dynamiczone', 'relation']);

/** Closed-set test: is this type one of the structured-content component kinds? */
export function isComponentFieldKind(value: unknown): value is ComponentFieldKind {
  return typeof value === 'string' && COMPONENT_FIELD_KINDS.has(value);
}

/** Thrown for a malformed component field spec (missing/empty component ref or dynamic-zone allowed-set). */
export class ComponentFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComponentFieldError';
  }
}

/**
 * Resolve a component field kind (+ options) to its physical pg column + the recorded params. Every
 * kind is a `jsonb` column (engine `json`) — byte-identical mechanics to a multiple-media field — so the
 * read path emits the inline component tree verbatim (RawJson) un-populated, and indexing skips it (json).
 * The referenced component name(s) are validated for SHAPE here (legal identifier) but their EXISTENCE
 * is checked by the repository against `component_types` (this module never touches a connection).
 *
 * params shape (stored verbatim in content_type_fields.params / component_type_fields.params):
 *   component / component-repeatable -> { kind, component: '<name>' }
 *   dynamiczone                      -> { kind, components: ['<name>', ...] }
 *   relation                         -> { kind, target: '<name>', multiple }
 */
export function resolveComponentField(kind: ComponentFieldKind, options?: FieldOptions): ResolvedType {
  if (kind === 'relation') {
    // be-05b: an inline id ref to a TARGET module. pgType is ALWAYS jsonb (engine `json`) for BOTH
    // cardinalities (unlike a top-level media single, which is an int4 COLUMN — here the ref always lives
    // INSIDE a json component column, so json is correct + simpler). SHAPE-only validation of the target
    // name here (a non-empty string with no NUL); its EXISTENCE in `content_types` is checked by the
    // repository against the live catalog (this module never touches a connection).
    const target = options?.target;
    if (typeof target !== 'string' || target.length === 0) {
      throw new ComponentFieldError('relation requires a target module name');
    }
    if (target.includes(' ')) throw new ComponentFieldError(`relation target ${JSON.stringify(target)} is not a valid name`);
    return { type: kind as unknown as CmsType, pgType: 'jsonb', engineType: 'json', params: { kind, target, multiple: options?.multiple === true } };
  }
  if (kind === 'dynamiczone') {
    const components = options?.components;
    if (!Array.isArray(components) || components.length === 0) {
      throw new ComponentFieldError('dynamiczone requires a non-empty components[] allowed-set');
    }
    const seen = new Set<string>();
    for (const c of components) {
      if (typeof c !== 'string' || c.length === 0) throw new ComponentFieldError(`dynamiczone components must be non-empty name strings, got ${String(c)}`);
      if (seen.has(c.toLowerCase())) throw new ComponentFieldError(`duplicate dynamiczone component: ${c}`);
      seen.add(c.toLowerCase());
    }
    return { type: kind as unknown as CmsType, pgType: 'jsonb', engineType: 'json', params: { kind, components: [...components] } };
  }
  // component / component-repeatable: exactly one referenced component name.
  const component = options?.component;
  if (typeof component !== 'string' || component.length === 0) {
    throw new ComponentFieldError(`${kind} requires a component name`);
  }
  return { type: kind as unknown as CmsType, pgType: 'jsonb', engineType: 'json', params: { kind, component } };
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
  // does NOT make a change metadata-only when the enum CHECK members or the type semantics differ.
  // A plain ALTER COLUMN TYPE never touches the existing CHECK constraint, so any transition that
  // would require adding/dropping/rebuilding the enum CHECK — or that flips the type while sharing
  // a pgType (json<->array, string<->uid/email, string<->enumeration) — is a 'rewrite' in Step 2 and
  // is rejected up front. Only a genuine binary-coercible widening of the SAME type is metadata-only.
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
  if (from.type !== to.type && from.pgType === to.pgType) return 'rewrite';

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
