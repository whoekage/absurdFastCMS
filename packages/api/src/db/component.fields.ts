import { resolveType, resolveComponentField, isComponentFieldKind, type CmsType, type ComponentFieldKind, type FieldOptions, type ResolvedType } from './type.catalog.ts';
import { validateFieldName, DuplicateFieldError } from './ddl.ts';

/**
 * be-05 — PURE component-field helpers + the component ROW TYPES. After the legacy-meta teardown the
 * `component_types`/`component_type_fields` meta tables and their read/write operations are GONE: a
 * component is declared files-first in `modules/components/<name>.ts`, loaded by `schema/load.ts`, and
 * consumed by `Registry.fromSchemas` via `schema/adapt.ts`. What survives is {@link resolveComponentFields}
 * (the field-spec → resolved-field validation the adapter reuses) and the row-shape TYPES the registry
 * consumes. A component has NO physical table, NO link table, and NO engine presence.
 */

/** A component-type row shape — the in-memory unit `schema/adapt.ts` builds for the registry. */
export interface ComponentTypeRow {
  id: number;
  name: string;
  created_at: Date;
  updated_at: Date;
}

/** A `component_type_fields` row shape (snake_case as stored). */
export interface ComponentFieldRow {
  id: number;
  component_type_id: number;
  name: string;
  type: string;
  params: Record<string, unknown>;
  nullable: boolean;
  sort: number;
}

/** A field the caller wants on a component type: a scalar CmsType, media, or a nested component kind. */
export interface ComponentFieldSpec {
  name: string;
  type: CmsType | ComponentFieldKind;
  options?: FieldOptions | undefined;
}

/** A resolved component field ready to consume: validated name + type + params + nullable. */
export interface ResolvedComponentField {
  name: string;
  type: string;
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
    const resolved: ResolvedType = isComponentFieldKind(spec.type)
      ? resolveComponentField(spec.type, spec.options)
      : resolveType(spec.type, spec.options);
    out.push({ name, type: resolved.type as string, params: resolved.params, nullable: spec.options?.nullable ?? true });
  }
  return out;
}
