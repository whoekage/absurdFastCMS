import type { CmsType, FieldSpec, FieldOptions } from '@absurd/sdk';
import { optionMetaFor } from '@/lib/field-types';

// Re-export the shared error-message extractor so the content-type feature has one import surface.
export { errorMessage } from '@/lib/errors';

/** TanStack Query keys for the content-type builder. */
export const contentTypeKeys = {
  all: ['content-types'] as const,
  list: () => ['content-types', 'list'] as const,
  detail: (apiId: string) => ['content-types', 'detail', apiId] as const,
};

// Postgres identifier rule the API enforces: starts with a letter/underscore, then word/$ chars,
// at most 63 bytes. We pre-validate for UX (the server validates authoritatively).
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const MAX_IDENTIFIER_LENGTH = 63;

/** Validate an api_id / field name; returns an error message or null when valid. */
export function validateIdentifier(value: string, label = 'Name'): string | null {
  if (value.length === 0) return `${label} is required`;
  if (value.length > MAX_IDENTIFIER_LENGTH) return `${label} must be ≤ ${MAX_IDENTIFIER_LENGTH} characters`;
  if (!IDENTIFIER_RE.test(value)) {
    return `${label} must start with a letter or _ and contain only letters, digits, _ or $`;
  }
  return null;
}

/**
 * The editable draft for one field in a builder form. Kept string-based for inputs; lowered into a
 * wire {@link FieldSpec} on submit. `enumValues` is the editable enum member list.
 */
export interface FieldDraft {
  /** Stable client-side row id (for React keys / remove). */
  key: string;
  name: string;
  cmsType: CmsType;
  nullable: boolean;
  /** raw `default` value as typed (empty = unset). */
  defaultValue: string;
  /** enumeration members (editable list). */
  enumValues: string[];
  /** varchar length (string form; empty = unset). */
  length: string;
  /** decimal precision (string form; empty = unset). */
  precision: string;
  /** decimal scale (string form; empty = unset). */
  scale: string;
}

let draftSeq = 0;

/** A fresh, empty field draft (defaults to a nullable string field). */
export function emptyFieldDraft(): FieldDraft {
  draftSeq += 1;
  return {
    key: `field-${draftSeq}`,
    name: '',
    cmsType: 'string',
    nullable: true,
    defaultValue: '',
    enumValues: [],
    length: '',
    precision: '',
    scale: '',
  };
}

/** A draft seeded from an existing field (for the edit-field dialog). */
export function draftFromField(field: {
  name: string;
  cmsType: CmsType;
  nullable: boolean;
  enumValues?: readonly string[];
  length?: number;
  precision?: number;
  scale?: number;
}): FieldDraft {
  draftSeq += 1;
  return {
    key: `field-${draftSeq}`,
    name: field.name,
    cmsType: field.cmsType,
    nullable: field.nullable,
    defaultValue: '',
    enumValues: field.enumValues ? [...field.enumValues] : [],
    length: field.length !== undefined ? String(field.length) : '',
    precision: field.precision !== undefined ? String(field.precision) : '',
    scale: field.scale !== undefined ? String(field.scale) : '',
  };
}

/** Validate a single draft; returns an error message or null. */
export function validateFieldDraft(draft: FieldDraft): string | null {
  const nameError = validateIdentifier(draft.name, 'Field name');
  if (nameError) return nameError;

  const meta = optionMetaFor(draft.cmsType);
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

/** Build the {@link FieldOptions} object for a draft (only the keys its cmsType honours). */
export function draftOptions(draft: FieldDraft): FieldOptions {
  const meta = optionMetaFor(draft.cmsType);
  const options: FieldOptions = { nullable: draft.nullable };

  if (meta.enumValues) {
    options.values = draft.enumValues.map((v) => v.trim()).filter((v) => v.length > 0);
  }
  if (meta.length && draft.length.trim() !== '') {
    options.length = Number(draft.length);
  }
  if (meta.precisionScale) {
    if (draft.precision.trim() !== '') options.precision = Number(draft.precision);
    if (draft.scale.trim() !== '') options.scale = Number(draft.scale);
  }
  if (draft.defaultValue.trim() !== '') {
    options.default = parseDefault(draft);
  }
  return options;
}

/** Lower a draft to the wire {@link FieldSpec}. */
export function draftToFieldSpec(draft: FieldDraft): FieldSpec {
  return { name: draft.name.trim(), cmsType: draft.cmsType, options: draftOptions(draft) };
}

/** Interpret the raw `default` string for a draft according to its cmsType. */
function parseDefault(draft: FieldDraft): unknown {
  const raw = draft.defaultValue.trim();
  switch (draft.cmsType) {
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
