import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject } from '../src/cli.ts';

/**
 * T2 — the CLI's project resolution (cwd → conti.config.ts + optional bootstrap.ts). A pure unit test:
 * it never opens a DB. conti.config.ts evaluates loadConfigFromEnv() at import (reads DATABASE_URL), so a
 * dummy string is provided; the full `conti start` bin boot is exercised end-to-end against a real PG by
 * the T4 fixture e2e.
 */
process.env.DATABASE_URL ??= 'postgres://localhost/conti_cli_unit';

// @conti/core (packages/api) is itself a valid conti project — it ships conti.config.ts + bootstrap.ts.
const projectDir = path.resolve(fileURLToPath(import.meta.url), '../../../api');

test('loadProject resolves conti.config.ts + bootstrap.ts from a project dir', async () => {
  const { config, lifecycle } = await loadProject(projectDir);
  assert.ok(config.database?.url, 'config.database.url is present');
  assert.equal(typeof config.server?.port, 'number', 'config.server.port is a number');
  assert.equal(typeof lifecycle, 'object', 'lifecycle is an object');
  assert.equal(typeof lifecycle.onAfterStart, 'function', "the project's bootstrap.ts onAfterStart loaded");
});

test('loadProject throws a clear error when no config exists', async () => {
  await assert.rejects(loadProject('/nonexistent/conti/project'), /no config at/);
});
