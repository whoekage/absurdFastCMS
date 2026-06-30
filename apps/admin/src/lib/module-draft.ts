import type { CmsType } from '@conti/sdk';
import { optionMetaFor, BUILDER_CMS_TYPES } from '@/lib/field-types';
import type {
  FieldCondition,
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
  /** UNIQUE constraint (offerable on uniqueable types — see optionMetaFor().unique). */
  unique: boolean;
  /** Editor layout: half-width (two side-by-side) vs full. Maps to options.editorWidth. */
  half: boolean;
  /** Lower bound — CONTEXTUAL: min char-length for string/email/uid, min VALUE for integer/float. */
  min: string;
  /** Upper VALUE bound for integer/float/biginteger/decimal (string types use `length` for their char max). */
  max: string;
  /** `array` only: forbid duplicate items. */
  uniqueItems: boolean;
  /** `array` only: item-count bounds (string-typed inputs). */
  minItems: string;
  maxItems: string;
  /** Conditional admin visibility ("show/hide when …"). Undefined = always visible. */
  condition?: FieldCondition;
  /** Soft-delete marker for a LOADED field (drops on apply, with a restore strip). New fields are removed outright. */
  deleted: boolean;
  /** Set for a non-authorable field (component/dynamiczone/inline-relation) — lowered verbatim. */
  raw?: FieldSchema;
}

let draftSeq = 0;
const nextKey = (prefix: string): string => {
  draftSeq += 1;
  return `${prefix}-${draftSeq}`;
};

/** A fresh, empty field draft (defaults to a nullable string field). `type` overrides the default. */
export function emptyFieldDraft(type: CmsType = 'string'): FieldDraft {
  return {
    key: nextKey('field'),
    name: '',
    type,
    nullable: true,
    defaultValue: '',
    enumValues: [],
    length: '',
    precision: '',
    scale: '',
    localized: true,
    multiple: false,
    unique: false,
    half: false,
    min: '',
    max: '',
    uniqueItems: false,
    minItems: '',
    maxItems: '',
    deleted: false,
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
    unique: field.options?.unique ?? false,
    half: field.options?.editorWidth === 'half',
    min: field.options?.min !== undefined ? String(field.options.min) : '',
    max: field.options?.max !== undefined ? String(field.options.max) : '',
    uniqueItems: field.options?.uniqueItems ?? false,
    minItems: field.options?.minItems !== undefined ? String(field.options.minItems) : '',
    maxItems: field.options?.maxItems !== undefined ? String(field.options.maxItems) : '',
    deleted: false,
  };
  if (field.options?.condition) base.condition = field.options.condition;
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
  if (meta.length) {
    if (draft.length.trim() !== '') {
      const n = Number(draft.length);
      if (!Number.isInteger(n) || n <= 0) return 'Max length must be a positive integer';
    }
    if (draft.min.trim() !== '') {
      const m = Number(draft.min);
      if (!Number.isInteger(m) || m < 0) return 'Min length must be a non-negative integer';
      if (draft.length.trim() !== '' && m > Number(draft.length)) return 'Min length can’t exceed max length';
    }
  }
  if (meta.numericBounds) {
    const hasMin = draft.min.trim() !== '';
    const hasMax = draft.max.trim() !== '';
    if (hasMin && !Number.isFinite(Number(draft.min))) return 'Min value must be a number';
    if (hasMax && !Number.isFinite(Number(draft.max))) return 'Max value must be a number';
    if (hasMin && hasMax && Number(draft.max) < Number(draft.min)) return 'Max value can’t be below min value';
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
  if (meta.length) {
    // string/email/uid: `length` is the char MAX, `min` the char minimum.
    if (draft.length.trim() !== '') options.length = Number(draft.length);
    if (draft.min.trim() !== '') options.min = Number(draft.min);
  }
  if (meta.numericBounds) {
    // integer/float bounds are NUMBERS (≤2^53 safe); biginteger/decimal bounds stay STRINGS (no precision loss).
    const asNumber = draft.type === 'integer' || draft.type === 'float';
    if (draft.min.trim() !== '') options.min = asNumber ? Number(draft.min) : draft.min.trim();
    if (draft.max.trim() !== '') options.max = asNumber ? Number(draft.max) : draft.max.trim();
  }
  if (meta.arrayItems) {
    if (draft.uniqueItems) options.uniqueItems = true;
    if (draft.minItems.trim() !== '') options.minItems = Number(draft.minItems);
    if (draft.maxItems.trim() !== '') options.maxItems = Number(draft.maxItems);
  }
  if (meta.precisionScale) {
    if (draft.precision.trim() !== '') options.precision = Number(draft.precision);
    if (draft.scale.trim() !== '') options.scale = Number(draft.scale);
  }
  if (meta.multiple) options.multiple = draft.multiple;
  if (meta.unique && draft.unique) options.unique = true;
  // editorWidth defaults to 'full' on the backend — only emit when 'half' to keep the schema clean.
  if (draft.half) options.editorWidth = 'half';
  if (draft.condition) options.condition = draft.condition;
  // media carries no constant default (the backend codegen can't express one — would be lost on reboot).
  if (draft.type !== 'media' && draft.defaultValue.trim() !== '') options.default = parseDefault(draft);
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

/** The client-derived change status of a field, relative to the loaded baseline. */
export type FieldStatus = 'clean' | 'new' | 'modified' | 'deleted';

/**
 * A stable, comparable serialization of a field's wire shape (excluding the stable `id`). Two fields
 * with the same name/type/options/localized serialize identically, so we can diff against a baseline
 * snapshot client-side for the status badge. `draftOptions` builds keys in a fixed order, so a loaded
 * field round-trips to the same string until the user actually changes something.
 */
function comparableField(field: Omit<FieldSchema, 'id'> & { id?: string }): string {
  return JSON.stringify({ name: field.name, type: field.type, options: field.options ?? {}, localized: field.localized });
}

/** Build the baseline map (fieldId → comparable snapshot) from loaded drafts. New/raw-less fields have no id. */
function baselineFrom(drafts: FieldDraft[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of drafts) if (d.id !== undefined) out[d.id] = comparableField(draftToField(d));
  return out;
}

/** Derive a field's status badge from the baseline: new (no id) / deleted / modified / clean. */
export function fieldStatus(draft: FieldDraft, baseline: Record<string, string>): FieldStatus {
  if (draft.deleted) return 'deleted';
  if (draft.id === undefined) return 'new';
  const base = baseline[draft.id];
  if (base === undefined) return 'new';
  return comparableField(draftToField(draft)) === base ? 'clean' : 'modified';
}

/** A one-line summary of a field's configured options (the collapsed card subtitle). */
export function fieldSummary(draft: FieldDraft): string {
  const meta = optionMetaFor(draft.type);
  const bits: string[] = [draft.nullable ? 'optional' : 'required'];
  if (meta.unique && draft.unique) bits.push('unique');
  if (meta.enumValues && draft.enumValues.length > 0) bits.push(`${draft.enumValues.length} values`);
  if (meta.length && draft.length.trim() !== '') bits.push(`max ${draft.length.trim()}`);
  if (meta.numericBounds) {
    if (draft.min.trim() !== '') bits.push(`min ${draft.min.trim()}`);
    if (draft.max.trim() !== '') bits.push(`max ${draft.max.trim()}`);
  }
  if (meta.multiple) bits.push(draft.multiple ? 'multiple' : 'single');
  if (draft.defaultValue.trim() !== '') bits.push(`default ${draft.defaultValue.trim()}`);
  return bits.join(' · ');
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
  /** Which target field the relation picker shows/searches ('' = the target's default). */
  displayField: string;
  /** Soft-delete marker for a LOADED relation (drops the join on apply; restorable). */
  deleted: boolean;
}

/** A fresh relation draft (targeting the given module by default, or empty). */
export function emptyRelationDraft(target = ''): RelationDraft {
  return { key: nextKey('rel'), field: '', kind: 'manyToOne', target, inverseField: '', displayField: '', deleted: false };
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
    displayField: rel.displayField ?? '',
    deleted: false,
  };
}

// ── 6-way cardinality (the design's friendly picker over our 4 kinds × inverse-present) ──────────

/** The six relation shapes the picker offers (Strapi parity). */
export type Cardinality = 'oneWay' | 'oneToOne' | 'oneToMany' | 'manyToOne' | 'manyToMany' | 'manyWay';

/** One cardinality card: end markers (1 / ∞), one-way flag, and the plain-English verbs. */
export interface CardinalityCard {
  key: Cardinality;
  label: string;
  aMark: '1' | '∞';
  bMark: '1' | '∞';
  oneWay: boolean;
  /** "Each <Module> <verb> <target>". */
  verb: string;
  /** Reverse-direction verb ("each <target> <inv> <Module>"); '' when one-way. */
  inv: string;
}

/** The picker catalog, in display order (mirrors the Lua design's `_CARDS()`). */
export const CARDINALITY_CARDS: readonly CardinalityCard[] = [
  { key: 'oneWay', label: 'has one', aMark: '1', bMark: '1', oneWay: true, verb: 'has one', inv: '' },
  { key: 'oneToOne', label: 'one ↔ one', aMark: '1', bMark: '1', oneWay: false, verb: 'has and belongs to one', inv: 'belongs to one' },
  { key: 'oneToMany', label: 'one → many', aMark: '1', bMark: '∞', oneWay: false, verb: 'has many', inv: 'belongs to one' },
  { key: 'manyToOne', label: 'many → one', aMark: '∞', bMark: '1', oneWay: false, verb: 'belongs to one', inv: 'has many' },
  { key: 'manyToMany', label: 'many ↔ many', aMark: '∞', bMark: '∞', oneWay: false, verb: 'has and belongs to many', inv: 'has and belongs to many' },
  { key: 'manyWay', label: 'has many', aMark: '1', bMark: '∞', oneWay: true, verb: 'has many', inv: '' },
];

const CARD_BY_KEY = new Map(CARDINALITY_CARDS.map((c) => [c.key, c]));

/** The card metadata for a cardinality key (falls back to the first card). */
export function cardinalityCard(key: Cardinality): CardinalityCard {
  return CARD_BY_KEY.get(key) ?? CARDINALITY_CARDS[0]!;
}

/** Derive the friendly cardinality from a draft's (kind, inverse-present). */
export function draftCardinality(d: RelationDraft): Cardinality {
  const hasInverse = d.inverseField.trim() !== '';
  switch (d.kind) {
    case 'oneToOne':
      return hasInverse ? 'oneToOne' : 'oneWay';
    case 'oneToMany':
      return hasInverse ? 'oneToMany' : 'manyWay';
    case 'manyToOne':
      return 'manyToOne';
    case 'manyToMany':
      return 'manyToMany';
  }
}

/** The (kind, inverse) patch a chosen cardinality implies. One-way kinds clear the inverse field. */
export function cardinalityPatch(card: Cardinality): Partial<RelationDraft> {
  switch (card) {
    case 'oneWay':
      return { kind: 'oneToOne', inverseField: '' };
    case 'manyWay':
      return { kind: 'oneToMany', inverseField: '' };
    case 'oneToOne':
      return { kind: 'oneToOne' };
    case 'oneToMany':
      return { kind: 'oneToMany' };
    case 'manyToOne':
      return { kind: 'manyToOne' };
    case 'manyToMany':
      return { kind: 'manyToMany' };
  }
}

/** Naive English pluralizer for the relation sentence (mirrors the design). */
export function pluralize(s: string): string {
  if (/s$/.test(s)) return s;
  if (/[^aeiou]y$/i.test(s)) return `${s.slice(0, -1)}ies`;
  return `${s}s`;
}

/** A comparable snapshot of a relation's wire shape (for the status badge). */
function comparableRelation(rel: Omit<RelationSchema, 'id'> & { id?: string }): string {
  return JSON.stringify({ field: rel.field, kind: rel.kind, target: rel.target, inverseField: rel.inverseField ?? '', displayField: rel.displayField ?? '' });
}

function relationBaselineFrom(drafts: RelationDraft[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of drafts) if (d.id !== undefined) out[d.id] = comparableRelation(draftToRelation(d));
  return out;
}

/** Derive a relation's status badge from the baseline (new / deleted / modified / clean). */
export function relationStatus(draft: RelationDraft, baseline: Record<string, string>): FieldStatus {
  if (draft.deleted) return 'deleted';
  if (draft.id === undefined) return 'new';
  const base = baseline[draft.id];
  if (base === undefined) return 'new';
  return comparableRelation(draftToRelation(draft)) === base ? 'clean' : 'modified';
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
  const display = draft.displayField.trim();
  return {
    ...(draft.id !== undefined ? { id: draft.id } : {}),
    field: draft.field.trim(),
    kind: draft.kind,
    target: draft.target,
    ...(inverse !== '' ? { inverseField: inverse } : {}),
    ...(display !== '' ? { displayField: display } : {}),
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
  /** fieldId → comparable snapshot at load (for client-side status badges). Empty on create. */
  baseline: Record<string, string>;
  /** relationId → comparable snapshot at load (relation status badges). Empty on create. */
  relationBaseline: Record<string, string>;
}

/** A blank create-form state — starts with NO fields (the empty-state prompt drives the first add). */
export function emptyModuleForm(): ModuleFormState {
  return { name: '', label: '', draftAndPublish: false, i18n: false, fields: [], relations: [], baseline: {}, relationBaseline: {} };
}

/** Seed an edit-form state from a loaded module schema (preserves ids; round-trips non-authorable fields). */
export function moduleToForm(schema: ModuleSchema): ModuleFormState {
  const fields = schema.fields.map(draftFromField);
  const relations = (schema.relations ?? []).map(relationFromSchema);
  return {
    id: schema.id,
    name: schema.name,
    label: schema.label ?? '',
    draftAndPublish: schema.options?.draftAndPublish ?? false,
    i18n: schema.options?.i18n ?? false,
    fields,
    relations,
    baseline: baselineFrom(fields),
    relationBaseline: relationBaselineFrom(relations),
  };
}

/** Lower a whole form state to the {@link ModuleDraft} PUT/preview payload. */
export function formToModuleDraft(state: ModuleFormState): ModuleDraft {
  // Soft-deleted fields are OMITTED so the server diff classifies them as drops.
  const draft: ModuleDraft = {
    name: state.name.trim(),
    options: { draftAndPublish: state.draftAndPublish, i18n: state.i18n },
    fields: state.fields.filter((f) => !f.deleted).map(draftToField),
  };
  const label = state.label.trim();
  if (label.length > 0) draft.label = label;
  if (state.id !== undefined) draft.id = state.id;
  // Soft-deleted relations are omitted so the server diff drops their join table.
  const liveRelations = state.relations.filter((r) => !r.deleted);
  if (liveRelations.length > 0) draft.relations = liveRelations.map(draftToRelation);
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

  const live = state.fields.filter((f) => !f.deleted);
  const authorable = live.filter((f) => !f.raw);
  if (authorable.length === 0) return 'A module needs at least one field';

  const names = new Set<string>();
  for (const f of live) {
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
  for (const r of state.relations.filter((rel) => !rel.deleted)) {
    const err = validateRelationDraft(r, targets);
    if (err) return err;
    const name = r.field.trim().toLowerCase();
    if (names.has(name)) return `Relation field "${name}" collides with a field`;
    names.add(name);
  }
  return null;
}
