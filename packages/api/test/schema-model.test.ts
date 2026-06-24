import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSchema, stringifySchema, loadSchemaDir, SchemaFileError } from '../src/db/schema/serialize.ts';
import { schemaToRows, SchemaAdaptError } from '../src/db/schema/adapt.ts';
import type { ContentTypeSchema } from '../src/db/schema/model.ts';

/**
 * S1-A — the PURE files-first schema layer (no DB). Validates the committed demo `schema/article.json`
 * parses + round-trips, that `schemaToRows` resolves the file through the SAME catalog the meta writer
 * uses, that the Zod boundary rejects malformed input with a typed error, and the dir loader's
 * stem===apiId guard. The real meta↔file EQUIVALENCE (byte-identical defs) lives in the real-PG test.
 */

const articlePath = fileURLToPath(new URL('../schema/article.json', import.meta.url));

test('committed article.json parses, round-trips, and adapts to expected meta rows', async () => {
  const schema = parseSchema(await readFile(articlePath, 'utf8'), 'article.json');
  assert.equal(schema.apiId, 'article');
  assert.equal(schema.fields.length, 7);

  // Canonical serialize round-trips with no loss.
  assert.deepEqual(parseSchema(stringifySchema(schema)), schema);

  const { ct, fieldRows, relationRows } = schemaToRows(schema);
  assert.equal(ct.api_id, 'article');
  assert.equal(ct.table_name, 'ct_article');
  assert.equal(ct.draft_publish, false);
  assert.equal(ct.i18n, false);
  assert.equal(relationRows.length, 0);

  assert.deepEqual(fieldRows.map((r) => r.name), ['title', 'body', 'status', 'views', 'rating', 'active', 'publishedAt']);
  // sort is the array index (the byte-identical projection order).
  assert.deepEqual(fieldRows.map((r) => r.sort), [0, 1, 2, 3, 4, 5, 6]);
  // cms_type is the declared `type` verbatim; engine_type is catalog-resolved.
  assert.deepEqual(fieldRows.map((r) => r.cms_type), ['string', 'text', 'enumeration', 'integer', 'float', 'boolean', 'datetime']);
  assert.deepEqual(fieldRows.map((r) => r.engine_type), ['string', 'text', 'string', 'i32', 'f64', 'bool', 'date']);
  assert.deepEqual(fieldRows.map((r) => r.nullable), [true, false, false, true, true, false, false]);
  // enum members ride `params.values`; the read registry eq-indexes them.
  const status = fieldRows.find((r) => r.name === 'status')!;
  assert.deepEqual(status.params['values'], ['draft', 'published', 'archived']);
});

test('Zod boundary rejects malformed schema input as a typed SchemaFileError', () => {
  assert.throws(() => parseSchema('{ not json', 'x.json'), SchemaFileError);
  // unknown field type
  assert.throws(() => parseSchema(JSON.stringify({ id: 'ct_a', apiId: 'a', fields: [{ id: 'f_a', name: 'a', type: 'nope' }] })), SchemaFileError);
  // unknown top-level key (.strict())
  assert.throws(() => parseSchema(JSON.stringify({ id: 'ct_a', apiId: 'a', fields: [], bogus: 1 })), SchemaFileError);
  // malformed id (no prefix_tail shape)
  assert.throws(() => parseSchema(JSON.stringify({ id: 'BADID', apiId: 'a', fields: [] })), SchemaFileError);
  // missing required apiId
  assert.throws(() => parseSchema(JSON.stringify({ id: 'ct_a', fields: [] })), SchemaFileError);
});

test('loadSchemaDir: empty for a missing dir, sorted load, stem===apiId guard', async () => {
  assert.deepEqual(await loadSchemaDir(path.join(tmpdir(), 'conti-no-such-dir-xyz')), []);

  const dir = await mkdtemp(path.join(tmpdir(), 'conti-schema-'));
  try {
    const good: ContentTypeSchema = { id: 'ct_b', apiId: 'beta', fields: [{ id: 'f_n', name: 'n', type: 'integer', options: { nullable: true } }] };
    const alpha: ContentTypeSchema = { id: 'ct_a', apiId: 'alpha', fields: [] };
    await writeFile(path.join(dir, 'beta.json'), stringifySchema(good));
    await writeFile(path.join(dir, 'alpha.json'), stringifySchema(alpha));
    const loaded = await loadSchemaDir(dir);
    assert.deepEqual(loaded.map((s) => s.apiId), ['alpha', 'beta']); // filename-sorted

    // stem must equal apiId.
    await writeFile(path.join(dir, 'wrong.json'), stringifySchema(good)); // apiId 'beta' != stem 'wrong'
    await assert.rejects(loadSchemaDir(dir), SchemaFileError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('schemaToRows rejects relation-bearing schemas (deferred to a later slice)', () => {
  const withRel: ContentTypeSchema = {
    id: 'ct_p',
    apiId: 'post',
    fields: [{ id: 'f_t', name: 'title', type: 'string', options: { nullable: true } }],
    relations: [{ id: 'rel_a', field: 'author', kind: 'manyToOne', target: 'user' }],
  };
  assert.throws(() => schemaToRows(withRel), SchemaAdaptError);
});
