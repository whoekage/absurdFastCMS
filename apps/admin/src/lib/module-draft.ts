import type { CmsType } from '@conti/sdk';
import { optionMetaFor, BUILDER_CMS_TYPES } from '@/lib/field-types';
import type {
  FieldOptions,
  FieldSchema,
  ModuleDraft,
  ModuleSchema,
  RelationKind,
  RelationSchema,
} from '@/lib/builder-client';

// Re-export the shared error-message extractor so the builder feature has one import surface.
export { errorMessage } from '@/lib/errors';

/** TanStack Query keys for the files-first module BUILDER (raw schema + version, distinct from read keys). */
export const builderKeys = {
  all: ['builder'] as const,
  list: () => ['builder', 'list'] as const,
  detail: (name: string) => ['builder', 'detail', name] as const,
};

// Postgres identifier rule the API enforces: starts with a letter/underscore, then word/$ chars, ≤63 bytes.
// We pre-validate for UX; the server validates authoritatively.
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const MAX_IDENTIFIER_LENGTH = 63;

/** Validate an name / field name / relation field; returns an error message or null when valid. */
function validateIdentifier(value: string, label = 'Name'): string | null {
  if (value.length === 0) return `${label} is required`;
  if (value.length > MAX_IDENTIFIER_LENGTH) return `${label} must be ≤ ${MAX_IDENTIFIER_LENGTH} characters`;
  if (!IDENTIFIER_RE.test(value)) {
    return `${label} must start with a letter or _ and contain only letters, digits, _ or $`;
  }
  return null;
}

// ── field drafts ─────────────────────────────────────────────────────────────────────────────────

/**
 * The editable draft for one field. String-based for inputs; lowered to a wire {@link FieldSchema} on
 * submit. `id` is the STABLE backend id — present on a loaded field (so keeping it + changing `name` is a
 * lossless RENAME, not drop+add), absent on a new field (the server mints one). `raw` is set for a field
 * the builder UI can't author yet (component / dynamiczone / inline-relation): it round-trips VERBATIM so
 * editing a module never corrupts those — they stay edited in code.
 */
export interface FieldDraft {
  /** Stable client-side row id (React keys / remove). */
  key: string;
  /** Backend stable id (absent = new field). */
  id?: string;
  name: string;
  type: CmsType;
  nullable: boolean;
  /** raw `default` value as typed (empty = unset). */
  defaultValue: string;
  enumValues: string[];
  length: string;
  precision: string;
  scale: string;
  /** i18n per-field localized flag (only meaningful on an i18n module; defaults true). */
  localized: boolean;
  /** be-04 MEDIA: single asset (false) vs asset array (true). */
  multiple: boolean;
  /** Set for a non-authorable field (component/dynamiczone/inline-relation) — lowered verbatim. */
  raw?: FieldSchema;
}

let draftSeq = 0;
const nextKey = (prefix: string): string => {
  draftSeq += 1;
  return `${prefix}-${draftSeq}`;
};

/** A fresh, empty field draft (defaults to a nullable string field). */
export function emptyFieldDraft(): FieldDraft {
  return {
    key: nextKey('field'),
    name: '',
    type: 'string',
    nullable: true,
    defaultValue: '',
    enumValues: [],
    length: '',
    precision: '',
    scale: '',
    localized: true,
    multiple: false,
  };
}

/** Is this field type editable by the builder form (vs. authored-in-code components/inline-relations)? */
function isAuthorableField(type: FieldSchema['type']): type is CmsType {
  return (BUILDER_CMS_TYPES as readonly string[]).includes(type);
}

/** A `default` wire value → its editable string form. */
function defaultToString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

/** Seed a draft from a loaded {@link FieldSchema} (the edit form). Preserves `id`; round-trips non-authorable. */
function draftFromField(field: FieldSchema): FieldDraft {
  const base: FieldDraft = {
    key: nextKey('field'),
    id: field.id,
    name: field.name,
    type: (isAuthorableField(field.type) ? field.type : 'string') as CmsType,
    nullable: field.options?.nullable ?? true,
    defaultValue: defaultToString(field.options?.default),
    enumValues: field.options?.values ? [...field.options.values] : [],
    length: field.options?.length !== undefined ? String(field.options.length) : '',
    precision: field.options?.precision !== undefined ? String(field.options.precision) : '',
    scale: field.options?.scale !== undefined ? String(field.options.scale) : '',
    localized: field.localized ?? true,
    multiple: field.options?.multiple ?? false,
  };
  if (!isAuthorableField(field.type)) base.raw = field;
  return base;
}

/** Validate a single field draft; returns an error message or null. (Raw/authored-in-code fields skip.) */
function validateFieldDraft(draft: FieldDraft): string | null {
  if (draft.raw) return null;
  const nameError = validateIdentifier(draft.name, 'Field name');
  if (nameError) return nameError;

  const meta = optionMetaFor(draft.type);
  if (meta.enumValues) {
    const values = draft.enumValues.map((v) => v.trim()).filter((v) => v.length > 0);
    if (values.length === 0) return 'Enumeration needs at least one value';
    if (new Set(values).size !== values.length) return 'Enumeration values must be distinct';
  }
  if (meta.length && draft.length.trim() !== '') {
    const n = Number(draft.length);
    if (!Number.isInteger(n) || n <= 0) return 'Length must be a positive integer';
  }
  if (meta.precisionScale) {
    if (draft.precision.trim() !== '') {
      const p = Number(draft.precision);
      if (!Number.isInteger(p) || p <= 0) return 'Precision must be a positive integer';
    }
    if (draft.scale.trim() !== '') {
      const s = Number(draft.scale);
      if (!Number.isInteger(s) || s < 0) return 'Scale must be a non-negative integer';
    }
  }
  return null;
}

/** Build the {@link FieldOptions} object for a draft (only the keys its type honours). */
function draftOptions(draft: FieldDraft): FieldOptions {
  const meta = optionMetaFor(draft.type);
  const options: FieldOptions = { nullable: draft.nullable };
  if (meta.enumValues) {
    options.values = draft.enumValues.map((v) => v.trim()).filter((v) => v.length > 0);
  }
  if (meta.length && draft.length.trim() !== '') options.length = Number(draft.length);
  if (meta.precisionScale) {
    if (draft.precision.trim() !== '') options.precision = Number(draft.precision);
    if (draft.scale.trim() !== '') options.scale = Number(draft.scale);
  }
  if (meta.multiple) options.multiple = draft.multiple;
  if (draft.defaultValue.trim() !== '') options.default = parseDefault(draft);
  return options;
}

/** Lower a draft to a wire field. A non-authorable field round-trips its `raw` verbatim (id + options kept). */
function draftToField(draft: FieldDraft): Omit<FieldSchema, 'id'> & { id?: string } {
  if (draft.raw) return draft.raw;
  return {
    ...(draft.id !== undefined ? { id: draft.id } : {}),
    name: draft.name.trim(),
    type: draft.type,
    options: draftOptions(draft),
    localized: draft.localized,
  };
}

/** Interpret the raw `default` string for a draft according to its type. */
function parseDefault(draft: FieldDraft): unknown {
  const raw = draft.defaultValue.trim();
  switch (draft.type) {
    case 'boolean':
      return raw === 'true' || raw === '1';
    case 'integer':
    case 'float': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case 'json':
    case 'array':
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    default:
      return raw;
  }
}

// ── relation drafts ──────────────────────────────────────────────────────────────────────────────

/** The editable draft for one top-level relation. */
export interface RelationDraft {
  key: string;
  id?: string;
  field: string;
  kind: RelationKind;
  target: string;
  inverseField: string;
}

/** A fresh relation draft (targeting the given module by default, or empty). */
export function emptyRelationDraft(target = ''): RelationDraft {
  return { key: nextKey('rel'), field: '', kind: 'manyToOne', target, inverseField: '' };
}

/** Seed a relation draft from a loaded {@link RelationSchema}. Preserves `id`. */
function relationFromSchema(rel: RelationSchema): RelationDraft {
  return {
    key: nextKey('rel'),
    id: rel.id,
    field: rel.field,
    kind: rel.kind,
    target: rel.target,
    inverseField: rel.inverseField ?? '',
  };
}

/** Validate a relation draft against the available module moduleNames; returns an error or null. */
function validateRelationDraft(draft: RelationDraft, targets: readonly string[]): string | null {
  const fieldError = validateIdentifier(draft.field, 'Relation field');
  if (fieldError) return fieldError;
  if (draft.target.trim() === '') return 'Relation needs a target module';
  if (!targets.includes(draft.target)) return `Target module "${draft.target}" does not exist`;
  if (draft.inverseField.trim() !== '') {
    const invError = validateIdentifier(draft.inverseField, 'Inverse field');
    if (invError) return invError;
    if (draft.inverseField.trim() === draft.field.trim()) return 'Inverse field must differ from the field';
  }
  return null;
}

/** Lower a relation draft to the wire shape. */
function draftToRelation(draft: RelationDraft): Omit<RelationSchema, 'id'> & { id?: string } {
  const inverse = draft.inverseField.trim();
  return {
    ...(draft.id !== undefined ? { id: draft.id } : {}),
    field: draft.field.trim(),
    kind: draft.kind,
    target: draft.target,
    ...(inverse !== '' ? { inverseField: inverse } : {}),
  };
}

// ── whole-module form state ──────────────────────────────────────────────────────────────────────

/** The editable state for a whole module (create or edit). */
export interface ModuleFormState {
  /** Backend stable id (absent on create). */
  id?: string;
  name: string;
  /** Editable human display name; falls back to `name` in the UI when blank. */
  label: string;
  draftAndPublish: boolean;
  i18n: boolean;
  fields: FieldDraft[];
  relations: RelationDraft[];
}

/** A blank create-form state. */
export function emptyModuleForm(): ModuleFormState {
  return { name: '', label: '', draftAndPublish: false, i18n: false, fields: [emptyFieldDraft()], relations: [] };
}

/** Seed an edit-form state from a loaded module schema (preserves ids; round-trips non-authorable fields). */
export function moduleToForm(schema: ModuleSchema): ModuleFormState {
  return {
    id: schema.id,
    name: schema.name,
    label: schema.label ?? '',
    draftAndPublish: schema.options?.draftAndPublish ?? false,
    i18n: schema.options?.i18n ?? false,
    fields: schema.fields.map(draftFromField),
    relations: (schema.relations ?? []).map(relationFromSchema),
  };
}

/** Lower a whole form state to the {@link ModuleDraft} PUT/preview payload. */
export function formToModuleDraft(state: ModuleFormState): ModuleDraft {
  const draft: ModuleDraft = {
    name: state.name.trim(),
    options: { draftAndPublish: state.draftAndPublish, i18n: state.i18n },
    fields: state.fields.map(draftToField),
  };
  const label = state.label.trim();
  if (label.length > 0) draft.label = label;
  if (state.id !== undefined) draft.id = state.id;
  if (state.relations.length > 0) draft.relations = state.relations.map(draftToRelation);
  return draft;
}

/** Validate the whole form; returns the first error message or null. */
export function validateModuleForm(state: ModuleFormState, allModuleNames: readonly string[]): string | null {
  const nameError = validateIdentifier(state.name, 'Name');
  if (nameError) return nameError;
  // On CREATE (no stable id yet), the name must be free — PUT is an upsert, so a taken name would
  // silently edit the existing module instead of creating a new one.
  if (state.id === undefined && allModuleNames.includes(state.name.trim())) {
    return `A module named "${state.name.trim()}" already exists`;
  }

  const authorable = state.fields.filter((f) => !f.raw);
  if (authorable.length === 0) return 'A module needs at least one field';

  const names = new Set<string>();
  for (const f of state.fields) {
    const err = validateFieldDraft(f);
    if (err) return err;
    const name = (f.raw?.name ?? f.name).trim().toLowerCase();
    if (name !== '') {
      if (names.has(name)) return `Duplicate field name "${name}"`;
      names.add(name);
    }
  }
  // Relations may target this module (self-ref) plus any existing module.
  const targets = [...new Set([state.name.trim(), ...allModuleNames])].filter((t) => t !== '');
  for (const r of state.relations) {
    const err = validateRelationDraft(r, targets);
    if (err) return err;
    const name = r.field.trim().toLowerCase();
    if (names.has(name)) return `Relation field "${name}" collides with a field`;
    names.add(name);
  }
  return null;
}
