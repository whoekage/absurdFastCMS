import type { Sql } from 'postgres';
import { Engine, DetachedTable, type EngineOptions } from '../store/engine.ts';
import { CursorCodec } from '../store/cursor-codec.ts';
import type { Table } from '../store/table.ts';
import { quoteIdent } from './ddl.ts';
import type { ContentTypeDef, ColumnDescriptor, Registry } from '../store/registry.ts';
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
 * Boot: define + load EVERY type from the registry into a fresh Engine. Empty registry => empty engine
 * (no error). Sequential per-type loads keep the source-of-truth-defines-correctness contract simple.
 */
export async function buildEngine(sql: Sql, registry: Registry, opts?: EngineOptions): Promise<Engine> {
  const engine = new Engine(opts);
  for (const def of registry.all()) await loadType(sql, engine, def);
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
 */
export async function rebuildType(sql: Sql, engine: Engine, def: ContentTypeDef): Promise<void> {
  const detached = await buildDetached(sql, def);
  engine.replaceType(def.apiId, detached);
}
