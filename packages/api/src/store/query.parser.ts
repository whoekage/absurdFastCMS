import { coerceDate, coerceDecimal, coerceI64, type ColumnType, type ScanOp } from './column.ts';
import type { FieldDef, FilterNode, Predicate, QueryOptions, RawKeysetOptions, SortKey } from './table.ts';
import type { SortDir } from './indexes/sorted.index.ts';

/**
 * API-VERTICAL SLICE 2 — the Strapi v5 query parser.
 *
 * Parse a Strapi-style query (a flat `key=value` map with BRACKET-NESTED keys, exactly what
 * `URLSearchParams`/`qs` hand you off the wire) into the engine's structured query:
 *
 *   - a {@link FilterNode} TREE (nested `$and`/`$or`/`$not`, the engine's combiner shape);
 *   - {@link QueryOptions} `sort` / `offset` / `limit` (BOTH pagination styles map here);
 *   - an optional {@link PopulatePlan} naming relations to populate.
 *
 * Everything is VALIDATED against the module schema (the `FieldDef[]` the Engine was
 * `define`d with): an unknown field, an unknown operator, a type-mismatched value, a string-only
 * op on a number field, a `between` without exactly two args, or malformed bracket syntax all THROW
 * a {@link QueryParseError} with a clear message — never a silent wrong query.
 *
 * Mock-free by construction: the parser is a pure function over (schema, params) and the tests
 * drive it + the real Engine end-to-end with brute-force oracles.
 */

/** A clear, typed parse failure (distinguishable from an engine bug in a catch). */
export class QueryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryParseError';
  }
}

/**
 * One relation to populate, with an optional nested sub-plan (Relations Slice 5). `children` empty =
 * leaf (a depth-1 frontier relation, expanded at most one hop). A NESTED `populate` value (e.g.
 * `populate[author][populate][books]`) yields the recursive `children`, which the EXECUTION-time
 * resolver validates + expands against the TARGET type. The `*` wildcard is the sentinel field name,
 * expanded at execution to every declared relation of the current type (depth-1).
 *
 * A recursive NODE (not a flat `{field,depth}`) is required so depth-2 records WHICH sub-relation to
 * expand — a single integer depth cannot. Relation NAMES stay UNvalidated at parse time (they are not
 * in the column schema); the plan is resolved against the registered relations at EXECUTION.
 */
export interface PopulateNode {
  field: string;
  children: PopulateNode[];
}

/** The optional populate plan: which relation fields to expand. Empty when `populate` is absent. */
export type PopulatePlan = PopulateNode[];

/** The Strapi v5 Draft & Publish lifecycle selector (v5 replaced v4 `publicationState=preview|live`). */
export type Status = 'draft' | 'published';

/** The `*` sentinel a `locale` query param accepts to mean "all variants" (no locale predicate). */
export const ALL_LOCALES = '*';

/**
 * A permissive locale slug bound: non-empty, <= 35 bytes (matches the `varchar(35)` locale column), and a
 * BCP-47-ish shape (letters/digits/`_`/`-`, e.g. `en`, `pt-BR`, `zh_Hant`). NOT a registry of enabled
 * locales — any well-formed slug is accepted in v1 (no per-type/project allowlist; documented deferral).
 */
const LOCALE_SLUG_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Validate a locale slug, returning it verbatim, or throw {@link QueryParseError} (`*` is NOT handled
 * here — the caller special-cases the all-variants sentinel before validation). Shared by the read
 * `locale` query param and (a later slice) the variant-create verb so both reject the same malformed
 * shapes identically.
 */
export function validateLocale(value: string, what = 'locale'): string {
  if (value.length === 0) throw new QueryParseError(`${what} must be a non-empty string`);
  if (Buffer.byteLength(value, 'utf8') > 35) throw new QueryParseError(`${what} must be <= 35 bytes`);
  if (!LOCALE_SLUG_RE.test(value)) throw new QueryParseError(`${what} must match /^[A-Za-z0-9_-]+$/ (e.g. en, pt-BR)`);
  return value;
}

/** The parser's full structured output. `where` is omitted when there are no filters. */
export interface ParsedQuery {
  where?: FilterNode;
  options: QueryOptions;
  populate: PopulatePlan;
  /**
   * The Draft & Publish lifecycle selector (`status=draft|published`), when present. VALIDATED here on
   * EVERY type (a bad token -> 400) but only ACTED ON for a D&P type by the read router; on a non-D&P
   * type it is a no-op. Absent => the router defaults a D&P type to published-only.
   */
  status?: Status;
  /**
   * The i18n locale selector (`locale=<slug>` or `locale=*`), when present. VALIDATED here on EVERY type
   * (a malformed slug -> 400) but only ACTED ON for an i18n type by the read router; on a non-i18n type it
   * is a no-op. `*` ({@link ALL_LOCALES}) means all variants (no predicate). Absent => the router defaults
   * an i18n type to DEFAULT_LOCALE.
   */
  locale?: string;
  /**
   * The sparse field selection (`fields=a,b,c` or `fields[0]=a&fields[1]=b`), when present and non-empty.
   * VALIDATED here on EVERY type against the column schema (an unknown field -> 400, the SAME gate
   * `parseLeafOp` uses). The engine ACTS on it as a scalar projection at assembly time, force-including
   * `id` (Strapi always returns it). Absent / empty => no projection (the full-row zero-copy path is
   * byte-identical to before). Relations stay populate-governed; `fields` filters scalars only.
   */
  fields?: string[];
}

// --- the Strapi `$op` -> engine ScanOp map ----------------------------------

/**
 * Strapi filter operator (`$eq`, `$gt`, ...) -> engine {@link ScanOp}. This is the WHITELIST: an
 * operator token not in here is rejected. Strapi's `$contains`/`$startsWith`/`$endsWith` are
 * CASE-SENSITIVE and the `*i`/`*ci` variants case-insensitive — mapped to the engine's `eqi`/`nei`/
 * `containsi`/`startsWithi`/`endsWithi` folded ops. `$between` is positional [lo, hi].
 */
const OP_MAP: Record<string, ScanOp> = {
  $eq: 'eq',
  $ne: 'ne',
  $gt: 'gt',
  $gte: 'gte',
  $lt: 'lt',
  $lte: 'lte',
  $between: 'between',
  $in: 'in',
  $notIn: 'notIn',
  $null: 'null',
  $notNull: 'notNull',
  $eqi: 'eqi',
  $nei: 'nei',
  $contains: 'contains',
  $containsi: 'containsi',
  $notContains: 'notContains',
  $notContainsi: 'notContainsi',
  $startsWith: 'startsWith',
  $startsWithi: 'startsWithi',
  $endsWith: 'endsWith',
  $endsWithi: 'endsWithi',
};

/** Ops that compare TEXT semantics — invalid on a non-string/text field. */
const STRING_ONLY_OPS = new Set<ScanOp>([
  'eqi',
  'nei',
  'contains',
  'containsi',
  'notContains',
  'notContainsi',
  'startsWith',
  'startsWithi',
  'endsWith',
  'endsWithi',
]);

/** Ops whose value is a SET (array / comma list). */
const SET_OPS = new Set<ScanOp>(['in', 'notIn']);

/** Ops whose value is the presence flag `true` (null / not-null). */
const NULL_OPS = new Set<ScanOp>(['null', 'notNull']);

const LOGICAL_KEYS = new Set(['$and', '$or', '$not']);

// --- bracket-key params parsing ---------------------------------------------

/**
 * A nested params value: a leaf string, or a nested object/array of the same. This is the shape
 * `qs`/`URLSearchParams`-with-brackets produce; we accept it directly so the HTTP layer can hand us
 * either a raw query string or an already-parsed object.
 */
export type ParamNode = string | ParamNode[] | { [k: string]: ParamNode };

/**
 * A schema entry: the field's column type plus, for `decimal`, its fixed `scale`. The scale must be
 * threaded so a decimal predicate value coerces to the SAME scaled-int64 mantissa the column stored —
 * a `Map<string, ColumnType>` (the pre-step-3 shape) would lose it and silently mis-coerce.
 */
export interface SchemaEntry {
  type: ColumnType;
  scale?: number | undefined;
  precision?: number | undefined;
}
export type QuerySchema = Map<string, SchemaEntry>;

/** Relations Slice 4: max RELATION HOPS in a single filter chain (`a.b.c`). A deeper chain -> 400.
 * Counts relation hops ONLY, NOT `$and`/`$or`/`$not` nesting. The sole terminator for a self-
 * referential / cyclic relation filter (resolveTarget returns the same-shaped context each hop). */
export const MAX_RELATION_HOPS = 3;

/**
 * Relations Slice 5: max literal `[populate]` NESTING levels in a populate query key. INDEPENDENT of
 * the execution-time populate DEPTH cap (engine `POPULATE_DEPTH_CAP`): this bounds the PARSER recursion
 * over the URL string so a pathologically deep `populate[a][populate][a][populate]...` key fails fast as
 * a clean 400 (QueryParseError) instead of blowing the call stack (RangeError -> unhandled 500 / DoS).
 * Set above the execution cap so any query that COULD be expanded still parses; anything deeper is junk.
 */
export const MAX_POPULATE_NESTING = 8;

/**
 * Relations Slice 4 — the parse-time context the Engine supplies so the parser can (i) tell a
 * RELATION field from a scalar field on the current type and (ii) recurse a relation sub-filter
 * against the TARGET type's schema. Scalar-only callers pass a `FieldDef[]` (the legacy overload),
 * which becomes a context with no relations (a relation key then keeps 400ing as "unknown field").
 */
export interface RelationParseContext {
  /** The current type's scalar fields (the whitelist the leaf parser validates against). */
  fields: FieldDef[];
  /** Relation field name -> target apiId, for THIS type. Empty for a scalar-only caller. */
  relations: Map<string, string>;
  /** Resolve a target type's context for a deeper hop, or undefined if the type is absent. */
  resolveTarget(apiId: string): RelationParseContext | undefined;
}

/** Build the scalar {@link QuerySchema} (lookup map) from a context's field list. */
function schemaFromFields(fields: FieldDef[]): QuerySchema {
  const schema: QuerySchema = new Map<string, SchemaEntry>();
  for (const f of fields) schema.set(f.name, { type: f.type, scale: f.scale, precision: f.precision });
  return schema;
}

/** True if every key of `node` is a real leaf-operator token (an op-shaped value, not a nested
 * field object and not a logical combinator). Used to REJECT a relation value like
 * `filters[author][$eq]=5` / `[$null]=true`. A logical combinator (`$and`/`$or`/`$not`) is NOT
 * op-shaped — it is valid Strapi syntax INSIDE a relation sub-filter and must flow through to
 * `parseFilterObject`, which dispatches it against the TARGET schema. */
function isOpShaped(node: { [k: string]: ParamNode }): boolean {
  const keys = Object.keys(node);
  if (keys.length === 0) return false;
  return keys.every((k) => k in OP_MAP);
}

/**
 * Split a bracket key like `filters[$and][0][status][$eq]` into its path segments
 * `['filters', '$and', '0', 'status', '$eq']`. Rejects malformed brackets (unbalanced, empty
 * `[]` in the middle, stray characters) so a typo can't silently drop a clause.
 */
export function splitKey(key: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = key.length;
  // First segment is the bare head up to the first '['.
  let head = '';
  while (i < n && key[i] !== '[') {
    if (key[i] === ']') throw new QueryParseError(`malformed key "${key}": unexpected ']'`);
    head += key[i];
    i++;
  }
  if (head === '') throw new QueryParseError(`malformed key "${key}": empty head segment`);
  out.push(head);
  while (i < n) {
    if (key[i] !== '[') throw new QueryParseError(`malformed key "${key}": expected '[' at ${i}`);
    i++; // past '['
    let seg = '';
    while (i < n && key[i] !== ']') {
      if (key[i] === '[') throw new QueryParseError(`malformed key "${key}": nested '[' at ${i}`);
      seg += key[i];
      i++;
    }
    if (i >= n) throw new QueryParseError(`malformed key "${key}": unterminated '['`);
    i++; // past ']'
    if (seg === '') throw new QueryParseError(`malformed key "${key}": empty bracket segment`);
    out.push(seg);
  }
  return out;
}

/** Set `path` to `value` inside `root`, creating intermediate objects. Numeric segments stay as
 * object keys (we normalize array-ish objects to arrays at read time) so `[0]` and `[1]` survive. */
function assignPath(root: { [k: string]: ParamNode }, path: string[], value: string): void {
  let cur: { [k: string]: ParamNode } = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    const existing = cur[seg];
    if (existing === undefined) {
      const next: { [k: string]: ParamNode } = {};
      cur[seg] = next;
      cur = next;
    } else if (typeof existing === 'string' || Array.isArray(existing)) {
      throw new QueryParseError(`malformed key path: "${seg}" is both a leaf and a branch`);
    } else {
      cur = existing;
    }
  }
  cur[path[path.length - 1]!] = value;
}

/**
 * Parse a raw query STRING (`a[b]=1&c=2`) into a nested {@link ParamNode} object. Decodes
 * percent-escapes; a key without `=` is treated as an empty-string value. Leading `?` is tolerated.
 */
export function parseParams(qs: string): { [k: string]: ParamNode } {
  const root: { [k: string]: ParamNode } = {};
  const s = qs.startsWith('?') ? qs.slice(1) : qs;
  if (s === '') return root;
  for (const pair of s.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
    const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    const val = decodeURIComponent(rawVal.replace(/\+/g, ' '));
    assignPath(root, splitKey(key), val);
  }
  return root;
}

/** Treat an object whose keys are the contiguous indices `0..n-1` as an ordered array of values. */
function asOrderedList(node: ParamNode): ParamNode[] {
  if (Array.isArray(node)) return node;
  if (typeof node === 'string') return [node];
  const keys = Object.keys(node);
  const nums = keys.map((k) => Number(k));
  const ordered = keys.every((k, i) => Number.isInteger(nums[i]) && String(nums[i]) === k);
  if (!ordered) {
    // Not index-shaped — return values in declaration order (caller decides if that's valid).
    return keys.map((k) => (node as { [k: string]: ParamNode })[k]!);
  }
  const pairs = keys.map((k, i) => [nums[i]!, (node as { [k: string]: ParamNode })[k]!] as const);
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs.map((p) => p[1]);
}

// --- value coercion per field type ------------------------------------------

function coerceScalar(field: string, entry: SchemaEntry, op: ScanOp, raw: ParamNode): unknown {
  if (typeof raw !== 'string') {
    throw new QueryParseError(`filter ${field} $${op}: expected a scalar value, got a nested structure`);
  }
  const type = entry.type;
  switch (type) {
    case 'i32':
    case 'f64': {
      const n = Number(raw);
      if (raw.trim() === '' || Number.isNaN(n)) {
        throw new QueryParseError(`filter ${field}: "${raw}" is not a valid number`);
      }
      if (type === 'i32' && !Number.isInteger(n)) {
        throw new QueryParseError(`filter ${field}: "${raw}" is not an integer (i32 field)`);
      }
      return n;
    }
    case 'bool': {
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new QueryParseError(`filter ${field}: "${raw}" is not a boolean (use true/false)`);
    }
    case 'date': {
      // coerceDate accepts an ISO string or an epoch-ms NUMBER. Off the wire everything is a
      // string, so a bare integer string (e.g. "1609459200000") must become a number first —
      // otherwise Date.parse treats it as an unparseable date string. ISO strings pass through.
      const dateInput: string | number = /^-?\d+$/.test(raw) ? Number(raw) : raw;
      try {
        return coerceDate(dateInput);
      } catch (e) {
        throw new QueryParseError(`filter ${field}: ${(e as Error).message}`);
      }
    }
    case 'i64': {
      // Coerce the wire string to an exact int64 bigint (the column's canonical form). A float /
      // out-of-range / non-integer string is a parse error, not a silent miss.
      try {
        return coerceI64(raw);
      } catch (e) {
        throw new QueryParseError(`filter ${field}: ${(e as Error).message}`);
      }
    }
    case 'decimal': {
      // Coerce to the SAME scaled-int64 mantissa the column stored (using the field's threaded scale
      // and precision), so a decimal `$eq`/range matches exactly. An excess-fraction / out-of-precision /
      // malformed value throws — agreeing with what the column's own push would reject.
      try {
        return coerceDecimal(raw, entry.scale ?? 0, entry.precision);
      } catch (e) {
        throw new QueryParseError(`filter ${field}: ${(e as Error).message}`);
      }
    }
    case 'json':
      // Unreachable: parseLeafOp rejects every op on a json field before dispatch. Kept for the
      // exhaustive switch so type-stripping never silently returns undefined for a json arm.
      throw new QueryParseError(`field "${field}" is json; filtering on json fields is not supported`);
    case 'string':
    case 'text':
      return raw;
  }
}

/** Split a `$in`/`$notIn` value: either a `[]`-shaped param array or a comma-separated string. */
function coerceSet(field: string, entry: SchemaEntry, op: ScanOp, raw: ParamNode): unknown[] {
  let parts: ParamNode[];
  if (Array.isArray(raw)) parts = raw;
  else if (typeof raw !== 'string') parts = asOrderedList(raw);
  else parts = raw === '' ? [] : raw.split(',');
  return parts.map((p) => coerceScalar(field, entry, op, p));
}

/** Coerce a `$between` value: exactly two comma/array elements, each per-type-coerced. */
function coerceBetween(field: string, entry: SchemaEntry, raw: ParamNode): [unknown, unknown] {
  let parts: ParamNode[];
  if (Array.isArray(raw)) parts = raw;
  else if (typeof raw === 'string') parts = raw.split(',');
  else parts = asOrderedList(raw);
  if (parts.length !== 2) {
    throw new QueryParseError(`filter ${field} $between: expected exactly 2 bounds, got ${parts.length}`);
  }
  return [coerceScalar(field, entry, 'between', parts[0]!), coerceScalar(field, entry, 'between', parts[1]!)];
}

/** The `$null`/`$notNull` presence flag must be the literal `true`. */
function coerceNullFlag(field: string, op: ScanOp, raw: ParamNode): void {
  if (raw !== 'true') {
    throw new QueryParseError(`filter ${field} $${op}: value must be true`);
  }
}

// --- the filter tree walk ----------------------------------------------------

/**
 * Build one leaf predicate for `field $op value`, validating the field exists, the op is known and
 * type-compatible, and the value coerces. Returns the engine {@link FilterNode} leaf.
 */
function parseLeafOp(
  schema: QuerySchema,
  field: string,
  opToken: string,
  raw: ParamNode,
): Predicate {
  const entry = schema.get(field);
  if (entry === undefined) throw new QueryParseError(`unknown field "${field}"`);
  const type = entry.type;
  // json is NOT filterable: reject EVERY op before dispatch, so a `$eq`/`$gt`/`$contains` on a json
  // field is a clear parse error (never a silent 200 with empty data, never a column scan that throws).
  if (type === 'json') {
    throw new QueryParseError(`field "${field}" is json; filtering on json fields is not supported`);
  }
  const op = OP_MAP[opToken];
  if (op === undefined) throw new QueryParseError(`unknown operator "${opToken}" on field "${field}"`);
  if (STRING_ONLY_OPS.has(op) && type !== 'string' && type !== 'text') {
    throw new QueryParseError(`operator $${opToken} on field "${field}" requires a string field, got ${type}`);
  }
  if (NULL_OPS.has(op)) {
    coerceNullFlag(field, op, raw);
    return { field, op, value: true };
  }
  if (op === 'between') {
    return { field, op, value: coerceBetween(field, entry, raw) };
  }
  if (SET_OPS.has(op)) {
    return { field, op, value: coerceSet(field, entry, op, raw) };
  }
  return { field, op, value: coerceScalar(field, entry, op, raw) };
}

/**
 * A field-level filter object `{ $eq: 1, $gt: 0 }` (multiple ops on one field AND together) or the
 * Strapi short form `filters[field]=value` (bare value = `$eq`). Produces one leaf or an AND group.
 *
 * Relations Slice 4: precedence is SCALAR-FIRST (registry guarantees disjoint names — a relation
 * emits no FieldDef). If `field` is not a scalar but IS a relation on the current type, recurse the
 * sub-filter against the TARGET type's schema and emit a `{ relation, sub }` leaf (EXISTS). A key
 * that is neither -> the existing `unknown field` 400. `depth` counts relation hops; `path` is the
 * dotted prefix for error attribution (empty at the top level so scalar messages stay byte-identical).
 */
function parseFieldFilters(
  ctx: RelationParseContext,
  schema: QuerySchema,
  field: string,
  node: ParamNode,
  depth: number,
  path: string,
): FilterNode {
  // (1) SCALAR — the existing path, byte-unchanged for scalar-only callers.
  if (schema.has(field)) {
    if (typeof node === 'string') {
      // Short form: `filters[field]=value` means `$eq`.
      return { leaf: parseLeafOp(schema, field, '$eq', node) };
    }
    if (Array.isArray(node)) {
      throw new QueryParseError(`filter on field "${field}" must be an operator object, got an array`);
    }
    const opKeys = Object.keys(node);
    if (opKeys.length === 0) throw new QueryParseError(`filter on field "${field}" is empty`);
    const leaves: FilterNode[] = opKeys.map((opToken) => ({
      leaf: parseLeafOp(schema, field, opToken, (node as { [k: string]: ParamNode })[opToken]!),
    }));
    return leaves.length === 1 ? leaves[0]! : { op: 'and', children: leaves };
  }

  // (2) RELATION — recurse the sub-filter against the TARGET type's schema.
  const targetApiId = ctx.relations.get(field);
  if (targetApiId !== undefined) {
    if (depth + 1 > MAX_RELATION_HOPS) {
      throw new QueryParseError(`relation filter too deep (max ${MAX_RELATION_HOPS} hops) at "${path}${field}"`);
    }
    // A relation needs a nested FIELD object. Reject the short string form, an array, and an op-shaped
    // value (`[$eq]=5`, `[$null]=true` — `$null`-on-relation is out of scope) with a relation message.
    if (typeof node === 'string' || Array.isArray(node) || isOpShaped(node)) {
      throw new QueryParseError(
        `relation "${path}${field}" must be filtered by a nested field, e.g. filters[${field}][<field>][$eq]`,
      );
    }
    const targetCtx = ctx.resolveTarget(targetApiId);
    if (targetCtx === undefined) {
      // Declared but the target type is absent (a transient engine/registry desync) — clean 400, not a 500.
      throw new QueryParseError(`relation "${path}${field}" target type unavailable`);
    }
    const targetSchema = schemaFromFields(targetCtx.fields);
    const sub = parseFilterObject(targetCtx, targetSchema, node, depth + 1, `${path}${field}.`);
    return { relation: field, sub };
  }

  // (3) NEITHER — the existing 'unknown field "<field>"' 400 (preserved verbatim).
  throw new QueryParseError(`unknown field "${field}"`);
}

/**
 * Recursively parse a filters object into a {@link FilterNode}. Handles the logical combinators
 * `$and` / `$or` (arrays of sub-filter objects) and `$not` (a single sub-filter object), and field
 * keys (each a field-level operator object). Multiple sibling keys at one level AND together
 * (Strapi's implicit-AND of co-located conditions). The logical recursions keep the SAME ctx/schema/
 * depth/path (still on the current type — only a relation hop bumps depth and extends path).
 */
function parseFilterObject(
  ctx: RelationParseContext,
  schema: QuerySchema,
  node: ParamNode,
  depth: number,
  path: string,
): FilterNode {
  if (typeof node === 'string' || Array.isArray(node)) {
    throw new QueryParseError('filters must be an object of fields / logical operators');
  }
  const obj = node as { [k: string]: ParamNode };
  const keys = Object.keys(obj);
  if (keys.length === 0) throw new QueryParseError('empty filters object');

  const children: FilterNode[] = [];
  for (const key of keys) {
    if (key === '$and' || key === '$or') {
      const list = asOrderedList(obj[key]!);
      if (list.length === 0) throw new QueryParseError(`${key} must be a non-empty array of filters`);
      const sub = list.map((el) => parseFilterObject(ctx, schema, el, depth, path));
      children.push({ op: key === '$and' ? 'and' : 'or', children: sub });
    } else if (key === '$not') {
      children.push({ op: 'not', children: [parseFilterObject(ctx, schema, obj[key]!, depth, path)] });
    } else if (key.startsWith('$')) {
      throw new QueryParseError(`unknown logical operator "${key}"`);
    } else {
      children.push(parseFieldFilters(ctx, schema, key, obj[key]!, depth, path));
    }
  }
  return children.length === 1 ? children[0]! : { op: 'and', children };
}

// --- sort / pagination / fields / populate ----------------------------------

function parseSort(node: ParamNode): SortKey[] {
  const tokens = typeof node === 'string' ? node.split(',') : asOrderedList(node);
  const out: SortKey[] = [];
  for (const tok of tokens) {
    if (typeof tok !== 'string') throw new QueryParseError('sort entry must be a string');
    if (tok === '') continue;
    const colon = tok.indexOf(':');
    const field = colon === -1 ? tok : tok.slice(0, colon);
    const dirToken = colon === -1 ? 'asc' : tok.slice(colon + 1);
    if (dirToken !== 'asc' && dirToken !== 'desc') {
      throw new QueryParseError(`sort direction must be asc|desc, got "${dirToken}"`);
    }
    out.push({ field, dir: dirToken as SortDir });
  }
  return out;
}

/** Validate that every sort field exists in the schema (a misspelling is rejected, not ignored). */
function validateSortFields(schema: QuerySchema, sort: SortKey[]): void {
  for (const s of sort) {
    if (!schema.has(s.field)) throw new QueryParseError(`unknown sort field "${s.field}"`);
  }
}

function leafString(node: ParamNode, what: string): string {
  if (typeof node !== 'string') throw new QueryParseError(`${what} must be a scalar value`);
  return node;
}

function parsePositiveInt(raw: string, what: string): number {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(n) || n < 0) {
    throw new QueryParseError(`${what} must be a non-negative integer, got "${raw}"`);
  }
  return n;
}

/** The parser's pagination result: EITHER offset/limit (page/start modes) OR a raw keyset request. */
type ParsedPagination = { offset?: number; limit?: number; keyset?: RawKeysetOptions };

/**
 * Map the THREE Strapi-compatible pagination styles. Page-based
 * (`pagination[page]`/`pagination[pageSize]`) -> offset=(page-1)*pageSize, limit=pageSize. Offset-
 * based (`pagination[start]`/`pagination[limit]`) passes through directly. KEYSET (the additive
 * third mode) -> `pagination[cursor]` (forward) / `pagination[before]` (backward) + `pageSize` +
 * `withCount`, returned as a RAW token shape (the Engine owns the cursor codec and decodes it).
 *
 * `pageSize` is NEUTRAL — shared by page + keyset; it only enters keyset mode when `cursor`/`before`
 * is present, so a bare `pageSize` stays the legacy page path (byte-identical). The four modes
 * (page, start, cursor, before) are MUTUALLY EXCLUSIVE; cursor and before are exclusive too.
 */
function parsePagination(node: ParamNode): ParsedPagination {
  if (typeof node === 'string' || Array.isArray(node)) {
    throw new QueryParseError('pagination must be an object');
  }
  const obj = node as { [k: string]: ParamNode };
  // `pageSize` is a PAGE-mode knob (legacy) UNLESS keyset is active. Track it as part of "page".
  const hasCursor = 'cursor' in obj;
  const hasBefore = 'before' in obj;
  const hasKeyset = hasCursor || hasBefore;
  const hasPage = 'page' in obj || (!hasKeyset && 'pageSize' in obj);
  const hasStart = 'start' in obj || 'limit' in obj;

  // Mutual exclusivity across the modes (withCount is a neutral knob; pageSize is shared with keyset).
  const modes = (hasPage ? 1 : 0) + (hasStart ? 1 : 0) + (hasKeyset ? 1 : 0);
  if (modes > 1) {
    throw new QueryParseError('pagination: cannot mix page / start / cursor pagination modes');
  }
  if (hasCursor && hasBefore) {
    throw new QueryParseError('pagination: cannot use cursor and before together');
  }

  for (const k of Object.keys(obj)) {
    if (
      k !== 'page' && k !== 'pageSize' && k !== 'start' && k !== 'limit' &&
      k !== 'cursor' && k !== 'before' && k !== 'withCount'
    ) {
      throw new QueryParseError(`unknown pagination key "${k}"`);
    }
  }
  // `withCount` is a KEYSET-only knob (page mode always emits total; offset mode has no count). Reject
  // it in the non-keyset modes so a misplaced `withCount` keeps the SAME 400 it threw pre-keyset (the
  // offset/page response stays byte-identical), instead of being silently accepted-and-dropped.
  if (!hasKeyset && 'withCount' in obj) {
    throw new QueryParseError('pagination[withCount] is only valid with cursor/before pagination');
  }

  if (hasKeyset) {
    // pageSize: reuse parsePositiveInt; default 25; reject 0 (can't advance a cursor).
    const pageSize = 'pageSize' in obj
      ? parsePositiveInt(leafString(obj.pageSize!, 'pagination[pageSize]'), 'pagination[pageSize]')
      : 25;
    if (pageSize < 1) throw new QueryParseError('pagination[pageSize] must be >= 1 for cursor pagination');
    let withCount = false;
    if ('withCount' in obj) {
      const wc = leafString(obj.withCount!, 'pagination[withCount]');
      if (wc !== 'true' && wc !== 'false') throw new QueryParseError('pagination[withCount] must be true or false');
      withCount = wc === 'true';
    }
    const keyset: RawKeysetOptions = { pageSize, withCount };
    if (hasCursor) keyset.cursorToken = leafString(obj.cursor!, 'pagination[cursor]');
    if (hasBefore) {
      const beforeToken = leafString(obj.before!, 'pagination[before]');
      // Only `cursor=` (empty) bootstraps the FIRST page (head walk). An empty `before` has no
      // backward-tail semantics wired (assembleKeyset would silently treat it as a forward head
      // walk), so reject it rather than surprise a client bootstrapping the LAST page.
      if (beforeToken === '') throw new QueryParseError('pagination[before] must be a non-empty cursor; use pagination[cursor]= to bootstrap');
      keyset.beforeToken = beforeToken;
    }
    return { keyset };
  }

  // page mode (includes a bare `pageSize` when no keyset is active — legacy back-compat).
  if (hasPage) {
    const page = 'page' in obj ? parsePositiveInt(leafString(obj.page!, 'pagination[page]'), 'pagination[page]') : 1;
    // A page is 1-based; page 0 is meaningless (parsePositiveInt only floors out negatives).
    if (page < 1) throw new QueryParseError('pagination[page] must be >= 1');
    const pageSize = 'pageSize' in obj ? parsePositiveInt(leafString(obj.pageSize!, 'pagination[pageSize]'), 'pagination[pageSize]') : 25;
    return { offset: (page - 1) * pageSize, limit: pageSize };
  }
  const out: { offset?: number; limit?: number } = {};
  if ('start' in obj) out.offset = parsePositiveInt(leafString(obj.start!, 'pagination[start]'), 'pagination[start]');
  if ('limit' in obj) out.limit = parsePositiveInt(leafString(obj.limit!, 'pagination[limit]'), 'pagination[limit]');
  return out;
}

/** `fields=a,b,c` (or `fields[0]=a&fields[1]=b`) -> validated field-name list. */
function parseFields(schema: QuerySchema, node: ParamNode): string[] {
  const tokens = typeof node === 'string' ? node.split(',') : asOrderedList(node);
  const out: string[] = [];
  for (const tok of tokens) {
    if (typeof tok !== 'string') throw new QueryParseError('fields entry must be a string');
    if (tok === '') continue;
    if (!schema.has(tok)) throw new QueryParseError(`unknown field "${tok}" in fields`);
    out.push(tok);
  }
  return out;
}

/**
 * `populate=author` / `populate=author,tags` / `populate[0]=author` / `populate[author]=...` ->
 * a recursive {@link PopulatePlan}. The object form `populate[rel][populate]=<sub>` recurses into
 * the named relation's `children` (a nested sub-plan), so `populate[author][populate][books]` ->
 * `{field:'author',children:[{field:'books',children:[]}]}` and `populate[author][populate]=*` ->
 * `{field:'author',children:[{field:'*',children:[]}]}` (the `*` resolved against author's TARGET
 * type at execution). Relation NAMES are not in the column schema, so they are NOT whitelisted here —
 * the plan is validated + expanded against the table's registered Relations at execution time. Depth
 * beyond the execution cap is silently truncated at execution (documented). The `nesting` counter
 * bounds parser recursion over the literal `[populate]` levels ({@link MAX_POPULATE_NESTING}) so a
 * crafted over-deep query key 400s cleanly rather than overflowing the stack (RangeError -> 500 / DoS).
 */
function parsePopulate(node: ParamNode, nesting = 0): PopulatePlan {
  if (nesting > MAX_POPULATE_NESTING) {
    throw new QueryParseError(`populate nested too deep (max ${MAX_POPULATE_NESTING} levels)`);
  }
  if (typeof node === 'string') {
    if (node === '*') return [{ field: '*', children: [] }];
    return node
      .split(',')
      .filter((s) => s !== '')
      .map((field) => ({ field, children: [] }));
  }
  if (Array.isArray(node)) {
    return node.map((el) => ({ field: leafString(el, 'populate entry'), children: [] }));
  }
  const obj = node as { [k: string]: ParamNode };
  const keys = Object.keys(obj);
  // Index-shaped object `populate[0]=author` behaves like an array of names.
  const indexed = keys.length > 0 && keys.every((k, i) => String(i) === k);
  if (indexed) {
    return asOrderedList(obj).map((el) => ({ field: leafString(el, 'populate entry'), children: [] }));
  }
  // Object form: each key is a relation; a nested `populate` value yields its children recursively.
  return keys.map((field) => {
    const v = obj[field]!;
    let children: PopulateNode[] = [];
    if (typeof v !== 'string' && !Array.isArray(v) && 'populate' in v) {
      children = parsePopulate(v.populate!, nesting + 1); // recurse: populate[rel][populate][sub] / [populate]=*
    }
    return { field, children };
  });
}

// --- top-level entry ---------------------------------------------------------

/**
 * Parse a Strapi query into the engine's structured form. `input` is EITHER a raw query string
 * (`status[$eq]=published&...` — note: NO leading `filters` is added; pass full Strapi keys) or an
 * already-parsed {@link ParamNode} object (what a router hands you). `schema` is the module's
 * field list (from `Engine.define`); it is the whitelist.
 *
 * Returns `{ where?, options: { where?, sort?, offset?, limit? }, populate }`. `options.where` is
 * set to the same tree as the top-level `where` so the result is a drop-in `QueryOptions` for
 * `Engine.respond` — but `options` never carries the flat `filters` list (the parser always emits a
 * tree). Unknown TOP-LEVEL keys (anything other than filters/sort/pagination/fields/populate) are
 * rejected.
 */
export function parseQuery(
  ctxOrFields: FieldDef[] | RelationParseContext,
  input: string | { [k: string]: ParamNode },
): ParsedQuery {
  // Legacy overload: a bare FieldDef[] becomes a context with NO relations (a relation key then keeps
  // 400ing as "unknown field"), so every existing scalar-only caller / test stays byte-identical.
  const ctx: RelationParseContext = Array.isArray(ctxOrFields)
    ? { fields: ctxOrFields, relations: new Map(), resolveTarget: () => undefined }
    : ctxOrFields;
  const schema: QuerySchema = schemaFromFields(ctx.fields);

  const params = typeof input === 'string' ? parseParams(input) : input;

  let where: FilterNode | undefined;
  let sort: SortKey[] | undefined;
  let offset: number | undefined;
  let limit: number | undefined;
  let keysetRaw: RawKeysetOptions | undefined;
  let populate: PopulatePlan = [];
  let status: Status | undefined;
  let locale: string | undefined;
  let fields: string[] | undefined;

  for (const key of Object.keys(params)) {
    switch (key) {
      case 'filters':
        where = parseFilterObject(ctx, schema, params[key]!, 0, '');
        break;
      case 'sort': {
        const s = parseSort(params[key]!);
        validateSortFields(schema, s);
        if (s.length > 0) sort = s;
        break;
      }
      case 'pagination': {
        const pg = parsePagination(params[key]!);
        offset = pg.offset;
        limit = pg.limit;
        keysetRaw = pg.keyset;
        break;
      }
      case 'fields': {
        // Validated against the schema (the SAME unknown-field 400 gate as filters). Carried on the
        // result ONLY when non-empty, so an empty/all-blank `fields=` stays a no-op (no projection).
        const f = parseFields(schema, params[key]!);
        if (f.length > 0) fields = f;
        break;
      }
      case 'populate':
        populate = parsePopulate(params[key]!);
        break;
      case 'status': {
        // Draft & Publish lifecycle selector. Strapi v5 exposes ONLY draft|published (no `all`); a
        // value outside that set -> 400 on ANY type. The EFFECT (folding a published_at predicate) is
        // applied by the read router and only for a D&P type; on a non-D&P type the token parses but is
        // ignored (Strapi-faithful no-op). `status` is a lifecycle selector, NOT a filter/sort field.
        const v = leafString(params[key]!, 'status');
        if (v !== 'draft' && v !== 'published') {
          throw new QueryParseError(`status must be draft|published, got "${v}"`);
        }
        status = v;
        break;
      }
      case 'locale': {
        // i18n locale selector. Validated on ANY type (a malformed slug -> 400); the all-variants `*`
        // sentinel is accepted verbatim BEFORE slug validation. The EFFECT (folding a locale=eq predicate)
        // is applied by the read router and only for an i18n type; on a non-i18n type the token parses but
        // is ignored. `locale` is a selector, NOT a filter/sort field.
        const v = leafString(params[key]!, 'locale');
        locale = v === ALL_LOCALES ? ALL_LOCALES : validateLocale(v);
        break;
      }
      default:
        throw new QueryParseError(`unknown query parameter "${key}"`);
    }
  }

  const options: QueryOptions = {};
  if (where !== undefined) options.where = where;
  if (sort !== undefined) options.sort = sort;
  if (offset !== undefined) options.offset = offset;
  if (limit !== undefined) options.limit = limit;
  if (keysetRaw !== undefined) options.keysetRaw = keysetRaw;

  const out: ParsedQuery = { options, populate };
  if (where !== undefined) out.where = where;
  if (status !== undefined) out.status = status;
  if (locale !== undefined) out.locale = locale;
  if (fields !== undefined) out.fields = fields;
  return out;
}
