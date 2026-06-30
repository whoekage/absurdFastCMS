import { z } from 'zod';
import type { ReactNode } from 'react';
import type { CmsType, ComponentFieldKind, FieldDefinition } from '@conti/sdk';
import { Input } from '@/components/ui/input';
import { AutoTextarea } from '@/components/ui/auto-textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DatePickerInput } from '@/components/date-picker-input';
import { JsonEditor } from '@/components/json-editor';

// ──────────────────────────────────────────────────────────────────────────────────────────────
// type → widget registry.
//
// One entry per CmsType maps the type to three concerns:
//   • input   — a controlled form-input renderer (value/onChange/onBlur are wire-shaped).
//   • zod      — a factory building the Zod validator for a field (honours nullable/required).
//   • format   — a table-cell / read-only formatter (wire value → ReactNode).
//   • toForm   — wire value → the form field's controlled value (string-ish, for inputs).
//   • fromForm — the form field's value → the write-body wire value.
//
// The article type only exercises a subset, but every one of the 16 CmsTypes is wired so adding a
// new module needs no code here.
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** The controlled value carried by a form field. Inputs are string-based; boolean is the exception. */
export type FormFieldValue = string | boolean;

/** Props handed to an input renderer. Value/onChange are kept generic over the field value. */
export interface FieldInputProps {
  id: string;
  field: FieldDefinition;
  value: FormFieldValue;
  onChange: (value: FormFieldValue) => void;
  onBlur: () => void;
  disabled?: boolean;
}

export interface FieldTypeHandler {
  /** Render the form input for this field. */
  input: (props: FieldInputProps) => ReactNode;
  /** Build a Zod schema for this field (already accounts for nullable/required). */
  zod: (field: FieldDefinition) => z.ZodTypeAny;
  /** Format a wire value for read-only display (detail page + table cell). */
  format: (value: unknown, field: FieldDefinition) => ReactNode;
  /** Wire value → controlled form value. */
  toForm: (value: unknown) => FormFieldValue;
  /** Controlled form value → wire value for the write body. */
  fromForm: (value: FormFieldValue, field: FieldDefinition) => unknown;
  /** Empty/initial controlled value for a fresh create form. */
  emptyForm: () => FormFieldValue;
}

const NULL_DISPLAY = '—';

function displayNullable(value: unknown): ReactNode | undefined {
  if (value === null || value === undefined) return NULL_DISPLAY;
  return undefined;
}

// ── shared text-input builder ──────────────────────────────────────────────────────────────────

function textInput(type: 'text' | 'number' | 'email' = 'text', honorLength = false) {
  return function TextInputRenderer(props: FieldInputProps): ReactNode {
    // varchar-backed types cap input at the field's `length` so the user can't type past the column.
    const maxLength = honorLength ? props.field.length : undefined;
    return (
      <Input
        id={props.id}
        type={type}
        value={typeof props.value === 'string' ? props.value : ''}
        onChange={(e) => props.onChange(e.target.value)}
        onBlur={props.onBlur}
        {...(maxLength !== undefined ? { maxLength } : {})}
        {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
      />
    );
  };
}

// ── Zod helpers ──────────────────────────────────────────────────────────────────────────────

/** Wrap a base string schema so a nullable field accepts the empty string (→ null on submit). */
function stringSchema(field: FieldDefinition, base: z.ZodString, honorLength = false): z.ZodTypeAny {
  let s = base;
  if (honorLength && field.length !== undefined) {
    s = s.max(field.length, `Must be at most ${field.length} characters`);
  }
  if (field.nullable) return s.or(z.literal(''));
  return s.min(1, 'Required');
}

/** A numeric-string schema: text input → must parse to a finite number when present. */
function numberStringSchema(field: FieldDefinition, integer: boolean): z.ZodTypeAny {
  return z.string().superRefine((val, ctx) => {
    if (val === '') {
      if (!field.nullable) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Required' });
      }
      return;
    }
    const n = Number(val);
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be a number' });
      return;
    }
    if (integer && !Number.isInteger(n)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be an integer' });
    }
  });
}

/** A big-numeric STRING schema (biginteger / decimal): validated as a number, never coerced to one. */
function bigNumberStringSchema(field: FieldDefinition, integer: boolean): z.ZodTypeAny {
  return z.string().superRefine((val, ctx) => {
    if (val === '') {
      if (!field.nullable) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Required' });
      }
      return;
    }
    const pattern = integer ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/;
    if (!pattern.test(val.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: integer ? 'Must be a whole number' : 'Must be a decimal number',
      });
    }
  });
}

// ── per-type converters ────────────────────────────────────────────────────────────────────────

/** Wire value → string for a text-ish input. */
const wireToString = (value: unknown): FormFieldValue =>
  value === null || value === undefined ? '' : String(value);

/** String form value → wire value, mapping '' on a nullable field to null. */
function stringFromForm(value: FormFieldValue, field: FieldDefinition): unknown {
  const s = typeof value === 'string' ? value : String(value);
  if (s === '' && field.nullable) return null;
  return s;
}

// ── the registry ─────────────────────────────────────────────────────────────────────────────

const stringHandler: FieldTypeHandler = {
  input: textInput('text', true),
  zod: (f) => stringSchema(f, z.string(), true),
  format: (v) => displayNullable(v) ?? String(v),
  toForm: wireToString,
  fromForm: stringFromForm,
  emptyForm: () => '',
};

const emailHandler: FieldTypeHandler = {
  input: textInput('email', true),
  zod: (f) => stringSchema(f, z.string().email('Invalid email'), true),
  format: (v) => displayNullable(v) ?? String(v),
  toForm: wireToString,
  fromForm: stringFromForm,
  emptyForm: () => '',
};

const textHandler: FieldTypeHandler = {
  input: function TextareaRenderer(props) {
    return (
      <AutoTextarea
        id={props.id}
        value={typeof props.value === 'string' ? props.value : ''}
        onChange={(e) => props.onChange(e.target.value)}
        onBlur={props.onBlur}
        {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
      />
    );
  },
  zod: (f) => stringSchema(f, z.string()),
  format: (v) => displayNullable(v) ?? String(v),
  toForm: wireToString,
  fromForm: stringFromForm,
  emptyForm: () => '',
};

const numberHandler = (integer: boolean): FieldTypeHandler => ({
  input: textInput('number'),
  zod: (f) => numberStringSchema(f, integer),
  format: (v) => displayNullable(v) ?? String(v),
  toForm: wireToString,
  fromForm: (value, field) => {
    const s = typeof value === 'string' ? value.trim() : '';
    if (s === '') return field.nullable ? null : undefined;
    return Number(s);
  },
  emptyForm: () => '',
});

// biginteger / decimal: kept as STRING end-to-end (precision — never coerce to a JS number).
const bigStringHandler = (integer: boolean): FieldTypeHandler => ({
  input: textInput('text'),
  zod: (f) => bigNumberStringSchema(f, integer),
  format: (v) => displayNullable(v) ?? String(v),
  toForm: wireToString,
  fromForm: (value, field) => {
    const s = typeof value === 'string' ? value.trim() : '';
    if (s === '' && field.nullable) return null;
    return s;
  },
  emptyForm: () => '',
});

const booleanHandler: FieldTypeHandler = {
  input: function BooleanRenderer(props) {
    return (
      <div className="flex h-9 items-center">
        <Switch
          id={props.id}
          checked={props.value === true}
          onCheckedChange={(checked) => {
            props.onChange(checked);
            props.onBlur();
          }}
          {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
        />
      </div>
    );
  },
  zod: () => z.boolean(),
  format: (v) => {
    const nullDisplay = displayNullable(v);
    if (nullDisplay !== undefined) return nullDisplay;
    return v ? 'Yes' : 'No';
  },
  toForm: (v) => v === true,
  fromForm: (value) => value === true,
  emptyForm: () => false,
};

const enumerationHandler: FieldTypeHandler = {
  input: function EnumRenderer(props) {
    const values = props.field.enumValues ?? [];
    const current = typeof props.value === 'string' ? props.value : '';
    return (
      <Select
        value={current}
        onValueChange={(v) => {
          props.onChange(v);
          props.onBlur();
        }}
        {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
      >
        <SelectTrigger id={props.id}>
          <SelectValue placeholder="Select…" />
        </SelectTrigger>
        <SelectContent>
          {values.map((val) => (
            <SelectItem key={val} value={val}>
              {val}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  },
  zod: (f) => {
    const values = f.enumValues ?? [];
    const base =
      values.length > 0
        ? z.enum([values[0] as string, ...values.slice(1)] as [string, ...string[]])
        : z.string();
    if (f.nullable) return base.or(z.literal(''));
    return base;
  },
  format: (v) => displayNullable(v) ?? String(v),
  toForm: wireToString,
  fromForm: stringFromForm,
  emptyForm: () => '',
};

// date / datetime / time: calendar/popover picker (raw text still allowed); emit ISO for datetime.
const dateHandler = (kind: 'date' | 'datetime' | 'time'): FieldTypeHandler => {
  /** Wire value → the value the date control expects (datetime-local has no zone / millis). */
  const wireToInput = (value: unknown): FormFieldValue => {
    if (value === null || value === undefined || value === '') return '';
    const s = String(value);
    if (kind === 'datetime') {
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return s;
      // YYYY-MM-DDTHH:mm in local time for the datetime-local control.
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
        d.getHours(),
      )}:${pad(d.getMinutes())}`;
    }
    if (kind === 'date') {
      // The API materializes temporal columns as full ISO-8601
      // (e.g. '2026-06-18T00:00:00.000Z'); <input type="date"> needs a bare
      // 'YYYY-MM-DD' or it silently clears itself. Slice off the time portion.
      return s.split('T')[0] ?? '';
    }
    return s;
  };

  return {
    input: function DateRenderer(props) {
      return (
        <DatePickerInput
          id={props.id}
          kind={kind}
          value={typeof props.value === 'string' ? props.value : ''}
          onChange={(v) => props.onChange(v)}
          onBlur={props.onBlur}
          disabled={props.disabled}
        />
      );
    },
    zod: (f) =>
      z.string().superRefine((val, ctx) => {
        if (val === '' && !f.nullable) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Required' });
        }
      }),
    format: (v) => displayNullable(v) ?? String(v),
    toForm: wireToInput,
    fromForm: (value, field) => {
      const s = typeof value === 'string' ? value : '';
      if (s === '') return field.nullable ? null : undefined;
      if (kind === 'datetime') {
        // datetime-local → full ISO-8601 (UTC).
        const d = new Date(s);
        return Number.isNaN(d.getTime()) ? s : d.toISOString();
      }
      return s;
    },
    emptyForm: () => '',
  };
};

const jsonHandler: FieldTypeHandler = {
  input: function JsonRenderer(props) {
    return (
      <JsonEditor
        id={props.id}
        value={typeof props.value === 'string' ? props.value : ''}
        onChange={(v) => props.onChange(v)}
        onBlur={props.onBlur}
        disabled={props.disabled}
      />
    );
  },
  zod: (f) =>
    z.string().superRefine((val, ctx) => {
      if (val === '') {
        if (!f.nullable) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Required' });
        return;
      }
      try {
        JSON.parse(val);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid JSON' });
      }
    }),
  format: (v) => {
    const nullDisplay = displayNullable(v);
    if (nullDisplay !== undefined) return nullDisplay;
    return JSON.stringify(v);
  },
  toForm: (v) => (v === null || v === undefined ? '' : JSON.stringify(v, null, 2)),
  fromForm: (value, field) => {
    const s = typeof value === 'string' ? value : '';
    if (s === '') return field.nullable ? null : undefined;
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  },
  emptyForm: () => '',
};

const uuidHandler: FieldTypeHandler = {
  input: textInput('text'),
  zod: (f) => stringSchema(f, z.string()),
  format: (v) => displayNullable(v) ?? String(v),
  toForm: wireToString,
  fromForm: stringFromForm,
  emptyForm: () => '',
};

// ── be-04 MEDIA ─────────────────────────────────────────────────────────────────────────────────
// A media field references uploaded asset(s) by id. The ENTRY FORM does NOT use this handler's `input`
// — it routes media fields to a dedicated <MediaPicker> (like relations) and merges the picked id(s)
// straight into the write body. This handler exists so (a) the registry stays an exhaustive
// Record<CmsType,...> and (b) media fields render a THUMBNAIL in read-only table cells / detail views via
// `format`, which understands both a raw id / id[] and a populated FileAsset object/array.
const mediaHandler: FieldTypeHandler = {
  input: textInput('text'), // fallback only; the entry form overrides media with <MediaPicker>.
  zod: () => z.any(),
  format: (v) => formatMedia(v),
  toForm: (v) => (v === null || v === undefined ? '' : String(v)),
  fromForm: (value) => {
    const s = typeof value === 'string' ? value.trim() : '';
    if (s === '') return null;
    const n = Number(s);
    return Number.isInteger(n) && n > 0 ? n : s;
  },
  emptyForm: () => '',
};

/** A wire media value -> a read-only display: a thumbnail (populated asset), a count, or an id. */
function formatMedia(value: unknown): ReactNode {
  const nullDisplay = displayNullable(value);
  if (nullDisplay !== undefined) return nullDisplay;
  if (isAssetLike(value)) return <MediaThumb asset={value} />;
  if (Array.isArray(value)) {
    const assets = value.filter(isAssetLike);
    if (assets.length > 0) {
      return (
        <span className="inline-flex items-center gap-1">
          {assets.slice(0, 4).map((a) => (
            <MediaThumb key={a.id} asset={a} />
          ))}
          {assets.length > 4 && (
            <span className="text-xs text-muted-foreground">+{assets.length - 4}</span>
          )}
        </span>
      );
    }
    return <span className="text-xs text-muted-foreground">{value.length} file(s)</span>;
  }
  return <span className="text-xs text-muted-foreground">#{String(value)}</span>;
}

/** Minimal asset shape the formatter needs (a populated media value). */
interface AssetLike {
  id: number;
  url: string | null;
  mime: string;
  filename?: string;
}

function isAssetLike(v: unknown): v is AssetLike {
  return (
    typeof v === 'object' &&
    v !== null &&
    'id' in v &&
    'mime' in v &&
    typeof (v as { id: unknown }).id === 'number'
  );
}

/** A 28px thumbnail (image) or a mime badge (non-image), with the filename as a tooltip. */
function MediaThumb({ asset }: { asset: AssetLike }): ReactNode {
  const isImage = asset.mime.startsWith('image/') && asset.url;
  if (isImage) {
    return (
      <img
        src={asset.url as string}
        alt={asset.filename ?? `#${asset.id}`}
        title={asset.filename ?? `#${asset.id}`}
        className="inline-block h-7 w-7 rounded object-cover ring-1 ring-border"
      />
    );
  }
  return (
    <span
      title={asset.filename ?? `#${asset.id}`}
      className="inline-flex h-7 items-center rounded bg-muted px-1.5 text-[10px] text-muted-foreground ring-1 ring-border"
    >
      {asset.mime.split('/')[1] ?? 'file'}
    </span>
  );
}

const registry: Record<CmsType, FieldTypeHandler> = {
  string: stringHandler,
  text: textHandler,
  email: emailHandler,
  uid: stringHandler,
  enumeration: enumerationHandler,
  integer: numberHandler(true),
  float: numberHandler(false),
  biginteger: bigStringHandler(true),
  decimal: bigStringHandler(false),
  boolean: booleanHandler,
  date: dateHandler('date'),
  datetime: dateHandler('datetime'),
  time: dateHandler('time'),
  json: jsonHandler,
  array: jsonHandler,
  uuid: uuidHandler,
  media: mediaHandler,
};

/**
 * Resolve the handler for a field's type (falls back to a plain text/string handler). Accepts the
 * wider {@link ComponentFieldKind} too: a be-05 component / dynamic-zone field has no scalar handler yet
 * (the nested editor is a later admin phase), so it falls through to the string handler for now.
 */
export function getFieldHandler(type: CmsType | ComponentFieldKind): FieldTypeHandler {
  return (registry as Record<string, FieldTypeHandler | undefined>)[type] ?? stringHandler;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Module BUILDER metadata.
//
// The list of every CmsType (single source of truth — derived from the registry so it can never
// drift) plus, per type, which `FieldOptions` keys are meaningful. The builder forms read this to
// decide which conditional option inputs to render — no hardcoded type list anywhere else.
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** Every CmsType, in a stable display order. Derived from the registry keys (the closed set). */
const CMS_TYPES: readonly CmsType[] = Object.keys(registry) as CmsType[];

/**
 * cmsTypes the API genuinely supports end-to-end, hence offerable in the module builder.
 * `time` is excluded: it maps to engineType i32 but the engine's load path rejects it outright
 * (packages/api/src/store/registry.ts — "time is not supported on the load path"), so creating a
 * `time` field would brick its module on the next registry reload. The registry above still
 * carries a `time` handler so any pre-existing column renders defensively; new ones just can't be made.
 */
const UNSUPPORTED_BUILDER_TYPES: ReadonlySet<CmsType> = new Set<CmsType>(['time']);
export const BUILDER_CMS_TYPES: readonly CmsType[] = CMS_TYPES.filter(
  (t) => !UNSUPPORTED_BUILDER_TYPES.has(t),
);

/** The option keys a given type actually honours, beyond the universal `nullable` / `default`. */
export interface CmsTypeOptionMeta {
  /** editable enum `values` list applies. */
  enumValues: boolean;
  /** varchar `length` (max chars) + a min-chars input apply. */
  length: boolean;
  /** decimal `precision` + `scale` apply. */
  precisionScale: boolean;
  /** be-04 MEDIA: the `multiple` (single-vs-array) toggle applies. */
  multiple: boolean;
  /** numeric VALUE bounds (`min`/`max`) apply — integer / float (Part A). */
  numericBounds: boolean;
  /** a UNIQUE constraint is offerable (everything but text/boolean/json/array/media). */
  unique: boolean;
}

const NO_OPTIONS: CmsTypeOptionMeta = {
  enumValues: false,
  length: false,
  precisionScale: false,
  multiple: false,
  numericBounds: false,
  unique: false,
};

const optionMeta: Record<CmsType, CmsTypeOptionMeta> = {
  string: { ...NO_OPTIONS, length: true, unique: true },
  text: NO_OPTIONS,
  email: { ...NO_OPTIONS, length: true, unique: true },
  uid: { ...NO_OPTIONS, length: true, unique: true },
  enumeration: { ...NO_OPTIONS, enumValues: true, unique: true },
  integer: { ...NO_OPTIONS, numericBounds: true, unique: true },
  biginteger: { ...NO_OPTIONS, unique: true },
  float: { ...NO_OPTIONS, numericBounds: true, unique: true },
  decimal: { ...NO_OPTIONS, precisionScale: true, unique: true },
  boolean: NO_OPTIONS,
  date: { ...NO_OPTIONS, unique: true },
  datetime: { ...NO_OPTIONS, unique: true },
  time: NO_OPTIONS,
  json: NO_OPTIONS,
  array: NO_OPTIONS,
  uuid: { ...NO_OPTIONS, unique: true },
  media: { ...NO_OPTIONS, multiple: true },
};

/** Which conditional option inputs a type needs in the builder forms. */
export function optionMetaFor(type: CmsType): CmsTypeOptionMeta {
  return optionMeta[type] ?? NO_OPTIONS;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Builder type CATALOG — the type-picker gallery (glyph / one-line desc / group / colour tone).
// Mirrors the Lua design's `_TYPES()`. `soon` entries (rich text / blocks) render disabled — they
// aren't real CmsTypes yet, so they're typed loosely as `string` ids and filtered out of creation.
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** A colour tone keyed to a design token (`--primary`, `--info`, …). */
export type FieldTone = 'primary' | 'info' | 'success' | 'warning' | 'violet' | 'pink' | 'teal';

/** tone → the CSS var the glyph chip / type pill paints with. */
export const TONE_VAR: Record<FieldTone, string> = {
  primary: 'hsl(var(--primary))',
  info: 'var(--info)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  violet: 'var(--violet)',
  pink: 'var(--pink)',
  teal: 'var(--teal)',
};

/** One gallery entry. `soon` = previewed-but-not-creatable (no backend type). */
export interface BuilderTypeEntry {
  id: string;
  name: string;
  glyph: string;
  desc: string;
  group: string;
  tone: FieldTone;
  soon: boolean;
}

const T = (id: string, name: string, glyph: string, desc: string, group: string, tone: FieldTone, soon = false): BuilderTypeEntry => ({ id, name, glyph, desc, group, tone, soon });

/** The full picker catalog, in display order; grouped by {@link BUILDER_TYPE_GROUP_ORDER}. */
export const BUILDER_TYPE_CATALOG: readonly BuilderTypeEntry[] = [
  T('string', 'String', 'T', 'Short text, one line', 'Text', 'primary'),
  T('text', 'Text', '¶', 'Long text, multi-line', 'Text', 'primary'),
  T('email', 'Email', '@', 'Validated email address', 'Text', 'primary'),
  T('uid', 'UID', '/', 'Unique slug from a field', 'Text', 'primary'),
  T('enumeration', 'Enumeration', '▾', 'A fixed list of values', 'Text', 'primary'),
  T('uuid', 'UUID', 'id', 'Auto v4 identifier', 'Text', 'primary'),
  T('integer', 'Integer', '1', 'Whole number', 'Number', 'info'),
  T('float', 'Float', 'ƒ', 'Floating point', 'Number', 'info'),
  T('biginteger', 'Big integer', '∞', '64-bit integer', 'Number', 'info'),
  T('decimal', 'Decimal', '$', 'Fixed precision/scale', 'Number', 'info'),
  T('boolean', 'Boolean', '✓', 'True or false', 'Boolean', 'success'),
  T('date', 'Date', 'D', 'Calendar date', 'Date', 'warning'),
  T('datetime', 'Datetime', 'DT', 'Date and time', 'Date', 'warning'),
  T('json', 'JSON', '{}', 'Arbitrary JSON', 'Data', 'violet'),
  T('array', 'Array', '[]', 'List of scalars', 'Data', 'violet'),
  T('media', 'Media', '▣', 'Image, video or file', 'Media', 'pink'),
  T('richtext', 'Rich text', 'R', 'WYSIWYG formatted body', 'Rich content', 'primary', true),
  T('blocks', 'Blocks', '▦', 'Modular block editor', 'Rich content', 'pink', true),
];

/** The group headers, in picker order. */
export const BUILDER_TYPE_GROUP_ORDER: readonly string[] = ['Text', 'Number', 'Boolean', 'Date', 'Data', 'Media', 'Rich content'];

const TYPE_BY_ID = new Map(BUILDER_TYPE_CATALOG.map((t) => [t.id, t]));
const STRING_ENTRY = TYPE_BY_ID.get('string') as BuilderTypeEntry;

/** Resolve a type's gallery metadata (glyph / tone / desc); falls back to the string entry. */
export function typeMetaFor(type: string): BuilderTypeEntry {
  return TYPE_BY_ID.get(type) ?? STRING_ENTRY;
}

/** Format a wire value for display using the field's registered formatter. */
export function formatValue(value: unknown, field: FieldDefinition): ReactNode {
  return getFieldHandler(field.type).format(value, field);
}
