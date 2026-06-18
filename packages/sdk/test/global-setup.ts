/**
 * node:test --test-global-setup hook for the @absurd/sdk integration suite.
 *
 * The SDK is tested against a REAL @absurd/api server backed by a REAL Testcontainers Postgres, so the
 * harness reuses the api suite's golden-template machinery byte-for-byte: this module just re-exports the
 * api globalSetup/globalTeardown. They boot ONE Postgres (Testcontainers, reusable) OR use an external
 * TEST_DATABASE_URL admin connection, build the golden template `absurd_golden` ONCE (idempotently), and
 * expose ADMIN_DATABASE_URL to test child processes via the process.env env-diff. db-per-file.ts then
 * clones a fresh per-file DB from golden for each test file.
 *
 * @absurd/api has no public `exports`, so the harness imports its internals by relative path
 * (packages/api/src/... and packages/api/test/...) — permitted for the test harness only (see ROADMAP
 * Slice 3.5). Env comes from packages/sdk/.env.test (NODE_ENV=test), wired via the package.json test
 * script's --env-file=.env.test.
 */
export { globalSetup, globalTeardown } from '../../api/test/global-setup.ts';
