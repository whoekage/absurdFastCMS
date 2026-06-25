import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defToSchema, type TypeDef, type Hooks } from './define.ts';
import type { ContentTypeSchema } from './model.ts';

/**
 * The EDGE loader for the code-first source: import every `schema/<apiId>.ts` module and introspect its
 * default-exported {@link TypeDef} into the internal {@link ContentTypeSchema} IR. The apiId is the file
 * stem (renaming the file renames the type — the stable `id` keeps it lossless). Modules are loaded via
 * Node's native TS type-stripping (no build step); each resolves `@conti/core` exactly as `conti.config.ts`
 * does. A missing dir is an EMPTY catalog (a fresh project).
 *
 * Module caching is intentional and harmless: boot loads once, the CLI is a fresh process per command, and
 * `migrate` consumes the IR directly (never re-imports), so a stale ESM cache never bites.
 */

export class SchemaLoadError extends Error {
  readonly file: string;
  constructor(file: string, reason: string) {
    super(`schema module ${JSON.stringify(file)}: ${reason}`);
    this.name = 'SchemaLoadError';
    this.file = file;
  }
}

/** The loaded catalog: the IR (for migrate/registry) + the lifecycle hooks keyed by apiId (for the write path). */
export interface LoadedTypes {
  schemas: ContentTypeSchema[];
  hooks: Map<string, Hooks>;
}

export async function loadTypes(dir: string): Promise<LoadedTypes> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { schemas: [], hooks: new Map() };
    throw e;
  }
  const files = entries.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.endsWith('.test.ts')).sort();
  const schemas: ContentTypeSchema[] = [];
  const hooks = new Map<string, Hooks>();
  for (const f of files) {
    const apiId = f.slice(0, -'.ts'.length);
    const mod = (await import(pathToFileURL(path.join(dir, f)).href)) as { default?: TypeDef };
    if (!mod.default || typeof mod.default !== 'object' || !('fields' in mod.default)) {
      throw new SchemaLoadError(f, 'must `export default defineType({ ... })`');
    }
    schemas.push(defToSchema(mod.default, apiId));
    if (mod.default.hooks !== undefined) hooks.set(apiId, mod.default.hooks);
  }
  return { schemas, hooks };
}
