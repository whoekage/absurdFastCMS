import { coerceI64, coerceDecimal, formatDecimal } from './column.ts';
import type { ContentTypeDef, RegistryField } from './registry.ts';
import { SYSTEM_COLUMN_NAMES } from './registry.ts';

/**
 * The WRITE-side counterpart to the query parser: validate + coerce a request body against a content-
 * type's REGISTRY def. Same doctrine as the read parser — strict, never a silent wrong write:
 *
 *   - the body must be a JSON object (not array/scalar/null);
 *   - `id` is server-assigned -> rejected with a dedicated message; created_at/updated_at -> unknown;
 *   - any key not in `def.writableByName` -> unknown field (mass-assignment + injection guard: a body
 *     key NEVER becomes a SQL identifier, and a near-miss like `Title` vs `title` is rejected);
 *   - every value is type-checked + coerced against its engine type (i64 -> canonical digit string,
 *     decimal -> canonical fixed-point string, json -> verbatim text; enum membership + varchar length
 *     pre-checked for a clean 400 that beats a PG 22001/23514 500); `null` only for a NULLABLE field;
 *   - `create` requires every NOT-NULL-without-default field; `update` (partial, Strapi semantics)
 *     requires at least one writable field but no specific one.
 *
 * Returns a plain object keyed by ENGINE field names, values coerced to their bound-param wire form.
 */
export class BodyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BodyParseError';
  }
}

export type WriteMode = 'create' | 'update';

export function validateBody(def: ContentTypeDef, raw: unknown, mode: WriteMode): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BodyParseError('request body must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (key === 'id') throw new BodyParseError('`id` is server-assigned and cannot be set');
    if (SYSTEM_COLUMN_NAMES.has(key)) throw new BodyParseError(`unknown field "${key}"`);
    if (!def.writableByName.has(key)) throw new BodyParseError(`unknown field "${key}"`);
  }

  const out: Record<string, unknown> = {};
  for (const f of def.writable) {
    if (!(f.name in obj)) continue;
    const v = obj[f.name];
    if (v === null) {
      if (!def.nullableNames.has(f.name)) throw new BodyParseError(`field "${f.name}" cannot be null`);
      out[f.name] = null;
      continue;
    }
    out[f.name] = coerce(f, v);
  }

  if (mode === 'create') {
    for (const req of def.requiredOnCreate) {
      if (!(req in out)) throw new BodyParseError(`missing required field "${req}"`);
    }
  } else if (Object.keys(out).length === 0) {
    throw new BodyParseError('update body has no writable fields');
  }

  return out;
}

/** Type-check + coerce one non-null value against its engine field. Coerce throws become 400s here. */
function coerce(field: RegistryField, v: unknown): unknown {
  const name = field.name;
  switch (field.type) {
    case 'i32':
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new BodyParseError(`field "${name}" must be an integer`);
      return v;
    case 'f64':
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new BodyParseError(`field "${name}" must be a finite number`);
      return v;
    case 'bool':
      if (typeof v !== 'boolean') throw new BodyParseError(`field "${name}" must be a boolean`);
      return v;
    case 'string': {
      if (typeof v !== 'string') throw new BodyParseError(`field "${name}" must be a string`);
      // Clean 400s that beat a PG CHECK (23514) / varchar truncation (22001) 500.
      if (field.enumValues !== undefined && !field.enumValues.includes(v)) {
        throw new BodyParseError(`field "${name}" must be one of the allowed values`);
      }
      if (field.length !== undefined && v.length > field.length) {
        throw new BodyParseError(`field "${name}" exceeds the maximum length ${field.length}`);
      }
      return v;
    }
    case 'text':
      if (typeof v !== 'string') throw new BodyParseError(`field "${name}" must be a string`);
      return v;
    case 'date': {
      if (typeof v !== 'string' && typeof v !== 'number') {
        throw new BodyParseError(`field "${name}" must be an ISO-8601 string or epoch-ms number`);
      }
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new BodyParseError(`field "${name}" is not a valid date`);
      return d;
    }
    case 'i64':
      // Coerce to the exact bigint then return its digit STRING (the bound/wire form for int8).
      try {
        return coerceI64(v).toString();
      } catch {
        throw new BodyParseError(`field "${name}" must be a valid bigint (integer string or safe number)`);
      }
    case 'decimal':
      // Coerce to the scaled mantissa then format the canonical fixed-point STRING (the bound form).
      try {
        const mantissa = coerceDecimal(v, field.scale!, field.precision);
        return formatDecimal(mantissa, field.scale!);
      } catch {
        throw new BodyParseError(`field "${name}" must be a valid decimal within its precision/scale`);
      }
    case 'json':
      // Return the PARSED JS value (object/array/scalar) bound straight to jsonb by postgres.js, which
      // serializes it to a real jsonb VALUE (NOT a quoted string scalar — binding a pre-stringified text
      // to ::jsonb would double-encode it into a jsonb string). A string body field is the raw jsonb text,
      // so it is JSON.parse'd here (also the malformed-JSON 400 gate); a value the HTTP edge already
      // JSON.parse'd is bound as-is. The write RESPONSE's verbatim bytes come from the DB's RETURNING
      // `::text` (the RawJson path), NOT from this value — so >2^53 fidelity is the loader's concern, not
      // this write path (the wire JSON.parse already collapsed any >2^53 int to a float upstream).
      try {
        const parsed = typeof v === 'string' ? JSON.parse(v) : v;
        // Re-serializability gate: a value that cannot round-trip through JSON (e.g. an unpaired surrogate
        // in a key/value, or a non-finite number) is rejected here rather than as a PG 22P02 500.
        const probe = JSON.stringify(parsed);
        if (typeof probe !== 'string') throw new Error('not serializable');
        if (probe.isWellFormed !== undefined && !probe.isWellFormed()) throw new Error('unpaired surrogate');
        return parsed;
      } catch {
        throw new BodyParseError(`field "${name}" must be valid JSON`);
      }
    default:
      // type-stripping does not typecheck — a missing arm is a runtime hole; fail LOUD.
      throw new BodyParseError(`field "${name}" has an unsupported write type`);
  }
}
