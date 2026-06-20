import type { Sql } from 'postgres';
import { RawJson } from '../store/column.ts';
import type { ContentTypeDef, RegistryField } from '../store/registry.ts';
import { quoteIdent } from './ddl.ts';
import { assertTableName } from './engine.loader.ts';

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
  // A copied json value (variant-create shared-field copy) arrives as RawJson wrapping the sibling's
  // verbatim jsonb `::text`. The placeholder is `$n::jsonb`, and postgres.js binds a JS STRING param as
  // a TEXT value — so casting the raw STRING to jsonb DOUBLE-ENCODES it into a jsonb string scalar
  // (e.g. the gallery text "[1, 2]" would store as the jsonb string "[1, 2]", not the array [1,2]).
  // PARSE it back to a JS value so postgres.js serializes it to a REAL jsonb value — byte-identical to
  // how the normal create binds body.parser's parsed value (the proven path). The verbatim ::text is
  // canonical jsonb, so JSON.parse round-trips it; >2^53 fidelity is already the loader's concern (the
  // wire JSON.parse upstream collapsed any such int), exactly as on the normal write path.
  if (value instanceof RawJson) return JSON.parse(value.raw);
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
export async function insertEntry(
  sql: Sql,
  def: ContentTypeDef,
  data: Record<string, unknown>,
  // INTERNAL server-controlled seam — never reachable from the wire (body.parser rejects `document_id`
  // and `locale` keys via SYSTEM_COLUMN_NAMES). be-03 (draft/publish) + be-06 (i18n) pass an existing
  // parent id so a variant shares its document; the i18n write path also supplies the variant `locale`.
  //   - `documentId` left undefined: the column DEFAULTs to nextval('document_id_seq') (auto-allocate).
  //   - `locale` left undefined: omitted from the INSERT — only an i18n type has the (NOT NULL) column,
  //     so a plain create on an i18n type MUST pass it (the controller does); a non-i18n type never does.
  opts?: { documentId?: number; locale?: string },
): Promise<Record<string, unknown>> {
  assertTableName(def.tableName); // belt-and-suspenders identifier gate, symmetric with the loader.
  const keys = Object.keys(data);
  const cols: string[] = [];
  const vals: unknown[] = [];
  const jsonFlags: boolean[] = [];
  if (opts?.documentId !== undefined) {
    cols.push('document_id');
    vals.push(opts.documentId);
    jsonFlags.push(false);
  }
  if (opts?.locale !== undefined) {
    // Server-controlled like document_id: `locale` is a NOT NULL i18n system column the body can't spoof.
    cols.push('locale');
    vals.push(opts.locale);
    jsonFlags.push(false);
  }
  for (const key of keys) {
    const field = def.writableByName.get(key)!; // guaranteed present by the validator
    cols.push(field.column);
    vals.push(bindValue(field, data[key]));
    jsonFlags.push(field.json);
  }

  try {
    if (cols.length === 0) {
      // A system-fields-only type with no explicit document_id: INSERT DEFAULT VALUES
      // (id/document_id/created_at/updated_at all defaulted).
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

/**
 * UPDATE the present fields of entry `id` (+ updated_at=now()); `null` when no row has that id.
 *
 * i18n SHARED-FIELD FAN-OUT (S1): on an i18n type a SHARED field (`localized=false`) is conceptually one
 * value for the whole document, so an update to it must propagate to EVERY locale variant (same
 * `document_id`). LOCALIZED fields (`localized=true`) stay scoped to the addressed row. We do it in TWO
 * statements inside the caller's ONE tx:
 *   1. the addressed-row UPDATE (ALL present fields, both localized + shared) — also confirms the row
 *      exists (RETURNING the full row, incl. `document_id`), so a missing id is still `null` -> 404.
 *   2. (i18n + ≥1 shared field present) a sibling UPDATE of ONLY the shared fields, scoped by the
 *      addressed row's `document_id` and `id <> $id`, so the new shared value lands on every other variant.
 * For a NON-i18n type `def.i18n` is false => statement 2 never runs => this is BYTE-IDENTICAL to before.
 */
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
    if (rows.length === 0) return null;
    const row = fromDb(def, rows[0] as Record<string, unknown>);

    // i18n shared-field fan-out: propagate the SHARED assignments to the document's other variants.
    if (def.i18n) {
      const sharedKeys = keys.filter((k) => !def.writableByName.get(k)!.localized);
      if (sharedKeys.length > 0) {
        const docId = row['document_id'] as number; // present: document_id is a projected field on i18n.
        const sAssign: string[] = [];
        const sVals: unknown[] = [];
        let sp = 1;
        for (const key of sharedKeys) {
          const field = def.writableByName.get(key)!;
          const ph = field.json ? `$${sp}::jsonb` : `$${sp}`;
          sAssign.push(`${quoteIdent(field.column)} = ${ph}`);
          sVals.push(bindValue(field, data[key]));
          sp += 1;
        }
        sAssign.push(`${quoteIdent('updated_at')} = now()`);
        const docPh = `$${sp}`;
        const idPh = `$${sp + 1}`;
        sVals.push(docId, id);
        const sText = `UPDATE ${quoteIdent(def.tableName)} SET ${sAssign.join(', ')} WHERE ${quoteIdent('document_id')} = ${docPh} AND ${quoteIdent('id')} <> ${idPh}`;
        await sql.unsafe(sText, sVals as never[]);
      }
    }
    return row;
  } catch (e) {
    mapPgError(e);
  }
}

/**
 * The raw column snapshot of an i18n sibling row, used by the variant-create verb to COPY shared fields.
 * `documentId` is the variant-grouping key (reused for the new row). `shared` carries the bound wire-form
 * value of every SHARED user field (`localized=false`), keyed by engine field name — exactly the shape
 * {@link insertEntry}'s `data` expects (i64/decimal as STRING, date as Date, json as verbatim `::text`
 * which binds back through the `::jsonb` placeholder). LOCALIZED fields are NOT copied (the request
 * supplies them); system columns are excluded.
 */
export interface SiblingSnapshot {
  documentId: number;
  shared: Record<string, unknown>;
}

/**
 * Read the sibling row addressed by `id` on an i18n type and snapshot its `document_id` + every SHARED
 * user field, for the variant-create verb. SELECTs the shared columns by their registry-validated names
 * (json as `::text`, wrapped in {@link RawJson} so it re-binds verbatim). Returns `null` when no row has
 * that id. Caller must have verified `def.i18n`.
 */
export async function readSiblingForVariant(sql: Sql, def: ContentTypeDef, id: number): Promise<SiblingSnapshot | null> {
  assertTableName(def.tableName);
  const sharedFields = def.writable.filter((f) => !f.localized);
  const cols = ['document_id', ...sharedFields.map((f) => f.column)];
  const selectList = cols
    .map((c) => {
      const f = sharedFields.find((sf) => sf.column === c);
      return f?.json ? `${quoteIdent(c)}::text AS ${quoteIdent(c)}` : quoteIdent(c);
    })
    .join(', ');
  const text = `SELECT ${selectList} FROM ${quoteIdent(def.tableName)} WHERE ${quoteIdent('id')} = $1`;
  const rows = await sql.unsafe(text, [id] as never[]);
  if (rows.length === 0) return null;
  const dbRow = rows[0] as Record<string, unknown>;
  const shared: Record<string, unknown> = {};
  for (const f of sharedFields) {
    const v = dbRow[f.column];
    // json: re-bind the verbatim ::text via a RawJson so insertEntry can splice it through ::jsonb.
    shared[f.name] = f.json && v !== null && v !== undefined ? new RawJson(v as string) : v;
  }
  return { documentId: dbRow['document_id'] as number, shared };
}

/**
 * PUBLISH entry `id` (Model A Draft & Publish): set `published_at` to the CALLER-SUPPLIED `at` Date
 * (NOT a SQL `now()` — so a publish time is deterministic + pinnable in fixtures) + bump `updated_at`.
 * Returns the stored row (engine-named, incl. `published_at`); `null` when no row has that id. The
 * caller must have verified `def.draftPublish` (the column only exists on a D&P type).
 */
export async function publishEntry(sql: Sql, def: ContentTypeDef, id: number, at: Date): Promise<Record<string, unknown> | null> {
  assertTableName(def.tableName);
  const text = `UPDATE ${quoteIdent(def.tableName)} SET ${quoteIdent('published_at')} = $1, ${quoteIdent('updated_at')} = now() WHERE ${quoteIdent('id')} = $2 RETURNING ${returningList(def)}`;
  try {
    const rows = await sql.unsafe(text, [at, id] as never[]);
    return rows.length ? fromDb(def, rows[0] as Record<string, unknown>) : null;
  } catch (e) {
    mapPgError(e);
  }
}

/**
 * UNPUBLISH entry `id`: clear `published_at` to NULL (back to draft) + bump `updated_at`. Returns the
 * stored row; `null` when no row has that id. Caller must have verified `def.draftPublish`.
 */
export async function unpublishEntry(sql: Sql, def: ContentTypeDef, id: number): Promise<Record<string, unknown> | null> {
  assertTableName(def.tableName);
  const text = `UPDATE ${quoteIdent(def.tableName)} SET ${quoteIdent('published_at')} = NULL, ${quoteIdent('updated_at')} = now() WHERE ${quoteIdent('id')} = $1 RETURNING ${returningList(def)}`;
  try {
    const rows = await sql.unsafe(text, [id] as never[]);
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
 * be-05b RELATION-INSIDE-COMPONENT — the WRITE-side referential-integrity check for an inline relation
 * ref. Given candidate `id`s that a component's relation field points at the content-type `def`, return
 * the SUBSET that does NOT exist in `def`'s ct_ table (so the caller 400s naming the dangling ids). Mirror
 * of {@link import('./file.repository.ts').missingFileIds} but against the TARGET ct_ table — the table
 * identifier comes ONLY from the registry-built `def.tableName` (NEVER client input), the ids are bound.
 * Runs INSIDE the caller's tx so the check + the row insert/update commit atomically. Empty input -> [].
 */
export async function missingEntryIds(sql: Sql, def: ContentTypeDef, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  assertTableName(def.tableName);
  const unique = [...new Set(ids)];
  const text = `SELECT ${quoteIdent('id')} FROM ${quoteIdent(def.tableName)} WHERE ${quoteIdent('id')} = ANY($1::int[])`;
  const rows = await sql.unsafe(text, [unique] as never[]);
  const present = new Set((rows as { id: number }[]).map((r) => r.id));
  return unique.filter((id) => !present.has(id));
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
