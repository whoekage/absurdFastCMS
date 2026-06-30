import type { ModuleRow, FieldRow, RelationRow, FieldSpec } from '../module.fields.ts';
import { resolveFields } from '../module.fields.ts';
import { resolveComponentFields, type ComponentTypeRow, type ComponentFieldRow } from '../component.fields.ts';
import { deriveTableName, deriveLinkTableName, inverseKind } from '../ddl.ts';
import type { Schema, ComponentSchema, FieldSchema } from './model.ts';
import { AppError } from '../../errors/app-error.ts';

/**
 * The ADAPTER from the files-first schema model to the meta ROW shapes the {@link Registry} already
 * consumes ({@link ModuleRow}/{@link FieldRow}/{@link RelationRow}). This is the seam that lets
 * `Registry.fromSchemas` reuse the battle-tested `buildDef` verbatim: schema → rows → buildDef.
 *
 * The forward direction reuses the EXACT `resolveFields` the meta writer (`createContentType`) uses, so a
 * field resolves to the SAME `{ type, pg_type, engine_type, params, default_value }` whether it came
 * from a file or from the `content_type_fields` table — that equivalence is the S1 oracle.
 *
 * SYNTHETIC IDS: `buildDef`/`buildUserField` never read a row's numeric `id`/`content_type_id` (they key
 * off `name` + field `name`), so the file path supplies index-based placeholders. The STABLE STRING ids
 * (`ct_…`/`f_…`) live only in the file + drive the S3 diff — they are intentionally absent from the rows.
 *
 * The REVERSE direction (`rowsToSchema`, meta → file) is deferred to S5 (the Builder's meta→file export);
 * S1's compat shim builds defs from meta rows directly, so it is not needed yet.
 */

export class SchemaAdaptError extends AppError {
  readonly module: string;
  constructor(module: string, reason: string) {
    super('db.schema.adapt', { name: module, reason });
    this.name = 'SchemaAdaptError';
    this.module = module;
  }
}

// Placeholder numeric ids: buildDef/buildUserField ignore them (identity is name + field name). Kept 0
// so a stray reader sees an obviously-synthetic value rather than a plausible real DB id.
const SYNTHETIC_ID = 0;

/**
 * Project a schema's fields to the {@link FieldSpec}[] the meta writer (`createContentType`) + the catalog
 * (`resolveFields`) consume. Each `options`/`localized` is set ONLY when present (exactOptionalPropertyTypes
 * forbids an explicit `undefined` on an optional key). Shared by {@link schemaToRows} (registry build) and
 * the file-driven seed (table materialization). Relations are not fields and are not projected here.
 */
export function fieldSchemaToSpec(f: FieldSchema): FieldSpec {
  const spec: FieldSpec = { name: f.name, type: f.type };
  if (f.options !== undefined) spec.options = f.options;
  if (f.localized !== undefined) spec.localized = f.localized;
  return spec;
}

function schemaToFieldSpecs(schema: Schema): FieldSpec[] {
  return schema.fields.map(fieldSchemaToSpec);
}

/** Stringify a bound default for the `default_value` text column — mirrors the meta writer's `defaultText`. */
function defaultText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Convert a {@link Schema} into the meta rows `buildDef` expects. Resolves every field through
 * the catalog (via `resolveFields`) so the file path is byte-for-byte what the meta writer would store.
 *
 * RELATIONS are NOT produced here: a relation's identity spans TWO types (an owner row on the owner + a
 * synthesized inverse row on the target), so one schema in isolation can't build them. {@link relationRowsByType}
 * does the cross-type pass; {@link schemaToRows} returns only the ct + scalar field rows.
 */
export function schemaToRows(schema: Schema): { ct: ModuleRow; fieldRows: FieldRow[] } {
  const resolved = resolveFields(schemaToFieldSpecs(schema));
  const epoch = new Date(0); // synthetic created_at/updated_at — buildDef does not read them.
  const ct: ModuleRow = {
    id: SYNTHETIC_ID,
    name: schema.name,
    table_name: deriveTableName(schema.name),
    created_at: epoch,
    updated_at: epoch,
    draft_publish: schema.options?.draftAndPublish ?? false,
    i18n: schema.options?.i18n ?? false,
    single: schema.options?.single ?? false,
  };
  const fieldRows: FieldRow[] = resolved.map((rf, i) => ({
    id: i,
    content_type_id: SYNTHETIC_ID,
    name: rf.name,
    type: rf.resolved.type,
    pg_type: rf.resolved.pgType,
    engine_type: rf.resolved.engineType,
    nullable: rf.nullable,
    sort: i,
    default_value: defaultText(rf.defaultValue),
    params: rf.resolved.params,
    localized: rf.localized ?? true,
  }));
  return { ct, fieldRows };
}

/**
 * Build every {@link RelationRow}, keyed by the owning type's STABLE id, across the WHOLE catalog. Each
 * owner relation declared in a schema produces an OWNER row (is_owner=true) on the owner type and, when
 * two-way (`inverseField` set), a synthesized INVERSE row (is_owner=false) on the TARGET type — both
 * sharing one derived link table. This mirrors the meta writer's `declareRelationInTx` (owner row + inverse
 * row + one link table), so a relation-bearing def built from files is identical to the meta-built one.
 *
 * The inverse side lives on the target, which is why this is a cross-type pass and not part of
 * `schemaToRows`. A dangling target (relation points at an unknown type) fails LOUD.
 */
export function relationRowsByType(schemas: Schema[]): Map<string, RelationRow[]> {
  const byName = new Map<string, Schema>();
  for (const s of schemas) byName.set(s.name.toLowerCase(), s);
  const out = new Map<string, RelationRow[]>();
  const epoch = new Date(0);
  const push = (typeId: string, row: Omit<RelationRow, 'sort'>): void => {
    const list = out.get(typeId) ?? [];
    list.push({ ...row, sort: list.length });
    out.set(typeId, list);
  };
  for (const owner of schemas) {
    for (const rel of owner.relations ?? []) {
      // The target must exist for EITHER direction — the link-table FK references its ct_ table (mirrors
      // the meta writer's lockContentType for both one-way and two-way).
      const target = byName.get(rel.target.toLowerCase());
      if (!target) throw new SchemaAdaptError(owner.name, `relation "${rel.field}" targets unknown type "${rel.target}"`);
      const linkTable = deriveLinkTableName(owner.name, rel.field);
      push(owner.id, {
        id: 0, content_type_id: 0, field_name: rel.field, kind: rel.kind, target_name: rel.target,
        is_owner: true, inverse_field: rel.inverseField ?? null, link_table: linkTable, created_at: epoch, updated_at: epoch,
      });
      if (rel.inverseField !== undefined) {
        push(target.id, {
          id: 0, content_type_id: 0, field_name: rel.inverseField, kind: inverseKind(rel.kind), target_name: owner.name,
          is_owner: false, inverse_field: rel.field, link_table: linkTable, created_at: epoch, updated_at: epoch,
        });
      }
    }
  }
  return out;
}

/**
 * Convert a {@link ComponentSchema} into the component meta rows `buildComponentDef` expects. Resolves
 * every field through the SAME `resolveComponentFields` the meta writer uses (which allows a `relation`
 * inline-ref field, unlike a module field). Synthetic numeric ids (buildComponentDef keys off the
 * field name). A component has no physical table → these rows feed the registry only, never any DDL.
 */
export function componentSchemaToRows(schema: ComponentSchema): { cmp: ComponentTypeRow; fieldRows: ComponentFieldRow[] } {
  const resolved = resolveComponentFields(schema.fields.map(fieldSchemaToSpec));
  const epoch = new Date(0);
  const cmp: ComponentTypeRow = { id: SYNTHETIC_ID, name: schema.name, created_at: epoch, updated_at: epoch };
  const fieldRows: ComponentFieldRow[] = resolved.map((rf, i) => ({
    id: i,
    component_type_id: SYNTHETIC_ID,
    name: rf.name,
    type: rf.type,
    params: rf.params,
    nullable: rf.nullable,
    sort: i,
  }));
  return { cmp, fieldRows };
}
