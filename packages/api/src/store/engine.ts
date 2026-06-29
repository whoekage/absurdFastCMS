import { Table, type FieldDef, type FilterNode, type QueryOptions, type KeysetOptions, type RelationResolver } from './table.ts';
import { Bitset } from './bitset.ts';
import { RawJson } from './column.ts';
import { Relation } from './relation.ts';
import { QueryParseError, type RelationParseContext, type PopulateNode, type PopulatePlan } from './query.parser.ts';
import type { RelationKind } from './relation.ts';
import {
  CursorCodec,
  InvalidCursorError,
  type CursorPayload,
  type SigInput,
  type SortFieldType,
} from './cursor.codec.ts';
import {
  ResponseCache,
  queryKey,
  filterCanonical,
  type ResponseCacheOptions,
} from './response.cache.ts';

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
const OPEN_BRACKET = Buffer.from('[', 'utf8');
const CLOSE_BRACKET = Buffer.from(']', 'utf8');
const CLOSE_BRACE = Buffer.from('}', 'utf8');
const NULL_LIT = Buffer.from('null', 'utf8');

/**
 * Strapi/Payload default + our hard recursion ceiling for populate (Relations Slice 5): at most this
 * many relation hops below the owner row. depth=1 is the owner's DIRECT relations; depth=2 a
 * sub-relation; depth 3+ is the FRONTIER (not expanded). This counter is the SOLE terminator for
 * self-referential / cyclic populate over DATA (counts hops, not distinct types, so a 2-type A->B->A
 * cycle also stops here). It is INDEPENDENT of MAX_RELATION_HOPS (=3) in query-parser.ts: that bounds
 * relation-FILTER chain depth (slice 4), a different feature; both are hop counters but decoupled by
 * design — changing one must not change the other. (Parser-side populate nesting is bounded separately
 * by MAX_POPULATE_NESTING.)
 */
const POPULATE_DEPTH_CAP = 2;

/**
 * The module REGISTRY + output facade. Owns named modules -> {@link Table} instances and
 * their per-table {@link OutputArena}. Thin by design: the Table does all the query work (filter /
 * sort / paginate via `scanTree`/`query`); the Engine adds the serialize-on-write output store and
 * the list/single Buffer assembly (late materialization).
 *
 * The contract the tests pin: every assembled Buffer is BYTE-IDENTICAL to `JSON.stringify` of the
 * equivalent materialized envelope (Strapi v5 flat shape — `{ data, meta }`, no v4 `attributes`
 * wrapper), and round-trips through `JSON.parse` back to the same object.
 */
export interface EngineOptions {
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

  /** The bounded-LRU assembled-buffer cache (the SLICE 1 hot-path lever). A write calls
   * `cache.invalidateType(name)` directly to drop that type's entries. */
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

  /**
   * Per-type Draft & Publish flag, derived from the presence of the synthesized `published_at` field in
   * the type's schema (the registry only synthesizes it for a D&P type). Set on define/registerDetached/
   * replaceType, purged on dropType. The read router reads this to decide whether to fold a `status`
   * predicate into the query; a non-D&P type is never touched (byte-identical reads).
   */
  private readonly draftPublishFlags = new Map<string, boolean>();

  /**
   * Per-type i18n flag, derived from the presence of the synthesized `locale` field in the type's schema
   * (the registry only synthesizes it for an i18n type). Set on define/registerDetached/replaceType,
   * purged on dropType. The read router reads this to decide whether to fold a `locale` predicate into the
   * query; a non-i18n type is never touched (byte-identical reads).
   */
  private readonly i18nFlags = new Map<string, boolean>();

  /**
   * RELATION STORE: the in-memory CSR {@link Relation} per declared OWNER-side relation, keyed by
   * `ownerName + "\u0000" + field` (NUL-joined — api_ids/fields pass `validateIdentifier` and never
   * contain NUL, so `(a,bc)` and `(ab,c)` can never alias). Populated by the loader (boot phase-2 +
   * per-write refresh); NOT consulted by the unpopulated read path (respond/assemble/respondById) this
   * slice — stored for the next slices (relational filtering, populate). A Relation references LIVE
   * owner/related Table objects + dense rows captured at build, so it CANNOT survive a replaceType of
   * either endpoint (the dense numbering changes) — the loader re-derives on every replaceType, and
   * {@link dropType} purges every Relation touching a dropped type.
   */
  private readonly relations = new Map<string, Relation>();
  /**
   * RELATION TARGET CATALOG (Relations Slice 4): a parallel map `relKey(ownerName, field) ->
   * targetName`, populated alongside {@link relations} by the loader (which holds the Registry). A
   * {@link Relation} exposes its owner/related Table OBJECTS but NOT the target's name string, so this
   * map is what lets the Engine (i) tell the query parser which keys are relations + their target type
   * (see {@link relationParseContext}) and (ii) resolve `(ownerName, field) -> targetName -> Table` at
   * execution (see {@link relationResolver}). Kept independent of the Registry object so the Engine stays
   * standalone; purged in lockstep with {@link relations} on {@link dropType}.
   */
  private readonly relationTargets = new Map<string, string>();
  /**
   * RELATION KIND CATALOG (Relations Slice 5): parallel to {@link relationTargets}, keyed by the SAME
   * relKey, holding each relation's cardinality KIND so the populate assembler dispatches to-one
   * (object/null) vs to-many (array/[]) WITHOUT consulting the Registry — never from edge count.
   * Purged in lockstep with {@link relations} on {@link dropType}.
   */
  private readonly relationKinds = new Map<string, RelationKind>();

  constructor(opts: EngineOptions = {}) {
    this.cache = new ResponseCache(opts.cache);
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

  /** Record a type's D&P flag from its field schema (presence of the `published_at` system field). */
  private trackDraftPublish(name: string, fields: readonly FieldDef[]): void {
    this.draftPublishFlags.set(name, fields.some((f) => f.name === 'published_at'));
  }

  /** Whether `name` opted into Model A Draft & Publish (has the `published_at` system column). */
  isDraftPublish(name: string): boolean {
    return this.draftPublishFlags.get(name) ?? false;
  }

  /** Record a type's i18n flag from its field schema (presence of the synthesized `locale` system field). */
  private trackI18n(name: string, fields: readonly FieldDef[]): void {
    this.i18nFlags.set(name, fields.some((f) => f.name === 'locale'));
  }

  /** Whether `name` opted into i18n (has the `locale` system column). */
  isI18n(name: string): boolean {
    return this.i18nFlags.get(name) ?? false;
  }

  /** NUL-joined relation key (collision-free: validated api_ids/fields never contain NUL). */
  private static relKey(name: string, field: string): string {
    return name + '\u0000' + field;
  }

  /**
   * Install (or overwrite) the {@link Relation} for `(ownerName, field)`. Last-write-wins (NO
   * "already defined" guard, unlike {@link registerDetached}) — both the boot phase and the per-write
   * refresh call this, and a re-derive simply replaces the prior entry that referenced the now-stale
   * Table. Does NOT bump schemaVersion or invalidate the cache: a relation load/refresh touches ONLY this
   * Map, so the unpopulated read arena and plain keyset cursors stay valid.
   */
  setRelation(ownerName: string, field: string, rel: Relation, targetName: string, kind: RelationKind): void {
    const key = Engine.relKey(ownerName, field);
    this.relations.set(key, rel);
    this.relationTargets.set(key, targetName);
    this.relationKinds.set(key, kind);
  }

  /**
   * The cardinality KIND of `(ownerName, field)`, or undefined for an unknown type / unknown field /
   * a scalar field (mirrors {@link relation}). The populate assembler reads this to choose object/null
   * (to-one) vs array/[] (to-many), never inferring from the live edge count.
   */
  relationKind(ownerName: string, field: string): RelationKind | undefined {
    return this.relationKinds.get(Engine.relKey(ownerName, field));
  }

  /**
   * The PARSE CONTEXT for `name`: its scalar fields PLUS its relation fields (each -> target name),
   * with a resolver to recurse into a target type's own context for a deeper hop. Built fresh from the
   * relation catalog so the read path (router -> parseQuery) never touches the Registry. `resolveTarget`
   * recurses through {@link relationParseContext} for the next type; a deeper-than-cap chain is bounded
   * by the parser's hop cap, so the recursion always terminates (even self-referential).
   */
  relationParseContext(name: string): RelationParseContext {
    const fields = this.fields(name);
    const relations = new Map<string, string>();
    const prefix = name + '\u0000';
    for (const [k, target] of this.relationTargets) {
      if (k.startsWith(prefix)) relations.set(k.slice(prefix.length), target);
    }
    return {
      fields,
      relations,
      resolveTarget: (name) => (this.has(name) ? this.relationParseContext(name) : undefined),
    };
  }

  /**
   * Build the {@link RelationResolver} for an OWNER type: resolve a relation leaf `(relField, sub)` to
   * an owner-sized Bitset (EXISTS). It scans the TARGET table for `sub` (recursing the NEXT hop's
   * resolver for a deep chain), then lifts the matching related rows to owners via
   * {@link Relation.ownersMatching}. A declared-but-unloaded relation (`relation()===undefined`, a
   * mid-rebuild desync) returns an EMPTY owner bitset — the correct EXISTS over no edges.
   */
  private relationResolver(ownerName: string): RelationResolver {
    return (relField, sub) => {
      const rel = this.relation(ownerName, relField);
      if (rel === undefined) return new Bitset(this.table(ownerName).rowCount);
      const targetName = this.relationTargets.get(Engine.relKey(ownerName, relField))!;
      const targetTable = this.table(targetName);
      const relatedBs = targetTable.scanTree(sub, this.relationResolver(targetName));
      return rel.ownersMatching(relatedBs);
    };
  }

  /**
   * The current {@link Relation} for `(ownerName, field)`, or undefined for an unknown type / unknown
   * field / a scalar field. NEVER throws (mirrors {@link Registry.get} / {@link has} — a probe the next
   * slices branch on, e.g. `engine.relation(t, f)?.ownersMatching(bs)`). Returns the stored LIVE
   * reference (no copy); its owner/related are the Tables currently installed (the invariant the
   * loader's refresh maintains).
   */
  relation(ownerName: string, field: string): Relation | undefined {
    return this.relations.get(Engine.relKey(ownerName, field));
  }

  /** Define a module by name + field schema, creating its Table and output arena. */
  define(name: string, fields: FieldDef[]): Table {
    if (this.tables.has(name)) throw new Error(`module "${name}" already defined`);
    const t = new Table(fields);
    this.tables.set(name, t);
    this.arenas.set(name, new OutputArena());
    this.hasRawField.set(
      name,
      fields.some((f) => f.type === 'i64' || f.type === 'decimal' || f.type === 'json'),
    );
    this.trackSchema(name, fields);
    this.trackDraftPublish(name, fields);
    this.trackI18n(name, fields);
    return t;
  }

  /** The Table for a module (for index registration, warming, raw queries). */
  table(name: string): Table {
    const t = this.tables.get(name);
    if (t === undefined) throw new Error(`unknown module "${name}"`);
    return t;
  }

  /** Whether a module by this name is defined (the HTTP layer's 404 gate). */
  has(name: string): boolean {
    return this.tables.has(name);
  }

  /** All defined module names (registration order). Read-only introspection seam (debug inspector). */
  typeNames(): string[] {
    return [...this.tables.keys()];
  }

  /**
   * The field SCHEMA for a module, as a fresh `FieldDef[]` (the whitelist the query parser
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

  /** The dense row count of a module (the single-item id range gate: id in [0, rowCount)). */
  rowCount(name: string): number {
    return this.table(name).rowCount;
  }

  private arena(name: string): OutputArena {
    const a = this.arenas.get(name);
    if (a === undefined) throw new Error(`unknown module "${name}"`);
    return a;
  }

  /**
   * Insert a row into a module: append it to the Table (which builds the columns + null bits)
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
    this.cache.invalidateType(name);
    return rowId;
  }

  /**
   * Install a freshly-built {@link DetachedTable} as a NEW module (the boot/load path) WITHOUT
   * the throwaway empty Table + OutputArena that `define` would allocate. Sets the three Map slots
   * directly from the detached pair. Throws if `name` is ALREADY defined (use {@link replaceType} to
   * swap an existing type). No cache invalidation publish: at boot the cache is empty, and a freshly
   * registered type has no cached responses to drop.
   */
  registerDetached(name: string, detached: DetachedTable): void {
    if (this.tables.has(name)) throw new Error(`module "${name}" already defined`);
    this.tables.set(name, detached.table);
    this.arenas.set(name, detached.arena);
    this.hasRawField.set(name, detached.hasRawField);
    this.trackSchema(name, detached.table.fields);
    this.trackDraftPublish(name, detached.table.fields);
    this.trackI18n(name, detached.table.fields);
  }

  /**
   * Atomically REPLACE an already-defined module's storage with a freshly-built {@link
   * DetachedTable} (its Table + output arena + hasRawField). The per-type rebuild fast path: the
   * caller streams the type's rows into the detached pair off to the side (registering indexes +
   * warming once), THEN calls this — which does the three Map writes + the per-type cache
   * invalidation in ONE synchronous burst (no await between them, so a synchronous GET can never
   * observe a torn state: it sees either the whole old slot or the whole new one). Dropping the old
   * Table+arena refs makes them GC-eligible once `cache.invalidateType` releases this
   * type's cached Buffer VIEWS (which pinned the old arena's ArrayBuffer).
   *
   * Throws if `name` is NOT already defined (replace != define; {@link define} still throws on an
   * existing name). Sibling types' tables/arenas/caches are untouched — the blast radius is one type.
   */
  replaceType(name: string, detached: DetachedTable): void {
    if (!this.tables.has(name)) throw new Error(`module "${name}" is not defined (use define)`);
    // Synchronous swap burst: no await between these, so no torn read is possible.
    this.tables.set(name, detached.table);
    this.arenas.set(name, detached.arena);
    this.hasRawField.set(name, detached.hasRawField);
    // Bump the schema version ONLY if the field shape changed; a pure-data rebuild keeps it, so an
    // outstanding cursor survives a write (the headline write-stability win) but not a DDL.
    this.trackSchema(name, detached.table.fields);
    this.trackDraftPublish(name, detached.table.fields);
    this.trackI18n(name, detached.table.fields);
    this.cache.invalidateType(name); // drop ONLY this type's cached responses (frees the old arena's views).
  }

  /**
   * Remove a module entirely (the DROP path): delete its Table + arena + hasRawField slot and
   * publish so the response cache drops every Buffer view pinning the old arena. Synchronous burst — no
   * await between the deletes — so a concurrent GET sees `has()===false` atomically (clean 404), never a
   * torn slot. Throws if not defined (the caller only drops after a confirmed-present DB commit, so an
   * absent slot signals an engine/registry desync worth surfacing).
   */
  dropType(name: string): void {
    if (!this.tables.has(name)) throw new Error(`module "${name}" is not defined (cannot drop)`);
    const dropped = this.tables.get(name)!; // capture BEFORE the delete for the endpoint scan below.
    this.tables.delete(name);
    this.arenas.delete(name);
    this.hasRawField.delete(name);
    // Drop the schema-shape memo but KEEP the version counter: a re-created type with the same name
    // must bump past any version an old cursor was signed under (so a stale cursor never re-validates).
    this.schemaShapes.delete(name);
    this.draftPublishFlags.delete(name);
    this.i18nFlags.delete(name);
    // Purge every relation referencing the dropped type: by KEY (forward relations X owns + inverses
    // keyed on X) AND by stored ENDPOINT object (a SURVIVING partner's two-way inverse that points back
    // at X — keyed on the partner, so missed by the key scan). Deleting from a Map while iterating its
    // own iterator is safe in V8.
    const prefix = name + '\u0000';
    for (const [k, rel] of this.relations) {
      if (k.startsWith(prefix) || rel.owner === dropped || rel.related === dropped) {
        this.relations.delete(k);
        // relationTargets is keyed IDENTICALLY (same relKey) — purge in lockstep so the parse context /
        // resolver can never see a target for a relation whose Relation object was dropped.
        this.relationTargets.delete(k);
        // relationKinds is keyed IDENTICALLY too — purge in lockstep (the populate dispatch must never
        // see a kind for a relation whose Relation object was dropped).
        this.relationKinds.delete(k);
      }
    }
    this.cache.invalidateType(name); // ResponseCache.invalidateType drops this type's cached Buffers (frees arena views).
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
  /**
   * Frame ONE owner/related row's object `{...}` with its populated relations spliced in (Relations
   * Slice 5), pushing no-copy {@link Buffer} views into `parts`. Byte-identical to `JSON.stringify` of
   * the equivalent hand-built nested object (Strapi v5 flat shape — nested object/array directly under
   * the field key, no `data/attributes` wrapper). Related bytes are spliced VERBATIM — never parsed /
   * re-stringified — so i64/decimal/json fragments in a related row survive byte-exact.
   *
   *   - Fast path: a row with an EMPTY effective plan (no relations to expand, or past the cap) pushes
   *     its frozen arena slice UNCHANGED (a complete `{...}`).
   *   - Re-frame path: strip the trailing `}` (asserted), append each `,"<field>":<related>`, close `}`.
   *
   * Termination is by the integer `depth` ALONE (cap {@link POPULATE_DEPTH_CAP}) — no visited set;
   * self-referential + cyclic populate stop at the frontier. `plan` is already EXECUTION-resolved
   * (validated, `*`-expanded, children resolved against the target type) for THIS row's type.
   */
  private framePopulated(name: string, rowId: number, plan: PopulateNode[], depth: number, parts: Buffer[], ownerFields?: string[]): void {
    // The OWNER body is either the frozen arena slice (no projection) or a projected scalar subset
    // (`fields` present). `ownerFields` applies ONLY at this call's level — relation rows recurse with
    // undefined, so a projected list with populate yields projected owners + FULL related rows (fields
    // filters scalars only; relations stay populate-governed).
    const slice = ownerFields !== undefined ? this.projectRow(name, rowId, ownerFields) : this.arena(name).rowSlice(rowId);
    // Fast path: nothing to expand (empty plan, or past the cap) — emit the (projected or frozen) body.
    if (plan.length === 0 || depth > POPULATE_DEPTH_CAP) {
      parts.push(slice);
      return;
    }
    // Re-frame: defensively assert it is a non-empty `{...}` (every type has id/created_at/updated_at,
    // so a real slice is never `{}` — length > 2 — and its last byte is `}`). A violation is a
    // serializer/arena desync (a server bug) -> throw (500-class), NEVER emit corrupt JSON.
    if (slice.length <= 2 || slice[slice.length - 1] !== 0x7d /* } */) {
      throw new Error(`populate: malformed arena slice for "${name}" row ${rowId}`);
    }
    parts.push(slice.subarray(0, slice.length - 1)); // owner body, trailing `}` dropped (no copy).

    for (const node of plan) {
      // Resolve purely by (currentType, field): the getter returns the inverse Relation for an inverse
      // field too (the loader registered it under the inverse key), so no forward/inverse branch.
      const rel = this.relation(name, node.field);
      const kind = this.relationKind(name, node.field);
      const targetName = this.relationTargets.get(Engine.relKey(name, node.field));
      // Field key escaped exactly like serializeRow emits keys (byte-identity with the JSON.stringify
      // oracle); leading `,` is always correct (system fields id/created_at/updated_at precede it).
      parts.push(Buffer.from(`,${JSON.stringify(node.field)}:`, 'utf8'));

      // Declared-but-unloaded relation OR a kind desync (relationTargets has the entry but relationKinds
      // does not — set/purged in lockstep, so not reachable today): treat as a fail-soft to-one with
      // zero edges (emit `null`), never 500 and never mis-emit a to-one as `[]`. resolvePopulate already
      // 400s an unknown field, so a STILL-VALIDATED relation whose kind is absent degrades to null here.
      const desync = rel === undefined || targetName === undefined || kind === undefined;
      const toOne = kind === 'oneToOne' || kind === 'manyToOne' || desync;
      const related = desync ? [] : rel!.relatedRows(rowId);
      // Children expand at depth+1; at/over the cap they are dropped (the frontier => fast path).
      const childPlan = depth + 1 > POPULATE_DEPTH_CAP ? [] : node.children;

      if (toOne) {
        if (related.length === 0) {
          parts.push(NULL_LIT); // present-but-null; the key is always emitted.
        } else {
          // UNIQUE(owner_id) enforces a single edge; if data violates it, take the first deterministically.
          this.framePopulated(targetName!, related[0]!, childPlan, depth + 1, parts);
        }
      } else {
        parts.push(OPEN_BRACKET);
        for (let i = 0; i < related.length; i++) {
          if (i > 0) parts.push(COMMA);
          this.framePopulated(targetName!, related[i]!, childPlan, depth + 1, parts);
        }
        parts.push(CLOSE_BRACKET); // empty => `[]`.
      }
    }
    parts.push(CLOSE_BRACE); // exactly one closing brace, after ALL relation appends.
  }

  /**
   * EXECUTION-time resolution of a parsed {@link PopulatePlan} against `name`'s relation catalog
   * (Relations Slice 5): expands the `*` wildcard to every declared relation of THIS type (depth-1),
   * de-dupes by field (merging children), and VALIDATES every field at its level — an unknown / scalar
   * populate name throws {@link QueryParseError} (the router maps it to 400). Recurses into each
   * relation's TARGET type so a nested `*` / unknown is validated + expanded against the target's
   * relations. Returns the resolved plan (empty when there is nothing to populate).
   */
  private resolvePopulate(name: string, plan: PopulateNode[]): PopulateNode[] {
    if (plan.length === 0) return [];
    // Expand the `*` sentinel to every declared relation of THIS type (deterministic order = the
    // relationTargets prefix-scan order, same as relationParseContext), depth-1 frontier (children []).
    const expanded: PopulateNode[] = [];
    for (const node of plan) {
      if (node.field === '*') {
        // The relKey prefix for THIS type (NUL-joined, via the helper so no raw NUL in source).
        const prefix = Engine.relKey(name, '');
        for (const k of this.relationTargets.keys()) {
          if (k.startsWith(prefix)) expanded.push({ field: k.slice(prefix.length), children: [] });
        }
      } else {
        expanded.push(node);
      }
    }
    // De-dupe by field (merge children), validate each against THIS type's relations, recurse into target.
    const byField = new Map<string, PopulateNode>();
    for (const node of expanded) {
      const targetName = this.relationTargets.get(Engine.relKey(name, node.field));
      if (targetName === undefined) {
        throw new QueryParseError(`unknown populate field "${node.field}" on "${name}"`);
      }
      const prior = byField.get(node.field);
      const mergedChildren = prior ? [...prior.children, ...node.children] : node.children;
      // Recurse: validate + resolve the sub-plan against the TARGET type (`*` there expands the
      // target's relations). A desync where the target type is absent (has()===false) -> [] (no 500).
      const resolvedChildren = this.has(targetName) ? this.resolvePopulate(targetName, mergedChildren) : [];
      byField.set(node.field, { field: node.field, children: resolvedChildren });
    }
    return [...byField.values()];
  }

  /**
   * Sparse field projection (Strapi v5 `fields`): re-materialize ONE row and serialize ONLY the selected
   * scalar columns, plus a force-included `id` (Strapi always returns `id`; `documentId` is be-02b, out of
   * scope). Reuses {@link Table.materialize} + {@link serializeRow} so wire fidelity is preserved BY
   * CONSTRUCTION — RawJson spliced verbatim, i64/decimal as quoted strings, datetime ISO. Emits keys in
   * materialize (schema) order so two requests with the same SET but different field ORDER are byte-equal.
   * NEVER touches the frozen arena bytes; the unprojected path keeps the zero-copy slice.
   */
  private projectRow(name: string, rowId: number, fields: string[]): Buffer {
    const full = this.table(name).materialize(rowId);
    const keep = new Set(fields);
    keep.add('id'); // Strapi always returns id; keep the row addressable.
    const picked: Record<string, unknown> = {};
    for (const key of Object.keys(full)) {
      if (keep.has(key)) picked[key] = full[key];
    }
    return Buffer.from(serializeRow(picked), 'utf8');
  }

  respond(name: string, opts: QueryOptions = {}, populate: PopulatePlan = [], fields?: string[]): Buffer {
    // Resolve + VALIDATE the populate plan FIRST so an unknown/scalar name 400s before any byte work
    // (and even on the otherwise-cached path). An empty effective plan (no populate, or `populate=*` on
    // a relation-less type) keeps the UNCHANGED, still-cached, byte-identical fast path below.
    const effPlan = this.resolvePopulate(name, populate);
    if (effPlan.length === 0) {
      // Relations Slice 4: a relation-filtered response depends on the TARGET type's data, but a write
      // only invalidates the WRITTEN type. A write to the target would NOT invalidate this owner's
      // relation-filtered entry, so it could be served STALE. Cheapest correctness-preserving fix:
      // do NOT cache a response whose filter tree contains a relation leaf (skip get + set).
      if (opts.where !== undefined && hasRelationLeaf(opts.where)) {
        return this.assemble(name, opts, [], fields);
      }
      // Pass the nested filter TREE (if any) as the 3rd queryKey arg so cache keys canonicalize
      // `$and`/`$or`/`$not` shape — trivially-reordered-but-equivalent trees collapse to one entry. The
      // projected field set is the 4th arg so a `fields=a` response is never served for a full-row request
      // (or for a different field set) — and an unprojected key stays byte-identical (additive).
      const key = queryKey(name, opts, opts.where, fields);
      const cached = this.cache.get(key);
      if (cached !== undefined) return cached;
      const buf = this.assemble(name, opts, [], fields);
      this.cache.set(key, name, buf);
      return buf;
    }
    // Non-empty populate: the response depends on related types' bytes that single-type invalidation
    // cannot cover -> SKIP the cache (get + set), assemble fresh. Cross-type invalidation is slice 7.
    return this.assemble(name, opts, effPlan, fields);
  }

  /** The cold assembly path (always byte-identical to a cache hit, which stored exactly this). */
  private assemble(name: string, opts: QueryOptions, populate: PopulatePlan = [], fields?: string[]): Buffer {
    const t = this.table(name);
    const arena = this.arena(name);
    // ONE resolver per respond() call, bound to this owner type, so the page, the total, and (in the
    // keyset path) the withCount all derive from the IDENTICAL match set. A scalar-only tree never
    // invokes it (Table.scanTree only calls it on a relation leaf), so a non-relational query is
    // byte-identical. Deep nesting recurses across types inside the resolver itself.
    const resolve = this.relationResolver(name);

    // Additive third mode: a keyset request takes the seek path. The OFFSET/page branch below is
    // byte-identical to before this slice (no keysetRaw => unchanged code path).
    let rowIds: number[];
    let metaJson: string;
    if (opts.keysetRaw !== undefined) {
      const { rowIds: ids, metaJson: mj } = this.assembleKeyset(name, t, opts, resolve);
      rowIds = ids;
      metaJson = mj;
    } else {
      rowIds = t.query(opts, resolve);
      // Total is the FULL match count (tree or flat filters), independent of offset/limit.
      const total = t.matchSet(opts, resolve).count();
      const offset = opts.offset ?? 0;
      const limit = opts.limit ?? Infinity;
      const meta = { pagination: this.paginationMeta(total, offset, limit) };
      metaJson = JSON.stringify(meta);
    }

    const tail = Buffer.from(`],"meta":${metaJson}}`, 'utf8');
    const parts: Buffer[] = [HEAD];
    for (let i = 0; i < rowIds.length; i++) {
      if (i > 0) parts.push(COMMA);
      // No populate: the frozen slice verbatim (fast path) UNLESS a projection is requested, in which case
      // emit the projected scalar subset. With populate: per-row re-frame, depth starts at 1 (the owner's
      // DIRECT relations); `fields` (when present) projects the OWNER scalar body, then relations splice as
      // usual (fields filters scalars only — relations stay populate-governed). `populate` is resolved.
      if (populate.length === 0) {
        parts.push(fields !== undefined ? this.projectRow(name, rowIds[i]!, fields) : arena.rowSlice(rowIds[i]!));
      } else this.framePopulated(name, rowIds[i]!, populate, 1, parts, fields);
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
  private assembleKeyset(name: string, t: Table, opts: QueryOptions, resolve: RelationResolver): { rowIds: number[]; metaJson: string } {
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

    const result = t.queryKeyset({ ...opts, keyset: ks }, resolve);

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
      const total = t.matchSet(opts, resolve).count();
      meta.total = total;
      meta.pageCount = Math.ceil(total / raw.pageSize);
    }

    return { rowIds: result.rowIds, metaJson: JSON.stringify({ pagination: meta }) };
  }

  /**
   * Assemble a SINGLE-item response: `{"data":<row JSON>,"meta":{}}`. Byte-identical to
   * `JSON.stringify({ data: materialize(rowId), meta: {} })`.
   */
  respondOne(name: string, rowId: number, populate: PopulatePlan = [], fields?: string[]): Buffer {
    const parts: Buffer[] = [Buffer.from('{"data":', 'utf8')];
    // No populate: the frozen slice (fast path) UNLESS a projection is requested. With populate: the SAME
    // recursive framer as the list path (depth starts at 1), projecting the owner scalar body when `fields`
    // is present. `populate` is assumed already resolved by the caller (respondById).
    if (populate.length === 0) {
      parts.push(fields !== undefined ? this.projectRow(name, rowId, fields) : this.arena(name).rowSlice(rowId));
    } else this.framePopulated(name, rowId, populate, 1, parts, fields);
    parts.push(Buffer.from(',"meta":{}}', 'utf8'));
    return Buffer.concat(parts);
  }

  /**
   * Assemble a SINGLE-item response addressed by the PUBLIC primary key `id` (the real Postgres PK,
   * not the dense row position). Resolves `id` -> dense row via the eq index on the `id` field, then
   * reuses {@link respondOne}. Returns `null` when no row carries that id (the 404 gate). Requires the
   * module to have an eq index on `id`.
   */
  respondById(name: string, id: number, populate: PopulatePlan = [], where?: FilterNode, fields?: string[]): Buffer | null {
    // Resolve + VALIDATE the plan FIRST (unknown/scalar populate name -> 400) for the single-item path
    // too, BEFORE the id lookup. A populated single-item response is not cached (respondOne is uncached).
    const eff = this.resolvePopulate(name, populate);
    const t = this.table(name);
    const rowId = t.rowIdByEq('id', id);
    if (rowId === undefined) return null;
    // Draft & Publish single-item gate: when a `where` predicate is supplied (the router folds in the
    // status -> published_at IS [NOT] NULL leaf for a D&P type), the addressed row must ALSO satisfy it,
    // else it is invisible at the requested status -> 404. `where` is a pure scalar leaf (no relation
    // arm), so the resolver is never invoked. When `where` is undefined (every non-D&P / no-status read)
    // this is byte-identical to before — the row resolves straight through.
    if (where !== undefined && !t.matchSet({ where }, this.relationResolver(name)).get(rowId)) {
      return null;
    }
    return this.respondOne(name, rowId, eff, fields);
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
/**
 * True if a {@link FilterNode} tree contains a RELATION leaf anywhere (Relations Slice 4). Drives the
 * cache-skip in {@link Engine.respond}: a relation-filtered response depends on a sibling type's data
 * that single-type invalidation does not cover, so it is not cached this slice.
 */
function hasRelationLeaf(node: FilterNode): boolean {
  if ('relation' in node) return true;
  if ('leaf' in node) return false;
  return node.children.some(hasRelationLeaf);
}

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
