import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTypes } from '../src/db/schema/load.ts';

/**
 * Phase 3 — the code-first loader. Proves a real `schema/*.ts` module (which imports `@conti/core`) is
 * dynamically imported + introspected into the IR (no build step), and a missing dir is an empty catalog.
 */

const schemaDir = fileURLToPath(new URL('../schema', import.meta.url));

test('loadTypes imports schema/*.ts modules into the IR', async () => {
  const { schemas } = await loadTypes(schemaDir);
  const article = schemas.find((s) => s.apiId === 'article');
  assert.ok(article, 'article.ts was loaded + introspected');
  assert.equal(article!.id, 'ct_article');
  assert.deepEqual(article!.fields.map((f) => f.name), ['title', 'body', 'status', 'views', 'rating', 'active', 'publishedAt']);
  assert.ok(article!.fields.some((f) => f.name === 'status' && f.type === 'enumeration'));
});

test('loadTypes returns an empty catalog for a missing dir', async () => {
  const { schemas, hooks } = await loadTypes(path.join(schemaDir, 'does-not-exist'));
  assert.deepEqual(schemas, []);
  assert.equal(hooks.size, 0);
});
