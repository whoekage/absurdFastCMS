import type { ModuleDefinition, FieldDefinition } from '@conti/sdk';

// Re-export the shared error-message extractor so the content-manager feature has one import surface.
export { errorMessage } from '@/lib/errors';

/**
 * TanStack Query keys for the generic content manager, NAMESPACED PER module api_id.
 *
 * Every key is rooted at `['content', name, ...]` so a mutation on one type can invalidate only that
 * type's queries (`contentKeys.all(name)`) without disturbing any other type's cache. The schema
 * (`definition`) and the row data (`list` / `detail`) are sibling sub-trees under that root.
 */
export const contentKeys = {
  /** Root for one type — invalidate this after any create/update/delete to refetch lists + details. */
  all: (name: string) => ['content', name] as const,
  /** The module definition (schema) used to render columns + the form. */
  definition: (name: string) => ['content', name, 'definition'] as const,
  /**
   * A page of rows, keyed by the SERIALIZED list query (filters / sort / pagination) so each distinct
   * URL state caches independently. `params` is the SDK {@link QueryParams}-shaped object the route
   * derives from its typed search params; passing it whole keeps the key in lockstep with the request.
   */
  list: (name: string, params: unknown) => ['content', name, 'list', params] as const,
  /** A single row by its public id. */
  detail: (name: string, id: string) => ['content', name, 'detail', id] as const,
};

/** System columns are loaded + materialized but never writable — they lead the projected field list. */
export function systemFields(def: ModuleDefinition): FieldDefinition[] {
  return def.fields.filter((f) => f.system);
}

/**
 * Derive the ORDERED list-table columns for a type from its definition.
 *
 * Strategy: always lead with `id` (the public PK every type has), then append user-defined fields in
 * their projected order, capped at `maxUserColumns` so a wide type stays readable. System timestamps
 * (`created_at` / `updated_at`) are intentionally omitted from the table to keep it scannable — they
 * remain visible on the read-only view page. The returned names are field names; the matching
 * {@link FieldDefinition} is looked up via {@link fieldMap} for per-cell formatting.
 */
export function listColumns(def: ModuleDefinition, maxUserColumns = 5): string[] {
  const userCols = def.fields.filter((f) => !f.system).map((f) => f.name);
  return ['id', ...userCols.slice(0, maxUserColumns)];
}

/** Index a definition's fields by name for O(1) lookup when rendering cells. */
export function fieldMap(def: ModuleDefinition): Map<string, FieldDefinition> {
  return new Map(def.fields.map((f) => [f.name, f]));
}

/** A human-ish singular noun for a type's entries (used in headings / buttons / dialogs). */
export function typeLabel(name: string): string {
  return name;
}
