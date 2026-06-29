import { readdir } from 'node:fs/promises';
import { existsSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defToSchema, type TypeDef, type Hooks } from './define.ts';
import type { Schema } from './model.ts';
import { AppError } from '../../errors/app-error.ts';

/**
 * The EDGE loader for the code-first source. The project's entity definitions live under `modules/`, ONE
 * FOLDER PER module (Strapi-style): `modules/<name>/schema.ts` (the {@link TypeDef}, required) +
 * `modules/<name>/hooks.ts` (the {@link Hooks}, optional). The name is the FOLDER NAME (renaming the
 * folder renames the type — the stable `id` keeps it lossless). `services.ts`/`controller.ts` (custom
 * logic) are reserved for a later release and not yet loaded.
 *
 * The reserved `modules/components/` grouping dir (component definitions) is skipped here — a module
 * folder is exactly a subdir that contains a `schema.ts`. Modules load via Node's native TS type-stripping
 * (no build); each resolves `@conti/core` exactly as `conti.config.ts` does. A missing dir is an EMPTY
 * catalog. Module caching is harmless: boot loads once, the CLI is a fresh process, and `migrate` takes the
 * IR directly (never re-imports).
 */

class SchemaLoadError extends AppError {
  readonly file: string;
  constructor(file: string, reason: string) {
    super('db.schema.load', { file: JSON.stringify(file), reason });
    this.file = file;
  }
}

/** The loaded catalog: the IR (for migrate/registry) + the lifecycle hooks keyed by name (for the write path). */
export interface LoadedTypes {
  schemas: Schema[];
  hooks: Map<string, Hooks>;
}

export async function loadTypes(dir: string): Promise<LoadedTypes> {
  return loadTypesImpl(dir, '');
}

/**
 * S6: re-import every entity module with a per-call cache-bust token (`?v=<token>` on BOTH schema.ts AND
 * hooks.ts) so an OUT-OF-BAND file edit is actually re-read — Node's ESM cache otherwise serves the stale
 * module. Used by the catalog-version hash + `POST /builder/reload`. Race-TOLERANT: an entry that vanishes
 * between `readdir` and `import` (a concurrent DELETE's `rm`) is SKIPPED, not thrown (boot `loadTypes` stays
 * fail-loud). The token MUST change per call (a stable token re-hits the cache).
 */
export async function loadTypesCacheBusted(dir: string, token: string): Promise<LoadedTypes> {
  return loadTypesImpl(dir, token);
}

async function loadTypesImpl(dir: string, token: string): Promise<LoadedTypes> {
  const bust = token === '' ? '' : `?v=${encodeURIComponent(token)}`;
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
  const schemas: Schema[] = [];
  const hooks = new Map<string, Hooks>();
  for (const name of entityNames) {
    const schemaFile = path.join(dir, name, 'schema.ts');
    if (!existsSync(schemaFile)) continue; // a grouping dir, not an entity
    let mod: { default?: TypeDef };
    try {
      mod = (await import(pathToFileURL(schemaFile).href + bust)) as { default?: TypeDef };
    } catch (e) {
      if (bust !== '' && (e as NodeJS.ErrnoException).code === 'ENOENT') continue; // vanished mid-walk (race) — skip
      throw e;
    }
    if (!mod.default || typeof mod.default !== 'object' || !('fields' in mod.default)) {
      throw new SchemaLoadError(`${name}/schema.ts`, 'must `export default defineSchema({ ... })`');
    }
    schemas.push(defToSchema(mod.default, name));
    const hooksFile = path.join(dir, name, 'hooks.ts');
    if (existsSync(hooksFile)) {
      const hmod = (await import(pathToFileURL(hooksFile).href + bust)) as { default?: Hooks };
      if (hmod.default !== undefined) hooks.set(name, hmod.default);
    }
  }
  return { schemas, hooks };
}
