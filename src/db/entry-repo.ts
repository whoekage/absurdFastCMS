import type { Sql } from 'postgres';
import { RawJson } from '../store/column.ts';
import type { ContentTypeDef, RegistryField } from '../store/registry.ts';
import { quoteIdent } from './ddl.ts';
import { assertTableName } from './load.ts';

/**
 * The GENERIC write repository — Postgres is the SOURCE OF TRUTH, so each create/update/delete commits
 * here FIRST (single statement, registry-built RETURNING), and the caller rebuilds ONLY this type.
 *
 * SECURITY DOCTRINE (all enforced here, defense-in-depth behind the validator):
 *   - Every SQL identifier (table + columns) comes ONLY from the validated {@link ContentTypeDef}: the
 *     table via the registry's `tableName`, each column via `def.writableByName.get(key).column`. A body
 *     key is NEVER used as an identifier directly.
 *   - Every value is a BOUND parameter (never interpolated): i64 as a digit STRING, decimal as a
 *     canonical `formatDecimal` STRING, json as bound TEXT cast `::jsonb`, date as a JS Date, id in
 *     WHERE as a bound Number.
 *   - The RETURNING list is registry-built (NOT `RETURNING *`): json columns are emitted as
 *     `"col"::text AS "col"` so jsonb returns VERBATIM TEXT (mirrors the loader); int8/numeric/uuid
 *     come back as strings.
 *   - Known PG SQLSTATEs map to a typed, GENERIC {@link EntryWriteError} (400-class) with NO
 *     constraint/column/SQL text leaked. The validator should catch these before SQL; this is a backstop.
 */

/** A typed write error mapped from a known PG SQLSTATE — its message NEVER leaks SQL/constraint detail. */
export class EntryWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntryWriteError';
  }
}

interface PgError extends Error {
  code?: string;
}

/** Map a known data-error SQLSTATE to a generic {@link EntryWriteError}; rethrow anything else. */
export function mapPgError(e: unknown): never {
  const code = (e as PgError).code;
  switch (code) {
    case '23503': // foreign_key_violation — a relation op named a non-existent related id
      throw new EntryWriteError('write rejected: a related entry does not exist');
    case '23502': // not_null_violation
    case '23505': // unique_violation
    case '22001': // string_data_right_truncation
    case '22003': // numeric_value_out_of_range
    case '22P02': // invalid_text_representation
    case '23514': // check_violation
      throw new EntryWriteError('write rejected: the value is invalid for this field');
    default:
      throw e as Error;
  }
}

/** Bind a single writable value to the form Postgres stores exactly (every value a bound param). */
function bindValue(field: RegistryField, value: unknown): unknown {
  if (value === null) return null;
  switch (field.type) {
    case 'i64':
      // The validator produced a canonical digit STRING; bind it so int8 round-trips exactly.
      return value;
    case 'decimal':
      // The validator produced a canonical fixed-point STRING; bind it so numeric stores it exactly.
      return value;
    default:
      // date (JS Date), bool, i32/f64 (number), string/text (string) — bound verbatim.
      return value;
  }
}

/** The RETURNING fragment: every field in `def.fields` order, json columns cast to ::text. */
function returningList(def: ContentTypeDef): string {
  return def.fields
    .map((f) => (f.json ? `${quoteIdent(f.column)}::text AS ${quoteIdent(f.column)}` : quoteIdent(f.column)))
    .join(', ');
}

/**
 * Map a DB row (returned by the registry RETURNING) into the engine-named row the response serializer
 * expects. Column name === field name, so this is a positional pass that wraps a json column's verbatim
 * `::text` string in {@link RawJson} (so {@link serializeEntry} splices it byte-exact, never re-parsed).
 */
function fromDb(def: ContentTypeDef, dbRow: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of def.fields) {
    const v = dbRow[f.column];
    out[f.name] = f.json && v !== null && v !== undefined ? new RawJson(v as string) : v;
  }
  return out;
}

/**
 * INSERT one entry into ct_<apiId>. `data` keys are already a whitelisted subset of `def.writable`
 * names (the validator ran first). Returns the stored row (engine-named, with its serial id).
 */
export async function insertEntry(sql: Sql, def: ContentTypeDef, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  assertTableName(def.tableName); // belt-and-suspenders identifier gate, symmetric with the loader.
  const keys = Object.keys(data);
  const cols: string[] = [];
  const vals: unknown[] = [];
  const jsonFlags: boolean[] = [];
  for (const key of keys) {
    const field = def.writableByName.get(key)!; // guaranteed present by the validator
    cols.push(field.column);
    vals.push(bindValue(field, data[key]));
    jsonFlags.push(field.json);
  }

  try {
    if (cols.length === 0) {
      // A system-fields-only type: INSERT DEFAULT VALUES (id/created_at/updated_at all defaulted).
      const rows = await sql.unsafe(`INSERT INTO ${quoteIdent(def.tableName)} DEFAULT VALUES RETURNING ${returningList(def)}`);
      return fromDb(def, rows[0] as Record<string, unknown>);
    }
    const colFrag = cols.map(quoteIdent).join(', ');
    const placeholders = jsonFlags.map((isJson, i) => (isJson ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ');
    const text = `INSERT INTO ${quoteIdent(def.tableName)} (${colFrag}) VALUES (${placeholders}) RETURNING ${returningList(def)}`;
    const rows = await sql.unsafe(text, vals as never[]);
    return fromDb(def, rows[0] as Record<string, unknown>);
  } catch (e) {
    mapPgError(e);
  }
}

/** UPDATE the present fields of entry `id` (+ updated_at=now()); `null` when no row has that id. */
export async function updateEntry(sql: Sql, def: ContentTypeDef, id: number, data: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  assertTableName(def.tableName);
  const keys = Object.keys(data);
  const assignments: string[] = [];
  const vals: unknown[] = [];
  let p = 1;
  for (const key of keys) {
    const field = def.writableByName.get(key)!;
    const ph = field.json ? `$${p}::jsonb` : `$${p}`;
    assignments.push(`${quoteIdent(field.column)} = ${ph}`);
    vals.push(bindValue(field, data[key]));
    p += 1;
  }
  // Server-side updated_at; then the bound id in WHERE.
  assignments.push(`${quoteIdent('updated_at')} = now()`);
  const idPlaceholder = `$${p}`;
  vals.push(id);
  const text = `UPDATE ${quoteIdent(def.tableName)} SET ${assignments.join(', ')} WHERE ${quoteIdent('id')} = ${idPlaceholder} RETURNING ${returningList(def)}`;
  try {
    const rows = await sql.unsafe(text, vals as never[]);
    return rows.length ? fromDb(def, rows[0] as Record<string, unknown>) : null;
  } catch (e) {
    mapPgError(e);
  }
}

/** DELETE entry `id`, returning the deleted row (engine-named); `null` when no row had that id. */
export async function deleteEntry(sql: Sql, def: ContentTypeDef, id: number): Promise<Record<string, unknown> | null> {
  assertTableName(def.tableName);
  const text = `DELETE FROM ${quoteIdent(def.tableName)} WHERE ${quoteIdent('id')} = $1 RETURNING ${returningList(def)}`;
  try {
    const rows = await sql.unsafe(text, [id] as never[]);
    return rows.length ? fromDb(def, rows[0] as Record<string, unknown>) : null;
  } catch (e) {
    mapPgError(e);
  }
}

/**
 * Render a returned row (engine-named, json values wrapped in {@link RawJson}) into the SAME JSON the
 * read engine's `materialize`/`serializeRow` produces: fields in `def.fields` order, date -> ISO,
 * i64 -> quoted string, decimal -> quoted formatDecimal, json -> verbatim spliced, null -> null.
 * Used for ALL write responses (incl. DELETE, whose row no longer exists in the engine) so they are
 * byte-consistent with GET.
 */
export function serializeEntry(def: ContentTypeDef, row: Record<string, unknown>): string {
  let out = '{';
  let first = true;
  for (const f of def.fields) {
    if (!first) out += ',';
    first = false;
    out += JSON.stringify(f.name) + ':';
    const v = row[f.name];
    if (v === null || v === undefined) {
      out += 'null';
      continue;
    }
    if (f.json) {
      out += v instanceof RawJson ? v.raw : (v as string);
      continue;
    }
    switch (f.type) {
      case 'date':
        out += JSON.stringify(new Date(v as string | number | Date).toISOString());
        break;
      case 'i64':
        // postgres.js returns int8 as a STRING; emit it quoted (the interoperable wire form).
        out += JSON.stringify(String(v));
        break;
      case 'decimal':
        // postgres.js returns numeric as a canonical STRING already; emit it quoted verbatim.
        out += JSON.stringify(String(v));
        break;
      default:
        out += JSON.stringify(v);
    }
  }
  return out + '}';
}
