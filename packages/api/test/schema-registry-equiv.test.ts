import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { createContentType } from '../src/db/content-type.repository.ts';
import { Registry } from '../src/db/registry.ts';
import { ARTICLE_SEED_FIELDS } from '../src/db/seed.ts';
import { parseSchema } from '../src/db/schema/serialize.ts';
import type { ContentTypeSchema } from '../src/db/schema/model.ts';
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

test('fromSchemas builds two-way relation metadata identical to the meta path (owner + inverse)', async () => {
  // meta SOURCE: writer first, then post with a two-way manyToOne -> writer (inverse `posts`).
  await createContentType(sql, { apiId: 'writer', fields: [{ name: 'name', cmsType: 'string', options: { nullable: true } }] });
  await createContentType(sql, {
    apiId: 'post',
    fields: [{ name: 'title', cmsType: 'string', options: { nullable: true } }],
    relations: [{ field: 'author', kind: 'manyToOne', target: 'writer', inverseField: 'posts' }],
  });
  const metaReg = await Registry.build(sql);

  // file SOURCE: the same two types as schema objects (relations declared on the owner only).
  const writer: ContentTypeSchema = { id: 'ct_w', apiId: 'writer', fields: [{ id: 'f_nm', name: 'name', type: 'string', options: { nullable: true } }] };
  const post: ContentTypeSchema = {
    id: 'ct_p',
    apiId: 'post',
    fields: [{ id: 'f_ti', name: 'title', type: 'string', options: { nullable: true } }],
    relations: [{ id: 'rel_au', field: 'author', kind: 'manyToOne', target: 'writer', inverseField: 'posts' }],
  };
  const fileReg = Registry.fromSchemas([writer, post]);

  // The owner RelationMeta (post.author) and the synthesized inverse (writer.posts) must match byte-for-byte.
  assert.deepStrictEqual(fileReg.get('post')!.relationsByField.get('author'), metaReg.get('post')!.relationsByField.get('author'));
  assert.deepStrictEqual(fileReg.get('writer')!.relationsByField.get('posts'), metaReg.get('writer')!.relationsByField.get('posts'));
});
