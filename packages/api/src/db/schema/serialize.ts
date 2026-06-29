import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { schemaZ, type Schema } from './model.ts';
import { AppError } from '../../errors/app-error.ts';

/**
 * The FILE boundary for the files-first schema: parse + Zod-validate one `schema/<name>.json`, serialize
 * back to canonical text, and load a whole `schema/` directory. PURE except for the fs reads in
 * {@link loadSchemaDir}. All malformed input fails as a typed {@link SchemaFileError} that names the file
 * and the precise Zod path — a dev hand-editing JSON gets an actionable message, never a raw stack.
 */

export class SchemaFileError extends AppError {
  readonly file: string;
  constructor(file: string, reason: string) {
    super('db.schema.file', { file: JSON.stringify(file), reason });
    this.file = file;
  }
}

/** Parse + Zod-validate one schema file's TEXT into a {@link Schema}. `file` is error context. */
export function parseSchema(text: string, file = '<inline>'): Schema {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new SchemaFileError(file, `invalid JSON: ${(e as Error).message}`);
  }
  const result = schemaZ.safeParse(data);
  if (!result.success) {
    throw new SchemaFileError(file, result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '));
  }
  // The Zod output is structurally the explicit Schema; the cast bridges the
  // exactOptionalPropertyTypes `| undefined` drift between z.infer and the public interface (see model.ts).
  return result.data as Schema;
}

/** Serialize a {@link Schema} to canonical on-disk text (2-space indent, trailing newline). */
export function stringifySchema(schema: Schema): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

/**
 * Load every `*.json` in a schema directory into {@link Schema}s, sorted by filename for a
 * deterministic build order. A MISSING directory is an EMPTY catalog (valid — a fresh project before its
 * first type). Each file's stem MUST equal its `name` (so a rename touches the file name too, and the
 * route key `name` is always findable by name).
 */
export async function loadSchemaDir(dir: string): Promise<Schema[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const files = entries.filter((f) => f.endsWith('.json')).sort();
  const out: Schema[] = [];
  for (const f of files) {
    const text = await readFile(path.join(dir, f), 'utf8');
    const schema = parseSchema(text, f);
    const stem = f.slice(0, -'.json'.length);
    if (stem !== schema.name) {
      throw new SchemaFileError(f, `filename stem "${stem}" must equal name "${schema.name}"`);
    }
    out.push(schema);
  }
  return out;
}
