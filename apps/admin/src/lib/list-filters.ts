import { z } from 'zod';
import type {
  CmsType,
  ModuleDefinition,
  FieldDefinition,
  FilterCondition,
  FilterObject,
  FilterOperator,
  QueryParams,
} from '@conti/sdk';

// ──────────────────────────────────────────────────────────────────────────────────────────────
// List state: filtering / search / sort / pagination, all driven from the route's TYPED SEARCH
// PARAMS. This module is the single source of truth for three concerns:
//
//   1. OPERATOR GATING — which FilterOperators are valid for a given field's type.
//   2. The Zod SEARCH-PARAM SCHEMA (`listSearchSchema`) the route validates with `validateSearch`.
//   3. STATE → SDK QUERY mapping — turn the validated search params into a `QueryParams` the SDK
//      `api.list` / `buildQueryString` understands (filters / sort / pagination).
//
// Everything below is pure + serializable so the URL stays the canonical store of list state.
// ──────────────────────────────────────────────────────────────────────────────────────────────

// === 1. operator gating ========================================================================

/** A coarse "kind" grouping cmsTypes by how they filter — drives operator + value-input choice. */
export type FilterKind = 'text' | 'numeric' | 'date' | 'enum' | 'boolean';

/** Map a type to its {@link FilterKind}. The closed CmsType set means this `switch` is exhaustive. */
function filterKind(type: CmsType): FilterKind {
  switch (type) {
    case 'string':
    case 'text':
    case 'email':
    case 'uid':
    case 'uuid':
    case 'json':
    case 'array':
      return 'text';
    case 'integer':
    case 'biginteger':
    case 'float':
    case 'decimal':
      return 'numeric';
    case 'date':
    case 'datetime':
    case 'time':
      return 'date';
    case 'enumeration':
      return 'enum';
    case 'boolean':
      return 'boolean';
    // be-04 MEDIA: a media field is an asset-id reference, not a user-facing filterable scalar — it is
    // excluded from the filter UI by isFilterableField below. Map it to `text` only to keep this switch
    // exhaustive over the closed CmsType set (the value is never used: media never reaches a filter input).
    case 'media':
      return 'text';
  }
}

/** The be-05 structured-content kinds — never filterable (excluded by {@link isFilterableField}). */
const COMPONENT_KINDS = new Set<string>(['component', 'component-repeatable', 'dynamiczone']);

/** Resolve the {@link FilterKind} for a field. A be-05 component field is non-filterable -> 'text' fallback. */
export function fieldFilterKind(field: FieldDefinition): FilterKind {
  if (COMPONENT_KINDS.has(field.type)) return 'text';
  return filterKind(field.type as CmsType);
}

/**
 * Whether a field can be filtered at all. The API resolves both `json` and `array` cmsTypes to the
 * engine `json` ColumnType, and the store's query parser REJECTS every operator on a json column
 * ("filtering on json fields is not supported") — so offering ANY operator on these would guarantee
 * a 400. They are therefore non-filterable (excluded from the field picker AND the search fallback).
 */
export function isFilterableField(field: FieldDefinition): boolean {
  // be-04 MEDIA: a media field is an asset-id reference (a multiple one is a json column the parser
  // rejects operators on); filtering by raw file id is not a meaningful admin operation — exclude it.
  // be-05: a component / component-repeatable / dynamiczone field is a structured jsonb tree — not a
  // scalar to filter on; exclude it from the field picker + search fallback.
  return field.type !== 'json' && field.type !== 'array' && field.type !== 'media' && !COMPONENT_KINDS.has(field.type);
}

/**
 * The ALLOWED operators per {@link FilterKind}, in display order. This is the gate the filter-bar's
 * operator <Select> reads — a field only ever offers operators its kind supports:
 *
 *   • text    — eq/ne, the four contains/startsWith/endsWith (+case-insensitive `i` variants), null
 *   • numeric — eq/ne, the ordered comparisons, between, in/notIn, null
 *   • date    — same as numeric (dates compare + range cleanly), no `between` UI ambiguity avoided
 *   • enum    — eq/ne, in (multi-select of enumValues), null
 *   • boolean — eq (true/false), null
 */
const OPERATORS_BY_KIND: Record<FilterKind, readonly FilterOperator[]> = {
  text: [
    '$eq',
    '$ne',
    '$contains',
    '$containsi',
    '$notContains',
    '$notContainsi',
    '$startsWith',
    '$startsWithi',
    '$endsWith',
    '$endsWithi',
    '$null',
    '$notNull',
  ],
  numeric: ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$between', '$in', '$notIn', '$null', '$notNull'],
  date: ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$between', '$null', '$notNull'],
  enum: ['$eq', '$ne', '$in', '$null', '$notNull'],
  boolean: ['$eq', '$null', '$notNull'],
};

/** The operators a given field may use, derived from its type. */
export function operatorsForField(field: FieldDefinition): readonly FilterOperator[] {
  return OPERATORS_BY_KIND[fieldFilterKind(field)];
}

/** A human label for an operator token (filter-bar operator dropdown). */
export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  $eq: 'equals',
  $ne: 'not equals',
  $gt: 'greater than',
  $gte: 'greater or equal',
  $lt: 'less than',
  $lte: 'less or equal',
  $between: 'between',
  $in: 'in',
  $notIn: 'not in',
  $null: 'is empty',
  $notNull: 'is not empty',
  $eqi: 'equals (i)',
  $nei: 'not equals (i)',
  $contains: 'contains',
  $containsi: 'contains (i)',
  $notContains: 'does not contain',
  $notContainsi: 'does not contain (i)',
  $startsWith: 'starts with',
  $startsWithi: 'starts with (i)',
  $endsWith: 'ends with',
  $endsWithi: 'ends with (i)',
};

/** Operators that need NO value input (they take a boolean presence flag). */
export const NULLARY_OPERATORS: ReadonlySet<FilterOperator> = new Set<FilterOperator>([
  '$null',
  '$notNull',
]);

/** Operators that take a SET of values (rendered as a multi-value input / enum multi-select). */
export const MULTI_OPERATORS: ReadonlySet<FilterOperator> = new Set<FilterOperator>([
  '$in',
  '$notIn',
]);

/** Operators that take exactly TWO values (a range — `[lo, hi]`). */
export const RANGE_OPERATORS: ReadonlySet<FilterOperator> = new Set<FilterOperator>(['$between']);

// === 2. the search-param schema (validateSearch) ===============================================

/**
 * One filter row as stored in the URL. `value` is ALWAYS a string array so a single shape covers a
 * scalar op (`[v]`), a range op (`[lo, hi]`), a set op (`[...members]`), and a nullary op (`[]`).
 * Keeping values as STRINGS is deliberate — bigint/decimal precision is preserved (never coerced to
 * a JS number) and the whole row serializes straight into the URL.
 */
const filterRowSchema = z.object({
  field: z.string().min(1),
  op: z.string().min(1),
  value: z.array(z.string()).default([]),
});
export type FilterRow = z.infer<typeof filterRowSchema>;

/** Sort direction. */
const sortDirSchema = z.enum(['asc', 'desc']);
export type SortDir = z.infer<typeof sortDirSchema>;

/** One sort key (field + direction). Multi-key sort is an ordered list of these. */
const sortKeySchema = z.object({
  field: z.string().min(1),
  dir: sortDirSchema,
});
export type SortKey = z.infer<typeof sortKeySchema>;

/** Allowed page sizes for the page-size selector. */
export const PAGE_SIZES = [10, 25, 50] as const;
/** One of the allowed rows-per-page values. */
export type PageSize = (typeof PAGE_SIZES)[number];
const pageSizeSchema = z
  .number()
  .int()
  .refine((n): n is (typeof PAGE_SIZES)[number] => (PAGE_SIZES as readonly number[]).includes(n))
  .catch(10);

/**
 * The route's typed search-param schema. Every piece of list state lives here so the URL is
 * shareable + back/forward works, and it serializes straight into the SDK query. All members carry
 * `.catch(...)` defaults so a hand-edited / malformed URL degrades gracefully instead of throwing.
 */
export const listSearchSchema = z.object({
  /** Free-text search box value (debounced into the URL). Mapped to a `$containsi` on the search field. */
  q: z.string().catch(''),
  /** The structured filter rows, combined with `$and`. */
  filters: z.array(filterRowSchema).catch([]),
  /** Ordered sort keys (multi-key supported). Empty → server default (id:asc-ish). */
  sort: z.array(sortKeySchema).catch([]),
  /** 1-based page. */
  page: z.number().int().min(1).catch(1),
  /** Rows per page (one of {@link PAGE_SIZES}). */
  pageSize: pageSizeSchema,
});

export type ListSearch = z.infer<typeof listSearchSchema>;

/** The empty / default search state (also what "Clear filters" resets the URL toward). */
export const EMPTY_LIST_SEARCH: ListSearch = {
  q: '',
  filters: [],
  sort: [],
  page: 1,
  pageSize: 10,
};

// === 3. state → SDK query mapping ==============================================================

/**
 * Choose the field a free-text search box targets: the FIRST string/text user field, falling back to
 * any text-kind field, else `undefined` (no search box shown). Pure derivation from the definition.
 */
export function searchField(def: ModuleDefinition): FieldDefinition | undefined {
  const userFields = def.fields.filter((f) => !f.system && isFilterableField(f));
  const stringy = userFields.find((f) => f.type === 'string' || f.type === 'text');
  if (stringy) return stringy;
  return userFields.find((f) => fieldFilterKind(f) === 'text');
}

/** Coerce a URL string value to the wire form for a field — bigint/decimal stay STRINGS, numbers parse. */
function coerceValue(raw: string, field: FieldDefinition): string | number | boolean {
  const kind = fieldFilterKind(field);
  if (kind === 'boolean') return raw === 'true';
  if (kind === 'numeric') {
    // integer / float coerce to a JS number; biginteger / decimal MUST stay strings (precision).
    if (field.type === 'integer' || field.type === 'float') {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    return raw;
  }
  return raw;
}

/** Build the {@link FilterCondition} for one row, given its operator + coerced value(s). */
function rowCondition(row: FilterRow, field: FieldDefinition): FilterCondition | undefined {
  const op = row.op as FilterOperator;

  if (NULLARY_OPERATORS.has(op)) {
    // `$null` / `$notNull` take the literal `true` flag.
    return op === '$null' ? { $null: true } : { $notNull: true };
  }

  if (MULTI_OPERATORS.has(op)) {
    const members = row.value.filter((v) => v !== '').map((v) => coerceValue(v, field));
    if (members.length === 0) return undefined;
    return op === '$in' ? { $in: members } : { $notIn: members };
  }

  if (RANGE_OPERATORS.has(op)) {
    const lo = row.value[0];
    const hi = row.value[1];
    if (lo === undefined || hi === undefined || lo === '' || hi === '') return undefined;
    return { $between: [coerceValue(lo, field), coerceValue(hi, field)] };
  }

  // Scalar operators: take the first value.
  const raw = row.value[0];
  if (raw === undefined || raw === '') return undefined;
  const value = coerceValue(raw, field);
  // All remaining ops are single-value; index by the token.
  return { [op]: value } as FilterCondition;
}

/**
 * Build the SDK {@link FilterObject} from the validated search state. The free-text `q` becomes a
 * `$containsi` on the chosen search field; each structured row becomes a per-field condition. All
 * clauses are combined with `$and` (so they intersect). Rows whose field is unknown (stale URL after
 * a schema change) or whose value is empty are dropped. Returns `undefined` when there is nothing to
 * filter (so the SDK omits `filters` entirely).
 */
function buildFilters(
  search: ListSearch,
  def: ModuleDefinition,
  byName: Map<string, FieldDefinition>,
): FilterObject | undefined {
  const clauses: FilterObject[] = [];

  const q = search.q.trim();
  if (q !== '') {
    const sf = searchField(def);
    if (sf) clauses.push({ [sf.name]: { $containsi: q } });
  }

  for (const row of search.filters) {
    const field = byName.get(row.field);
    if (!field) continue;
    // Guard: drop rows on non-filterable (json/array) fields — the API 400s on any json filter.
    if (!isFilterableField(field)) continue;
    // Guard: the row's operator must be valid for the field's kind (stale URL hardening).
    if (!operatorsForField(field).includes(row.op as FilterOperator)) continue;
    const cond = rowCondition(row, field);
    if (cond) clauses.push({ [row.field]: cond });
  }

  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { $and: clauses };
}

/** Map the sort-key list to the SDK `sort` param (`['field:dir', ...]`). Empty → `undefined`. */
function buildSort(search: ListSearch): string[] | undefined {
  if (search.sort.length === 0) return undefined;
  return search.sort.map((k) => `${k.field}:${k.dir}`);
}

/**
 * The full STATE → SDK QueryParams mapping. The single function the route hands to `api.list`; it
 * also forms the basis of the TanStack Query key (serialize this object) so each distinct URL state
 * caches independently.
 */
export function toQueryParams(
  search: ListSearch,
  def: ModuleDefinition,
  byName: Map<string, FieldDefinition>,
): QueryParams {
  const params: QueryParams = {
    pagination: { page: search.page, pageSize: search.pageSize },
  };
  const filters = buildFilters(search, def, byName);
  if (filters) params.filters = filters;
  const sort = buildSort(search);
  if (sort) params.sort = sort;
  return params;
}

/** Look up the current sort direction for a field (for the column-header indicator), or null. */
export function sortDirFor(search: ListSearch, field: string): SortDir | null {
  return search.sort.find((k) => k.field === field)?.dir ?? null;
}

/** The 1-based ordinal of a field within the multi-key sort (for the column-header badge), or 0. */
export function sortIndexFor(search: ListSearch, field: string): number {
  const i = search.sort.findIndex((k) => k.field === field);
  return i < 0 ? 0 : i + 1;
}

/**
 * Toggle a column's sort. Single-click (replace=true) makes it the SOLE sort key, cycling
 * asc → desc → off. Shift-click (replace=false) appends / cycles it within the existing keys,
 * enabling multi-key sort. Returns the NEXT sort-key list (immutable).
 */
export function toggleSort(current: SortKey[], field: string, replace: boolean): SortKey[] {
  const existing = current.find((k) => k.field === field);

  if (replace) {
    if (!existing) return [{ field, dir: 'asc' }];
    if (existing.dir === 'asc') return [{ field, dir: 'desc' }];
    return []; // asc → desc → cleared
  }

  // Multi-key (shift): cycle this field within the list, keep the others.
  if (!existing) return [...current, { field, dir: 'asc' }];
  if (existing.dir === 'asc') {
    return current.map((k) => (k.field === field ? { field, dir: 'desc' as const } : k));
  }
  return current.filter((k) => k.field !== field); // remove this key on the third click
}

/**
 * The default value array for a freshly-chosen operator — sized for its arity so the value input(s)
 * render correctly (range → two slots, multi → empty list, nullary → empty, scalar → one slot).
 */
export function defaultValueForOp(op: FilterOperator): string[] {
  if (NULLARY_OPERATORS.has(op)) return [];
  if (RANGE_OPERATORS.has(op)) return ['', ''];
  if (MULTI_OPERATORS.has(op)) return [];
  return [''];
}
