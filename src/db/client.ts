import postgres from 'postgres';
import type { Sql } from 'postgres';

/**
 * Open a postgres.js client to `DATABASE_URL` (dev from .env, test from .env.test — the env-file the
 * process was launched with decides). The caller OWNS the handle and must `await sql.end()` when done
 * (a worker keeps it for the process lifetime; tests close it in `after()`).
 *
 * postgres.js is the only DB layer: the boot load streams rows with `.cursor()`, writes are
 * parameterized template queries, and migrations run raw SQL files — no ORM in the stack.
 */
export function createSql(url = process.env.DATABASE_URL): Sql {
  if (!url) throw new Error('DATABASE_URL is not set (launch with --env-file=.env or .env.test)');
  return postgres(url, { max: 4, prepare: true });
}
