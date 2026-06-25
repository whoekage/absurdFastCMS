import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTypes } from '../src/db/schema/load.ts';

/**
 * The code-first loader. Proves a real `entities/<apiId>/schema.ts` module (which imports `@conti/core`) is
 * dynamically imported + introspected into the IR (no build step), a missing dir is an empty catalog, and
 * a `hooks.ts` in the entity folder is paired (while `schema.ts` is the only thing loaded as a type).
 */

const entitiesDir = fileURLToPath(new URL('../entities', import.meta.url));

test('loadTypes imports entities/<apiId>/schema.ts modules into the IR', async () => {
  const { schemas } = await loadTypes(entitiesDir);
  const article = schemas.find((s) => s.apiId === 'article');
  assert.ok(article, 'article.ts was loaded + introspected');
  assert.equal(article!.id, 'ct_article');
  assert.deepEqual(article!.fields.map((f) => f.name), ['title', 'body', 'status', 'views', 'rating', 'active', 'publishedAt']);
  assert.ok(article!.fields.some((f) => f.name === 'status' && f.type === 'enumeration'));
});

test('loadTypes returns an empty catalog for a missing dir', async () => {
  const { schemas, hooks } = await loadTypes(path.join(entitiesDir, 'does-not-exist'));
  assert.deepEqual(schemas, []);
  assert.equal(hooks.size, 0);
});

test('loadTypes pairs entities/<apiId>/hooks.ts with its schema (apiId = folder name)', async () => {
  const dir = fileURLToPath(new URL('./fixtures/hooked', import.meta.url));
  const { schemas, hooks } = await loadTypes(dir);
  assert.deepEqual(schemas.map((s) => s.apiId), ['widget']); // folder name = apiId
  assert.ok(hooks.has('widget'));
  assert.ok(hooks.get('widget')!.beforeCreate, 'the folder hooks.ts was paired');
});
