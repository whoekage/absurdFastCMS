import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/cli.ts';

/**
 * T4 — `conti init` scaffold correctness. Asserts the files are WRITTEN with the right shape (no execution,
 * so a plain os tmpdir is fine). The full init -> conti start -> serve -> stop bin boot is the e2e in
 * packages/api/test (which has the Testcontainers Postgres infra).
 */

test('initProject scaffolds the two-file project + standard dirs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'conti-init-'));
  try {
    await initProject(dir, { name: 'my-cms' });
    for (const f of [
      'conti.config.ts',
      'bootstrap.ts',
      'package.json',
      '.env.example',
      '.gitignore',
      'extensions/.gitkeep',
      'generated/.gitkeep',
      // The demo module lives under modules/<apiId>/ (one folder per module) — the code-first source
      // of truth (the old standalone `schema/` dir was replaced by this per-module bundle).
      'modules/article/schema.ts',
      'modules/article/hooks.ts',
      'modules/article/services.ts',
      'modules/article/controller.ts',
    ]) {
      assert.ok(existsSync(path.join(dir, f)), `${f} was created`);
    }
    // The demo module schema is declared with the files-first `defineSchema` builder.
    assert.match(await readFile(path.join(dir, 'modules/article/schema.ts'), 'utf8'), /defineSchema\(/);
    const config = await readFile(path.join(dir, 'conti.config.ts'), 'utf8');
    assert.match(config, /from '@conti\/core'/);
    assert.match(config, /defineConfig\(loadConfigFromEnv\(\)\)/);
    assert.match(await readFile(path.join(dir, 'bootstrap.ts'), 'utf8'), /defineBootstrap/);
    const env = await readFile(path.join(dir, '.env.example'), 'utf8');
    assert.match(env, /AUTH_SECRET=[0-9a-f]{64}/, 'a fresh 32-byte AUTH_SECRET');
    assert.match(env, /CURSOR_SECRET=[0-9a-f]{64}/, 'a fresh 32-byte CURSOR_SECRET');
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as {
      name: string;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.name, 'my-cms');
    assert.equal(pkg.scripts.dev, 'conti dev');
    assert.equal(pkg.scripts.start, 'conti start');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('initProject refuses to overwrite an existing project', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'conti-init-'));
  try {
    await initProject(dir);
    await assert.rejects(initProject(dir), /already contains/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
