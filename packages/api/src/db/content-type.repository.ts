import { resolveType, resolveComponentField, isComponentFieldKind, ComponentFieldError, type CmsType, type ComponentFieldKind, type FieldOptions } from './type.catalog.ts';
import { validateFieldName, validateDefault, DuplicateFieldError, type RelationKind, type ResolvedField } from './ddl.ts';

/**
 * PURE content-type field helpers + the meta ROW TYPES. After the legacy-meta teardown, the meta-write
 * operations (createContentType / addField / addRelation / dropContentType / …) and the meta-read selects
 * are GONE — files (`entities/<apiId>/schema.ts`) + `_schema_applied` are the source of truth, materialized
 * by `migrate()`. What survives here is {@link resolveFields} (the field-spec → resolved-field validation,
 * reused by the files-first `schema/adapt.ts` + `schema/migrate.ts`) and the row-shape TYPES the
 * {@link Registry} / adapter still consume.
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

/** A `content_types` row shape (snake_case as stored) — the unit `schema/adapt.ts` builds for the registry. */
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

/** A `content_type_fields` row shape (snake_case as stored). */
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

/** A `content_type_relations` row shape (snake_case as stored). */
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
