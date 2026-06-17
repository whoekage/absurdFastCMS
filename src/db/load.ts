import type { Sql } from 'postgres';
import { Engine, DetachedTable, type EngineOptions } from '../store/engine.ts';
import { CursorCodec } from '../store/cursor-codec.ts';
import { Relation } from '../store/relation.ts';
import type { Table } from '../store/table.ts';
import { quoteIdent, validateIdentifier } from './ddl.ts';
import type { ContentTypeDef, ColumnDescriptor, Registry, RelationMeta } from '../store/registry.ts';
import { config } from '../config.ts';

/** Rows pulled per cursor batch — bounds peak memory so a multi-million-row table never buffers whole. */
const LOAD_BATCH = 5000;

/**
 * Build the keyset cursor codec from the validated config.
 * Uses `CURSOR_SECRET` if set, otherwise falls back to the documented dev default.
 */
export function cursorCodecFromEnv(): CursorCodec {
  return new CursorCodec(config.cursorSecret);
}

/**
 * The GENERALIZED loader. Every SQL identifier (table + column names) comes ONLY from the validated
 * {@link ContentTypeDef}, never from client input, and is re-asserted defensively before any SQL. A
 * `json` column is fetched as `"col"::text` so its verbatim bytes (nested integers > 2^53 + key order)
 * are stored unparsed; int8/numeric/uuid arrive as STRINGS and are passed straight to the engine's
 * exact coercers (never Number()-coerced).
 */

/**
 * Defense-in-depth: re-assert the registry-built `ct_<apiId>` table name shape (and the 63-byte gate)
 * before it is ever interpolated as a SQL identifier. Shared by the loader AND the write repo so EVERY
 * SQL-building module re-runs the same gate (the identifier-gate invariant is symmetric across modules).
 * The message NEVER echoes the offending name (no SQL leak).
 */
const CT_TABLE_RE = /^ct_[A-Za-z_][A-Za-z0-9_$]*$/;

export function assertTableName(name: string): void {
  if (!CT_TABLE_RE.test(name) || Buffer.byteLength(name, 'utf8') > 63) {
    throw new Error('table name failed the registry identifier gate');
  }
}

/** Build the SELECT column list from the def: json columns get `"col"::text AS "col"`, others plain. */
function selectList(def: ContentTypeDef): string {
  return def.fields
    .map((f) => (f.json ? `${quoteIdent(f.column)}::text AS ${quoteIdent(f.column)}` : quoteIdent(f.column)))
    .join(', ');
}

/**
 * Coerce one DB row (keyed by column name) into the engine row object (keyed by field name) using the
 * positional {@link ColumnDescriptor} plan. NULL passes through untouched (the engine sets the null
 * bit); int8/numeric arrive as strings and are passed verbatim (coerceI64/coerceDecimal handle them);
 * a json column's `::text` value is the verbatim string (JsonColumn stores its bytes), and SQL NULL of
 * a jsonb column is JS `null` (null bit) — distinct from the jsonb literal `'null'` (the 4-char value).
 */
function coerceRow(plan: ColumnDescriptor[], dbRow: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of plan) {
    // For every kind the value is passed THROUGH (the engine column's push applies the exact coercion):
    // id (number), i64/decimal (string), date (Date), json (::text string), passthrough (string/bool).
    out[d.name] = dbRow[d.name];
  }
  return out;
}

/**
 * Build a DETACHED Table + arena for one type: register its indexes (before any row), cursor-stream the
 * ct_ table type-aware-coercing each column, then warm the indexes ONCE. Shared by {@link loadType}
 * (boot) and {@link rebuildType} (per-write fast path). Empty type yields a valid 0-row pair.
 */
async function buildDetached(sql: Sql, def: ContentTypeDef): Promise<DetachedTable> {
  assertTableName(def.tableName);
  const detached = new DetachedTable(def.fieldDefs);
  const t: Table = detached.table;
  for (const field of def.indexPlan.eq) t.createEqIndex(field);
  for (const field of def.indexPlan.sorted) t.createSortedIndex(field);

  // The SELECT list always includes the 3 system columns, so a zero-user-field type is a valid 3-column
  // SELECT (never `SELECT FROM`). FROM uses postgres.js identifier escaping; ORDER BY id is deterministic.
  const cursor = sql.unsafe(`SELECT ${selectList(def)} FROM ${quoteIdent(def.tableName)} ORDER BY id`).cursor(LOAD_BATCH);
  for await (const rows of cursor) {
    for (const r of rows) detached.insert(coerceRow(def.columnPlan, r as Record<string, unknown>));
  }
  t.warmIndexes();
  return detached;
}

/** Define one type on the engine and load it (boot path). Inserts nothing if the table is empty. */
export async function loadType(sql: Sql, engine: Engine, def: ContentTypeDef): Promise<void> {
  const detached = await buildDetached(sql, def);
  // Install the fully-built detached pair directly as a NEW type — no throwaway empty Table/arena (and
  // no needless cache-invalidation publish on the cold boot path). Same byte format as Engine.insert.
  engine.registerDetached(def.apiId, detached);
}

/**
 * Load the edges of ONE owner relation (an `isOwner=true` meta) into the engine's relation store,
 * building the forward {@link Relation} and, for a two-way relation, the inverse Relation from the SAME
 * edge set swapped. The single source of truth for boot phase-2 AND the per-write refresh — both paths
 * call exactly this, so the SELECT, the PK->dense mapping, the dangling-skip, and the inverse
 * construction can never drift.
 *
 * Resolves BOTH endpoint Tables from the CURRENT engine (so after a {@link Engine.replaceType} it reads
 * the NEW Table + NEW dense numbering). Edges are DENSE ROW ids, not PKs: each owner_id/related_id is
 * mapped via `rowIdByEq('id', pk)`. A pk that maps to undefined (a dangling edge — should not happen
 * given the link FK + ON DELETE CASCADE) is SKIPPED on BOTH the forward and inverse direction with a
 * diagnostic, never linked. Always builds + stores a Relation even with zero edges (presence is driven
 * by the META, not the edge count).
 */
async function loadOwnerRelation(sql: Sql, engine: Engine, ownerApiId: string, meta: RelationMeta): Promise<void> {
  if (!meta.isOwner) return; // inverse rows are produced by their partner owner row's swap — never double-load.

  // Defensive endpoint presence (phase ordering guarantees this in the normal case; a desync must not
  // crash boot/rebuild — skip + diagnostic instead).
  if (!engine.has(ownerApiId) || !engine.has(meta.targetApiId)) {
    console.warn(`relation load: skipping ${ownerApiId}.${meta.field} — endpoint table missing`);
    return;
  }

  const ownerTable = engine.table(ownerApiId);
  const targetTable = engine.table(meta.targetApiId); // === ownerTable when self-referential (correct).

  // Defense-in-depth: re-validate the link-table identifier before interpolation. Link tables are
  // `<owner>_<field>_lnk` (NOT ct_-prefixed), so use validateIdentifier — not assertTableName/CT_TABLE_RE.
  validateIdentifier(meta.linkTable);
  const rows = await sql.unsafe<{ owner_id: number; related_id: number }[]>(
    `SELECT owner_id, related_id FROM ${quoteIdent(meta.linkTable)} ORDER BY owner_id`,
  );

  const fwd: [number, number][] = [];
  const inv: [number, number][] = [];
  const twoWay = meta.inverseField !== undefined;
  for (const { owner_id, related_id } of rows) {
    // owner_id/related_id arrive as JS numbers (postgres.js `integer` -> number), matching the i32 `id`
    // eq key — passed through, never String()/BigInt()-coerced.
    const o = ownerTable.rowIdByEq('id', owner_id);
    const r = targetTable.rowIdByEq('id', related_id);
    if (o === undefined || r === undefined) {
      console.warn(`relation load: dangling edge in ${meta.linkTable} (owner_id=${owner_id}, related_id=${related_id})`);
      continue; // NEVER link(undefined); skip both forward AND inverse so they stay consistent.
    }
    fwd.push([o, r]);
    if (twoWay) inv.push([r, o]); // swap the dense rows for the inverse direction.
  }

  engine.setRelation(ownerApiId, meta.field, Relation.fromEdges(ownerTable, targetTable, fwd));
  if (twoWay) {
    // Inverse: BOTH the Table args AND the edge orientation are swapped together.
    engine.setRelation(meta.targetApiId, meta.inverseField!, Relation.fromEdges(targetTable, ownerTable, inv));
  }
}

/**
 * Load (or re-derive) relations across the WHOLE registry. The simplest-correct strategy: re-derive ALL
 * owner relations. Used by {@link buildEngine} phase-2 (boot) and by {@link rebuildType} (after a
 * replaceType) — re-deriving everything trivially covers "every relation whose owner OR target was
 * rebuilt" incl. inverses, self-refs, and both-endpoint cases, with no affected-set predicate to get
 * wrong. Cost O(sum of all link-table rows) per call; acceptable for v1 (catalogs are small).
 */
export async function loadAllRelations(sql: Sql, engine: Engine, registry: Registry): Promise<void> {
  for (const def of registry.all()) {
    for (const meta of def.relations) {
      if (meta.isOwner) await loadOwnerRelation(sql, engine, def.apiId, meta);
    }
  }
}

/**
 * Boot: define + load EVERY type from the registry into a fresh Engine, THEN load relation edges.
 * Empty registry => empty engine (no error). TWO-PHASE: phase 1 registers every `ct_` Table (each with
 * its warmed eq-on-id index) so a relation can resolve a FORWARD reference to a later type; phase 2
 * loads the edges strictly AFTER, mapping every PK -> dense row against the now-complete table set.
 */
export async function buildEngine(sql: Sql, registry: Registry, opts?: EngineOptions): Promise<Engine> {
  const engine = new Engine(opts);
  for (const def of registry.all()) await loadType(sql, engine, def); // PHASE 1: all ct_ Tables + warm eq-on-id.
  await loadAllRelations(sql, engine, registry); // PHASE 2: edges, strictly after every Table exists.
  return engine;
}

/**
 * The per-type rebuild fast path: re-stream + reindex ONLY this type into a side {@link DetachedTable}
 * and swap it into the LIVE engine via {@link Engine.replaceType} (atomic, invalidating ONLY this
 * type's cache — sibling types stay hot). Reads the COMMITTED DB state, so a later rebuild reflects >=
 * an earlier one (the last committed write's snapshot wins). Write cost is O(rows of this type).
 *
 * SEAM: a future surgical single-row append would replace this full re-stream; the per-type blast
 * radius (vs the old whole-engine reload) is the locked-in win here.
 *
 * RELATIONS: a {@link Relation} pins LIVE owner/related Table refs + dense rows captured at build, so it
 * CANNOT survive a replaceType of either endpoint (the new Table renumbers densely). After the atomic
 * swap we re-derive ALL relations against the now-current Tables (ordering matters — the swap MUST come
 * first so `rowIdByEq` reads the new numbering). Re-deriving everything is the simplest-correct option:
 * it covers the written type as owner, as target, the inverse registered on the target, and self-refs.
 */
export async function rebuildType(sql: Sql, engine: Engine, def: ContentTypeDef, registry: Registry): Promise<void> {
  const detached = await buildDetached(sql, def);
  engine.replaceType(def.apiId, detached); // 1. new Table installed (new dense ids).
  await loadAllRelations(sql, engine, registry); // 2. re-derive ALL relations against the current Tables.
}
