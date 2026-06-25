import { resolveType, resolveComponentField, isComponentFieldKind, type CmsType, type ComponentFieldKind, type FieldOptions, type ResolvedType } from './type.catalog.ts';
import { validateFieldName, DuplicateFieldError } from './ddl.ts';

/**
 * be-05 — PURE component-field helpers + the component ROW TYPES. After the legacy-meta teardown the
 * `component_types`/`component_type_fields` meta tables and their read/write operations are GONE: a
 * component is declared files-first in `modules/components/<apiId>.ts`, loaded by `schema/load.ts`, and
 * consumed by `Registry.fromSchemas` via `schema/adapt.ts`. What survives is {@link resolveComponentFields}
 * (the field-spec → resolved-field validation the adapter reuses) and the row-shape TYPES the registry
 * consumes. A component has NO physical table, NO link table, and NO engine presence.
 */

/** A `component_types` row shape (snake_case as stored). */
export interface ComponentTypeRow {
  id: number;
  api_id: string;
  created_at: Date;
  updated_at: Date;
}

/** A `component_type_fields` row shape (snake_case as stored). */
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

/** A resolved component field ready to consume: validated name + cms_type + params + nullable. */
export interface ResolvedComponentField {
  name: string;
  cmsType: string;
  params: Record<string, unknown>;
  nullable: boolean;
}

/**
 * Validate + resolve a batch of component-field specs (names unique CI; each type resolves; a component
 * kind resolves to its `{kind, component|components}` params). Renders NO SQL, touches NO connection.
 * Exported so the files-first adapter (`schema/adapt.ts`) resolves a component field consistently.
 */
export function resolveComponentFields(specs: ComponentFieldSpec[]): ResolvedComponentField[] {
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
