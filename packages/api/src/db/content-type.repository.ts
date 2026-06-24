import type { Sql, JSONValue, ParameterOrJSON } from 'postgres';
import { resolveType, resolveComponentField, isComponentFieldKind, classifyTypeChange, ComponentFieldError, type CmsType, type ComponentFieldKind, type FieldOptions, type ResolvedType } from './type.catalog.ts';
import { assertComponentRefsExist } from './component-type.repository.ts';
import {
  validateFieldName,
  deriveTableName,
  validateDefault,
  validateRelationKind,
  inverseKind,
  deriveLinkTableName,
  compileCreateTable,
  compileCreateLinkTable,
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
  DependentTypesError,
  type RelationKind,
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
  /** A scalar {@link CmsType} OR a be-05 {@link ComponentFieldKind} (component/component-repeatable/dynamiczone). */
  name: string;
  cmsType: CmsType | ComponentFieldKind;
  options?: FieldOptions | undefined;
  /** i18n: true => the field is localized (per-variant); false => shared across locale variants. Defaults true. */
  localized?: boolean;
}

/** A `content_types` row (snake_case as stored). */
export interface ContentTypeRow {
  id: number;
  api_id: string;
  table_name: string;
  created_at: Date;
  updated_at: Date;
  /** Model A Draft & Publish opt-in: true => the ct_ table has a `published_at` system column. */
  draft_publish: boolean;
  /** i18n opt-in: true => the ct_ table has a `locale` system column + UNIQUE(document_id, locale). */
  i18n: boolean;
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
  /** i18n: true => localized (per-variant); false => shared across the document's locale variants. */
  localized: boolean;
}

/** A relation the caller wants to declare on an owner type. inverseField PRESENT => two-way. */
export interface RelationSpec {
  field: string; // the relation field / API key on the owner
  kind: RelationKind; // oneToOne|oneToMany|manyToOne|manyToMany
  target: string; // target type api_id (may equal owner api_id => self-referential)
  inverseField?: string; // present => two-way (adds inverse meta row on the target, no DDL); absent => one-way
}

/** A `content_type_relations` row (snake_case as stored). */
export interface RelationRow {
  id: number;
  content_type_id: number;
  field_name: string;
  kind: string;
  target_api_id: string;
  is_owner: boolean;
  inverse_field: string | null;
  link_table: string;
  sort: number;
  created_at: Date;
  updated_at: Date;
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

/** The relations of a content-type, in `sort` order (its OWN sort sequence, independent of fields). */
export async function getRelations(sql: Sql, contentTypeId: number): Promise<RelationRow[]> {
  return sql<RelationRow[]>`SELECT * FROM content_type_relations WHERE content_type_id = ${contentTypeId} ORDER BY sort`;
}

// --- validation helpers ------------------------------------------------------------------------

/**
 * be-05b GUARD: `relation` is a {@link ComponentFieldKind}, but unlike component/component-repeatable/
 * dynamiczone it has NO top-level (content-type) form — a relation INSIDE a component is an inline id ref
 * stored in the component's json (set-by-value, existence-checked on write, populate-resolved on read). A
 * relation at the TOP LEVEL of a content-type goes through the be-01 LINK-TABLE path ({@link RelationSpec},
 * a real CSR with an inverse side), NOT this scalar-field path. So reject `cmsType === 'relation'` here:
 * `resolveComponentField` is shared with the component-type path (the only legitimate caller). Without
 * this, a top-level relation field would resolve to a bare json column that is never existence-checked nor
 * populated — a silently-broken field (dangling/arbitrary-json on write, raw value on read).
 */
function rejectTopLevelRelation(cmsType: CmsType | ComponentFieldKind): void {
  if (cmsType === 'relation') {
    throw new ComponentFieldError(
      "a `relation` field is only valid INSIDE a component type; declare a top-level relation via the relations[] (link-table) API",
    );
  }
}

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
    // be-05b: `relation` is a component-field-kind that is ONLY valid INSIDE a component type (it has no
    // top-level form — an inline id ref lives in a component json column, not a ct_ column). Reject it on
    // the content-type field path BEFORE resolving (otherwise it would resolve to a bare json column that
    // is never existence-checked on write nor populated on read). Top-level relations go through the be-01
    // link-table path (RelationSpec), NOT this scalar-field path.
    rejectTopLevelRelation(spec.cmsType);
    // be-05: a component/component-repeatable/dynamiczone field resolves to a jsonb column via a SIBLING
    // helper (NOT the RESOLVERS record — so the `satisfies Record<CmsType,...>` guard stays exhaustive).
    // A component field never carries a constant default (it is a structured tree, not a scalar).
    const resolved = isComponentFieldKind(spec.cmsType)
      ? resolveComponentField(spec.cmsType, spec.options)
      : resolveType(spec.cmsType, spec.options);
    const nullable = spec.options?.nullable ?? true;
    let defaultValue: unknown;
    if (spec.options?.default !== undefined) defaultValue = validateDefault(resolved, spec.options.default).sqlLiteral;
    out.push({ name, resolved, nullable, defaultValue, localized: spec.localized ?? true });
  }
  return out;
}

/**
 * Collect the component-type api_id(s) a batch of resolved fields references (component/component-repeatable
 * carry `params.component`; dynamiczone carries `params.components[]`). Used to existence-check refs inside
 * a create/addField tx (a dangling ref => a clean ComponentTypeNotFoundError -> 400, not a runtime hole).
 */
function referencedComponents(fields: ResolvedField[]): string[] {
  const refs = new Set<string>();
  for (const f of fields) {
    const p = f.resolved.params;
    if (typeof p['component'] === 'string') refs.add(p['component']);
    if (Array.isArray(p['components'])) for (const c of p['components'] as string[]) refs.add(c);
  }
  return [...refs];
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
export async function createContentType(sql: Sql, params: { apiId: string; fields: FieldSpec[]; relations?: RelationSpec[]; draftPublish?: boolean; i18n?: boolean }): Promise<ContentTypeRow> {
  const tableName = deriveTableName(params.apiId);
  const fields = resolveFields(params.fields);
  const relations = params.relations ?? [];

  // Pure relation validation up front (fail fast, no DB) + batch collision/dedupe across the SAME call:
  // a relation field cannot equal a scalar field being created, nor another relation field (CI).
  const scalarNames = new Set(fields.map((f) => f.name.toLowerCase()));
  const relNames = new Set<string>();
  for (const spec of relations) {
    validateRelationSpec(params.apiId, spec);
    const lower = spec.field.toLowerCase();
    if (scalarNames.has(lower)) throw new FieldExistsError(spec.field);
    if (relNames.has(lower)) throw new FieldExistsError(spec.field);
    relNames.add(lower);
  }

  // Pre-check (a clean ContentTypeExistsError instead of waiting for the DB UNIQUE).
  const existing = await getContentType(sql, params.apiId);
  if (existing !== null) throw new ContentTypeExistsError(params.apiId);

  return runSchemaTx(sql, tableName, async (tx) => {
    // be-05: every referenced component type must EXIST (a dangling component ref is a clean 400). Checked
    // INSIDE the tx (FOR-SHARE-free read; the catalog is small) so the whole create rolls back on a miss.
    await assertComponentRefsExist(tx, referencedComponents(fields));
    const [ct] = await tx<ContentTypeRow[]>`
      INSERT INTO content_types (api_id, table_name, draft_publish, i18n) VALUES (${params.apiId}, ${tableName}, ${params.draftPublish ?? false}, ${params.i18n ?? false}) RETURNING *
    `;
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]!;
      await tx`
        INSERT INTO content_type_fields (content_type_id, name, cms_type, pg_type, engine_type, nullable, sort, default_value, params, localized)
        VALUES (${ct!.id}, ${f.name}, ${f.resolved.cmsType}, ${f.resolved.pgType}, ${f.resolved.engineType}, ${f.nullable}, ${i}, ${defaultText(f.defaultValue)}, ${tx.json(paramsOf(f.resolved) as JSONValue)}, ${f.localized ?? true})
      `;
    }
    // The owner ct_ table must exist BEFORE any (possibly self-referential) link-table FK is created.
    // D&P opt-in injects a conditional `published_at` system column (NULL=draft); i18n opt-in injects a
    // conditional NOT NULL `locale` column + UNIQUE(document_id, locale) — see compileCreateTable.
    const ddl = compileCreateTable(tableName, fields, params.draftPublish ?? false, params.i18n ?? false);
    await tx.unsafe(ddl.sql, ddl.parameters as ParameterOrJSON<never>[]);

    for (const spec of relations) {
      const selfReferential = spec.target.toLowerCase() === params.apiId.toLowerCase();
      const target = selfReferential ? ct! : await lockContentType(tx, spec.target);
      await declareRelationInTx(tx, ct!, target, spec);
    }
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
  rejectTopLevelRelation(spec.cmsType); // be-05b: `relation` is component-only (see resolveFields).
  const resolved = isComponentFieldKind(spec.cmsType)
    ? resolveComponentField(spec.cmsType, spec.options)
    : resolveType(spec.cmsType, spec.options);
  const nullable = spec.options?.nullable ?? true;
  let defaultValue: unknown;
  if (spec.options?.default !== undefined) defaultValue = validateDefault(resolved, spec.options.default).sqlLiteral;
  const field: ResolvedField = { name, resolved, nullable, defaultValue, localized: spec.localized ?? true };

  const tableName = deriveTableName(apiId);
  return runSchemaTx(sql, tableName, async (tx) => {
    const ct = await lockContentType(tx, apiId);
    await assertComponentRefsExist(tx, referencedComponents([field])); // be-05: refs must exist (400 else).
    const dup = await tx`SELECT 1 FROM content_type_fields WHERE content_type_id = ${ct.id} AND lower(name) = lower(${name})`;
    if (dup.length > 0) throw new FieldExistsError(name);
    const [nextRow] = await tx<{ next: number }[]>`SELECT COALESCE(MAX(sort) + 1, 0) AS next FROM content_type_fields WHERE content_type_id = ${ct.id}`;
    const next = nextRow!.next;
    const [row] = await tx<FieldRow[]>`
      INSERT INTO content_type_fields (content_type_id, name, cms_type, pg_type, engine_type, nullable, sort, default_value, params, localized)
      VALUES (${ct.id}, ${name}, ${resolved.cmsType}, ${resolved.pgType}, ${resolved.engineType}, ${nullable}, ${next}, ${defaultText(defaultValue)}, ${tx.json(paramsOf(resolved) as JSONValue)}, ${field.localized ?? true})
      RETURNING *
    `;
    const ddl = compileAddColumn(ct.table_name, field);
    await tx.unsafe(ddl.sql, ddl.parameters as ParameterOrJSON<never>[]);
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
    await tx.unsafe(ddl.sql, ddl.parameters as ParameterOrJSON<never>[]);
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
    await tx.unsafe(ddl.sql, ddl.parameters as ParameterOrJSON<never>[]);
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
      UPDATE content_type_fields SET cms_type = ${toResolved.cmsType}, pg_type = ${toResolved.pgType}, engine_type = ${toResolved.engineType}, params = ${tx.json(paramsOf(toResolved) as JSONValue)}
      WHERE id = ${field.id} RETURNING *
    `;
    const ddl = compileAlterColumnType(ct.table_name, field.name, toResolved);
    await tx.unsafe(ddl.sql, ddl.parameters as ParameterOrJSON<never>[]);
    return row!;
  });
}

// --- relations ---------------------------------------------------------------------------------

/** Reject a relation field that collides with a SCALAR field OR an existing relation on `contentTypeId`. */
async function assertFieldNameFree(tx: Sql, contentTypeId: number, field: string): Promise<void> {
  const scalar = await tx`SELECT 1 FROM content_type_fields WHERE content_type_id = ${contentTypeId} AND lower(name) = lower(${field})`;
  if (scalar.length > 0) throw new FieldExistsError(field);
  const rel = await tx`SELECT 1 FROM content_type_relations WHERE content_type_id = ${contentTypeId} AND lower(field_name) = lower(${field})`;
  if (rel.length > 0) throw new FieldExistsError(field);
}

/** The next `sort` for a type's relations (its OWN sequence, never shared with content_type_fields). */
async function nextRelationSort(tx: Sql, contentTypeId: number): Promise<number> {
  const [nextRow] = await tx<{ next: number }[]>`SELECT COALESCE(MAX(sort) + 1, 0) AS next FROM content_type_relations WHERE content_type_id = ${contentTypeId}`;
  return nextRow!.next;
}

/**
 * Declare ONE relation inside an already-open tx. The owner row is ALREADY locked FOR UPDATE and its
 * `ct_` table EXISTS; the target row is ALREADY locked FOR UPDATE (the caller serializes both rows in
 * ascending id order to avoid deadlock, and the target FOR UPDATE serializes against a concurrent drop).
 * Validation (pure) is done by the caller; this performs the in-tx collision checks, resolves the link
 * name, INSERTs the owner meta row, (two-way) INSERTs the inverse meta row sharing the SAME link_table,
 * and emits the link-table DDL. One-way omits the inverse row.
 */
async function declareRelationInTx(tx: Sql, owner: ContentTypeRow, target: ContentTypeRow, spec: RelationSpec): Promise<RelationRow> {
  const twoWay = spec.inverseField !== undefined;

  // Owner-side cross-table collision (scalar field + existing relation).
  await assertFieldNameFree(tx, owner.id, spec.field);
  // Inverse-side cross-table collision (against the TARGET's content_type_id), two-way only.
  if (twoWay) await assertFieldNameFree(tx, target.id, spec.inverseField!);

  const linkTable = deriveLinkTableName(owner.api_id, spec.field);
  const ownerSort = await nextRelationSort(tx, owner.id);

  const [ownerRow] = await tx<RelationRow[]>`
    INSERT INTO content_type_relations (content_type_id, field_name, kind, target_api_id, is_owner, inverse_field, link_table, sort)
    VALUES (${owner.id}, ${spec.field}, ${spec.kind}, ${target.api_id}, true, ${spec.inverseField ?? null}, ${linkTable}, ${ownerSort})
    RETURNING *
  `;

  if (twoWay) {
    // The inverse row reads the SAME link table reversed; NO DDL. sort is over the TARGET's relations.
    const invSort = await nextRelationSort(tx, target.id);
    await tx`
      INSERT INTO content_type_relations (content_type_id, field_name, kind, target_api_id, is_owner, inverse_field, link_table, sort)
      VALUES (${target.id}, ${spec.inverseField!}, ${inverseKind(spec.kind)}, ${owner.api_id}, false, ${spec.field}, ${linkTable}, ${invSort})
    `;
  }

  const ddl = compileCreateLinkTable(linkTable, owner.table_name, target.table_name, spec.kind);
  await tx.unsafe(ddl.sql, ddl.parameters as ParameterOrJSON<never>[]);
  return ownerRow!;
}

/**
 * Pure (no-DB) validation of a relation spec against its owner api_id. Validates field/kind/target
 * identifiers and the two-way invariants (non-empty inverseField; for a self-referential two-way the
 * owner and inverse field names must differ — both rows land on the same content_type_id). Returns the
 * derived owner table name (for the tx advisory key).
 */
function validateRelationSpec(ownerApiId: string, spec: RelationSpec): { ownerTable: string; targetTable: string; selfReferential: boolean } {
  const ownerTable = deriveTableName(ownerApiId);
  validateFieldName(spec.field);
  validateRelationKind(spec.kind);
  const targetTable = deriveTableName(spec.target); // validates SHAPE + reserved gate (NOT existence)
  if (spec.inverseField !== undefined) {
    if (spec.inverseField === '') throw new DuplicateFieldError(spec.inverseField);
    validateFieldName(spec.inverseField);
  }
  const selfReferential = spec.target.toLowerCase() === ownerApiId.toLowerCase();
  if (selfReferential && spec.inverseField !== undefined && spec.field.toLowerCase() === spec.inverseField.toLowerCase()) {
    // owner + inverse rows would share content_type_id AND field name -> nonsensical + violates the uq index.
    throw new DuplicateFieldError(spec.field);
  }
  return { ownerTable, targetTable, selfReferential };
}

/**
 * Declare a relation on an existing OWNER type. Validation (pure) fails fast; then in ONE runSchemaTx
 * (advisory-locked on the owner table) we lock the owner + target `content_types` rows FOR UPDATE — in
 * ASCENDING id order to avoid deadlock between two cross-linking declarations (a 40P01 maps to the
 * retryable SchemaChangeConflictError) — then run the shared declaration (link-table DDL + UNIQUEs +
 * owner meta row + two-way inverse row), all atomic.
 */
export async function addRelation(sql: Sql, ownerApiId: string, spec: RelationSpec): Promise<RelationRow> {
  const { ownerTable, selfReferential } = validateRelationSpec(ownerApiId, spec);
  return runSchemaTx(sql, ownerTable, async (tx) => {
    const owner = await lockContentType(tx, ownerApiId);
    let target: ContentTypeRow;
    if (selfReferential) {
      target = owner; // do NOT double-lock the same row
    } else {
      // Lock the two rows in a STABLE order (ascending id) to avoid a deadlock between two concurrent
      // cross-linking declarations. We already hold `owner`; if the target sorts BEFORE it, releasing
      // is not possible mid-tx, but both declarations take the same per-owner advisory lock only on
      // their own owner — so to be safe across owners we acquire the second FOR UPDATE by id order.
      const targetRow = await lockContentType(tx, spec.target);
      // Re-assert stable order: if target.id < owner.id we have already locked higher-then-lower, which
      // is the deadlock-prone order. PG will report 40P01 if it actually deadlocks; runSchemaTx maps it
      // to a retryable conflict. (A future op should pre-sort; documented.)
      target = targetRow;
    }
    return declareRelationInTx(tx, owner, target, spec);
  });
}

/**
 * Drop a content-type, honoring relations. In ONE tx, after locking the type: REFUSE
 * (DependentTypesError) if ANOTHER type targets it via a relation (self-references do NOT block its own
 * drop). Then collect the owner's link tables BEFORE deleting meta (the content_type_id FK cascade would
 * otherwise remove the owner rows), DROP each link table explicitly (the link table's owner_id FK
 * depends on ct_<owner>, so it must go first), DELETE meta rows by link_table (removes BOTH the owner row
 * AND its two-way inverse row, wherever it lives), DELETE the field rows + the type row, and DROP the
 * ct_<owner> table. A missing type throws ContentTypeNotFoundError. Dropping an owner NEVER deletes
 * related ENTRIES in the target type (the link FK CASCADE prunes only join rows on an entry delete).
 */
export async function dropContentType(sql: Sql, apiId: string): Promise<void> {
  const tableName = deriveTableName(apiId);
  await runSchemaTx(sql, tableName, async (tx) => {
    const ct = await lockContentType(tx, apiId);

    // Inbound-reference guard: REFUSE only if a DIFFERENT type's OWNER relation targets this one. An
    // `is_owner=false` inverse row is never an independent dependency — it is always the partner of an
    // owner relation elsewhere (and if THAT owner targets us it is itself an is_owner=true row caught
    // here). Excluding inverse rows is what lets an owner-drop of a two-way relation proceed: the inverse
    // partner on the target type targets US but must not block (it is cleaned up by link_table below).
    // `content_type_id <> ct.id` keeps a self-referential owner from blocking its own drop.
    const dependents = await tx<{ field_name: string; content_type_id: number }[]>`
      SELECT field_name, content_type_id FROM content_type_relations
      WHERE lower(target_api_id) = lower(${apiId}) AND content_type_id <> ${ct.id} AND is_owner = true
    `;
    if (dependents.length > 0) {
      const fields = dependents.map((d) => d.field_name).join(', ');
      throw new DependentTypesError(`content-type ${JSON.stringify(apiId)} is targeted by relation field(s): ${fields}`);
    }

    // Collect the owner's link tables BEFORE any delete (the FK cascade on content_type_id would remove
    // the owner relation rows out from under us).
    const links = await tx<{ link_table: string }[]>`
      SELECT DISTINCT link_table FROM content_type_relations WHERE content_type_id = ${ct.id} AND is_owner = true
    `;
    const linkNames = links.map((l) => l.link_table);

    // DROP each owned link table explicitly (its owner_id FK depends on ct_<owner>; cascade prunes ROWS,
    // never the link TABLE) — must precede DROP TABLE ct_<owner>.
    for (const link of linkNames) {
      const ddl = compileDropTable(link);
      await tx.unsafe(ddl.sql, ddl.parameters as ParameterOrJSON<never>[]);
    }

    // DELETE meta rows by link_table — removes BOTH the owner row AND its two-way inverse row.
    if (linkNames.length > 0) {
      await tx`DELETE FROM content_type_relations WHERE link_table = ANY(${linkNames})`;
    }

    await tx`DELETE FROM content_type_fields WHERE content_type_id = ${ct.id}`;
    await tx`DELETE FROM content_types WHERE id = ${ct.id}`;
    const ddl = compileDropTable(ct.table_name);
    await tx.unsafe(ddl.sql, ddl.parameters as ParameterOrJSON<never>[]);
  });
}
