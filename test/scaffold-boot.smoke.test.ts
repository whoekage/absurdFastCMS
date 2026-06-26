import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * END-TO-END distribution smoke test — the one that guards the whole "monorepo vs installed package" bug
 * class (admin-404, migrations-ENOENT, .storage-in-node_modules) AND the runtime admin-config wiring. It
 * exercises the REAL chain with NO mocks: publish @conti/* to the local Verdaccio registry → `conti init` a
 * throwaway project → `npm install` (so @conti/core is a genuinely INSTALLED + bundled package, not a
 * workspace symlink) → `conti migrate` + `conti start` against a REAL Postgres (testcontainers) → assert the
 * admin SPA serves at `/`, the content API serves under `/api`, and `server.publicUrl` injects the API base
 * into the admin index at runtime. If any package-relative path or wiring regresses, this goes red.
 *
 * Heavy + Docker-bound, so it is NOT part of the unit suite — run via `npm run test:smoke`. Requires a
 * running Verdaccio (`npm run registry`) and a Docker daemon (for the Postgres container).
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = process.env.CONTI_REGISTRY ?? 'http://localhost:4873/';
const HOOK = { timeout: 600_000 };

let pg: StartedPostgreSqlContainer | undefined;
let projectDir: string | undefined;
let conti = '';
let baseEnv: NodeJS.ProcessEnv = {};
let base = '';
const children: ChildProcess[] = [];

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

/** Boot the installed `conti start` on `port` with extra env, wait until the content API answers. */
async function boot(port: number, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  const base = `http://127.0.0.1:${port}`;
  let log = '';
  const child = spawn(conti, ['start'], { cwd: projectDir, env: { ...baseEnv, ...extraEnv, PORT: String(port) } });
  children.push(child);
  child.stdout?.on('data', (d) => (log += d));
  child.stderr?.on('data', (d) => (log += d));
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${base}/api/article`)).ok) return base;
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  throw new Error(`server did not become ready on ${base}\n--- server log ---\n${log}`);
}

before(async () => {
  // Preflight: the registry must be up — this test is meaningless without it (fail loud, don't skip).
  assert.ok(await reachable(REGISTRY), `Verdaccio not reachable at ${REGISTRY} — start it with \`npm run registry\``);

  // 1) Publish the CURRENT @conti/* (built JS) + uWS tarball, so the install below pulls today's code.
  if (process.env.SMOKE_SKIP_PUBLISH !== '1') {
    execFileSync('npm', ['run', 'publish:local'], { cwd: REPO, stdio: 'inherit' });
  }

  // 2) Real Postgres.
  pg = await new PostgreSqlContainer('postgres:18-alpine').start();

  // 3) Scaffold (init only writes files; the runtime-critical migrate/start below run the INSTALLED bin).
  const parent = mkdtempSync(path.join(tmpdir(), 'conti-smoke-'));
  projectDir = path.join(parent, 'app');
  execFileSync('node', [path.join(REPO, 'packages/cli/src/cli.ts'), 'init', projectDir], { stdio: 'inherit' });

  // 4) Point the install at Verdaccio and install — @conti/core + @conti/cli + uWS all from local.
  writeFileSync(path.join(projectDir, '.npmrc'), `registry=${REGISTRY}\nlegacy-peer-deps=true\n`);
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: projectDir, stdio: 'inherit' });

  conti = path.join(projectDir, 'node_modules/.bin/conti');
  assert.ok(existsSync(conti), 'installed @conti/cli bin (node_modules/.bin/conti) is missing');
  baseEnv = {
    ...process.env,
    DATABASE_URL: pg.getConnectionUri(),
    AUTH_SECRET: 'smoke-test-auth-secret-0123456789',
    CURSOR_SECRET: 'smoke-test-cursor-secret-0123456789',
  };

  // 5) Migrate (proves the SQL migrations ship + resolve from the installed package).
  execFileSync(conti, ['migrate'], { cwd: projectDir, env: baseEnv, stdio: 'inherit' });

  // 6) Boot the default (same-origin) server once; tests 1-4 share it. The publicUrl test boots its own.
  base = await boot(31599);
}, HOOK);

after(async () => {
  for (const c of children) c.kill('SIGTERM');
  await sleep(300);
  if (pg) await pg.stop();
  if (projectDir) rmSync(path.dirname(projectDir), { recursive: true, force: true });
}, HOOK);

test('content API serves under /api', { timeout: 60_000 }, async () => {
  const r = await fetch(`${base}/api/article`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as { data: unknown[] };
  assert.ok(Array.isArray(body.data), `expected a data array, got ${JSON.stringify(body)}`);
});

test('admin SPA index serves at the root (same-origin: no injected config)', { timeout: 60_000 }, async () => {
  for (const p of ['/', '/index.html']) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 200, `${p} should be 200`);
    const html = await r.text();
    assert.match(html, /<!doctype html>/i, `${p} should serve the admin index HTML`);
    assert.doesNotMatch(html, /__CONTI__/, `${p} same-origin must be served untouched (no runtime config)`);
  }
});

test('admin SPA deep-link falls back to index (client routing)', { timeout: 60_000 }, async () => {
  const r = await fetch(`${base}/modules`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<!doctype html>/i);
});

test('admin static assets are shipped + served', { timeout: 60_000 }, async () => {
  const assetsDir = path.join(projectDir!, 'node_modules/@conti/core/admin/assets');
  const asset = readdirSync(assetsDir).find((f) => f.endsWith('.js'));
  assert.ok(asset, 'no JS asset found in the installed admin bundle');
  const r = await fetch(`${base}/assets/${asset}`);
  assert.equal(r.status, 200, `/assets/${asset} should be 200`);
});

test('server.publicUrl injects the absolute API base into the admin index at runtime', HOOK, async () => {
  // Cross-origin admin: CONTI_PUBLIC_URL → the served index carries window.__CONTI__.apiBase = <url>/api,
  // with NO rebuild of the prebuilt admin bundle. This is the whole point of the runtime-config design.
  const altBase = await boot(31600, { CONTI_PUBLIC_URL: 'https://example.com' });
  const html = await (await fetch(`${altBase}/`)).text();
  assert.match(html, /window\.__CONTI__=\{"apiBase":"https:\/\/example\.com\/api"\}/, 'apiBase must be injected');
});
