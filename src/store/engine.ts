import { Table, type FieldDef, type QueryOptions } from './table.ts';
import {
  ResponseCache,
  InProcessChangeBus,
  queryKey,
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

export interface PaginationMeta {
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
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
}

export class Engine {
  private readonly tables = new Map<string, Table>();
  private readonly arenas = new Map<string, OutputArena>();

  /** The invalidation seam: insert() publishes here; the response cache subscribes. */
  readonly bus: ChangeBus;
  /** The bounded-LRU assembled-buffer cache (the SLICE 1 hot-path lever). */
  readonly cache: ResponseCache;

  constructor(opts: EngineOptions = {}) {
    this.bus = opts.bus ?? new InProcessChangeBus();
    this.cache = new ResponseCache(this.bus, opts.cache);
  }

  /** Define a content-type by name + field schema, creating its Table and output arena. */
  define(name: string, fields: FieldDef[]): Table {
    if (this.tables.has(name)) throw new Error(`content-type "${name}" already defined`);
    const t = new Table(fields);
    this.tables.set(name, t);
    this.arenas.set(name, new OutputArena());
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
    return this.table(name).fields.map((f) => ({ name: f.name, type: f.type }));
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
    this.arena(name).append(JSON.stringify(t.materialize(rowId)));
    // A write to this type invalidates every cached response for it (no stale serve). Predicate-
    // aware partial invalidation is a later optimization; for this slice we drop the whole type.
    this.bus.publish(name);
    return rowId;
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
    const rowIds = t.query(opts);
    // Total is the FULL match count (tree or flat filters), independent of offset/limit.
    const total = t.matchSet(opts).count();
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? Infinity;
    const meta = { pagination: this.paginationMeta(total, offset, limit) };

    const tail = Buffer.from(`],"meta":${JSON.stringify(meta)}}`, 'utf8');
    const parts: Buffer[] = [HEAD];
    for (let i = 0; i < rowIds.length; i++) {
      if (i > 0) parts.push(COMMA);
      parts.push(arena.rowSlice(rowIds[i]!));
    }
    parts.push(tail);
    return Buffer.concat(parts);
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
