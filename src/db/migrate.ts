import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

/**
 * Apply pending Drizzle migrations to `DATABASE_URL` PROGRAMMATICALLY (no drizzle-kit CLI), so the
 * exact same code path runs from the `db:migrate` scripts AND from test `before()` hooks — mock-free,
 * env-file-driven. Migration SQL itself is always authored by `drizzle-kit generate`, never by hand.
 */
export async function runMigrations(url = process.env.DATABASE_URL): Promise<void> {
  if (!url) throw new Error('DATABASE_URL is not set (launch with --env-file=.env or .env.test)');
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: './drizzle' });
  } finally {
    await sql.end();
  }
}

// Run directly: `node --env-file=.env src/db/migrate.ts`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMigrations();
  console.log('migrations applied');
}
