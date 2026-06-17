import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { createSql } from '../src/db/database.client.ts';
import { config } from '../src/config.ts';

/**
 * Per-FILE database isolation cloned from the golden template. createFileDatabase() opens a short-lived
 * admin handle, CREATE DATABASE t_<label>_<rand> TEMPLATE absurd_golden under a narrow advisory lock
 * (template-contention insurance), closes the admin handle, and returns a fresh per-file postgres.js
 * handle. dropFileDatabase() is best-effort: terminate lingering backends, then DROP. See
 * docs/research/testcontainers-testing.md.
 */

const GOLDEN_DB = 'absurd_golden';
// Fixed 64-bit key for the narrow CREATE-DATABASE lock (distinct from the golden-build + deleted catalog keys).
const CREATE_LOCK_KEY = 0x0c_7e_a7_e0;

export interface FileDatabase {
  name: string;
  sql: Sql;
  url: string;
}

function adminUrl(): string {
  // ADMIN_DATABASE_URL is set by globalSetup and propagates to each test child process via env-diff
  const fromEnv = config.adminDatabaseUrl;
  if (fromEnv) return fromEnv;
  throw new Error(
    'ADMIN_DATABASE_URL not set — --test-global-setup did not run/propagate. ' +
      'Ensure the test script passes --test-global-setup=./test/global-setup.ts',
  );
}

function urlForDb(admin: string, dbName: string): string {
  const u = new URL(admin); // preserve query params (sslmode etc.)
  u.pathname = `/${dbName}`;
  return u.href;
}

function buildName(label: string): string {
  const rand = randomBytes(6).toString('hex'); // 12 hex chars, 48 bits — collision-safe
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/^[^a-z]/, 'x');
  const prefix = 't_';
  const suffix = `_${rand}`;
  const room = 63 - prefix.length - suffix.length; // cap to NAMEDATALEN-1; truncate LABEL, never rand
  return `${prefix}${safeLabel.slice(0, room)}${suffix}`;
}

export async function createFileDatabase(label: string): Promise<FileDatabase> {
  const admin = adminUrl();
  const name = buildName(label);
  const adminSql = postgres(admin, { max: 1, onnotice: () => {} });
  try {
    const conn = await adminSql.reserve(); // session-scoped lock needs one dedicated backend
    try {
      await conn`SELECT pg_advisory_lock(${CREATE_LOCK_KEY})`;
      try {
        // CREATE DATABASE cannot run in a tx; name is built from a safe alphabet, quoted defensively.
        await conn.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${GOLDEN_DB}"`);
      } finally {
        await conn`SELECT pg_advisory_unlock(${CREATE_LOCK_KEY})`;
      }
    } finally {
      conn.release();
    }
  } finally {
    await adminSql.end({ timeout: 5 }); // never leave the admin pool open
  }
  const url = urlForDb(admin, name);
  return { name, sql: createSql(url), url };
}

export async function dropFileDatabase(name: string): Promise<void> {
  const adminSql = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    // DROP ... WITH (FORCE) (PG13+; default container is PG18) atomically terminates remaining backends
    // and drops, eliminating the terminate->DROP TOCTOU. Keep pg_terminate_backend as a fallback for an
    // escape-hatch external PG that might predate PG13.
    try {
      await adminSql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } catch {
      await adminSql`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = ${name} AND pid <> pg_backend_pid()
      `;
      await adminSql.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    }
  } catch (err) {
    console.warn(`dropFileDatabase(${name}) failed (best-effort):`, (err as Error).message);
  } finally {
    await adminSql.end({ timeout: 5 });
  }
}
