import { coerceI64, coerceDecimal, formatDecimal } from './column.ts';
import type { ContentTypeDef, RegistryField, RelationMeta } from './registry.ts';
import { SYSTEM_COLUMN_NAMES } from './registry.ts';

/** The Postgres int4 PK upper bound — a related id must be a positive int4 (mirrors {@link write.ts}). */
const MAX_INT4 = 2147483647;

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

/**
 * `create` requires every NOT-NULL-without-default field; `update` (partial) requires at least one
 * writable/relation field; `variant` (i18n variant create) requires NOTHING (a variant whose fields are
 * all SHARED is copied from the sibling, so an empty body is valid — the controller re-checks that every
 * required LOCALIZED field is present). All three type-check + coerce each PRESENT field identically.
 */
export type WriteMode = 'create' | 'update' | 'variant';

/**
 * One validated relation mutation parsed off the body. `field` is the relation API key (a Map-lookup key
 * ONLY — it NEVER becomes a SQL identifier; the link table + columns are resolved from the relation meta
 * by the link-mutation layer). `ids` are deduped, validated positive int4s. `set` REPLACES the owner's
 * related set ([] clears); `connect` ADDS (cardinality maintained); `disconnect` REMOVES specific edges.
 */
export interface RelationOp {
  field: string;
  op: 'set' | 'connect' | 'disconnect';
  ids: number[];
}

/** The split body: scalar `data` (byte-identical to the pre-relations return) + the relation ops. */
export interface ParsedBody {
  data: Record<string, unknown>;
  relationOps: RelationOp[];
}

export function validateBody(def: ContentTypeDef, raw: unknown, mode: WriteMode): ParsedBody {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BodyParseError('request body must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  const relationOps: RelationOp[] = [];
  for (const key of Object.keys(obj)) {
    if (key === 'id') throw new BodyParseError('`id` is server-assigned and cannot be set');
    if (SYSTEM_COLUMN_NAMES.has(key)) throw new BodyParseError(`unknown field "${key}"`);
    if (def.writableByName.has(key)) continue; // scalar -> handled by the coerce loop below.
    const meta = def.relationsByField.get(key);
    if (meta === undefined) throw new BodyParseError(`unknown field "${key}"`); // SAME message as before.
    parseRelationValue(meta, obj[key], relationOps);
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
  } else if (mode === 'update' && Object.keys(out).length === 0 && relationOps.length === 0) {
    throw new BodyParseError('update body has no writable or relation fields');
  }
  // mode === 'variant': require NOTHING here (an all-shared variant carries no body) — the caller
  // re-checks required LOCALIZED fields after merging the sibling's shared copy.

  return { data: out, relationOps };
}

/**
 * Parse one relation field value into 0..2 {@link RelationOp}s appended to `out`. Grammar:
 *   - bare `id` (number) or `[ids]` (array) -> shorthand for `set`;
 *   - `{ set | connect | disconnect: id|[ids] }` -> the explicit ops; `set` is MUTUALLY EXCLUSIVE with
 *     connect/disconnect; connect + disconnect together is allowed (emitted disconnect-THEN-connect so a
 *     connect wins any overlap, matching Strapi);
 *   - `null` / any other primitive / an object with an unknown key -> 400.
 * A to-one (oneToOne / manyToOne) accepts at most ONE id for set/connect (disconnect of >1 is allowed,
 * extras are no-ops). `meta.kind` is ALREADY this side's cardinality: the owning row stores `spec.kind`,
 * the inverse row stores `inverseKind(spec.kind)` (content-type-repo) — so it needs NO further flip here.
 */
function parseRelationValue(meta: RelationMeta, value: unknown, out: RelationOp[]): void {
  const field = meta.field;
  const isToOne = meta.kind === 'oneToOne' || meta.kind === 'manyToOne';

  if (value === null) {
    throw new BodyParseError(`relation field "${field}" cannot be null (use set: [] to clear)`);
  }
  if (typeof value === 'number' || Array.isArray(value)) {
    out.push({ field, op: 'set', ids: normalizeIds(meta, isToOne, 'set', value) });
    return;
  }
  if (typeof value !== 'object') {
    throw new BodyParseError(`relation field "${field}" must be an id, array of ids, or a {set|connect|disconnect} object`);
  }

  const o = value as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k !== 'set' && k !== 'connect' && k !== 'disconnect') throw new BodyParseError(`relation field "${field}" has an invalid value`);
  }
  const hasSet = 'set' in o;
  const hasConnect = 'connect' in o;
  const hasDisconnect = 'disconnect' in o;
  if (!hasSet && !hasConnect && !hasDisconnect) throw new BodyParseError(`relation field "${field}" must specify set, connect, or disconnect`);
  if (hasSet && (hasConnect || hasDisconnect)) throw new BodyParseError(`relation field "${field}": set cannot be combined with connect/disconnect`);

  if (hasSet) {
    out.push({ field, op: 'set', ids: relIds(meta, isToOne, 'set', field, o.set) });
    return;
  }
  // disconnect THEN connect (deterministic; a connect wins any overlapping id).
  if (hasDisconnect) out.push({ field, op: 'disconnect', ids: relIds(meta, isToOne, 'disconnect', field, o.disconnect) });
  if (hasConnect) out.push({ field, op: 'connect', ids: relIds(meta, isToOne, 'connect', field, o.connect) });
}

/** Validate an op's value is an id or array of ids, then normalize (else a 400 naming the op). */
function relIds(meta: RelationMeta, isToOne: boolean, op: 'set' | 'connect' | 'disconnect', field: string, raw: unknown): number[] {
  if (typeof raw !== 'number' && !Array.isArray(raw)) {
    throw new BodyParseError(`relation field "${field}": ${op} must be an id or array of ids`);
  }
  return normalizeIds(meta, isToOne, op, raw);
}

/** Validate every id (positive int4 integer), dedup (first-seen order), and apply the to-one cap. */
function normalizeIds(meta: RelationMeta, isToOne: boolean, op: 'set' | 'connect' | 'disconnect', raw: unknown): number[] {
  const arr = Array.isArray(raw) ? raw : [raw];
  for (const v of arr) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > MAX_INT4) {
      throw new BodyParseError(`relation field "${meta.field}": ids must be positive integers`);
    }
  }
  const ids = [...new Set(arr as number[])];
  if (isToOne && (op === 'set' || op === 'connect') && ids.length > 1) {
    throw new BodyParseError(`relation field "${meta.field}" is to-one and accepts at most one id`);
  }
  return ids;
}

/**
 * be-04 MEDIA: validate + normalize a media field's body value into the bound wire form. SINGLE accepts
 * a bare positive-int4 id (or, leniently, a single-element array) -> a NUMBER bound straight to the int4
 * column. MULTIPLE accepts an id or an array of ids -> a deduped NUMBER[] bound to the jsonb column
 * (postgres.js serializes the JS array to a real jsonb array, NOT a quoted string). Every id is a
 * positive int4 (mirrors the relation id rule + write.handler's MAX_INT4 guard); a non-int / <=0 / >int4
 * id is a clean 400 that beats a PG 22003. The id's EXISTENCE in `files` is checked later in
 * write.handler (the body parser is sync + has no DB); a deleted-asset id simply populates as skipped.
 */
function coerceMedia(field: RegistryField, multiple: boolean, v: unknown): unknown {
  const name = field.name;
  const validId = (x: unknown): x is number =>
    typeof x === 'number' && Number.isInteger(x) && x > 0 && x <= MAX_INT4;
  if (!multiple) {
    // Single: a bare id, or a 1-element array (lenient — clients sometimes send `[id]`).
    if (Array.isArray(v)) {
      if (v.length === 0) throw new BodyParseError(`media field "${name}" is single-valued (use null to clear)`);
      if (v.length > 1) throw new BodyParseError(`media field "${name}" is single-valued and accepts at most one id`);
      v = v[0];
    }
    if (!validId(v)) throw new BodyParseError(`media field "${name}" must be a positive integer file id`);
    return v;
  }
  // Multiple: an id or an array of ids -> a deduped (first-seen order) array of positive int4s.
  const arr = Array.isArray(v) ? v : [v];
  for (const x of arr) {
    if (!validId(x)) throw new BodyParseError(`media field "${name}" must be a positive integer file id or an array of them`);
  }
  return [...new Set(arr as number[])];
}

/** Type-check + coerce one non-null value against its engine field. Coerce throws become 400s here. */
function coerce(field: RegistryField, v: unknown): unknown {
  const name = field.name;
  // be-04 MEDIA: a media field is a real scalar column (engine i32 single / json multiple) but its VALUE
  // is a file-id reference with cardinality + positive-int4 rules — coerce it HERE before the generic
  // engine-type switch (which would accept any integer / any JSON for i32 / json).
  if (field.media !== undefined) return coerceMedia(field, field.media.multiple, v);
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
