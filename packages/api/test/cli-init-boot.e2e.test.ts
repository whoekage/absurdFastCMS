import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { createFileDatabase, dropFileDatabase } = await import('./db-per-file.ts');
const { freePort } = await import('./helpers.ts');
const { initProject } = await import('../../cli/src/cli.ts');

/**
 * Phase 3 (T4) — the full CLI path end-to-end over the REAL bin: `conti init` scaffolds a project, then a
 * spawned `conti start` boots it against a per-file Postgres on a free port, serves a content read, and
 * exits 0 on SIGTERM (graceful). The scaffolded project is created UNDER the repo root so its
 * `import '@conti/core'` resolves via the hoisted root node_modules. NO mocks.
 */

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../..');
const cliEntry = path.join(repoRoot, 'packages/cli/src/cli.ts');

let db: Awaited<ReturnType<typeof createFileDatabase>>;
let projectDir: string;
let child: ChildProcess | undefined;

before(async () => {
  db = await createFileDatabase('cliboot');
  projectDir = path.join(repoRoot, `.conti-cli-e2e-${process.pid}`);
  await initProject(projectDir);
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (db) {
    await db.sql.end();
    await dropFileDatabase(db.name);
  }
  if (projectDir) await rm(projectDir, { recursive: true, force: true });
});

function waitForLine(stream: NodeJS.ReadableStream, re: RegExp, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${re}`)), ms);
    let buf = '';
    stream.on('data', (chunk) => {
      buf += String(chunk);
      if (re.test(buf)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

test('conti init + conti start: scaffolded project boots and serves over the real bin', async () => {
  const port = await freePort();
  child = spawn(process.execPath, [cliEntry, 'start'], {
    cwd: projectDir,
    env: { ...process.env, DATABASE_URL: db.url, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await waitForLine(child.stdout!, /ready on/, 20_000);

  const res = await fetch(`http://127.0.0.1:${port}/api/article`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: unknown };
  assert.ok(Array.isArray(body.data), 'GET /article returns a {data:[...]} collection');

  child.kill('SIGTERM');
  const [code] = (await once(child, 'exit')) as [number | null];
  assert.equal(code, 0, 'graceful shutdown via SIGTERM exits 0');
});
