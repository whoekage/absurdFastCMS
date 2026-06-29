import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSchema, stringifySchema, loadSchemaDir, SchemaFileError } from '../src/db/schema/serialize.ts';
import { schemaToRows, relationRowsByType, SchemaAdaptError } from '../src/db/schema/adapt.ts';
import type { Schema } from '../src/db/schema/model.ts';

/**
 * S1-A — the PURE files-first schema layer (no DB). Validates the committed demo `schema/article.json`
 * parses + round-trips, that `schemaToRows` resolves the file through the SAME catalog the meta writer
 * uses, that the Zod boundary rejects malformed input with a typed error, and the dir loader's
 * stem===name guard. The real meta↔file EQUIVALENCE (byte-identical defs) lives in the real-PG test.
 */

const articlePath = fileURLToPath(new URL('./fixtures/article.json', import.meta.url));

test('committed article.json parses, round-trips, and adapts to expected meta rows', async () => {
  const schema = parseSchema(await readFile(articlePath, 'utf8'), 'article.json');
  assert.equal(schema.name, 'article');
  assert.equal(schema.fields.length, 7);

  // Canonical serialize round-trips with no loss.
  assert.deepEqual(parseSchema(stringifySchema(schema)), schema);

  const { ct, fieldRows } = schemaToRows(schema);
  assert.equal(ct.name, 'article');
  assert.equal(ct.table_name, 'ct_article');
  assert.equal(ct.draft_publish, false);
  assert.equal(ct.i18n, false);

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
  assert.throws(() => parseSchema(JSON.stringify({ id: 'ct_a', name: 'a', fields: [{ id: 'f_a', name: 'a', type: 'nope' }] })), SchemaFileError);
  // unknown top-level key (.strict())
  assert.throws(() => parseSchema(JSON.stringify({ id: 'ct_a', name: 'a', fields: [], bogus: 1 })), SchemaFileError);
  // malformed id (no prefix_tail shape)
  assert.throws(() => parseSchema(JSON.stringify({ id: 'BADID', name: 'a', fields: [] })), SchemaFileError);
  // missing required name
  assert.throws(() => parseSchema(JSON.stringify({ id: 'ct_a', fields: [] })), SchemaFileError);
});

test('loadSchemaDir: empty for a missing dir, sorted load, stem===name guard', async () => {
  assert.deepEqual(await loadSchemaDir(path.join(tmpdir(), 'conti-no-such-dir-xyz')), []);

  const dir = await mkdtemp(path.join(tmpdir(), 'conti-schema-'));
  try {
    const good: Schema = { id: 'ct_b', name: 'beta', fields: [{ id: 'f_n', name: 'n', type: 'integer', options: { nullable: true } }] };
    const alpha: Schema = { id: 'ct_a', name: 'alpha', fields: [] };
    await writeFile(path.join(dir, 'beta.json'), stringifySchema(good));
    await writeFile(path.join(dir, 'alpha.json'), stringifySchema(alpha));
    const loaded = await loadSchemaDir(dir);
    assert.deepEqual(loaded.map((s) => s.name), ['alpha', 'beta']); // filename-sorted

    // stem must equal name.
    await writeFile(path.join(dir, 'wrong.json'), stringifySchema(good)); // name 'beta' != stem 'wrong'
    await assert.rejects(loadSchemaDir(dir), SchemaFileError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('relationRowsByType synthesizes owner + inverse rows across the two types', () => {
  const post: Schema = {
    id: 'ct_p',
    name: 'post',
    fields: [{ id: 'f_t', name: 'title', type: 'string', options: { nullable: true } }],
    relations: [{ id: 'rel_a', field: 'author', kind: 'manyToOne', target: 'writer', inverseField: 'posts' }],
  };
  const writer: Schema = { id: 'ct_w', name: 'writer', fields: [] };
  const rels = relationRowsByType([post, writer]);

  const owner = rels.get('ct_p')!;
  assert.equal(owner.length, 1);
  assert.equal(owner[0]!.field_name, 'author');
  assert.equal(owner[0]!.is_owner, true);
  assert.equal(owner[0]!.kind, 'manyToOne');
  assert.equal(owner[0]!.target_name, 'writer');

  const inverse = rels.get('ct_w')!;
  assert.equal(inverse.length, 1);
  assert.equal(inverse[0]!.field_name, 'posts');
  assert.equal(inverse[0]!.is_owner, false);
  assert.equal(inverse[0]!.kind, 'oneToMany'); // inverse of manyToOne
  assert.equal(inverse[0]!.link_table, owner[0]!.link_table); // both sides share ONE link table
});

test('relationRowsByType fails LOUD on a dangling relation target', () => {
  const post: Schema = {
    id: 'ct_p',
    name: 'post',
    fields: [],
    relations: [{ id: 'rel_a', field: 'author', kind: 'manyToOne', target: 'ghost' }],
  };
  assert.throws(() => relationRowsByType([post]), SchemaAdaptError);
});
