import type { Sql } from 'postgres';
import { resolveType, classifyTypeChange, type CmsType, type FieldOptions, type ResolvedType } from './type-catalog.ts';
import {
  validateFieldName,
  deriveTableName,
  validateDefault,
  compileCreateTable,
  compileAddColumn,
  compileRenameColumn,
  compileDropColumn,
  compileAlterColumnType,
  compileDropTable,
  runSchemaTx,
  DuplicateFieldError,
  ContentTypeExistsError,
  ContentTypeNotFoundError,
  FieldExistsError,
  FieldNotFoundError,
  TypeChangeForbiddenError,
  type ResolvedField,
} from './ddl.ts';

/**
 * The META REPOSITORY: read/write `content_types` + `content_type_fields`, plus the high-level,
 * validated content-type operations (create / addField / renameField / dropField / changeFieldType /
 * dropContentType). Every mutating op composes validation -> the type catalog -> the Kysely-compiled
 * DDL -> ONE atomic postgres.js transaction (DDL + meta together, via {@link runSchemaTx}). Meta is
 * the SOURCE OF TRUTH; this module owns NO connection (callers pass `sql`) and NEVER touches
 * `_migrations` (that belongs to the file migration runner).
 *
 * CONNECTION DECISION (re: the blueprint's "dedicated short-lived max:1 schema-change connection"):
 * these ops are deliberately written to accept an INJECTABLE `Sql` (the tests drive the real shared
 * pool, per the no-mocks rule). The dedicated `postgres(url,{max:1})` handle the blueprint mandates —
 * so a DDL ACCESS EXCLUSIVE / a `lock_timeout` wait never starves the main read/write pool — is the
 * responsibility of the (not-yet-written) PRODUCTION wiring/HTTP layer that lands in a later step: it
 * must open a short-lived max:1 handle, pass it here, and `sql.end()` it in a finally (mirroring
 * migrate.ts). A future caller MUST NOT run schema changes on the hot shared pool.
 */

/** A field the caller wants to define: the user name, its cms_type, and per-type options. */
export interface FieldSpec {
  name: string;
  cmsType: CmsType;
  options?: FieldOptions;
}

/** A `content_types` row (snake_case as stored). */
export interface ContentTypeRow {
  id: number;
  api_id: string;
  table_name: string;
  created_at: Date;
  updated_at: Date;
}

/** A `content_type_fields` row (snake_case as stored). */
export interface FieldRow {
  id: number;
  content_type_id: number;
  name: string;
  cms_type: string;
  pg_type: string;
  engine_type: string;
  nullable: boolean;
  sort: number;
  default_value: string | null;
  params: Record<string, unknown>;
}

// --- pure reads --------------------------------------------------------------------------------

/** All content-types, ordered by id. */
export async function listContentTypes(sql: Sql): Promise<ContentTypeRow[]> {
  return sql<ContentTypeRow[]>`SELECT * FROM content_types ORDER BY id`;
}

/** One content-type by api_id (case-insensitive), or null. */
export async function getContentType(sql: Sql, apiId: string): Promise<ContentTypeRow | null> {
  const rows = await sql<ContentTypeRow[]>`SELECT * FROM content_types WHERE lower(api_id) = lower(${apiId})`;
  return rows[0] ?? null;
}

/** The fields of a content-type, in `sort` order (the canonical projection order — never attnum). */
export async function getFields(sql: Sql, contentTypeId: number): Promise<FieldRow[]> {
  return sql<FieldRow[]>`SELECT * FROM content_type_fields WHERE content_type_id = ${contentTypeId} ORDER BY sort`;
}

// --- validation helpers ------------------------------------------------------------------------

/**
 * Validate a batch of field specs: each name passes {@link validateFieldName}, names are unique
 * case-insensitively (DuplicateFieldError), each type resolves, and a supplied default type-checks.
 * Returns the resolved fields paired with their (bound) default values — ready for the DDL builders.
 */
export function resolveFields(specs: FieldSpec[]): ResolvedField[] {
  const seen = new Set<string>();
  const out: ResolvedField[] = [];
  for (const spec of specs) {
    const name = validateFieldName(spec.name);
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw new DuplicateFieldError(name);
    seen.add(lower);
    const resolved = resolveType(spec.cmsType, spec.options);
    const nullable = spec.options?.nullable ?? true;
    let defaultValue: unknown;
    if (spec.options?.default !== undefined) defaultValue = validateDefault(resolved, spec.options.default).sqlLiteral;
    out.push({ name, resolved, nullable, defaultValue });
  }
  return out;
}

/** The `params` jsonb stored for a field is the catalog's resolved params verbatim. */
function paramsOf(resolved: ResolvedType): Record<string, unknown> {
  return resolved.params;
}

/** Stringify a bound default for the `default_value` text column (NULL when none). */
function defaultText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

// --- high-level operations ---------------------------------------------------------------------

/**
 * Create a content-type: validate the api_id + derive the table name, resolve+validate every field,
 * then in ONE transaction INSERT content_types (RETURNING id) -> INSERT content_type_fields (eager
 * `sort`) -> CREATE TABLE. A pre-check rejects an existing api_id BEFORE any DDL; the DB UNIQUE on
 * lower(api_id)/lower(table_name) is the atomic backstop for a race.
 */
export async function createContentType(sql: Sql, params: { apiId: string; fields: FieldSpec[] }): Promise<ContentTypeRow> {
  const tableName = deriveTableName(params.apiId);
  const fields = resolveFields(params.fields);

  // Pre-check (a clean ContentTypeExistsError instead of waiting for the DB UNIQUE).
  const existing = await getContentType(sql, params.apiId);
  if (existing !== null) throw new ContentTypeExistsError(params.apiId);

  return runSchemaTx(sql, tableName, async (tx) => {
    const [ct] = await tx<ContentTypeRow[]>`
      INSERT INTO content_types (api_id, table_name) VALUES (${params.apiId}, ${tableName}) RETURNING *
    `;
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]!;
      await tx`
        INSERT INTO content_type_fields (content_type_id, name, cms_type, pg_type, engine_type, nullable, sort, default_value, params)
        VALUES (${ct!.id}, ${f.name}, ${f.resolved.cmsType}, ${f.resolved.pgType}, ${f.resolved.engineType}, ${f.nullable}, ${i}, ${defaultText(f.defaultValue)}, ${tx.json(paramsOf(f.resolved))})
      `;
    }
    const ddl = compileCreateTable(tableName, fields);
    await tx.unsafe(ddl.sql, ddl.parameters as unknown[]);
    return ct!;
  });
}

/** Look up the content-type row FOR UPDATE inside a tx, or throw ContentTypeNotFoundError. */
async function lockContentType(tx: Sql, apiId: string): Promise<ContentTypeRow> {
  const rows = await tx<ContentTypeRow[]>`SELECT * FROM content_types WHERE lower(api_id) = lower(${apiId}) FOR UPDATE`;
  if (rows.length === 0) throw new ContentTypeNotFoundError(apiId);
  return rows[0]!;
}

/**
 * Add a field to an existing type: validate the name + resolve the type, then in ONE tx lock the
 * content_types row, reject a duplicate (case-insensitive), append at `max(sort)+1`, INSERT the meta
 * row, and ALTER TABLE ADD COLUMN. A NOT NULL add to a populated table without a constant default is
 * rejected by PG (23502) and rolls the whole change back.
 */
export async function addField(sql: Sql, apiId: string, spec: FieldSpec): Promise<FieldRow> {
  const name = validateFieldName(spec.name);
  const resolved = resolveType(spec.cmsType, spec.options);
  const nullable = spec.options?.nullable ?? true;
  let defaultValue: unknown;
  if (spec.options?.default !== undefined) defaultValue = validateDefault(resolved, spec.options.default).sqlLiteral;
  const field: ResolvedField = { name, resolved, nullable, defaultValue };

  const tableName = deriveTableName(apiId);
  return runSchemaTx(sql, tableName, async (tx) => {
    const ct = await lockContentType(tx, apiId);
    const dup = await tx`SELECT 1 FROM content_type_fields WHERE content_type_id = ${ct.id} AND lower(name) = lower(${name})`;
    if (dup.length > 0) throw new FieldExistsError(name);
    const [{ next }] = await tx<{ next: number }[]>`SELECT COALESCE(MAX(sort) + 1, 0) AS next FROM content_type_fields WHERE content_type_id = ${ct.id}`;
    const [row] = await tx<FieldRow[]>`
      INSERT INTO content_type_fields (content_type_id, name, cms_type, pg_type, engine_type, nullable, sort, default_value, params)
      VALUES (${ct.id}, ${name}, ${resolved.cmsType}, ${resolved.pgType}, ${resolved.engineType}, ${nullable}, ${next!}, ${defaultText(defaultValue)}, ${tx.json(paramsOf(resolved))})
      RETURNING *
    `;
    const ddl = compileAddColumn(ct.table_name, field);
    await tx.unsafe(ddl.sql, ddl.parameters as unknown[]);
    return row!;
  });
}

/**
 * Rename a field: real RENAME COLUMN + meta UPDATE in ONE tx. The new name is re-validated (rejects
 * reserved system columns and `_`-leading), a collision with an existing sibling (case-insensitive)
 * is rejected, and a missing source field throws FieldNotFoundError. Never drop+recreate.
 */
export async function renameField(sql: Sql, apiId: string, from: string, to: string): Promise<FieldRow> {
  const newName = validateFieldName(to);
  const tableName = deriveTableName(apiId);
  return runSchemaTx(sql, tableName, async (tx) => {
    const ct = await lockContentType(tx, apiId);
    const rows = await tx<FieldRow[]>`SELECT * FROM content_type_fields WHERE content_type_id = ${ct.id} AND lower(name) = lower(${from})`;
    if (rows.length === 0) throw new FieldNotFoundError(from);
    const source = rows[0]!;
    if (newName.toLowerCase() !== source.name.toLowerCase()) {
      const collide = await tx`SELECT 1 FROM content_type_fields WHERE content_type_id = ${ct.id} AND lower(name) = lower(${newName})`;
      if (collide.length > 0) throw new FieldExistsError(newName);
    }
    const [row] = await tx<FieldRow[]>`UPDATE content_type_fields SET name = ${newName} WHERE id = ${source.id} RETURNING *`;
    const ddl = compileRenameColumn(ct.table_name, source.name, newName);
    await tx.unsafe(ddl.sql, ddl.parameters as unknown[]);
    return row!;
  });
}

/**
 * Drop a field: DROP COLUMN (RESTRICT) + meta DELETE in ONE tx. System columns are rejected, a
 * missing field throws FieldNotFoundError; no `IF EXISTS` masking.
 */
export async function dropField(sql: Sql, apiId: string, name: string): Promise<void> {
  // Uniform identifier gate (matches renameField/changeFieldType): a malformed/injection `name` is
  // rejected with InvalidIdentifierError, and a reserved system column with ReservedFieldNameError.
  validateFieldName(name);
  const tableName = deriveTableName(apiId);
  await runSchemaTx(sql, tableName, async (tx) => {
    const ct = await lockContentType(tx, apiId);
    const rows = await tx<FieldRow[]>`SELECT * FROM content_type_fields WHERE content_type_id = ${ct.id} AND lower(name) = lower(${name})`;
    if (rows.length === 0) throw new FieldNotFoundError(name);
    const field = rows[0]!;
    await tx`DELETE FROM content_type_fields WHERE id = ${field.id}`;
    const ddl = compileDropColumn(ct.table_name, field.name);
    await tx.unsafe(ddl.sql, ddl.parameters as unknown[]);
  });
}

/**
 * Change a field's type. Step 2 ONLY allows `metadata-only` transitions (e.g. varchar grow,
 * varchar -> text); `rewrite` and `forbidden` are rejected up front with {@link TypeChangeForbiddenError}
 * (the rewrite-aware path lands in a later step). The allowed ALTER COLUMN TYPE ... USING and the
 * meta UPDATE run in ONE tx, so any in-tx failure rolls BOTH back.
 *
 * NOTE — the failed-cast rollback path (a 22P02/22003/22001 mid-cast mapped to TypeChangeFailedError
 * in runSchemaTx) is UNREACHABLE through this public API in Step 2: the only metadata-only transitions
 * the classifier returns (varchar grow, varchar -> text) are binary-coercible casts that cannot fail
 * on data. The TypeChangeFailedError mapping is intentionally present for the LATER rewrite-aware step
 * (which will permit fallible casts); P4 below therefore tests the UP-FRONT rewrite REJECTION, not an
 * in-transaction cast rollback. The shared atomicity mechanism (one sql.begin per op) is proven by P2b.
 */
export async function changeFieldType(sql: Sql, apiId: string, name: string, cmsType: CmsType, options?: FieldOptions): Promise<FieldRow> {
  validateFieldName(name);
  const toResolved = resolveType(cmsType, options);
  const tableName = deriveTableName(apiId);
  return runSchemaTx(sql, tableName, async (tx) => {
    const ct = await lockContentType(tx, apiId);
    const rows = await tx<FieldRow[]>`SELECT * FROM content_type_fields WHERE content_type_id = ${ct.id} AND lower(name) = lower(${name})`;
    if (rows.length === 0) throw new FieldNotFoundError(name);
    const field = rows[0]!;
    const fromResolved = resolveType(field.cms_type as CmsType, field.params as FieldOptions);
    const klass = classifyTypeChange(fromResolved, toResolved);
    if (klass !== 'metadata-only') throw new TypeChangeForbiddenError(`type change ${field.pg_type} -> ${toResolved.pgType} is a ${klass} change, not allowed in this step`);
    const [row] = await tx<FieldRow[]>`
      UPDATE content_type_fields SET cms_type = ${toResolved.cmsType}, pg_type = ${toResolved.pgType}, engine_type = ${toResolved.engineType}, params = ${tx.json(paramsOf(toResolved))}
      WHERE id = ${field.id} RETURNING *
    `;
    const ddl = compileAlterColumnType(ct.table_name, field.name, toResolved);
    await tx.unsafe(ddl.sql, ddl.parameters as unknown[]);
    return row!;
  });
}

/**
 * Drop a content-type: DROP TABLE (RESTRICT) + DELETE its field rows + DELETE the type row in ONE tx.
 * A missing type throws ContentTypeNotFoundError. (Cross-type dependencies are not modelled in Step 2;
 * the DependentTypesError signal exists for the relation step.)
 */
export async function dropContentType(sql: Sql, apiId: string): Promise<void> {
  const tableName = deriveTableName(apiId);
  await runSchemaTx(sql, tableName, async (tx) => {
    const ct = await lockContentType(tx, apiId);
    await tx`DELETE FROM content_type_fields WHERE content_type_id = ${ct.id}`;
    await tx`DELETE FROM content_types WHERE id = ${ct.id}`;
    const ddl = compileDropTable(ct.table_name);
    await tx.unsafe(ddl.sql, ddl.parameters as unknown[]);
  });
}
