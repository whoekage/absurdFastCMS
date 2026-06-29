import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff, riskyChanges, forbiddenChanges, SchemaDiffError, type Change } from '../src/db/schema/diff.ts';
import type { Schema, FieldSchema, FieldType } from '../src/db/schema/model.ts';
import type { FieldOptions } from '../src/db/type.catalog.ts';

/**
 * S3 — the PURE diff engine (no DB). Validates stable-id matching: a rename is id-match + name-change (the
 * lossless win), a reorder is wire-only, presentation never emits DDL, every op carries the right `risk`,
 * and `diff(x,x)` is empty (idempotency — the anti-churn invariant). These are exactly the failure modes
 * the cross-ecosystem survey flagged (Strapi #12626/#19141, Prisma #4694, Atlas MF103/104, Directus #10755).
 */

const f = (id: string, name: string, type: FieldType, options?: FieldOptions): FieldSchema =>
  options ? { id, name, type, options } : { id, name, type };
const schema = (id: string, name: string, fields: FieldSchema[], options?: Schema['options']): Schema =>
  options ? { id, name, fields, options } : { id, name, fields };

const only = (cs: { changes: readonly Change[] }): Change => {
  assert.equal(cs.changes.length, 1, `expected exactly one change, got ${cs.changes.map((c) => c.kind).join(',')}`);
  return cs.changes[0]!;
};

// A small base type used across cases.
const base = schema('ct_a', 'article', [
  f('f_title', 'title', 'string', { length: 512, nullable: true }),
  f('f_status', 'status', 'enumeration', { values: ['draft', 'published', 'archived'], nullable: false }),
  f('f_views', 'views', 'integer', { nullable: true }),
]);

test('idempotency: diff(x, x) is empty (no churn)', () => {
  assert.deepEqual(diff([base], [base]).changes, []);
  assert.deepEqual(diff([], []).changes, []);
});

test('addType / dropType', () => {
  const add = only(diff([], [base]));
  assert.equal(add.kind, 'addType');
  assert.equal(add.risk, 'safe');
  assert.equal(add.typeId, 'ct_a');

  const drop = only(diff([base], []));
  assert.equal(drop.kind, 'dropType');
  assert.equal(drop.risk, 'destructive');
});

test('renameType (name change, same id) → table rename, lossless; label/collectionName emit nothing', () => {
  const renamed = schema('ct_a', 'post', base.fields);
  const c = only(diff([base], [renamed]));
  assert.equal(c.kind, 'renameType');
  assert.equal(c.risk, 'safe');
  assert.equal((c as Extract<Change, { kind: 'renameType' }>).fromName, 'article');
  assert.equal((c as Extract<Change, { kind: 'renameType' }>).toName, 'post');

  // presentation-only deltas → empty diff
  const labelled: Schema = { ...base, collectionName: 'whatever', label: 'Articles!' };
  assert.deepEqual(diff([base], [labelled]).changes, []);
});

test('renameField (same id, changed name) is the lossless headline op', () => {
  const next = schema('ct_a', 'article', [
    f('f_title', 'headline', 'string', { length: 512, nullable: true }), // same id f_title, new name
    base.fields[1]!,
    base.fields[2]!,
  ]);
  const c = only(diff([base], [next]));
  assert.equal(c.kind, 'renameField');
  assert.equal(c.risk, 'safe');
  const rf = c as Extract<Change, { kind: 'renameField' }>;
  assert.equal(rf.fieldId, 'f_title');
  assert.equal(rf.from, 'title');
  assert.equal(rf.to, 'headline');
});

test('addField risk: nullable safe; NOT NULL no default data-dependent; NOT NULL with default safe', () => {
  const nullableAdd = diff([base], [schema('ct_a', 'article', [...base.fields, f('f_note', 'note', 'text', { nullable: true })])]);
  assert.equal(only(nullableAdd).risk, 'safe');

  const notNull = diff([base], [schema('ct_a', 'article', [...base.fields, f('f_flag', 'flag', 'boolean', { nullable: false })])]);
  const nn = only(notNull);
  assert.equal(nn.kind, 'addField');
  assert.equal(nn.risk, 'data-dependent'); // existing rows would violate NOT NULL — Atlas MF103
  assert.equal((nn as Extract<Change, { kind: 'addField' }>).sort, 3);

  const withDefault = diff([base], [schema('ct_a', 'article', [...base.fields, f('f_flag', 'flag', 'boolean', { nullable: false, default: false })])]);
  assert.equal(only(withDefault).risk, 'safe');
});

test('dropField is destructive', () => {
  const next = schema('ct_a', 'article', [base.fields[0]!, base.fields[1]!]); // drop f_views
  const c = only(diff([base], [next]));
  assert.equal(c.kind, 'dropField');
  assert.equal(c.risk, 'destructive');
  assert.equal((c as Extract<Change, { kind: 'dropField' }>).fieldName, 'views');
});

test('retypeField: risk is derived from classifyTypeChange; enum member removal is a type change', () => {
  // integer -> biginteger (same id+name): a real resolved-type change.
  const widen = schema('ct_a', 'article', [base.fields[0]!, base.fields[1]!, f('f_views', 'views', 'biginteger', { nullable: true })]);
  const c = only(diff([base], [widen])) as Extract<Change, { kind: 'retypeField' }>;
  assert.equal(c.kind, 'retypeField');
  assert.equal(c.fieldName, 'views'); // unchanged field name
  assert.ok(['metadata-only', 'rewrite', 'forbidden'].includes(c.classification));
  const expectRisk = c.classification === 'metadata-only' ? 'safe' : c.classification === 'rewrite' ? 'data-dependent' : 'forbidden';
  assert.equal(c.risk, expectRisk);

  // enum member removal -> a retypeField (params.values changed). Risk is whatever the catalog classifies.
  const enumShrink = schema('ct_a', 'article', [base.fields[0]!, f('f_status', 'status', 'enumeration', { values: ['draft', 'published'], nullable: false }), base.fields[2]!]);
  const e = only(diff([base], [enumShrink]));
  assert.equal(e.kind, 'retypeField');
});

test('setFieldNullable: → NOT NULL data-dependent, → NULL safe', () => {
  const toNotNull = schema('ct_a', 'article', [f('f_title', 'title', 'string', { length: 512, nullable: false }), base.fields[1]!, base.fields[2]!]);
  const a = only(diff([base], [toNotNull]));
  assert.equal(a.kind, 'setFieldNullable');
  assert.equal(a.risk, 'data-dependent');
  assert.equal((a as Extract<Change, { kind: 'setFieldNullable' }>).to, false);

  const toNull = schema('ct_a', 'article', [base.fields[0]!, f('f_status', 'status', 'enumeration', { values: ['draft', 'published', 'archived'], nullable: true }), base.fields[2]!]);
  assert.equal(only(diff([base], [toNull])).risk, 'safe');
});

test('reorderFields is wire-only and emitted ONLY on a real reorder of common fields', () => {
  // pure append must NOT emit a reorder.
  const appended = schema('ct_a', 'article', [...base.fields, f('f_x', 'x', 'integer', { nullable: true })]);
  assert.ok(!diff([base], [appended]).changes.some((c) => c.kind === 'reorderFields'));

  // genuine swap of two existing fields → one reorderFields, wire-only.
  const swapped = schema('ct_a', 'article', [base.fields[0]!, base.fields[2]!, base.fields[1]!]);
  const c = only(diff([base], [swapped]));
  assert.equal(c.kind, 'reorderFields');
  assert.equal(c.risk, 'safe');
  assert.deepEqual((c as Extract<Change, { kind: 'reorderFields' }>).order, ['f_title', 'f_views', 'f_status']);
});

test('rename + retype in ONE step emits BOTH ops (impossible for name-pairing differs)', () => {
  const next = schema('ct_a', 'article', [
    f('f_views', 'hits', 'biginteger', { nullable: true }), // f_views: renamed views->hits AND integer->biginteger
    base.fields[0]!,
    base.fields[1]!,
  ]);
  const cs = diff([base], [next]);
  const kinds = cs.changes.map((c) => c.kind).sort();
  // a reorder is also expected (f_views moved to front); assert the two field ops are present.
  assert.ok(kinds.includes('renameField'), 'renameField present');
  assert.ok(kinds.includes('retypeField'), 'retypeField present');
  const rn = cs.changes.find((c) => c.kind === 'renameField') as Extract<Change, { kind: 'renameField' }>;
  assert.equal(rn.from, 'views');
  assert.equal(rn.to, 'hits');
});

test('setTypeOption: ON additive (safe), OFF destructive', () => {
  const dpOn = schema('ct_a', 'article', base.fields, { draftAndPublish: true });
  const on = only(diff([base], [dpOn]));
  assert.equal(on.kind, 'setTypeOption');
  assert.equal(on.risk, 'safe');
  assert.equal((on as Extract<Change, { kind: 'setTypeOption' }>).option, 'draftAndPublish');

  const off = only(diff([dpOn], [base]));
  assert.equal(off.kind, 'setTypeOption');
  assert.equal(off.risk, 'destructive');
});

test('riskyChanges + forbiddenChanges select the right subset', () => {
  const cs = diff([base], []); // a dropType (destructive)
  assert.equal(riskyChanges(cs).length, 1);
  assert.equal(forbiddenChanges(cs).length, 0);
});

test('relations add/drop by stable id (add safe, drop destructive)', () => {
  const withRel: Schema = { ...base, relations: [{ id: 'rel_au', field: 'author', kind: 'manyToOne', target: 'writer', inverseField: 'posts' }] };
  const add = diff([base], [withRel]);
  assert.deepEqual(add.changes.map((c) => c.kind), ['addRelation']);
  const ar = add.changes[0] as Extract<Change, { kind: 'addRelation' }>;
  assert.equal(ar.risk, 'safe');
  assert.equal(ar.field, 'author');
  assert.equal(ar.target, 'writer');
  assert.equal(ar.inverseField, 'posts');

  const drop = diff([withRel], [base]);
  assert.deepEqual(drop.changes.map((c) => c.kind), ['dropRelation']);
  assert.equal(drop.changes[0]!.risk, 'destructive');
});

test('a relation CHANGE and a rename-of-a-relation-owner are deferred (loud)', () => {
  const r1: Schema = { ...base, relations: [{ id: 'rel_au', field: 'author', kind: 'manyToOne', target: 'writer' }] };
  const renamedField: Schema = { ...base, relations: [{ id: 'rel_au', field: 'editor', kind: 'manyToOne', target: 'writer' }] }; // same id, field changed
  assert.throws(() => diff([r1], [renamedField]), SchemaDiffError);
  const renamedType: Schema = { ...base, name: 'gazette', relations: [{ id: 'rel_au', field: 'author', kind: 'manyToOne', target: 'writer' }] };
  assert.throws(() => diff([r1], [renamedType]), SchemaDiffError);
});

test('duplicate ids fail LOUD', () => {
  const dupType = [base, schema('ct_a', 'other', [])];
  assert.throws(() => diff([], dupType), SchemaDiffError);
  const dupField = schema('ct_b', 'b', [f('f_d', 'a', 'integer'), f('f_d', 'b', 'integer')]);
  assert.throws(() => diff([], [dupField]), SchemaDiffError);
});
