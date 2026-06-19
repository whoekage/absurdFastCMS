import type { Predicate, QueryOptions, SortKey, FilterNode } from './table.ts';
import { isSetOp } from './column.ts';

/**
 * API-VERTICAL SLICE 1 — assembled-buffer response cache (the hot-path lever the HTTP bench
 * highlighted: a repeated hot query collapses to one Map.get -> send, skipping the whole
 * query/assemble pipeline).
 *
 * Three pieces live here, all framework-agnostic and mock-free:
 *
 *  1. {@link queryKey} — a CANONICAL, stable string key built from (typeName + normalized
 *     QueryOptions). "The same query" (documented precisely below) maps to the same key, so
 *     trivially-reordered-but-equivalent queries share one cache entry.
 *  2. {@link ResponseCache} — a BOUNDED LRU over assembled Buffers, capped by entry count AND total
 *     cached bytes (both configurable, sane defaults). Overflow evicts least-recently-used. A
 *     near-unique query stream can never leak: the caps are hard.
 *  3. {@link ChangeBus} / {@link InProcessChangeBus} — the invalidation SEAM. `publish(typeName)`
 *     fans out to subscribers; the cache subscribes and DROPS every entry for that type. A Redis
 *     pub/sub cluster bus is a future drop-in behind this same interface — NOT built here.
 */

// --- key normalization ------------------------------------------------------

/**
 * Canonical JSON-ish encoding of an arbitrary predicate value. Objects are emitted with sorted keys
 * so two structurally-equal values stringify identically regardless of insertion order; everything
 * else falls back to JSON.stringify (numbers, strings, bools, null). Dates are normalized to their
 * epoch-ms number so a Date and its millisecond-equal number coincide (the engine coerces dates to
 * f64 epoch-ms anyway).
 */
function encodeValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Date) return String(v.getTime());
  if (Array.isArray(v)) return '[' + v.map(encodeValue).join(',') + ']';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + encodeValue(o[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/** Stable encoding of one predicate's value, set-order-normalized for the set operators. */
function encodePredicateValue(p: Predicate): string {
  if (isSetOp(p.op) && Array.isArray(p.value)) {
    // `in`/`notIn` are SET membership: element order is semantically irrelevant, so sort the
    // encoded elements. `between` ([lo, hi]) is positional and is left untouched by encodeValue.
    const els = p.value.map(encodeValue).slice().sort();
    return '[' + els.join(',') + ']';
  }
  return encodeValue(p.value);
}

/** A single predicate -> canonical token `field|op|value`. */
function encodePredicate(p: Predicate): string {
  return JSON.stringify(p.field) + '|' + p.op + '|' + encodePredicateValue(p);
}

/**
 * Canonicalize the top-level `filters[]`. These are AND-combined and ORDER-INDEPENDENT, so we sort
 * the encoded predicates: `[{status eq published},{views gt 10}]` and `[{views gt 10},{status eq
 * published}]` produce the IDENTICAL key (a "trivially-reordered-but-equivalent" query).
 */
function encodeFilters(filters: Predicate[]): string {
  return '[' + filters.map(encodePredicate).slice().sort().join(',') + ']';
}

/**
 * Canonicalize a FilterNode tree. AND/OR children are order-independent (boolean algebra) so their
 * encodings are sorted; NOT and leaves are structural. This is conservative — it does NOT flatten
 * `and(and(a,b),c)` or dedupe, so a re-associated tree is NOT treated as the same key (it would
 * still be CORRECT, just a cache miss). Equivalence is by canonical *shape*, not full SAT.
 */
function encodeNode(node: FilterNode): string {
  // Relations Slice 4: a RELATION leaf (checked FIRST — structurally disjoint). The relation field
  // name + the recursively-encoded sub-tree both enter the canonical key, so two different relation
  // filters (`author.name=A` vs `=B`, or `author` vs `editor` same sub) never collide on one entry,
  // and the keyset cursor sig (via filterCanonical) binds the relation leaf too.
  if ('relation' in node) return 'R(' + JSON.stringify(node.relation) + ':' + encodeNode(node.sub) + ')';
  if ('leaf' in node) return 'L(' + encodePredicate(node.leaf) + ')';
  if (node.op === 'not') return 'NOT(' + encodeNode(node.children[0]) + ')';
  const kids = node.children.map(encodeNode).slice().sort();
  return (node.op === 'and' ? 'AND' : 'OR') + '(' + kids.join(',') + ')';
}

/** Canonicalize one sort key. */
function encodeSort(sort: SortKey[]): string {
  // Sort keys are POSITIONAL (primary, secondary, ...) so order is preserved.
  return '[' + sort.map((s) => JSON.stringify(s.field) + ':' + s.dir).join(',') + ']';
}

/**
 * Build the canonical cache key for `(typeName, opts)`.
 *
 * WHAT COUNTS AS "THE SAME QUERY":
 *  - same content-type name;
 *  - same set of top-level filter predicates (ORDER-INDEPENDENT — they AND together) with
 *    set-operator values (`in`/`notIn`) compared as ORDER-INDEPENDENT sets;
 *  - same filter TREE shape when `filterTree` is used (AND/OR children order-independent; NOT and
 *    associativity are structural — re-associated trees are a miss, not a stale hit);
 *  - same sort keys IN ORDER (sort is positional);
 *  - same offset (default 0) and same limit (default Infinity -> "*").
 *
 * Anything not in this list (e.g. a re-associated boolean tree) simply misses and re-assembles
 * correctly — the key never produces a FALSE hit.
 */
/**
 * The canonical FILTER token of a query: the nested `where` TREE (`'T' + encodeNode`) when present,
 * else the order-independent flat `filters` encoding. The SINGLE source of this choice so {@link
 * queryKey} (cache key) and {@link filterCanonical} (cursor signature) can never drift on how a filter
 * canonicalizes.
 */
function canonicalFilterToken(tree: FilterNode | undefined, filters: QueryOptions['filters']): string {
  return tree !== undefined ? 'T' + encodeNode(tree) : encodeFilters(filters ?? []);
}

export function queryKey(typeName: string, opts: QueryOptions, tree?: FilterNode, fields?: string[]): string {
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? Infinity;
  const limitTok = limit === Infinity ? '*' : String(limit);
  const filterTok = canonicalFilterToken(tree, opts.filters);
  // The projected field SET is folded in sorted, so field ORDER is irrelevant (the projection always
  // emits in materialize order) but the SET is bound: a `fields=a` response can never be served for a
  // full-row request, nor for a `fields=a,b` one. The token is ABSENT when fields is undefined/empty, so
  // an unprojected query's key is byte-identical to before this slice (the additive guarantee).
  const fieldsTok = fields !== undefined && fields.length > 0 ? '\u0000F' + [...fields].sort().join(',') : '';
  const base =
    JSON.stringify(typeName) +
    '\u0000' + filterTok +
    '\u0000' + encodeSort(opts.sort ?? []) +
    '\u0000' + String(offset) +
    '\u0000' + limitTok +
    fieldsTok;
  // Keyset requests share no offset/limit, so without this two distinct cursors (page 2 vs page 5)
  // would COLLIDE on the base key. Append the raw cursor/before tokens + pageSize + withCount.
  // The offset key string is UNCHANGED when keysetRaw is absent (the additive guarantee).
  if (opts.keysetRaw !== undefined) {
    const k = opts.keysetRaw;
    return base + '\u0000C' + (k.cursorToken ?? '') + '|' + (k.beforeToken ?? '') + '|' + String(k.pageSize) + '|' + String(k.withCount);
  }
  return base;
}

/**
 * The canonical FILTER shape of a query (the same derivation {@link queryKey} uses for its filter
 * token): the tree encoding when a `where` tree is present, else the order-independent flat
 * `filters` encoding. Exported so the cursor sig binds the SAME filter canonicalization — a
 * logically-equal-but-reordered filter doesn't spuriously 400, but any value/shape change does.
 */
export function filterCanonical(opts: QueryOptions): string {
  return canonicalFilterToken(opts.where, opts.filters);
}

// --- change bus (invalidation seam) -----------------------------------------

/**
 * The invalidation SEAM. `publish(typeName)` signals that a content-type's data changed; subscribers
 * react (the cache drops that type's entries). A Redis pub/sub cluster bus is a future drop-in behind
 * this same interface.
 */
export interface ChangeBus {
  publish(typeName: string): void;
  subscribe(handler: (typeName: string) => void): void;
}

/** In-process default bus: a plain synchronous fan-out to local subscribers. */
export class InProcessChangeBus implements ChangeBus {
  private readonly handlers: ((typeName: string) => void)[] = [];

  publish(typeName: string): void {
    for (const h of this.handlers) h(typeName);
  }

  subscribe(handler: (typeName: string) => void): void {
    this.handlers.push(handler);
  }
}

// --- bounded LRU response cache ---------------------------------------------

interface CacheEntry {
  typeName: string;
  buf: Buffer;
}

export interface ResponseCacheOptions {
  /** Hard cap on entry count. Default 1024. */
  maxEntries?: number;
  /** Hard cap on total cached payload bytes. Default 64 MiB. */
  maxBytes?: number;
  /** When false, get/set are no-ops (cache disabled — for cold-path benchmarking). Default true. */
  enabled?: boolean;
}

const DEFAULT_MAX_ENTRIES = 1024;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * A bounded LRU cache of assembled response Buffers, keyed by {@link queryKey}.
 *
 * Recency is tracked by JS Map insertion order: a `get` hit re-inserts the key (moving it to the
 * "most recently used" end), and overflow evicts from the "oldest" end. Two hard caps hold
 * simultaneously — `maxEntries` and `maxBytes` — so neither a flood of tiny near-unique queries nor
 * a few huge payloads can leak memory.
 *
 * Per-type invalidation is tracked by a side index `typeName -> Set<key>`, so a `publish` drops only
 * that type's entries in O(#entries-for-type), leaving every other type's cache untouched. Predicate-
 * aware PARTIAL invalidation (dropping only the entries a write could affect) is a later optimization;
 * for this slice a write to a type drops ALL of that type's cached responses.
 */
export class ResponseCache {
  private readonly map = new Map<string, CacheEntry>();
  private readonly byType = new Map<string, Set<string>>();
  private bytes = 0;

  readonly maxEntries: number;
  readonly maxBytes: number;
  enabled: boolean;

  /** Observability: total hits and misses since construction (used by tests + future metrics). */
  hits = 0;
  misses = 0;
  evictions = 0;

  constructor(bus: ChangeBus, opts: ResponseCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.enabled = opts.enabled ?? true;
    bus.subscribe((typeName) => this.invalidateType(typeName));
  }

  /** Current number of cached entries. */
  get size(): number {
    return this.map.size;
  }

  /** Current total cached payload bytes. */
  get byteSize(): number {
    return this.bytes;
  }

  /**
   * Look up an assembled buffer. On a hit, mark the key most-recently-used and return the SAME
   * buffer bytes (byte-identical to a cold assemble — the caller stored exactly that). On a miss
   * (or when disabled) return undefined.
   */
  get(key: string): Buffer | undefined {
    if (!this.enabled) return undefined;
    const entry = this.map.get(key);
    if (entry === undefined) {
      this.misses++;
      return undefined;
    }
    // Bump recency: delete + re-set moves it to the most-recently-used end of the Map.
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.buf;
  }

  /** Store an assembled buffer for `key` under content-type `typeName`, then enforce the caps. */
  set(key: string, typeName: string, buf: Buffer): void {
    if (!this.enabled) return;
    const existing = this.map.get(key);
    if (existing !== undefined) {
      this.bytes -= existing.buf.length;
      this.map.delete(key);
      // typeName is stable for a given key, so byType already has it — no re-index needed.
    }
    this.map.set(key, { typeName, buf });
    this.bytes += buf.length;
    let set = this.byType.get(typeName);
    if (set === undefined) {
      set = new Set();
      this.byType.set(typeName, set);
    }
    set.add(key);
    this.evictToBounds();
  }

  /** Evict least-recently-used entries until BOTH caps hold. */
  private evictToBounds(): void {
    while (this.map.size > this.maxEntries || (this.bytes > this.maxBytes && this.map.size > 0)) {
      // The first key in Map iteration order is the least-recently-used.
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.evictKey(oldest.value);
      this.evictions++;
    }
  }

  private evictKey(key: string): void {
    const entry = this.map.get(key);
    if (entry === undefined) return;
    this.bytes -= entry.buf.length;
    this.map.delete(key);
    const set = this.byType.get(entry.typeName);
    if (set !== undefined) {
      set.delete(key);
      if (set.size === 0) this.byType.delete(entry.typeName);
    }
  }

  /** Drop EVERY cached entry for one content-type (the ChangeBus invalidation handler). */
  invalidateType(typeName: string): void {
    const set = this.byType.get(typeName);
    if (set === undefined) return;
    for (const key of set) {
      const entry = this.map.get(key);
      if (entry !== undefined) {
        this.bytes -= entry.buf.length;
        this.map.delete(key);
      }
    }
    this.byType.delete(typeName);
  }

  /** Drop everything (e.g. for a benchmark reset). */
  clear(): void {
    this.map.clear();
    this.byType.clear();
    this.bytes = 0;
  }
}
