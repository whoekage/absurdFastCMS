import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { contentTypeSchemaZ, type ContentTypeSchema } from './model.ts';

/**
 * The FILE boundary for the files-first schema: parse + Zod-validate one `schema/<apiId>.json`, serialize
 * back to canonical text, and load a whole `schema/` directory. PURE except for the fs reads in
 * {@link loadSchemaDir}. All malformed input fails as a typed {@link SchemaFileError} that names the file
 * and the precise Zod path — a dev hand-editing JSON gets an actionable message, never a raw stack.
 */

export class SchemaFileError extends Error {
  readonly file: string;
  constructor(file: string, reason: string) {
    super(`schema file ${JSON.stringify(file)}: ${reason}`);
    this.name = 'SchemaFileError';
    this.file = file;
  }
}

/** Parse + Zod-validate one schema file's TEXT into a {@link ContentTypeSchema}. `file` is error context. */
export function parseSchema(text: string, file = '<inline>'): ContentTypeSchema {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new SchemaFileError(file, `invalid JSON: ${(e as Error).message}`);
  }
  const result = contentTypeSchemaZ.safeParse(data);
  if (!result.success) {
    throw new SchemaFileError(file, result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '));
  }
  // The Zod output is structurally the explicit ContentTypeSchema; the cast bridges the
  // exactOptionalPropertyTypes `| undefined` drift between z.infer and the public interface (see model.ts).
  return result.data as ContentTypeSchema;
}

/** Serialize a {@link ContentTypeSchema} to canonical on-disk text (2-space indent, trailing newline). */
export function stringifySchema(schema: ContentTypeSchema): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

/**
 * Load every `*.json` in a schema directory into {@link ContentTypeSchema}s, sorted by filename for a
 * deterministic build order. A MISSING directory is an EMPTY catalog (valid — a fresh project before its
 * first type). Each file's stem MUST equal its `apiId` (so a rename touches the file name too, and the
 * route key `apiId` is always findable by name).
 */
export async function loadSchemaDir(dir: string): Promise<ContentTypeSchema[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const files = entries.filter((f) => f.endsWith('.json')).sort();
  const out: ContentTypeSchema[] = [];
  for (const f of files) {
    const text = await readFile(path.join(dir, f), 'utf8');
    const schema = parseSchema(text, f);
    const stem = f.slice(0, -'.json'.length);
    if (stem !== schema.apiId) {
      throw new SchemaFileError(f, `filename stem "${stem}" must equal apiId "${schema.apiId}"`);
    }
    out.push(schema);
  }
  return out;
}
