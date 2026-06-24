import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.ts';
import { defineConfig, loadConfigFromEnv, type ContiConfig } from '../src/compose/config.ts';

// This is a pure config-mapping unit test — it never opens a DB. `.env.test` sets DATABASE_URL only
// dynamically (per-file via the golden-template harness), which this file doesn't engage, so provide a
// string-only fallback (never connected). `??=` keeps any real value the harness may have set; node's
// test runner isolates each file in its own process, so the config-module cache cannot leak across files.
process.env.DATABASE_URL ??= 'postgres://localhost/conti_config_unit_test';

/**
 * T1 oracle: loadConfigFromEnv() is a pure structuring snapshot over the env-reading `config` module.
 * These assert the MAPPING (so a future typo — e.g. local.path <- publicBaseUrl — is caught) and the
 * CLI-port threading, without re-testing config's env precedence or needing a database.
 */

test('loadConfigFromEnv maps every field from the env-config module (no drift)', () => {
  const c = loadConfigFromEnv();
  assert.equal(c.database.url, config.databaseUrl);
  assert.equal(c.server.port, config.port());
  assert.equal(c.auth.secret, config.authSecret);
  assert.equal(c.cursor.secret, config.cursorSecret);
  assert.equal(c.storage.uploadMaxBytes, config.uploadMaxBytes);
  assert.equal(c.storage.local.path, config.localStoragePath);
  assert.equal(c.storage.local.publicBaseUrl, config.publicBaseUrl);
  assert.deepEqual(c.storage.s3, config.s3);
  assert.equal(c.i18n.defaultLocale, config.defaultLocale);
  assert.equal(c.debug.inspector, config.debugInspector);
});

test('loadConfigFromEnv threads the CLI port arg through config.port', () => {
  // Compared against config.port('54321') (not a literal) so the env-PORT-wins precedence is respected:
  // this proves the arg is threaded, regardless of whether PORT is set in the test env.
  assert.equal(loadConfigFromEnv('54321').server.port, config.port('54321'));
});

test('defineConfig is an identity helper for typed authoring', () => {
  const cfg: ContiConfig = {
    database: { url: 'postgres://example' },
    server: { port: 3000 },
    auth: { secret: 's' },
    cursor: { secret: 'c' },
    storage: { uploadMaxBytes: 1, local: { path: '/p', publicBaseUrl: 'http://x' } },
    i18n: { defaultLocale: 'en' },
    debug: { inspector: false },
  };
  assert.equal(defineConfig(cfg), cfg);
});
