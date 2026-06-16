import { coerceDate, coerceDecimal, coerceI64, type ColumnType, type ScanOp } from './column.ts';
import type { FieldDef, FilterNode, Predicate, QueryOptions, RawKeysetOptions, SortKey } from './table.ts';
import type { SortDir } from './sorted-index.ts';

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
 * Everything is VALIDATED against the content-type schema (the `FieldDef[]` the Engine was
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

/** A single relation to populate (single-hop; `depth` is reserved for simple nested populate). */
export interface PopulateEntry {
  field: string;
  depth: number;
}

/** The optional populate plan: which relation fields to expand. Empty when `populate` is absent. */
export type PopulatePlan = PopulateEntry[];

/** The parser's full structured output. `where` is omitted when there are no filters. */
export interface ParsedQuery {
  where?: FilterNode;
  options: QueryOptions;
  populate: PopulatePlan;
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
  scale?: number;
  precision?: number;
}
export type Schema = Map<string, SchemaEntry>;

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
  schema: Schema,
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
 */
function parseFieldFilters(schema: Schema, field: string, node: ParamNode): FilterNode {
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

/**
 * Recursively parse a filters object into a {@link FilterNode}. Handles the logical combinators
 * `$and` / `$or` (arrays of sub-filter objects) and `$not` (a single sub-filter object), and field
 * keys (each a field-level operator object). Multiple sibling keys at one level AND together
 * (Strapi's implicit-AND of co-located conditions).
 */
function parseFilterObject(schema: Schema, node: ParamNode): FilterNode {
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
      const sub = list.map((el) => parseFilterObject(schema, el));
      children.push({ op: key === '$and' ? 'and' : 'or', children: sub });
    } else if (key === '$not') {
      children.push({ op: 'not', children: [parseFilterObject(schema, obj[key]!)] });
    } else if (key.startsWith('$')) {
      throw new QueryParseError(`unknown logical operator "${key}"`);
    } else {
      children.push(parseFieldFilters(schema, key, obj[key]!));
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
function validateSortFields(schema: Schema, sort: SortKey[]): void {
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
function parseFields(schema: Schema, node: ParamNode): string[] {
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
 * a flat single-hop plan. A simple `populate[rel][populate]=sub` bumps `depth` to 2 (the deepest
 * "simple" case we support); anything richer is accepted as depth 1 on the named relation.
 * Relation NAMES are not in the column schema, so they are not whitelisted here (the populate plan
 * is resolved against the table's registered Relations at execution time).
 */
function parsePopulate(node: ParamNode): PopulatePlan {
  if (typeof node === 'string') {
    if (node === '*') return [{ field: '*', depth: 1 }];
    return node
      .split(',')
      .filter((s) => s !== '')
      .map((field) => ({ field, depth: 1 }));
  }
  if (Array.isArray(node)) {
    return node.map((el) => ({ field: leafString(el, 'populate entry'), depth: 1 }));
  }
  const obj = node as { [k: string]: ParamNode };
  const keys = Object.keys(obj);
  // Index-shaped object `populate[0]=author` behaves like an array of names.
  const indexed = keys.length > 0 && keys.every((k, i) => String(i) === k);
  if (indexed) {
    return asOrderedList(obj).map((el) => ({ field: leafString(el, 'populate entry'), depth: 1 }));
  }
  return keys.map((field) => {
    const v = obj[field]!;
    let depth = 1;
    if (typeof v !== 'string' && !Array.isArray(v) && 'populate' in v) depth = 2;
    return { field, depth };
  });
}

// --- top-level entry ---------------------------------------------------------

/**
 * Parse a Strapi query into the engine's structured form. `input` is EITHER a raw query string
 * (`status[$eq]=published&...` — note: NO leading `filters` is added; pass full Strapi keys) or an
 * already-parsed {@link ParamNode} object (what a router hands you). `schema` is the content-type's
 * field list (from `Engine.define`); it is the whitelist.
 *
 * Returns `{ where?, options: { where?, sort?, offset?, limit? }, populate }`. `options.where` is
 * set to the same tree as the top-level `where` so the result is a drop-in `QueryOptions` for
 * `Engine.respond` — but `options` never carries the flat `filters` list (the parser always emits a
 * tree). Unknown TOP-LEVEL keys (anything other than filters/sort/pagination/fields/populate) are
 * rejected.
 */
export function parseQuery(fields: FieldDef[], input: string | { [k: string]: ParamNode }): ParsedQuery {
  const schema: Schema = new Map<string, SchemaEntry>();
  for (const f of fields) schema.set(f.name, { type: f.type, scale: f.scale, precision: f.precision });

  const params = typeof input === 'string' ? parseParams(input) : input;

  let where: FilterNode | undefined;
  let sort: SortKey[] | undefined;
  let offset: number | undefined;
  let limit: number | undefined;
  let keysetRaw: RawKeysetOptions | undefined;
  let populate: PopulatePlan = [];

  for (const key of Object.keys(params)) {
    switch (key) {
      case 'filters':
        where = parseFilterObject(schema, params[key]!);
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
      case 'fields':
        // Validated against the schema (selection projection is a later slice; we whitelist here).
        parseFields(schema, params[key]!);
        break;
      case 'populate':
        populate = parsePopulate(params[key]!);
        break;
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
  return out;
}
