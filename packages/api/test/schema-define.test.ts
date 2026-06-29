import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineSchema, c, defToSchema, type InferType } from '../src/db/schema/define.ts';
import { parseSchema } from '../src/db/schema/serialize.ts';

/**
 * Phase 1 of the TS-DSL pivot — `defineSchema` + `c.*` builders. Proves the DSL introspects to the SAME IR
 * the JSON path produced (so diff/migrate/registry are unchanged), splits relations out of `fields`, falls
 * back ids to the key/name, and that types are inferred (the compile-time block fails `tsc` if wrong).
 */

const articlePath = fileURLToPath(new URL('./fixtures/article.json', import.meta.url));

const Article = defineSchema({
  id: 'ct_article',
  label: 'Article',
  options: { draftAndPublish: false, i18n: false },
  fields: {
    title: c.string({ id: 'f_title', max: 512, nullable: true }),
    body: c.text({ id: 'f_body', nullable: false }),
    status: c.enum(['draft', 'published', 'archived'], { id: 'f_status', nullable: false }),
    views: c.integer({ id: 'f_views', nullable: true }),
    rating: c.float({ id: 'f_rating', nullable: true }),
    active: c.boolean({ id: 'f_active', nullable: false }),
    publishedAt: c.datetime({ id: 'f_publishedAt', nullable: false }),
  },
});

test('defToSchema produces the SAME IR as the committed article.json (minus cosmetic collectionName)', async () => {
  const ir = defToSchema(Article, 'article');
  const json = parseSchema(await readFile(articlePath, 'utf8'));
  const { collectionName: _cn, ...core } = json; // collectionName is cosmetic, not in the DSL (label IS)
  assert.deepStrictEqual(ir, core);
});

test('defToSchema splits relations out of fields', () => {
  const Post = defineSchema({
    id: 'ct_post',
    fields: {
      title: c.string({ id: 'f_t' }),
      author: c.relation('writer', { id: 'rel_a', kind: 'manyToOne', inverse: 'posts' }),
    },
  });
  const ir = defToSchema(Post, 'post');
  assert.deepEqual(ir.fields.map((f) => f.name), ['title']); // the relation is NOT a field
  assert.equal(ir.relations?.length, 1);
  assert.deepEqual(ir.relations?.[0], { id: 'rel_a', field: 'author', kind: 'manyToOne', target: 'writer', inverseField: 'posts' });
});

test('ids fall back to the field key / name when not pinned', () => {
  const Thing = defineSchema({ fields: { name: c.string() } });
  const ir = defToSchema(Thing, 'thing');
  assert.equal(ir.id, 'thing'); // type id <- name
  assert.equal(ir.fields[0]!.id, 'name'); // field id <- key
  assert.equal(ir.fields[0]!.options?.nullable, true); // nullable defaults true
});

test('InferType derives the typed entry — compile-time (this block fails tsc if inference breaks)', () => {
  type T = InferType<typeof Article>;
  const entry: T = {
    id: 1,
    created_at: '',
    updated_at: '',
    title: null, // nullable string
    body: 'x', // NOT NULL string
    status: 'published', // literal union, not string
    views: 5,
    rating: null,
    active: true,
    publishedAt: '',
  };
  const _status: 'draft' | 'published' | 'archived' = entry.status; // errors if status widened to string
  void _status;
  assert.equal(entry.body, 'x');
});
