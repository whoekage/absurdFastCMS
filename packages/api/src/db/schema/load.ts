import { readdir } from 'node:fs/promises';
import { existsSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defToSchema, type TypeDef, type Hooks } from './define.ts';
import type { ContentTypeSchema } from './model.ts';

/**
 * The EDGE loader for the code-first source. The project's entity definitions live under `entities/`, ONE
 * FOLDER PER content-type (Strapi-style): `entities/<apiId>/schema.ts` (the {@link TypeDef}, required) +
 * `entities/<apiId>/hooks.ts` (the {@link Hooks}, optional). The apiId is the FOLDER NAME (renaming the
 * folder renames the type — the stable `id` keeps it lossless). `services.ts`/`controller.ts` (custom
 * logic) are reserved for a later release and not yet loaded.
 *
 * The reserved `entities/components/` grouping dir (component definitions) is skipped here — a content-type
 * folder is exactly a subdir that contains a `schema.ts`. Modules load via Node's native TS type-stripping
 * (no build); each resolves `@conti/core` exactly as `conti.config.ts` does. A missing dir is an EMPTY
 * catalog. Module caching is harmless: boot loads once, the CLI is a fresh process, and `migrate` takes the
 * IR directly (never re-imports).
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
  let dirents: Dirent[];
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { schemas: [], hooks: new Map() };
    throw e;
  }
  // An entity is a subdir holding a `schema.ts`. `components/` is the reserved component-definition group.
  const entityNames = dirents
    .filter((d) => d.isDirectory() && d.name !== 'components')
    .map((d) => d.name)
    .sort();
  const schemas: ContentTypeSchema[] = [];
  const hooks = new Map<string, Hooks>();
  for (const apiId of entityNames) {
    const schemaFile = path.join(dir, apiId, 'schema.ts');
    if (!existsSync(schemaFile)) continue; // a grouping dir, not an entity
    const mod = (await import(pathToFileURL(schemaFile).href)) as { default?: TypeDef };
    if (!mod.default || typeof mod.default !== 'object' || !('fields' in mod.default)) {
      throw new SchemaLoadError(`${apiId}/schema.ts`, 'must `export default defineType({ ... })`');
    }
    schemas.push(defToSchema(mod.default, apiId));
    const hooksFile = path.join(dir, apiId, 'hooks.ts');
    if (existsSync(hooksFile)) {
      const hmod = (await import(pathToFileURL(hooksFile).href)) as { default?: Hooks };
      if (hmod.default !== undefined) hooks.set(apiId, hmod.default);
    }
  }
  return { schemas, hooks };
}
