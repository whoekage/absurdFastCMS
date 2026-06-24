// @conti/sdk — QUERY-STRING BUILDER (Slice 2).
//
// Build a Strapi v5 bracket-syntax query string from a typed {@link QueryParams} object — the exact
// `key[..]=value` wire shape the api's `parseQuery` (packages/api/src/store/query.parser.ts) decodes.
//
// Round-trip contract (mock-free verification): for every supported input,
//   parseParams(buildQueryString(x))  ===  the nested ParamNode tree parseQuery expects.
// The builder is therefore the exact inverse of `parseParams` over the supported surface.
//
// ── ENCODING RULE (load-bearing) ─────────────────────────────────────────────────────────────────
// The parser splits a key into bracket segments FIRST (`splitKey`) and then `decodeURIComponent`s the
// whole key + value of each `a=b` pair. So:
//   • VALUES are `encodeURIComponent`-escaped (the parser decodes them back) — this also escapes `&`,
//     `=`, `[`, `]`, `,` inside a value so they can't corrupt the key grammar.
//   • bracket KEYS stay LITERAL: the literal `[`/`]` survive `decodeURIComponent` unchanged and are
//     exactly what `splitKey()` consumes. (We DON'T percent-encode the brackets.)
//
// ── DETERMINISM ──────────────────────────────────────────────────────────────────────────────────
// Top-level keys are emitted in a FIXED order — filters, sort, pagination, fields, populate — so the
// output is stable for snapshots/caching. `{}` (or a params object with nothing to emit) → `''`.

import type { FilterOperator } from './types.ts';

// === Input types ================================================================================

/**
 * A primitive filter value as the caller supplies it. Numbers/booleans/Date are stringified the same
 * way the wire expects (Date → ISO 8601, which the parser's `date` coercion accepts). `bigint` is
 * stringified to its exact decimal (anti precision-loss, matches `biginteger`/`i64` coercion).
 */
export type FilterValue = string | number | boolean | bigint | Date;

/**
 * The per-operator value shape. Most operators take a single {@link FilterValue}; `$in`/`$notIn`
 * take an array; `$between` takes a 2-tuple; `$null`/`$notNull` take a boolean flag (always emitted
 * as the literal `true` the parser requires — `false` omits the clause).
 */
export interface FilterCondition {
  $eq?: FilterValue;
  $ne?: FilterValue;
  $gt?: FilterValue;
  $gte?: FilterValue;
  $lt?: FilterValue;
  $lte?: FilterValue;
  $eqi?: FilterValue;
  $nei?: FilterValue;
  $contains?: FilterValue;
  $containsi?: FilterValue;
  $notContains?: FilterValue;
  $notContainsi?: FilterValue;
  $startsWith?: FilterValue;
  $startsWithi?: FilterValue;
  $endsWith?: FilterValue;
  $endsWithi?: FilterValue;
  $in?: FilterValue[];
  $notIn?: FilterValue[];
  $between?: [FilterValue, FilterValue];
  $null?: boolean;
  $notNull?: boolean;
}

/**
 * A filters tree. A key is EITHER a logical combinator (`$and`/`$or` = array of sub-trees, `$not` =
 * one sub-tree) OR a field name. A field maps to a {@link FilterCondition} (operator object), a bare
 * {@link FilterValue} (short form → `$eq`), or a nested {@link FilterObject} (a RELATION sub-filter,
 * `filters[rel][field][$op]`, up to MAX_RELATION_HOPS=3 deep). The three shapes are disjoint enough
 * to overlap in the union; the recursive flattener picks the right encoding at runtime.
 */
export interface FilterObject {
  $and?: FilterObject[];
  $or?: FilterObject[];
  $not?: FilterObject;
  [field: string]: FilterValue | FilterCondition | FilterObject | FilterObject[] | undefined;
}

/** `sort` — a single key (`'views:desc'`) or an ordered multi-key list (joined with `,`). */
export type SortParam = string | string[];

/** Page-based pagination (1-based `page` + `pageSize`). */
export interface PagePagination {
  page?: number;
  pageSize?: number;
}

/** Offset-based pagination (`start` offset + `limit`). */
export interface OffsetPagination {
  start?: number;
  limit?: number;
}

/**
 * Keyset (cursor) pagination. Forward = `cursor` (empty string bootstraps the first page); backward
 * = `before` (a non-empty opaque token). `pageSize` and `withCount` are the keyset knobs. `cursor`
 * and `before` are mutually exclusive (the parser rejects both).
 */
export interface KeysetPagination {
  cursor?: string;
  before?: string;
  pageSize?: number;
  withCount?: boolean;
}

/** The three Strapi-compatible pagination modes (mutually exclusive at the parser). */
export type PaginationParam = PagePagination | OffsetPagination | KeysetPagination;

/**
 * A populate spec. `'*'` (wildcard, all depth-1 relations), a single relation name, an array of
 * names, or a nested object mapping a relation to a sub-spec (`true` = leaf, or `{ populate: ... }`
 * to recurse — `populate[rel][populate][...]`).
 */
export type PopulateParam = string | string[] | PopulateObject;

/** The nested object form of populate: relation → leaf (`true`) or a recursive `{ populate }` node. */
export interface PopulateObject {
  [relation: string]: boolean | { populate?: PopulateParam } | undefined;
}

/** The Draft & Publish lifecycle selector (Strapi v5; replaced v4 `publicationState`). */
export type StatusParam = 'draft' | 'published';

/**
 * i18n locale selector. A locale slug (`'en'`, `'fr'`, `'pt-BR'`) returns only that locale's variants;
 * `'*'` returns ALL variants (no locale predicate); omitted defaults server-side to DEFAULT_LOCALE. No
 * fallback — a slug with no variant returns nothing. No-op on a type without i18n enabled.
 */
export type LocaleParam = string;

/** The full read-query parameter set the builder serializes. All keys optional; `{}` → `''`. */
export interface QueryParams {
  filters?: FilterObject;
  sort?: SortParam;
  pagination?: PaginationParam;
  fields?: string[];
  populate?: PopulateParam;
  /**
   * Draft & Publish lifecycle selector. `published` (the server default when omitted) returns only
   * published entries; `draft` returns only drafts. No-op on a type without Draft & Publish enabled.
   */
  status?: StatusParam;
  /**
   * i18n locale selector. A slug returns only that locale's variants; `'*'` returns all variants; omitted
   * defaults server-side to DEFAULT_LOCALE (no fallback). No-op on a type without i18n enabled.
   */
  locale?: LocaleParam;
}

// === core: a recursive key/value pair accumulator ===============================================

/** One flattened wire pair: a LITERAL bracket key and a RAW (un-encoded) value. */
interface Pair {
  key: string;
  value: string;
}

/** Stringify a leaf filter value to its wire form (Date → ISO, bigint → exact decimal). */
function stringifyValue(v: FilterValue): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  return String(v);
}

/** Append `[seg]` to a base bracket key (the base is a bare head or an already-bracketed key). */
function child(base: string, seg: string): string {
  return `${base}[${seg}]`;
}

// === filters ====================================================================================

/** True when an object is a {@link FilterCondition} (every key is a known operator token). */
function isCondition(node: Record<string, unknown>): boolean {
  const keys = Object.keys(node);
  if (keys.length === 0) return false;
  return keys.every((k) => k in OPERATOR_KEYS);
}

/** Operator-token whitelist (mirrors the parser's OP_MAP keys) for {@link isCondition}. */
const OPERATOR_KEYS: Record<FilterOperator, true> = {
  $eq: true, $ne: true, $gt: true, $gte: true, $lt: true, $lte: true,
  $eqi: true, $nei: true, $contains: true, $containsi: true,
  $notContains: true, $notContainsi: true, $startsWith: true, $startsWithi: true,
  $endsWith: true, $endsWithi: true, $in: true, $notIn: true, $between: true,
  $null: true, $notNull: true,
};

/** The set / range / flag operators that need special value encoding. */
const SET_OPS = new Set<string>(['$in', '$notIn']);
const NULL_OPS = new Set<string>(['$null', '$notNull']);

/** Emit one operator condition `<base>[$op]=value` (or its array / flag variants) into `out`. */
function emitCondition(base: string, cond: FilterCondition, out: Pair[]): void {
  for (const op of Object.keys(cond) as FilterOperator[]) {
    const raw = cond[op];
    if (raw === undefined) continue;
    const opKey = child(base, op);
    if (NULL_OPS.has(op)) {
      // The parser requires the literal flag `true`; a `false`/absent flag emits NOTHING.
      if (raw === true) out.push({ key: opKey, value: 'true' });
      continue;
    }
    if (SET_OPS.has(op)) {
      // `$in`/`$notIn`: indexed brackets `[$in][0]=a&[$in][1]=b`. An empty array emits nothing.
      const arr = raw as FilterValue[];
      arr.forEach((el, i) => out.push({ key: child(opKey, String(i)), value: stringifyValue(el) }));
      continue;
    }
    if (op === '$between') {
      // Exactly two positional bounds `[$between][0]=lo&[$between][1]=hi`.
      const [lo, hi] = raw as [FilterValue, FilterValue];
      out.push({ key: child(opKey, '0'), value: stringifyValue(lo) });
      out.push({ key: child(opKey, '1'), value: stringifyValue(hi) });
      continue;
    }
    out.push({ key: opKey, value: stringifyValue(raw as FilterValue) });
  }
}

/**
 * Recursively flatten a filters object under `base` (`filters` at the top). Handles the logical
 * combinators (`$and`/`$or` → indexed array of sub-trees, `$not` → one sub-tree), the field short
 * form (bare value → `$eq`), the operator-object form, and the RELATION sub-filter form (a nested
 * object that is NOT a condition recurses as `filters[rel][...]`).
 */
function emitFilterObject(base: string, node: FilterObject, out: Pair[]): void {
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (val === undefined) continue;

    if (key === '$and' || key === '$or') {
      const list = val as FilterObject[];
      list.forEach((sub, i) => emitFilterObject(child(child(base, key), String(i)), sub, out));
      continue;
    }
    if (key === '$not') {
      emitFilterObject(child(base, key), val as FilterObject, out);
      continue;
    }

    // A field key.
    const fieldKey = child(base, key);
    if (val instanceof Date || typeof val !== 'object') {
      // Short form: `filters[field]=value` → `$eq`.
      out.push({ key: fieldKey, value: stringifyValue(val as FilterValue) });
      continue;
    }
    const obj = val as Record<string, unknown>;
    if (isCondition(obj)) {
      emitCondition(fieldKey, obj as FilterCondition, out);
    } else {
      // A nested object that is NOT a condition → a relation sub-filter; recurse one hop deeper.
      emitFilterObject(fieldKey, obj as FilterObject, out);
    }
  }
}

// === sort / pagination / fields / populate ======================================================

function emitSort(node: SortParam, out: Pair[]): void {
  const joined = Array.isArray(node) ? node.join(',') : node;
  if (joined === '') return;
  out.push({ key: 'sort', value: joined });
}

function emitPagination(node: PaginationParam, out: Pair[]): void {
  for (const k of Object.keys(node) as (keyof (PagePagination & OffsetPagination & KeysetPagination))[]) {
    const v = (node as Record<string, unknown>)[k];
    if (v === undefined) continue;
    // `withCount` is a boolean flag; everything else is a number / opaque string token.
    out.push({ key: child('pagination', k), value: typeof v === 'boolean' ? String(v) : String(v) });
  }
}

function emitFields(node: string[], out: Pair[]): void {
  const joined = node.join(',');
  if (joined === '') return;
  out.push({ key: 'fields', value: joined });
}

/** Flatten a populate spec under `base` (`populate` at the top). */
function emitPopulate(base: string, node: PopulateParam, out: Pair[]): void {
  if (typeof node === 'string') {
    out.push({ key: base, value: node }); // `populate=*` or `populate=author,tags`
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((rel, i) => out.push({ key: child(base, String(i)), value: rel }));
    return;
  }
  // Object form: each key is a relation; `true` is a leaf, `{ populate }` recurses.
  for (const rel of Object.keys(node)) {
    const sub = node[rel];
    if (sub === undefined) continue;
    const relKey = child(base, rel);
    if (sub === true) {
      // A leaf relation. Emit `populate[rel][populate]=*`? No — a bare `populate[rel]=true` would be
      // a non-index, non-`populate` object at the parser and yield an empty-children leaf. We emit
      // the explicit, unambiguous `populate[rel]=true` leaf marker that the parser reads as a name.
      out.push({ key: relKey, value: 'true' });
      continue;
    }
    if (sub === false) continue; // explicit opt-out: omit the relation entirely (do not populate it).
    // sub is `{ populate?: ... }`.
    if (sub.populate !== undefined) {
      emitPopulate(child(relKey, 'populate'), sub.populate, out);
    } else {
      out.push({ key: relKey, value: 'true' });
    }
  }
}

// === top-level entry ============================================================================

/**
 * Serialize a {@link QueryParams} into a Strapi bracket-syntax query string (no leading `?`). Keys
 * are emitted in the FIXED order filters → sort → pagination → fields → populate for deterministic
 * output. Values are `encodeURIComponent`-escaped; bracket keys stay literal. Returns `''` when there
 * is nothing to emit (`{}` or all-empty members).
 */
export function buildQueryString(params: QueryParams): string {
  const out: Pair[] = [];

  if (params.filters !== undefined) emitFilterObject('filters', params.filters, out);
  if (params.sort !== undefined) emitSort(params.sort, out);
  if (params.pagination !== undefined) emitPagination(params.pagination, out);
  if (params.fields !== undefined) emitFields(params.fields, out);
  if (params.populate !== undefined) emitPopulate('populate', params.populate, out);
  if (params.status !== undefined) out.push({ key: 'status', value: params.status });
  if (params.locale !== undefined) out.push({ key: 'locale', value: params.locale });

  return out.map((p) => `${p.key}=${encodeURIComponent(p.value)}`).join('&');
}
