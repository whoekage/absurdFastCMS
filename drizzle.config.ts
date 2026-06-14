import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config — used ONLY for `drizzle-kit generate` (schema -> SQL migration files).
 * Migrations are APPLIED programmatically by `src/db/migrate.ts` (the `db:migrate` scripts), so
 * the env-file (.env / .env.test) controls which database is touched, never this config.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
