import type { ContentTypeRow, FieldRow, RelationRow, FieldSpec } from '../content-type.repository.ts';
import { resolveFields } from '../content-type.repository.ts';
import { deriveTableName } from '../ddl.ts';
import type { ContentTypeSchema, FieldSchema } from './model.ts';

/**
 * The ADAPTER from the files-first schema model to the meta ROW shapes the {@link Registry} already
 * consumes ({@link ContentTypeRow}/{@link FieldRow}/{@link RelationRow}). This is the seam that lets
 * `Registry.fromSchemas` reuse the battle-tested `buildDef` verbatim: schema → rows → buildDef.
 *
 * The forward direction reuses the EXACT `resolveFields` the meta writer (`createContentType`) uses, so a
 * field resolves to the SAME `{ cms_type, pg_type, engine_type, params, default_value }` whether it came
 * from a file or from the `content_type_fields` table — that equivalence is the S1 oracle.
 *
 * SYNTHETIC IDS: `buildDef`/`buildUserField` never read a row's numeric `id`/`content_type_id` (they key
 * off `api_id` + field `name`), so the file path supplies index-based placeholders. The STABLE STRING ids
 * (`ct_…`/`f_…`) live only in the file + drive the S3 diff — they are intentionally absent from the rows.
 *
 * The REVERSE direction (`rowsToSchema`, meta → file) is deferred to S5 (the Builder's meta→file export);
 * S1's compat shim builds defs from meta rows directly, so it is not needed yet.
 */

export class SchemaAdaptError extends Error {
  readonly apiId: string;
  constructor(apiId: string, reason: string) {
    super(`content-type "${apiId}": ${reason}`);
    this.name = 'SchemaAdaptError';
    this.apiId = apiId;
  }
}

// Placeholder numeric ids: buildDef/buildUserField ignore them (identity is api_id + field name). Kept 0
// so a stray reader sees an obviously-synthetic value rather than a plausible real DB id.
const SYNTHETIC_ID = 0;

/**
 * Project a schema's fields to the {@link FieldSpec}[] the meta writer (`createContentType`) + the catalog
 * (`resolveFields`) consume. Each `options`/`localized` is set ONLY when present (exactOptionalPropertyTypes
 * forbids an explicit `undefined` on an optional key). Shared by {@link schemaToRows} (registry build) and
 * the file-driven seed (table materialization). Relations are not fields and are not projected here.
 */
export function fieldSchemaToSpec(f: FieldSchema): FieldSpec {
  const spec: FieldSpec = { name: f.name, cmsType: f.type };
  if (f.options !== undefined) spec.options = f.options;
  if (f.localized !== undefined) spec.localized = f.localized;
  return spec;
}

export function schemaToFieldSpecs(schema: ContentTypeSchema): FieldSpec[] {
  return schema.fields.map(fieldSchemaToSpec);
}

/** Stringify a bound default for the `default_value` text column — mirrors the meta writer's `defaultText`. */
function defaultText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Convert a {@link ContentTypeSchema} into the meta rows `buildDef` expects. Resolves every field through
 * the catalog (via `resolveFields`) so the file path is byte-for-byte what the meta writer would store.
 *
 * RELATIONS are DEFERRED to a later slice: the demo seed (article) has none, and the S1 compat shim still
 * serves relation-bearing types from meta. A schema that declares `relations` fails LOUD here rather than
 * silently dropping them.
 */
export function schemaToRows(schema: ContentTypeSchema): { ct: ContentTypeRow; fieldRows: FieldRow[]; relationRows: RelationRow[] } {
  if (schema.relations && schema.relations.length > 0) {
    throw new SchemaAdaptError(schema.apiId, 'relations in schema files are deferred to a later slice (use the meta path for now)');
  }
  const resolved = resolveFields(schemaToFieldSpecs(schema));
  const epoch = new Date(0); // synthetic created_at/updated_at — buildDef does not read them.
  const ct: ContentTypeRow = {
    id: SYNTHETIC_ID,
    api_id: schema.apiId,
    table_name: deriveTableName(schema.apiId),
    created_at: epoch,
    updated_at: epoch,
    draft_publish: schema.options?.draftAndPublish ?? false,
    i18n: schema.options?.i18n ?? false,
  };
  const fieldRows: FieldRow[] = resolved.map((rf, i) => ({
    id: i,
    content_type_id: SYNTHETIC_ID,
    name: rf.name,
    cms_type: rf.resolved.cmsType,
    pg_type: rf.resolved.pgType,
    engine_type: rf.resolved.engineType,
    nullable: rf.nullable,
    sort: i,
    default_value: defaultText(rf.defaultValue),
    params: rf.resolved.params,
    localized: rf.localized ?? true,
  }));
  return { ct, fieldRows, relationRows: [] };
}
