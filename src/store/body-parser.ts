import type { ColumnType } from './column.ts';
import { ARTICLE_WRITABLE, ARTICLE_NULLABLE, ARTICLE_REQUIRED_ON_CREATE } from './content-type.ts';

/**
 * The WRITE-side counterpart to the query parser: validate + coerce a request body against the
 * `article` schema. Same doctrine as the read parser — strict, never a silent wrong write:
 *
 *   - the body must be a JSON object (not array/scalar/null);
 *   - `id` is server-assigned — sending it is rejected;
 *   - an unknown field is rejected;
 *   - every value is type-checked against its {@link ColumnType} (and coerced: a `date` becomes a JS
 *     `Date`); `null` is allowed only for a NULLABLE field;
 *   - `create` additionally requires every NOT-NULL-without-default field; `update` (partial, Strapi
 *     semantics) requires at least one writable field but no specific one.
 *
 * Returns a plain object keyed by ENGINE field names (camelCase), values coerced for Postgres.
 */
export class BodyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BodyParseError';
  }
}

export type WriteMode = 'create' | 'update';

export function parseArticleBody(raw: unknown, mode: WriteMode): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BodyParseError('request body must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const writable = new Map<string, ColumnType>(ARTICLE_WRITABLE.map((f) => [f.name, f.type]));

  for (const key of Object.keys(obj)) {
    if (key === 'id') throw new BodyParseError('`id` is server-assigned and cannot be set');
    if (!writable.has(key)) throw new BodyParseError(`unknown field "${key}"`);
  }

  const out: Record<string, unknown> = {};
  for (const f of ARTICLE_WRITABLE) {
    if (!(f.name in obj)) continue;
    const v = obj[f.name];
    if (v === null) {
      if (!ARTICLE_NULLABLE.has(f.name)) throw new BodyParseError(`field "${f.name}" cannot be null`);
      out[f.name] = null;
      continue;
    }
    out[f.name] = coerce(f.name, f.type, v);
  }

  if (mode === 'create') {
    for (const req of ARTICLE_REQUIRED_ON_CREATE) {
      if (!(req in out)) throw new BodyParseError(`missing required field "${req}"`);
    }
  } else if (Object.keys(out).length === 0) {
    throw new BodyParseError('update body has no writable fields');
  }

  return out;
}

/** Type-check (and where needed coerce) a single non-null value against its column type. */
function coerce(name: string, type: ColumnType, v: unknown): unknown {
  switch (type) {
    case 'i32':
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new BodyParseError(`field "${name}" must be an integer`);
      return v;
    case 'f64':
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new BodyParseError(`field "${name}" must be a finite number`);
      return v;
    case 'bool':
      if (typeof v !== 'boolean') throw new BodyParseError(`field "${name}" must be a boolean`);
      return v;
    case 'string':
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
    // i64 / decimal / json are not in the article schema; this write path is article-only. A future
    // dynamic-content write of one of these types must fail LOUDLY here rather than silently return
    // undefined (type-stripping does not typecheck, so a missing arm is a runtime hole).
    default:
      throw new BodyParseError(`field "${name}" has unsupported write type "${type}"`);
  }
}
