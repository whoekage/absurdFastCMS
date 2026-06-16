import { Table, type FieldDef, type QueryOptions, type KeysetOptions } from './table.ts';
import { RawJson } from './column.ts';
import {
  CursorCodec,
  InvalidCursorError,
  type CursorPayload,
  type SigInput,
  type SortFieldType,
} from './cursor-codec.ts';
import {
  ResponseCache,
  InProcessChangeBus,
  queryKey,
  filterCanonical,
  type ChangeBus,
  type ResponseCacheOptions,
} from './response-cache.ts';

/**
 * The OUTPUT layer's per-table arena: every row's response JSON bytes, packed.
 *
 * This is the bench-validated late-materialization store (experiments/http-serialization): a row's
 * output JSON is serialized to UTF-8 bytes ONCE at insert time (serialize-on-write) and appended to
 * a single growable `Uint8Array` byte arena, with an `Int32Array` of offsets — `bytes[off[r]..off[r+1]]`
 * is row r's JSON. A list response is then assembled by concatenating subarray slices of the arena +
 * the envelope framing, which the experiment measured at ~3x the throughput of per-request
 * `JSON.stringify`. Critically this is NOT a `Map<id, Buffer>` (millions of Buffer objects would be
 * GC pressure / retained heap); it is two flat typed arrays — the off-heap output store.
 *
 * Append-only for this slice: rows are inserted, never updated or deleted, so the arena only ever
 * grows by appending. Updates/deletes (which would need slot reuse or a tombstone + rewrite) are
 * OUT OF SCOPE for AV0 and a later slice.
 */
const INITIAL_ARENA = 4096;

class OutputArena {
  private bytes = new Uint8Array(INITIAL_ARENA);
  private used = 0;
  private offsets = new Int32Array(1024 + 1);
  /** Number of rows whose JSON is stored (offsets has `count + 1` valid entries). */
  count = 0;

  private static readonly encoder = new TextEncoder();

  private ensureBytes(need: number): void {
    if (this.used + need <= this.bytes.length) return;
    let cap = this.bytes.length;
    while (cap < this.used + need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.bytes);
    this.bytes = next;
  }

  private ensureOffsets(): void {
    if (this.count + 1 < this.offsets.length) return;
    const next = new Int32Array(this.offsets.length * 2);
    next.set(this.offsets);
    this.offsets = next;
  }

  /** Append one row's already-serialized JSON string, encoding it to UTF-8 bytes ONCE. */
  append(json: string): void {
    const encoded = OutputArena.encoder.encode(json);
    this.ensureBytes(encoded.length);
    this.ensureOffsets();
    this.offsets[this.count] = this.used;
    this.bytes.set(encoded, this.used);
    this.used += encoded.length;
    this.offsets[this.count + 1] = this.used;
    this.count += 1;
  }

  /** A Buffer view of row r's JSON bytes (a subarray slice — no copy). */
  rowSlice(row: number): Buffer {
    const start = this.offsets[row]!;
    const end = this.offsets[row + 1]!;
    return Buffer.from(this.bytes.buffer, this.bytes.byteOffset + start, end - start);
  }
}

/**
 * A DETACHED Table + OutputArena pair, built OFF to the side from a field schema and populated row by
 * row with the EXACT same serialize-on-write discipline as {@link Engine.insert}. This is the building
 * block for {@link Engine.replaceType}: a per-type rebuild streams all rows into a fresh detached pair
 * (registering indexes + warming once), then asks the live Engine to swap it in atomically — so reads
 * keep hitting the OLD slot while the new one is constructed, and the byte format is defined in ONE
 * place (here), never drifting from `Engine.insert`.
 */
export class DetachedTable {
  readonly table: Table;
  readonly arena = new OutputArena();
  readonly hasRawField: boolean;

  constructor(fields: FieldDef[]) {
    this.table = new Table(fields);
    this.hasRawField = fields.some((f) => f.type === 'i64' || f.type === 'decimal' || f.type === 'json');
  }

  /** Append one row: into the Table (columns + null bits) AND serialize-on-write into the side arena. */
  insert(row: Record<string, unknown>): number {
    const rowId = this.table.insert(row);
    const materialized = this.table.materialize(rowId);
    const json = this.hasRawField ? serializeRow(materialized) : JSON.stringify(materialized);
    this.arena.append(json);
    return rowId;
  }
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
}

/**
 * Keyset (cursor) pagination meta. `total`/`pageCount` are present ONLY when `withCount` (free via
 * the filter bitset popcount). `nextCursor`/`prevCursor` are opaque tokens (null when no further /
 * preceding page). The offset/page meta shape is unchanged ({@link PaginationMeta}).
 */
export interface KeysetPaginationMeta {
  pageSize: number;
  total?: number;
  pageCount?: number;
  nextCursor: string | null;
  prevCursor: string | null;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

const HEAD = Buffer.from('{"data":[', 'utf8');
const COMMA = Buffer.from(',', 'utf8');

/**
 * The content-type REGISTRY + output facade. Owns named content-types -> {@link Table} instances and
 * their per-table {@link OutputArena}. Thin by design: the Table does all the query work (filter /
 * sort / paginate via `scanTree`/`query`); the Engine adds the serialize-on-write output store and
 * the list/single Buffer assembly (late materialization).
 *
 * The contract the tests pin: every assembled Buffer is BYTE-IDENTICAL to `JSON.stringify` of the
 * equivalent materialized envelope (Strapi v5 flat shape — `{ data, meta }`, no v4 `attributes`
 * wrapper), and round-trips through `JSON.parse` back to the same object.
 */
export interface EngineOptions {
  /** Inject a custom ChangeBus (e.g. a future Redis bus). Defaults to {@link InProcessChangeBus}. */
  bus?: ChangeBus;
  /** Response-cache tuning (caps, enabled). See {@link ResponseCacheOptions}. */
  cache?: ResponseCacheOptions;
  /**
   * The HMAC cursor codec for keyset pagination (constructed at the composition root with the
   * `CURSOR_SECRET`). When absent, a keyset request throws {@link InvalidCursorError} (so a
   * misconfigured deployment fails closed, never serving an unsigned cursor).
   */
  cursorCodec?: CursorCodec;
}

export class Engine {
  private readonly tables = new Map<string, Table>();
  private readonly arenas = new Map<string, OutputArena>();
  /**
   * Per-table flag: true iff the schema has any i64/decimal/json field, so insert uses the
   * type-aware row serializer. A table with ONLY existing types keeps the fast `JSON.stringify`
   * path, producing bytes BYTE-IDENTICAL to before this slice (the 304-test additive guarantee).
   */
  private readonly hasRawField = new Map<string, boolean>();

  /** The invalidation seam: insert() publishes here; the response cache subscribes. */
  readonly bus: ChangeBus;
  /** The bounded-LRU assembled-buffer cache (the SLICE 1 hot-path lever). */
  readonly cache: ResponseCache;
  /** The HMAC cursor codec (undefined unless wired at the composition root). */
  private readonly codec: CursorCodec | undefined;
  /**
   * Per-type SCHEMA VERSION: a counter bumped ONLY when a type's field SHAPE changes (DDL), NOT on
   * pure data writes. Tracked by the canonical field-list hash so a same-schema rebuild keeps the
   * version — the headline write-stability guarantee (a cursor survives a data write, but an old
   * cursor after a DDL is rejected). Drives the cursor sig.
   */
  private readonly schemaVersions = new Map<string, number>();
  private readonly schemaShapes = new Map<string, string>();

  constructor(opts: EngineOptions = {}) {
    this.bus = opts.bus ?? new InProcessChangeBus();
    this.cache = new ResponseCache(this.bus, opts.cache);
    this.codec = opts.cursorCodec;
  }

  /** Canonical hash of a type's field SHAPE (name+type+scale+precision, in order). */
  private shapeOf(fields: readonly FieldDef[]): string {
    return fields.map((f) => `${f.name}:${f.type}:${f.scale ?? ''}:${f.precision ?? ''}`).join(',');
  }

  /**
   * Record a type's field shape, bumping its schema version IFF the shape changed. Called on
   * define / registerDetached / replaceType so a pure-data rebuild (same shape) keeps the version
   * and an old cursor stays valid, while a DDL (shape change) bumps it and invalidates old cursors.
   */
  private trackSchema(name: string, fields: readonly FieldDef[]): void {
    const shape = this.shapeOf(fields);
    const prev = this.schemaShapes.get(name);
    if (prev === shape) return; // same shape => keep the version (data-write stability).
    this.schemaShapes.set(name, shape);
    this.schemaVersions.set(name, (this.schemaVersions.get(name) ?? 0) + 1);
  }

  /** The current schema version for a type (field-shape counter); 0 if unknown. */
  schemaVersion(name: string): number {
    return this.schemaVersions.get(name) ?? 0;
  }

  /** Define a content-type by name + field schema, creating its Table and output arena. */
  define(name: string, fields: FieldDef[]): Table {
    if (this.tables.has(name)) throw new Error(`content-type "${name}" already defined`);
    const t = new Table(fields);
    this.tables.set(name, t);
    this.arenas.set(name, new OutputArena());
    this.hasRawField.set(
      name,
      fields.some((f) => f.type === 'i64' || f.type === 'decimal' || f.type === 'json'),
    );
    this.trackSchema(name, fields);
    return t;
  }

  /** The Table for a content-type (for index registration, warming, raw queries). */
  table(name: string): Table {
    const t = this.tables.get(name);
    if (t === undefined) throw new Error(`unknown content-type "${name}"`);
    return t;
  }

  /** Whether a content-type by this name is defined (the HTTP layer's 404 gate). */
  has(name: string): boolean {
    return this.tables.has(name);
  }

  /**
   * The field SCHEMA for a content-type, as a fresh `FieldDef[]` (the whitelist the query parser
   * validates against). Throws on an unknown type — callers gate with {@link has} first.
   */
  fields(name: string): FieldDef[] {
    // Carry `scale` (and `precision`) so a `decimal` field round-trips through the parser: it needs the
    // column's scale to coerce a predicate value to the SAME mantissa the column stored (dropping scale
    // would coerce against scale 0 and silently miss), and the precision to reject an out-of-precision
    // predicate value exactly as the column's push and Postgres do.
    return this.table(name).fields.map((f) => ({
      name: f.name,
      type: f.type,
      ...(f.scale !== undefined ? { scale: f.scale } : {}),
      ...(f.precision !== undefined ? { precision: f.precision } : {}),
    }));
  }

  /** The dense row count of a content-type (the single-item id range gate: id in [0, rowCount)). */
  rowCount(name: string): number {
    return this.table(name).rowCount;
  }

  private arena(name: string): OutputArena {
    const a = this.arenas.get(name);
    if (a === undefined) throw new Error(`unknown content-type "${name}"`);
    return a;
  }

  /**
   * Insert a row into a content-type: append it to the Table (which builds the columns + null bits)
   * AND serialize-on-write its output JSON bytes into the arena ONCE. `materialize` already renders a
   * NULL field as `null` and a date as ISO-8601, so the stored bytes match the read-time envelope.
   * Returns the dense row id.
   */
  insert(name: string, row: Record<string, unknown>): number {
    const t = this.table(name);
    const rowId = t.insert(row);
    // Serialize the row's output exactly as JSON.stringify would render it in the envelope's data[].
    // A table with NO i64/decimal/json field takes the fast JSON.stringify path (byte-identical to
    // before this slice); otherwise the type-aware serializer splices RawJson fragments verbatim.
    const materialized = t.materialize(rowId);
    const json = this.hasRawField.get(name) ? serializeRow(materialized) : JSON.stringify(materialized);
    this.arena(name).append(json);
    // A write to this type invalidates every cached response for it (no stale serve). Predicate-
    // aware partial invalidation is a later optimization; for this slice we drop the whole type.
    this.bus.publish(name);
    return rowId;
  }

  /**
   * Install a freshly-built {@link DetachedTable} as a NEW content-type (the boot/load path) WITHOUT
   * the throwaway empty Table + OutputArena that `define` would allocate. Sets the three Map slots
   * directly from the detached pair. Throws if `name` is ALREADY defined (use {@link replaceType} to
   * swap an existing type). No cache invalidation publish: at boot the cache is empty, and a freshly
   * registered type has no cached responses to drop.
   */
  registerDetached(name: string, detached: DetachedTable): void {
    if (this.tables.has(name)) throw new Error(`content-type "${name}" already defined`);
    this.tables.set(name, detached.table);
    this.arenas.set(name, detached.arena);
    this.hasRawField.set(name, detached.hasRawField);
    this.trackSchema(name, detached.table.fields);
  }

  /**
   * Atomically REPLACE an already-defined content-type's storage with a freshly-built {@link
   * DetachedTable} (its Table + output arena + hasRawField). The per-type rebuild fast path: the
   * caller streams the type's rows into the detached pair off to the side (registering indexes +
   * warming once), THEN calls this — which does the three Map writes + the per-type cache
   * invalidation in ONE synchronous burst (no await between them, so a synchronous GET can never
   * observe a torn state: it sees either the whole old slot or the whole new one). Dropping the old
   * Table+arena refs makes them GC-eligible once `bus.publish` -> `invalidateType` releases this
   * type's cached Buffer VIEWS (which pinned the old arena's ArrayBuffer).
   *
   * Throws if `name` is NOT already defined (replace != define; {@link define} still throws on an
   * existing name). Sibling types' tables/arenas/caches are untouched — the blast radius is one type.
   */
  replaceType(name: string, detached: DetachedTable): void {
    if (!this.tables.has(name)) throw new Error(`content-type "${name}" is not defined (use define)`);
    // Synchronous swap burst: no await between these, so no torn read is possible.
    this.tables.set(name, detached.table);
    this.arenas.set(name, detached.arena);
    this.hasRawField.set(name, detached.hasRawField);
    // Bump the schema version ONLY if the field shape changed; a pure-data rebuild keeps it, so an
    // outstanding cursor survives a write (the headline write-stability win) but not a DDL.
    this.trackSchema(name, detached.table.fields);
    this.bus.publish(name); // drop ONLY this type's cached responses (frees the old arena's views).
  }

  /**
   * Remove a content-type entirely (the DROP path): delete its Table + arena + hasRawField slot and
   * publish so the response cache drops every Buffer view pinning the old arena. Synchronous burst — no
   * await between the deletes — so a concurrent GET sees `has()===false` atomically (clean 404), never a
   * torn slot. Throws if not defined (the caller only drops after a confirmed-present DB commit, so an
   * absent slot signals an engine/registry desync worth surfacing).
   */
  dropType(name: string): void {
    if (!this.tables.has(name)) throw new Error(`content-type "${name}" is not defined (cannot drop)`);
    this.tables.delete(name);
    this.arenas.delete(name);
    this.hasRawField.delete(name);
    // Drop the schema-shape memo but KEEP the version counter: a re-created type with the same name
    // must bump past any version an old cursor was signed under (so a stale cursor never re-validates).
    this.schemaShapes.delete(name);
    this.bus.publish(name); // ResponseCache.invalidateType drops this type's cached Buffers (frees arena views).
  }

  /** Compute Strapi-style pagination meta from a total count and the query's offset/limit. */
  private paginationMeta(total: number, offset: number, limit: number): PaginationMeta {
    const pageSize = limit === Infinity ? (total === 0 ? 0 : total) : limit;
    const page = pageSize === 0 ? 1 : Math.floor(offset / pageSize) + 1;
    const pageCount = pageSize === 0 ? 0 : Math.ceil(total / pageSize);
    return { page, pageSize, pageCount, total };
  }

  /**
   * Run a query (filter + sort + paginate via the Table) and assemble the LIST response as a single
   * Buffer: `{"data":[` + each matched row's arena bytes joined by `,` + `],"meta":` + metaJSON + `}`.
   * The meta is derived from the FULL filter match count (not the page) plus the offset/limit, so
   * page/pageSize/pageCount/total describe the whole result set, Strapi v5 flat shape.
   *
   * Byte-identical to `JSON.stringify({ data: pageRows.map(materialize), meta })`.
   */
  respond(name: string, opts: QueryOptions = {}): Buffer {
    // Pass the nested filter TREE (if any) as the 3rd queryKey arg so cache keys canonicalize
    // `$and`/`$or`/`$not` shape — trivially-reordered-but-equivalent trees collapse to one entry.
    const key = queryKey(name, opts, opts.where);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const buf = this.assemble(name, opts);
    this.cache.set(key, name, buf);
    return buf;
  }

  /** The cold assembly path (always byte-identical to a cache hit, which stored exactly this). */
  private assemble(name: string, opts: QueryOptions): Buffer {
    const t = this.table(name);
    const arena = this.arena(name);

    // Additive third mode: a keyset request takes the seek path. The OFFSET/page branch below is
    // byte-identical to before this slice (no keysetRaw => unchanged code path).
    let rowIds: number[];
    let metaJson: string;
    if (opts.keysetRaw !== undefined) {
      const { rowIds: ids, metaJson: mj } = this.assembleKeyset(name, t, opts);
      rowIds = ids;
      metaJson = mj;
    } else {
      rowIds = t.query(opts);
      // Total is the FULL match count (tree or flat filters), independent of offset/limit.
      const total = t.matchSet(opts).count();
      const offset = opts.offset ?? 0;
      const limit = opts.limit ?? Infinity;
      const meta = { pagination: this.paginationMeta(total, offset, limit) };
      metaJson = JSON.stringify(meta);
    }

    const tail = Buffer.from(`],"meta":${metaJson}}`, 'utf8');
    const parts: Buffer[] = [HEAD];
    for (let i = 0; i < rowIds.length; i++) {
      if (i > 0) parts.push(COMMA);
      parts.push(arena.rowSlice(rowIds[i]!));
    }
    parts.push(tail);
    return Buffer.concat(parts);
  }

  /**
   * The keyset seek branch: decode + verify the cursor/before tokens against the live request sig,
   * run {@link Table.queryKeyset}, mint next/prev cursors, and build the keyset meta JSON. Throws
   * {@link InvalidCursorError} (router maps to 400) for a missing codec, a bad/mismatched cursor, or
   * an unseekable sort (caught + re-thrown as a generic invalid-cursor failure to avoid a 500/leak).
   */
  private assembleKeyset(name: string, t: Table, opts: QueryOptions): { rowIds: number[]; metaJson: string } {
    if (this.codec === undefined) throw new InvalidCursorError();
    const raw = opts.keysetRaw!;

    // Resolve the sort spec (client keys + appended id) and build the sig context + per-key types.
    // A json sort key / missing id surfaces as KeysetUnsupportedError -> normalize to InvalidCursorError.
    let resolved;
    let fieldTypes: SortFieldType[];
    try {
      resolved = t.resolveSortKeys(opts.sort ?? []);
      fieldTypes = (opts.sort ?? []).map((s) => {
        const f = t.fields.find((fd) => fd.name === s.field)!;
        return { type: f.type, scale: f.scale, precision: f.precision };
      });
    } catch {
      throw new InvalidCursorError();
    }

    const sortCanonical = Table.canonicalSortSpec(resolved);
    const sig: SigInput = {
      typeName: name,
      sortCanonical,
      filterCanonical: filterCanonical(opts),
      schemaVersion: this.schemaVersion(name),
    };

    const ks: KeysetOptions = { pageSize: raw.pageSize, withCount: raw.withCount };
    // An EMPTY cursor/before token is the bootstrap FIRST page (head walk) — no boundary to decode.
    if (raw.cursorToken !== undefined && raw.cursorToken !== '') {
      ks.cursor = this.codec.decode(sig, fieldTypes, raw.cursorToken);
    }
    if (raw.beforeToken !== undefined && raw.beforeToken !== '') {
      ks.before = this.codec.decode(sig, fieldTypes, raw.beforeToken);
    }

    const result = t.queryKeyset({ ...opts, keyset: ks });

    const mint = (boundary: typeof result.firstBoundary): string | null => {
      if (boundary === undefined) return null;
      const payload: CursorPayload = { v: 1, sortValues: boundary.sortValues, id: boundary.id };
      return this.codec!.encode(sig, fieldTypes, payload);
    };

    const meta: KeysetPaginationMeta = {
      pageSize: raw.pageSize,
      nextCursor: mint(result.lastBoundary),
      prevCursor: mint(result.firstBoundary),
      hasNextPage: result.hasNextPage,
      hasPreviousPage: result.hasPreviousPage,
    };
    if (raw.withCount) {
      const total = t.matchSet(opts).count();
      meta.total = total;
      meta.pageCount = Math.ceil(total / raw.pageSize);
    }

    return { rowIds: result.rowIds, metaJson: JSON.stringify({ pagination: meta }) };
  }

  /**
   * Assemble a SINGLE-item response: `{"data":<row JSON>,"meta":{}}`. Byte-identical to
   * `JSON.stringify({ data: materialize(rowId), meta: {} })`.
   */
  respondOne(name: string, rowId: number): Buffer {
    const arena = this.arena(name);
    return Buffer.concat([
      Buffer.from('{"data":', 'utf8'),
      arena.rowSlice(rowId),
      Buffer.from(',"meta":{}}', 'utf8'),
    ]);
  }

  /**
   * Assemble a SINGLE-item response addressed by the PUBLIC primary key `id` (the real Postgres PK,
   * not the dense row position). Resolves `id` -> dense row via the eq index on the `id` field, then
   * reuses {@link respondOne}. Returns `null` when no row carries that id (the 404 gate). Requires the
   * content-type to have an eq index on `id`.
   */
  respondById(name: string, id: number): Buffer | null {
    const rowId = this.table(name).rowIdByEq('id', id);
    return rowId === undefined ? null : this.respondOne(name, rowId);
  }
}

/**
 * Type-aware single-row JSON serializer for a materialized row that may contain a {@link RawJson}
 * marker (a `json` field's verbatim bytes). It iterates the object's own keys IN ORDER and concatenates
 * the SAME segments `JSON.stringify` would emit — no spaces, `:`/`,` separators, keys via
 * `JSON.stringify(key)` — so for an object with no markers it is byte-identical to `JSON.stringify`.
 *
 *   - {@link RawJson}: `.raw` VERBATIM (no quotes, no re-escape) so nested integers > 2^53 and object
 *     key order survive byte-exact.
 *
 * i64/decimal need no marker: they materialize as plain STRINGS that `JSON.stringify` quotes (the
 * interoperable wire form). Each RawJson is spliced at its own field position independently (N json
 * fields all handled), with NO placeholder/string-replace step (collision-free by construction).
 */
function serializeRow(row: Record<string, unknown>): string {
  let out = '{';
  let first = true;
  for (const key of Object.keys(row)) {
    if (!first) out += ',';
    first = false;
    out += JSON.stringify(key) + ':';
    const v = row[key];
    if (v instanceof RawJson) out += v.raw;
    else out += JSON.stringify(v); // a plain value (incl. i64/decimal strings, and `null`).
  }
  return out + '}';
}
