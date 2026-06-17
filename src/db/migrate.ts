import { pathToFileURL, fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { config } from '../config.ts';

/**
 * A tiny, dependency-free SQL migration runner (replaces the Drizzle migrator). Applies every
 * `migrations/*.sql` file in lexical order exactly once, tracked in a `_migrations` table, each in its
 * own transaction (Postgres DDL is transactional). Runs from the `db:migrate` scripts AND from test
 * `before()` hooks — mock-free, env-file-driven. SQL is authored by hand (these are real .sql files).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

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

// Run directly: `node --env-file=.env src/db/migrate.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMigrations();
  console.log('migrations applied');
}
