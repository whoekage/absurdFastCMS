import type { ColumnType } from '../store/column.ts';
import { DECIMAL_MAX_SAFE_PRECISION } from '../store/decimal.const.ts';

/**
 * The SINGLE source of the `cms_type -> { pgType, engineType, params }` mapping. Both the DDL
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
    super(`unknown or unsupported module field type: ${String(cmsType)}`);
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
export const COMPONENT_FIELD_KINDS: ReadonlySet<string> = new Set<ComponentFieldKind>(['component', 'component-repeatable', 'dynamiczone', 'relation']);

/** Closed-set test: is this cms_type one of the structured-content component kinds? */
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
    return { cmsType: kind as unknown as CmsType, pgType: 'jsonb', engineType: 'json', params: { kind, target, multiple: options?.multiple === true } };
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
    return { cmsType: kind as unknown as CmsType, pgType: 'jsonb', engineType: 'json', params: { kind, components: [...components] } };
  }
  // component / component-repeatable: exactly one referenced component name.
  const component = options?.component;
  if (typeof component !== 'string' || component.length === 0) {
    throw new ComponentFieldError(`${kind} requires a component name`);
  }
  return { cmsType: kind as unknown as CmsType, pgType: 'jsonb', engineType: 'json', params: { kind, component } };
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
