import postgres from 'postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../src/db/migration.runner.ts';
import { config } from '../src/config.ts';

/**
 * node:test --test-global-setup hook. Boots ONE Postgres (Testcontainers, reusable) OR uses an external
 * TEST_DATABASE_URL admin connection, builds the golden template `absurd_golden` ONCE (idempotently),
 * and exposes the admin URI to test child processes via process.env (the documented env-diff: mutating
 * process.env in globalSetup propagates to each test child process — undocumented in node:test but real).
 * See docs/research/testcontainers-testing.md.
 *
 * A failed globalSetup surfaces as a GLOBAL-SETUP error stack (which node:test reports), not as a per-file
 * ADMIN_DATABASE_URL "did not run" diagnostic — debug the golden-build/migration failure from that stack.
 *
 * NOTE on the reuse hash: `new PostgreSqlContainer('postgres:18-alpine')` below carries NO run-varying
 * config on purpose. Adding any per-run .withName()/.withEnvironment()/.withCommand() would change the
 * .withReuse() label hash and silently spawn a fresh container every run, defeating reuse.
 */

const GOLDEN_DB = 'absurd_golden';
// Distinct fixed 64-bit key for the golden-build critical section (NOT the per-file create key,
// NOT the deleted catalog key).
const GOLDEN_LOCK_KEY = 0x60_1d_e2_60;

// Module scope so globalTeardown sees what globalSetup created.
let container: StartedPostgreSqlContainer | undefined;

function reuseEnabled(): boolean {
  return config.testcontainersReuse;
}

function goldenUrlFrom(adminUri: string): string {
  const u = new URL(adminUri); // preserves user/pass/host/port AND query (?sslmode=...)
  u.pathname = `/${GOLDEN_DB}`;
  return u.href;
}

export async function globalSetup(): Promise<void> {
  // Use TEST_DATABASE_URL from config if available (external/compose pg).
  const external = config.testDatabaseUrl;
  let adminUri: string;

  if (external) {
    // escape-hatch: external/compose pg, admin/superuser-capable, NOT absurd_golden.
    let parsed: URL;
    try {
      parsed = new URL(external);
    } catch {
      throw new Error(
        `TEST_DATABASE_URL is not a valid URL: ${JSON.stringify(external)}. ` +
          'Set TEST_DATABASE_URL=postgres://<superuser>@host:port/<admin-db> to use an external Postgres.',
      );
    }
    if (parsed.pathname === `/${GOLDEN_DB}`) {
      throw new Error(
        `TEST_DATABASE_URL must NOT point at the golden template database "${GOLDEN_DB}". ` +
          'Point it at an admin/maintenance database (e.g. /postgres) — the suite creates and clones ' +
          'absurd_golden itself.',
      );
    }
    adminUri = external;
  } else {
    try {
      const builder = new PostgreSqlContainer('postgres:18-alpine');
      container = await (reuseEnabled() ? builder.withReuse() : builder).start();
    } catch (err) {
      throw new Error(
        'Could not start the Postgres test container (is Docker running?). ' +
          'To use an external Postgres instead, set TEST_DATABASE_URL=postgres://<superuser>@host:port/db and re-run. ' +
          `Underlying error: ${(err as Error).message}`,
      );
    }
    adminUri = container.getConnectionUri();
  }

  // Build / top-up the golden template, serialized against concurrent globalSetups via an advisory lock.
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    if (external) {
      // The escape-hatch admin role MUST be able to CREATE DATABASE, or every per-file clone fails
      // later with an opaque permission error. Probe up front and fail with actionable guidance.
      const [role] = await admin`
        SELECT current_user AS who, (rolcreatedb OR rolsuper) AS can_create
        FROM pg_roles WHERE rolname = current_user
      `;
      if (!role?.can_create) {
        throw new Error(
          `TEST_DATABASE_URL admin role "${role?.who}" lacks CREATEDB/superuser; per-file ` +
            'CREATE DATABASE clones would all fail. Grant CREATEDB or point TEST_DATABASE_URL at a superuser.',
        );
      }
    }
    // Hold GOLDEN_LOCK_KEY across the ENTIRE build (CREATE + migrate + sanity), not just the CREATE.
    // runMigrations' "SELECT 1 FROM _migrations / else INSERT+DDL" check is non-atomic, so two
    // concurrent globalSetups against the SAME reused container could both see a migration as
    // unapplied and double-execute its (non-IF-NOT-EXISTS) DDL — one side aborts and poisons the
    // run. The lock is held on `admin` (connected to the admin db, NOT golden), so holding it across
    // runMigrations attaches NO session to golden and does NOT block per-file clones (those serialize
    // on CREATE_LOCK_KEY in db-per-file.ts).
    await admin`SELECT pg_advisory_lock(${GOLDEN_LOCK_KEY})`;
    try {
      const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${GOLDEN_DB}`;
      // DRIFT HEAL (pre-launch drop & recreate, no backfill): the consolidated migrations/0001_init.sql is
      // applied ONCE per golden (tracked in _migrations by name), so EDITING it (e.g. be-05 adding the
      // component_* tables) would NOT re-apply onto a REUSED stale golden. Detect that drift by probing for
      // a sentinel table from the latest init; if golden exists but lacks it, DROP golden so it is recreated
      // fresh below and re-migrated from the current init. A non-reused (fresh) container has no golden, so
      // this is a no-op there.
      if (exists.length > 0) {
        const goldenProbe = postgres(goldenUrlFrom(adminUri), { max: 1, onnotice: () => {} });
        let drift = false;
        try {
          const t = await goldenProbe`SELECT to_regclass('public.component_types') AS reg`;
          drift = t[0]?.reg === null;
        } catch {
          drift = true;
        } finally {
          await goldenProbe.end({ timeout: 5 });
        }
        if (drift) {
          // Terminate lingering backends so DROP DATABASE is not blocked, then drop.
          await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${GOLDEN_DB} AND pid <> pg_backend_pid()`;
          await admin.unsafe(`DROP DATABASE IF EXISTS "${GOLDEN_DB}"`);
        }
      }
      const present = await admin`SELECT 1 FROM pg_database WHERE datname = ${GOLDEN_DB}`;
      if (present.length === 0) await admin.unsafe(`CREATE DATABASE "${GOLDEN_DB}"`);
      // ALWAYS migrate (idempotent via _migrations): tops up a reused/stale golden with new migrations.
      // runMigrations opens + ends its OWN handle; golden is connected to only inside this window.
      const goldenUrl = goldenUrlFrom(adminUri);
      await runMigrations(goldenUrl);
      // Sanity: golden actually got the schema before any file clones it.
      const golden = postgres(goldenUrl, { max: 1, onnotice: () => {} });
      try {
        const m = await golden`SELECT 1 FROM _migrations LIMIT 1`;
        if (m.length === 0)
          throw new Error('golden template has no applied migrations after runMigrations');
      } finally {
        await golden.end({ timeout: 5 });
      }
    } finally {
      await admin`SELECT pg_advisory_unlock(${GOLDEN_LOCK_KEY})`;
    }
  } catch (err) {
    // Setup failed after partial acquisition: don't leak a non-reuse container.
    if (container && !reuseEnabled()) await container.stop().catch(() => {});
    throw err;
  } finally {
    await admin.end({ timeout: 5 });
  }

  // Env-diff to child test processes (db-per-file.ts reads ADMIN_DATABASE_URL).
  process.env.ADMIN_DATABASE_URL = adminUri;
}

export async function globalTeardown(): Promise<void> {
  // Only stop what WE started, and only when not reusing (e.g. CI). Gate on startedHere (not just
  // reuse semantics) so this stays correct if the escape-hatch ever changes — we never touch an
  // external pg. On the TEST_DATABASE_URL escape-hatch we intentionally leave `absurd_golden` AND any
  // orphaned `t_*` per-file DBs (a file that crashes before its after() leaves one) for the operator
  // to reap — the external server accrues them across runs. The container default is self-cleaning
  // (everything dies with the container); `SELECT datname FROM pg_database WHERE datname LIKE 't\_%'`
  // is the manual sweep for the escape-hatch.
  const startedHere = container !== undefined;
  if (startedHere && !reuseEnabled()) await container!.stop().catch(() => {});
}
