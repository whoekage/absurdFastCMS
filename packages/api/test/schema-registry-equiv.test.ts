import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { createContentType } from '../src/db/content-type.repository.ts';
import { Registry } from '../src/db/registry.ts';
import { ARTICLE_SEED_FIELDS } from '../src/db/seed.ts';
import { parseSchema } from '../src/db/schema/serialize.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { cleanCatalog } from './helpers.ts';

/**
 * S1-A ORACLE (real Postgres, no mocks) — the files-first SOURCE must produce a registry indistinguishable
 * from the meta SOURCE. Build the `article` def two ways: (1) the existing in-code seed fields →
 * `createContentType` → `Registry.build` (the TEMPORARY meta compat shim); (2) the committed
 * `schema/article.json` → `Registry.fromSchemas` (the PERMANENT file path). The two {@link ContentTypeDef}s
 * must be byte-identical — that equivalence is the proof S1 introduces no behaviour/byte regression.
 */

const articlePath = fileURLToPath(new URL('../schema/article.json', import.meta.url));

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;

before(async () => {
  db = await createFileDatabase('schemaequiv');
  sql = db.sql;
});
beforeEach(() => cleanCatalog(sql));
after(async () => {
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

test('fromSchemas(article.json) yields a ContentTypeDef byte-identical to the meta path', async () => {
  // (1) meta SOURCE: the in-code seed fields → meta tables → the temp shim.
  await createContentType(sql, { apiId: 'article', fields: ARTICLE_SEED_FIELDS });
  const metaDef = (await Registry.build(sql)).get('article');
  assert.ok(metaDef, 'meta path built an article def');

  // (2) file SOURCE: the committed schema/article.json → the permanent entry.
  const schema = parseSchema(await readFile(articlePath, 'utf8'), 'article.json');
  const fileDef = Registry.fromSchemas([schema]).get('article');
  assert.ok(fileDef, 'file path built an article def');

  // deepStrictEqual walks fields/fieldDefs/columnPlan/indexPlan + the Maps/Sets — order-independent for
  // Maps/Sets, order-sensitive for the projection arrays (both built from the same field order).
  assert.deepStrictEqual(fileDef, metaDef);
});
