import type { Sql, JSONValue } from 'postgres';
import {
  resolveType,
  resolveComponentField,
  isComponentFieldKind,
  type CmsType,
  type ComponentFieldKind,
  type FieldOptions,
  type ResolvedType,
} from './type.catalog.ts';
import {
  validateIdentifier,
  validateFieldName,
  runSchemaTx,
  DuplicateFieldError,
  FieldExistsError,
  FieldNotFoundError,
  ReservedTableNameError,
  TABLE_PREFIX,
  RESERVED_TABLE_NAMES,
} from './ddl.ts';

/**
 * be-05 — the COMPONENT META REPOSITORY: read/write `component_types` + `component_type_fields`. A
 * component type is a reusable FIELD GROUP that is PURE META — it has NO physical ct_ table, NO link
 * tables, and NO engine presence (the columnar engine is built only from content_types). So unlike
 * {@link import('./content-type.repository.ts')}, NO operation here emits any DDL: a create/addField is
 * just INSERTs, a drop is just DELETEs (FK CASCADE removes the field rows). Every mutation still runs in
 * ONE atomic {@link runSchemaTx} so a validation failure rolls back cleanly.
 *
 * A component field's spec lives entirely in `cms_type` + `params` (mirroring content_type_fields, MINUS
 * pg_type/engine_type — a component field never becomes a physical column). A field may be a SCALAR
 * ({@link CmsType}), a MEDIA ref, or a NESTED component / dynamiczone ({@link ComponentFieldKind}).
 *
 * CYCLE SAFETY: a component reference graph (component A contains B contains A) would make a write
 * infinitely recurse, so a reference cycle is FORBIDDEN at DEFINITION time (a DFS over the existing
 * reference graph from each newly-referenced component back to the component being defined). The runtime
 * recursive-write validator (next phase) keeps a depth cap as defense-in-depth.
 */

/** A `component_types` row (snake_case as stored). */
export interface ComponentTypeRow {
  id: number;
  api_id: string;
  created_at: Date;
  updated_at: Date;
}

/** A `component_type_fields` row (snake_case as stored). */
export interface ComponentFieldRow {
  id: number;
  component_type_id: number;
  name: string;
  cms_type: string;
  params: Record<string, unknown>;
  nullable: boolean;
  sort: number;
}

/** A field the caller wants on a component type: a scalar CmsType, media, or a nested component kind. */
export interface ComponentFieldSpec {
  name: string;
  cmsType: CmsType | ComponentFieldKind;
  options?: FieldOptions | undefined;
}

// --- typed errors (deterministic; never leak a raw PG error) -----------------------------------

export class ComponentTypeExistsError extends Error {
  readonly apiId: string;
  constructor(apiId: string) {
    super(`component-type ${JSON.stringify(apiId)} already exists`);
    this.name = 'ComponentTypeExistsError';
    this.apiId = apiId;
  }
}
export class ComponentTypeNotFoundError extends Error {
  readonly apiId: string;
  constructor(apiId: string) {
    super(`component-type ${JSON.stringify(apiId)} not found`);
    this.name = 'ComponentTypeNotFoundError';
    this.apiId = apiId;
  }
}
export class ComponentCycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComponentCycleError';
  }
}
export class ComponentInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComponentInUseError';
  }
}
/** be-05b: thrown when a component's relation field points at a content-type that does not exist. */
export class RelationTargetNotFoundError extends Error {
  readonly target: string;
  constructor(target: string) {
    super(`relation target content-type ${JSON.stringify(target)} not found`);
    this.name = 'RelationTargetNotFoundError';
    this.target = target;
  }
}

// --- api_id validation -------------------------------------------------------------------------

/**
 * Validate a component api_id: a legal identifier, not `_`-leading, not `ct_`-leading (those belong to
 * content-type tables), and not a reserved table name. A component has NO physical table, but we keep the
 * SAME namespace discipline as content-type api_ids so a component + content-type never collide by api_id
 * in a downstream reference.
 */
export function validateComponentApiId(apiId: string): string {
  const id = validateIdentifier(apiId);
  const lower = id.toLowerCase();
  if (id.startsWith('_')) throw new ReservedTableNameError(id);
  if (lower.startsWith(TABLE_PREFIX)) throw new ReservedTableNameError(id);
  if (RESERVED_TABLE_NAMES.has(lower)) throw new ReservedTableNameError(id);
  return id;
}

// --- field resolution (no DB) ------------------------------------------------------------------

/** A resolved component field ready to INSERT: validated name + cms_type + params + nullable. */
interface ResolvedComponentField {
  name: string;
  cmsType: string;
  params: Record<string, unknown>;
  nullable: boolean;
}

/**
 * Validate + resolve a batch of component-field specs (names unique CI; each type resolves; a component
 * kind resolves to its `{kind, component|components}` params). Renders NO SQL, touches NO connection.
 */
function resolveComponentFields(specs: ComponentFieldSpec[]): ResolvedComponentField[] {
  const seen = new Set<string>();
  const out: ResolvedComponentField[] = [];
  for (const spec of specs) {
    const name = validateFieldName(spec.name);
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw new DuplicateFieldError(name);
    seen.add(lower);
    const resolved: ResolvedType = isComponentFieldKind(spec.cmsType)
      ? resolveComponentField(spec.cmsType, spec.options)
      : resolveType(spec.cmsType, spec.options);
    out.push({ name, cmsType: resolved.cmsType as string, params: resolved.params, nullable: spec.options?.nullable ?? true });
  }
  return out;
}

/** Collect the component api_id(s) referenced by a batch of resolved component fields. */
function referencedComponents(fields: ResolvedComponentField[]): string[] {
  const refs = new Set<string>();
  for (const f of fields) {
    if (typeof f.params['component'] === 'string') refs.add(f.params['component'] as string);
    if (Array.isArray(f.params['components'])) for (const c of f.params['components'] as string[]) refs.add(c);
  }
  return [...refs];
}

/** be-05b: collect the relation TARGET content-type api_id(s) referenced by a batch of resolved fields. */
function referencedTargets(fields: ResolvedComponentField[]): string[] {
  const refs = new Set<string>();
  for (const f of fields) {
    if (f.params['kind'] === 'relation' && typeof f.params['target'] === 'string') refs.add(f.params['target'] as string);
  }
  return [...refs];
}

// --- pure reads --------------------------------------------------------------------------------

/** All component-types, ordered by id. */
export async function listComponentTypes(sql: Sql): Promise<ComponentTypeRow[]> {
  return sql<ComponentTypeRow[]>`SELECT * FROM component_types ORDER BY id`;
}

/** One component-type by api_id (case-insensitive), or null. */
export async function getComponentType(sql: Sql, apiId: string): Promise<ComponentTypeRow | null> {
  const rows = await sql<ComponentTypeRow[]>`SELECT * FROM component_types WHERE lower(api_id) = lower(${apiId})`;
  return rows[0] ?? null;
}

/** The fields of a component-type, in `sort` order. */
export async function getComponentFields(sql: Sql, componentTypeId: number): Promise<ComponentFieldRow[]> {
  return sql<ComponentFieldRow[]>`SELECT * FROM component_type_fields WHERE component_type_id = ${componentTypeId} ORDER BY sort`;
}

// --- referenced-component existence gate (used by BOTH repos) ----------------------------------

/**
 * Assert every api_id in `refs` names an existing component type, else throw {@link ComponentTypeNotFoundError}
 * for the FIRST missing one. Empty input is a no-op (no query). Runs on the caller's `sql`/`tx` so an
 * attaching content-type/component create can gate inside its own schema tx (a dangling ref rolls back).
 */
export async function assertComponentRefsExist(sql: Sql, refs: string[]): Promise<void> {
  if (refs.length === 0) return;
  const unique = [...new Set(refs.map((r) => r.toLowerCase()))];
  const rows = await sql<{ api_id: string }[]>`SELECT lower(api_id) AS api_id FROM component_types WHERE lower(api_id) = ANY(${unique})`;
  const present = new Set(rows.map((r) => r.api_id));
  for (const ref of refs) {
    if (!present.has(ref.toLowerCase())) throw new ComponentTypeNotFoundError(ref);
  }
}

/**
 * be-05b: assert every relation-field TARGET in `targets` names an existing CONTENT-TYPE (not a component),
 * else throw {@link RelationTargetNotFoundError} for the FIRST missing one. Mirror of
 * {@link assertComponentRefsExist} but against `content_types`. Empty input is a no-op (no query). Runs on
 * the caller's tx so a dangling target rolls the component-type create/addField back inside its schema tx.
 */
export async function assertTargetTypesExist(sql: Sql, targets: string[]): Promise<void> {
  if (targets.length === 0) return;
  const unique = [...new Set(targets.map((t) => t.toLowerCase()))];
  const rows = await sql<{ api_id: string }[]>`SELECT lower(api_id) AS api_id FROM content_types WHERE lower(api_id) = ANY(${unique})`;
  const present = new Set(rows.map((r) => r.api_id));
  for (const t of targets) {
    if (!present.has(t.toLowerCase())) throw new RelationTargetNotFoundError(t);
  }
}

// --- cycle detection ---------------------------------------------------------------------------

/**
 * Reject a reference cycle. `definedApiId` is the component being created/extended; `newRefs` are the
 * component api_id(s) it is about to reference. A cycle exists iff some `newRef` can (transitively, via
 * the EXISTING reference graph in `component_type_fields`) reach `definedApiId` — or a `newRef` IS
 * `definedApiId` (a direct self-reference). DFS over the graph; visited-set bounds it on any pre-existing
 * cycle (there should be none, since each prior edge was gated the same way). All comparisons CI.
 */
async function assertNoComponentCycle(tx: Sql, definedApiId: string, newRefs: string[]): Promise<void> {
  const target = definedApiId.toLowerCase();
  const visited = new Set<string>();
  const stack = newRefs.map((r) => r.toLowerCase());
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === target) {
      throw new ComponentCycleError(`component "${definedApiId}" reference forms a cycle (reaches itself via "${cur}")`);
    }
    if (visited.has(cur)) continue;
    visited.add(cur);
    // Pull every component api_id that `cur` references (component/component-repeatable -> params.component,
    // dynamiczone -> params.components[]) out of its field rows, in ONE query, and push onto the stack.
    const rows = await tx<{ params: Record<string, unknown> }[]>`
      SELECT f.params FROM component_type_fields f
      JOIN component_types t ON t.id = f.component_type_id
      WHERE lower(t.api_id) = ${cur}
    `;
    for (const { params } of rows) {
      if (typeof params['component'] === 'string') stack.push((params['component'] as string).toLowerCase());
      if (Array.isArray(params['components'])) for (const c of params['components'] as string[]) stack.push(c.toLowerCase());
    }
  }
}

// --- high-level operations ---------------------------------------------------------------------

/**
 * Create a component type: validate the api_id + every field spec, then in ONE tx INSERT component_types
 * (RETURNING id) -> INSERT component_type_fields (eager `sort`). A pre-check rejects an existing api_id
 * BEFORE the insert; the DB UNIQUE on lower(api_id) is the atomic backstop. Referenced components must
 * exist AND must not form a cycle with this new component. NO DDL (meta-only).
 */
export async function createComponentType(sql: Sql, params: { apiId: string; fields: ComponentFieldSpec[] }): Promise<ComponentTypeRow> {
  const apiId = validateComponentApiId(params.apiId);
  const fields = resolveComponentFields(params.fields);
  const refs = referencedComponents(fields);
  const targets = referencedTargets(fields);

  const existing = await getComponentType(sql, apiId);
  if (existing !== null) throw new ComponentTypeExistsError(apiId);

  return runSchemaTx(sql, `component:${apiId}`, async (tx) => {
    await assertComponentRefsExist(tx, refs); // every referenced component must already exist (400 else).
    await assertTargetTypesExist(tx, targets); // be-05b: every relation target content-type must exist (400 else).
    await assertNoComponentCycle(tx, apiId, refs); // forbid a definition-time reference cycle (400 else).
    const [cmp] = await tx<ComponentTypeRow[]>`INSERT INTO component_types (api_id) VALUES (${apiId}) RETURNING *`;
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]!;
      await tx`
        INSERT INTO component_type_fields (component_type_id, name, cms_type, params, nullable, sort)
        VALUES (${cmp!.id}, ${f.name}, ${f.cmsType}, ${tx.json(f.params as JSONValue)}, ${f.nullable}, ${i})
      `;
    }
    return cmp!;
  });
}

/** Look up the component-type row FOR UPDATE inside a tx, or throw ComponentTypeNotFoundError. */
async function lockComponentType(tx: Sql, apiId: string): Promise<ComponentTypeRow> {
  const rows = await tx<ComponentTypeRow[]>`SELECT * FROM component_types WHERE lower(api_id) = lower(${apiId}) FOR UPDATE`;
  if (rows.length === 0) throw new ComponentTypeNotFoundError(apiId);
  return rows[0]!;
}

/**
 * Add a field to an existing component type: in ONE tx lock the row, reject a duplicate (CI), append at
 * `max(sort)+1`, gate referenced-component existence + cycle, INSERT the meta row. NO DDL.
 */
export async function addComponentField(sql: Sql, apiId: string, spec: ComponentFieldSpec): Promise<ComponentFieldRow> {
  const [field] = resolveComponentFields([spec]);
  const refs = referencedComponents([field!]);
  const targets = referencedTargets([field!]);
  return runSchemaTx(sql, `component:${apiId}`, async (tx) => {
    const cmp = await lockComponentType(tx, apiId);
    await assertComponentRefsExist(tx, refs);
    await assertTargetTypesExist(tx, targets); // be-05b: relation target content-type must exist (400 else).
    await assertNoComponentCycle(tx, cmp.api_id, refs);
    const dup = await tx`SELECT 1 FROM component_type_fields WHERE component_type_id = ${cmp.id} AND lower(name) = lower(${field!.name})`;
    if (dup.length > 0) throw new FieldExistsError(field!.name);
    const [nextRow] = await tx<{ next: number }[]>`SELECT COALESCE(MAX(sort) + 1, 0) AS next FROM component_type_fields WHERE component_type_id = ${cmp.id}`;
    const next = nextRow!.next;
    const [row] = await tx<ComponentFieldRow[]>`
      INSERT INTO component_type_fields (component_type_id, name, cms_type, params, nullable, sort)
      VALUES (${cmp.id}, ${field!.name}, ${field!.cmsType}, ${tx.json(field!.params as JSONValue)}, ${field!.nullable}, ${next})
      RETURNING *
    `;
    return row!;
  });
}

/** Drop a field from a component type: meta DELETE in ONE tx. A missing field throws FieldNotFoundError. */
export async function dropComponentField(sql: Sql, apiId: string, name: string): Promise<void> {
  validateFieldName(name);
  await runSchemaTx(sql, `component:${apiId}`, async (tx) => {
    const cmp = await lockComponentType(tx, apiId);
    const rows = await tx<ComponentFieldRow[]>`SELECT * FROM component_type_fields WHERE component_type_id = ${cmp.id} AND lower(name) = lower(${name})`;
    if (rows.length === 0) throw new FieldNotFoundError(name);
    await tx`DELETE FROM component_type_fields WHERE id = ${rows[0]!.id}`;
  });
}

/**
 * Drop a component type. REFUSE ({@link ComponentInUseError}) if it is referenced by a CONTENT-TYPE field
 * OR by ANOTHER component's field (scan both `content_type_fields.params` and `component_type_fields.params`
 * for `{component: apiId}` / `{components:[...apiId...]}`). Then DELETE the type row (FK CASCADE removes its
 * own field rows). NO DDL. A missing type throws ComponentTypeNotFoundError.
 */
export async function dropComponentType(sql: Sql, apiId: string): Promise<void> {
  await runSchemaTx(sql, `component:${apiId}`, async (tx) => {
    const cmp = await lockComponentType(tx, apiId);
    const lower = cmp.api_id.toLowerCase();
    // Inbound-reference scan across BOTH catalogs. `params->>'component'` matches a single/repeatable ref;
    // the jsonb `?` / array containment matches a dynamiczone allowed-set member. CI via lower().
    const ctRefs = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM content_type_fields
      WHERE lower(params->>'component') = ${lower}
         OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE jsonb_typeof(params->'components') WHEN 'array' THEN params->'components' ELSE '[]'::jsonb END) e WHERE lower(e) = ${lower})
    `;
    const cmpRefs = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM component_type_fields f
      WHERE f.component_type_id <> ${cmp.id}
        AND (lower(f.params->>'component') = ${lower}
         OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE jsonb_typeof(f.params->'components') WHEN 'array' THEN f.params->'components' ELSE '[]'::jsonb END) e WHERE lower(e) = ${lower}))
    `;
    if ((ctRefs[0]?.n ?? 0) > 0 || (cmpRefs[0]?.n ?? 0) > 0) {
      throw new ComponentInUseError(`component-type ${JSON.stringify(cmp.api_id)} is still referenced by a content-type or component field`);
    }
    await tx`DELETE FROM component_types WHERE id = ${cmp.id}`;
  });
}
