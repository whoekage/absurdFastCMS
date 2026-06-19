import { defineConfig, devices } from '@playwright/test';

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Playwright E2E config for @absurd/admin.
//
// These tests are MOCK-FREE end-to-end: Playwright drives a REAL Chromium against the REAL admin
// (Vite dev server on :5173), which proxies `/api` to the REAL API (:3000) backed by REAL Postgres.
// Nothing is stubbed — the specs create/read/update/delete through the actual stack and clean up
// after themselves so reruns are idempotent.
//
// SERVERS: the user runs both dev servers themselves (the project rule is to NEVER auto-run
// `npm run dev`). `webServer` below ONLY references the admin dev server and sets
// `reuseExistingServer: true`, so Playwright ATTACHES to the already-running admin instead of
// spawning one. The API (:3000) is deliberately NOT managed here — start it separately. The `command`
// is a fallback for a fully-local run; in normal use the running server is reused and `command`
// never executes.
// ──────────────────────────────────────────────────────────────────────────────────────────────

const ADMIN_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  // Each spec mutates shared server-side state for its own throwaway content type, so keep specs
  // serial within a file; across files Playwright still isolates by using distinct type api_ids.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: ADMIN_URL,
    trace: 'on-first-retry',
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Attach to the user-run admin dev server (never the API). reuseExistingServer keeps Playwright
  // from spawning a second Vite when one is already up.
  webServer: {
    command: 'npm run dev',
    url: ADMIN_URL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
