import type { Engine } from './engine.ts';
import type { ColumnType } from './column.ts';
import { RawJson } from './column.ts';

/**
 * READ-ONLY debug introspection over a live {@link Engine}. The columnar RAM layer stores values
 * ENCODED — strings as Int32Array dictionary codes, text as a UTF-8 byte arena, i64/decimal as a
 * BigInt64Array, dates as Float64Array epoch-ms — so a generic heap snapshot / debugger shows raw
 * typed arrays, not readable data. These helpers decode through the SAME public late-materialization
 * path the read endpoints use ({@link Table.materialize}) plus a per-column storage summary, so you
 * can see both the human-readable rows AND how each field is physically held.
 *
 * Built ENTIRELY on the Engine/Table PUBLIC surface (no private-field reach-in): typeNames / table /
 * fields / rowCount / column().type / isNull / materialize / eqStrategy / relationParseContext. It
 * never mutates anything (warming an index is intentionally NOT triggered here), so it is safe to call
 * from a debug HTTP route on a live process. Gated to dev by the caller — never wired in prod/test.
 */

/** A one-line human description of the physical structure backing each column type. */
const STORAGE: Record<ColumnType, string> = {
  i32: 'Int32Array (value direct)',
  f64: 'Float64Array (value direct)',
  bool: 'Uint8Array (0/1 per row)',
  string: 'dictionary-encoded: Int32Array codes -> string[] dict (deduped)',
  text: 'UTF-8 byte arena (Uint8Array) + Int32Array row offsets',
  i64: 'BigInt64Array (exact int64, no f64 coercion)',
  decimal: 'BigInt64Array mantissa + fixed scale',
  date: 'Float64Array (epoch milliseconds)',
  json: 'verbatim UTF-8 bytes, spliced un-parsed',
};

export interface ColumnSummary {
  name: string;
  type: ColumnType;
  /** How the column is physically held in RAM. */
  storage: string;
  /** Dense rows backing this column. */
  length: number;
  /** Rows whose value is NULL (tracked in a separate Uint32Array null plane, not a sentinel). */
  nullCount: number;
  /** Which equality structure the planner chose, if an eq index exists on this field. */
  eqIndex?: 'plane' | 'csr' | 'dict';
  /**
   * For dictionary-encoded `string` columns: how many DISTINCT decoded values were seen across the
   * scanned rows, plus a small sample — this is the dictionary made visible. Truncated when the table
   * is larger than {@link DISTINCT_SCAN_CAP} (scanned count reported as `sampledRows`).
   */
  distinctValues?: number;
  distinctSample?: string[];
  sampledRows?: number;
}

export interface RelationSummary {
  field: string;
  targetType: string;
}

export interface TypeInspection {
  type: string;
  rowCount: number;
  columns: ColumnSummary[];
  relations: RelationSummary[];
  /** Decoded rows for the requested window (offset..offset+limit), via the live materialize path. */
  rows: Record<string, unknown>[];
  window: { offset: number; limit: number; returned: number };
}

/** Cap the distinct-value scan so inspecting a huge table stays cheap (it is a debug probe, not a query). */
const DISTINCT_SCAN_CAP = 10_000;
/** Cap how many distinct sample values are echoed back per string column. */
const DISTINCT_SAMPLE_CAP = 25;

/** All defined content-types with their row counts — the `/debug` index. */
export function listTypes(engine: Engine): { types: { type: string; rowCount: number }[] } {
  return {
    types: engine.typeNames().map((type) => ({ type, rowCount: engine.rowCount(type) })),
  };
}

/**
 * Decode-and-summarize ONE content-type: per-column storage + null counts + (for strings) the decoded
 * dictionary, the relation fields, and a window of fully-materialized rows. `limit`/`offset` bound the
 * decoded row window only (column stats always reflect the whole table). Returns null for an unknown type.
 */
export function inspectType(engine: Engine, type: string, opts: { offset?: number; limit?: number } = {}): TypeInspection | null {
  if (!engine.has(type)) return null;

  const table = engine.table(type);
  const fields = engine.fields(type);
  const rowCount = engine.rowCount(type);

  const columns: ColumnSummary[] = fields.map((f) => {
    const col = table.column(f.name);
    let nullCount = 0;
    for (let r = 0; r < rowCount; r++) if (table.isNull(f.name, r)) nullCount++;

    const summary: ColumnSummary = {
      name: f.name,
      type: f.type,
      storage: STORAGE[f.type],
      length: col.length,
      nullCount,
    };

    // Index strategy (if eq-indexed); eqStrategy throws when no eq index exists on the field.
    try {
      summary.eqIndex = table.eqStrategy(f.name);
    } catch {
      /* no eq index on this field — leave undefined */
    }

    // For string columns, surface the dictionary by collecting distinct decoded values (capped).
    if (f.type === 'string') {
      const scan = Math.min(rowCount, DISTINCT_SCAN_CAP);
      const seen = new Set<string>();
      for (let r = 0; r < scan; r++) {
        if (table.isNull(f.name, r)) continue;
        seen.add(col.at(r) as string);
      }
      summary.distinctValues = seen.size;
      summary.distinctSample = [...seen].slice(0, DISTINCT_SAMPLE_CAP);
      summary.sampledRows = scan;
    }

    return summary;
  });

  // Relation fields + their target type, from the public parse context (no Registry / private reach-in).
  const relations: RelationSummary[] = [...engine.relationParseContext(type).relations.entries()].map(
    ([field, targetType]) => ({ field, targetType }),
  );

  // Decoded row window. materialize() returns the SAME shape the read path serializes (RawJson markers
  // for json fields are flattened to their raw string so the result is JSON-safe).
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(0, Math.min(opts.limit ?? 20, 200));
  const rows: Record<string, unknown>[] = [];
  for (let r = offset; r < Math.min(offset + limit, rowCount); r++) {
    rows.push(jsonSafe(table.materialize(r)));
  }

  return {
    type,
    rowCount,
    columns,
    relations,
    rows,
    window: { offset, limit, returned: rows.length },
  };
}

/** Flatten any RawJson marker (verbatim json bytes) to a parsed value so the result is plain JSON. */
function jsonSafe(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const v = row[key];
    out[key] = v instanceof RawJson ? safeParse(v.raw) : v;
  }
  return out;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // malformed stored json — show it verbatim rather than throwing in a debug view.
  }
}
