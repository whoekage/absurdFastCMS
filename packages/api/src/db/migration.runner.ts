import { pathToFileURL, fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { config } from '../config.ts';

/**
 * A tiny, dependency-free SQL migration runner (replaces the Drizzle migrator). Applies every
 * `migrations/*.sql` file in lexical order exactly once, tracked in a `_migrations` table, each in its
 * own transaction (Postgres DDL is transactional). Runs from the `db:migrate` scripts AND from test
 * `before()` hooks — mock-free, env-file-driven. SQL is authored by hand (these are real .sql files).
 */
// Resolve <package-root>/migrations INDEPENDENTLY of bundling depth. In the workspace this module is
// `src/db/migration.runner.ts` (package root = packages/api); published+bundled it is `dist/index.js`
// (package root = @conti/core). A fixed `../../` relative path breaks across those depths, so walk up to
// the nearest package.json either way, then `migrations/` (shipped in the package's `files`).
function findMigrationsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'package.json'))) return path.join(dir, 'migrations');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), 'migrations'); // last resort
}
const MIGRATIONS_DIR = findMigrationsDir();

export async function runMigrations(url = config.databaseUrl): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const already = await sql`SELECT 1 FROM _migrations WHERE name = ${file}`;
      if (already.length > 0) continue;
      const ddl = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
        await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      });
    }
  } finally {
    await sql.end();
  }
}

// Run directly: `node --env-file=.env src/db/migration.runner.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMigrations();
  console.log('migrations applied');
}
