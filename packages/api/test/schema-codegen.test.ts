import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTypes, generateSchemaSource } from '../src/db/schema/codegen.ts';
import { parseSchema, stringifySchema } from '../src/db/schema/serialize.ts';
import type { Schema } from '../src/db/schema/model.ts';

/**
 * S5-A — the pure types codegen (no DB). JSON is the source; this derives the `.d.ts`. Validates the
 * CmsType→TS mapping, enum literal unions, nullable `?: T | null`, the i64/decimal→string choice, and the
 * conditional system fields (draft&publish / i18n).
 */

const article: Schema = {
  id: 'ct_article',
  name: 'article',
  options: { draftAndPublish: false, i18n: false },
  fields: [
    { id: 'f_title', name: 'title', type: 'string', options: { length: 512, nullable: true } },
    { id: 'f_body', name: 'body', type: 'text', options: { nullable: false } },
    { id: 'f_status', name: 'status', type: 'enumeration', options: { values: ['draft', 'published', 'archived'], nullable: false } },
    { id: 'f_views', name: 'views', type: 'integer', options: { nullable: true } },
    { id: 'f_big', name: 'big', type: 'biginteger', options: { nullable: false } },
    { id: 'f_active', name: 'active', type: 'boolean', options: { nullable: false } },
  ],
};

test('generateTypes maps the article schema to a typed interface', () => {
  const out = generateTypes([article]);
  assert.match(out, /export interface Article \{/);
  assert.match(out, /^\s*id: number;/m);
  assert.match(out, /^\s*created_at: string;/m);
  assert.match(out, /^\s*updated_at: string;/m);
  assert.match(out, /title\?: string \| null;/); // nullable string
  assert.match(out, /body: string;/); // NOT NULL
  assert.match(out, /status: "draft" \| "published" \| "archived";/); // enum literal union
  assert.match(out, /views\?: number \| null;/);
  assert.match(out, /big: string;/); // biginteger serializes as string
  assert.match(out, /active: boolean;/);
  // non-D&P, non-i18n: no published_at / locale / document_id lines.
  assert.doesNotMatch(out, /published_at/);
  assert.doesNotMatch(out, /\blocale\b/);
});

test('draft&publish + i18n add the conditional system fields', () => {
  const out = generateTypes([{ ...article, name: 'page', id: 'ct_page', options: { draftAndPublish: true, i18n: true } }]);
  assert.match(out, /export interface Page \{/);
  assert.match(out, /document_id: number;/);
  assert.match(out, /published_at\?: string \| null;/);
  assert.match(out, /^\s*locale: string;/m);
});

test('output is deterministic + name-sorted (diff-stable artifact)', () => {
  const a = generateTypes([article, { ...article, name: 'zebra', id: 'ct_zebra' }]);
  const b = generateTypes([{ ...article, name: 'zebra', id: 'ct_zebra' }, article]);
  assert.equal(a, b); // order-independent
  assert.ok(a.indexOf('interface Article') < a.indexOf('interface Zebra'), 'sorted by name');
});

// be-builder Stage 1 — the new field/relation metadata (min / editorWidth / condition / displayField) MUST
// be emitted by generateSchemaSource AND accepted by the Zod boundary, or it is silently lost on the next
// boot (the `info`/`label` lesson). These two tests pin both halves of the round-trip.
const withMeta: Schema = {
  id: 'ct_meta',
  name: 'meta',
  fields: [
    {
      id: 'f_title',
      name: 'title',
      type: 'string',
      options: { length: 200, min: 3, nullable: false, editorWidth: 'half', condition: { field: 'active', op: 'eq', value: true, action: 'show' } },
    },
    { id: 'f_score', name: 'score', type: 'integer', options: { nullable: true, min: 0, max: 100 } },
  ],
  relations: [{ id: 'rel_a', field: 'author', kind: 'manyToOne', target: 'user', inverseField: 'posts', displayField: 'name' }],
};

test('generateSchemaSource emits min / max / editorWidth / condition / displayField', () => {
  const src = generateSchemaSource(withMeta);
  assert.match(src, /min: 3/); // string char-min
  assert.match(src, /c\.integer\(\{[^}]*min: 0[^}]*max: 100/); // numeric value bounds
  assert.match(src, /editorWidth: "half"/);
  assert.match(src, /condition: \{.*"field":"active".*"action":"show".*\}/);
  assert.match(src, /displayField: "name"/);
});

test('parseSchema accepts + round-trips the new metadata (Zod boundary)', () => {
  assert.deepEqual(parseSchema(stringifySchema(withMeta)), withMeta);
});
