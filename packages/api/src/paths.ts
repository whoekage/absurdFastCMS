import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Locate assets that @conti/core SHIPS inside its own package (the admin SPA, the SQL migrations). The one
 * hard requirement: this must resolve correctly both in the monorepo (this file runs as `src/paths.ts`,
 * package root = `packages/api`) AND when installed + bundled (everything collapses into `dist/index.js`,
 * package root = `node_modules/@conti/core`). A fixed `../` relative path breaks across those depths — the
 * exact bug class behind the admin-404 / migrations-ENOENT regressions.
 *
 * The idiomatic, layout-agnostic fix is to walk up from this module to its OWN `package.json` (cf.
 * sindresorhus/`pkg-dir`). It is depth-INDEPENDENT (works at any bundle depth) and needs no `exports`
 * plumbing or self-referencing, and it sidesteps the `require.resolve('@pkg/...')`-by-name pitfalls that
 * bite other CMSes under pnpm / non-hoisted layouts (e.g. directus/directus#14706).
 */
function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('@conti/core: could not locate the package root (no package.json on the path up from paths.ts)');
    dir = parent;
  }
}

/**
 * Absolute path to the prebuilt admin SPA shipped in @conti/core (`files: ["admin"]`, populated by
 * `npm run build:admin`). This is the value a generated `conti.config.ts` passes as `adminDir` so the
 * server serves the admin at the root — explicit and overridable, no boot-time fallback.
 */
export function adminBundleDir(): string {
  return path.join(packageRoot(), 'admin');
}

/** Absolute path to the SQL migrations shipped in @conti/core (`files: ["migrations"]`). */
export function migrationsDir(): string {
  return path.join(packageRoot(), 'migrations');
}
