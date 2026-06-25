// Pure unit test for projectSchemas — the client-side port of the api's deleted `projectDef`. No server,
// no mocks (a pure function over the wire Schema IR). Guards the projection the admin depends on: system
// fields synthesized in the byte-identical order, conditional i18n/D&P system fields, media `multiple`,
// enum/decimal metadata, and TWO-WAY inverse relations folded onto the target module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectSchemas, type ModuleSchema } from '../src/modules.ts';

test('system fields are synthesized + prepended in order; user-field metadata + defaults project', () => {
  const schemas: ModuleSchema[] = [
    {
      id: 'ct_a', apiId: 'article',
      fields: [
        { id: 'f_1', name: 'title', type: 'string', options: { length: 255 } },
        { id: 'f_2', name: 'price', type: 'decimal', options: { precision: 10, scale: 2, nullable: false } },
        { id: 'f_3', name: 'kind', type: 'enumeration', options: { values: ['a', 'b'] } },
        { id: 'f_4', name: 'cover', type: 'media', options: { multiple: true } },
      ],
    },
  ];
  const [def] = projectSchemas(schemas);
  assert.equal(def!.apiId, 'article');
  assert.deepEqual(def!.fields.slice(0, 3).map((f) => f.name), ['id', 'created_at', 'updated_at']);
  assert.ok(def!.fields.slice(0, 3).every((f) => f.system));
  // non-i18n type omits the conditional `localized` key entirely
  assert.equal('localized' in def!.fields[0]!, false);

  const byName = new Map(def!.fields.map((f) => [f.name, f]));
  assert.equal(byName.get('title')!.nullable, true); // files-first default: nullable
  assert.equal(byName.get('title')!.length, 255);
  assert.equal(byName.get('price')!.nullable, false);
  assert.equal(byName.get('price')!.precision, 10);
  assert.equal(byName.get('price')!.scale, 2);
  assert.deepEqual(byName.get('kind')!.enumValues, ['a', 'b']);
  assert.equal(byName.get('cover')!.multiple, true);
  assert.deepEqual(def!.relations, []);
  assert.equal(def!.draftPublish, undefined);
  assert.equal(def!.i18n, undefined);
});

test('i18n + Draft & Publish synthesize document_id/published_at/locale in order, with per-field localized', () => {
  const [def] = projectSchemas([
    {
      id: 'ct_p', apiId: 'page',
      options: { i18n: true, draftAndPublish: true },
      fields: [
        { id: 'f_1', name: 'title', type: 'string', localized: true },
        { id: 'f_2', name: 'slug', type: 'string', localized: false },
      ],
    },
  ]);
  assert.equal(def!.i18n, true);
  assert.equal(def!.draftPublish, true);
  assert.deepEqual(
    def!.fields.map((f) => f.name),
    ['id', 'created_at', 'updated_at', 'document_id', 'published_at', 'locale', 'title', 'slug'],
  );
  const byName = new Map(def!.fields.map((f) => [f.name, f]));
  assert.equal(byName.get('published_at')!.nullable, true); // D&P column is nullable (NULL = draft)
  assert.equal(byName.get('document_id')!.localized, false); // shared grouping key
  assert.equal(byName.get('locale')!.localized, false);
  assert.equal(byName.get('title')!.localized, true);
  assert.equal(byName.get('slug')!.localized, false);
});

test('a two-way relation folds the INVERSE side onto the target module (owner:false, inverted kind)', () => {
  const defs = projectSchemas([
    {
      id: 'ct_a', apiId: 'article',
      fields: [],
      relations: [{ id: 'rel_1', field: 'author', kind: 'manyToOne', target: 'user', inverseField: 'articles' }],
    },
    { id: 'ct_u', apiId: 'user', fields: [] },
  ]);
  const article = defs.find((d) => d.apiId === 'article')!;
  const user = defs.find((d) => d.apiId === 'user')!;

  // Owner side keeps its declared relation.
  assert.deepEqual(article.relations, [{ field: 'author', kind: 'manyToOne', target: 'user', owner: true, inverseField: 'articles' }]);
  // Target gets the inverse, owner:false, kind inverted manyToOne → oneToMany.
  assert.deepEqual(user.relations, [{ field: 'articles', kind: 'oneToMany', target: 'article', owner: false, inverseField: 'author' }]);
});

test('a ONE-WAY relation (no inverseField) does NOT project onto the target', () => {
  const defs = projectSchemas([
    { id: 'ct_a', apiId: 'article', fields: [], relations: [{ id: 'rel_1', field: 'author', kind: 'manyToOne', target: 'user' }] },
    { id: 'ct_u', apiId: 'user', fields: [] },
  ]);
  assert.equal(defs.find((d) => d.apiId === 'article')!.relations.length, 1);
  assert.deepEqual(defs.find((d) => d.apiId === 'user')!.relations, []);
});
