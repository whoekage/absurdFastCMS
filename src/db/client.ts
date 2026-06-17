import postgres from 'postgres';
import type { Sql } from 'postgres';
import { config } from '../config.ts';

/**
 * Open a postgres.js client to `DATABASE_URL` (dev from .env, test from .env.test — the env-file the
 * process was launched with decides). The caller OWNS the handle and must `await sql.end()` when done
 * (a worker keeps it for the process lifetime; tests close it in `after()`).
 *
 * postgres.js is the only DB layer: the boot load streams rows with `.cursor()`, writes are
 * parameterized template queries, and migrations run raw SQL files — no ORM in the stack.
 */
export function createSql(url = config.databaseUrl): Sql {
  return postgres(url, { max: 4, prepare: true });
}
