// @conti/sdk — Slice 8.1 fluent filter builder, MOCK-FREE round-trip verification.
//
// The builder is sugar over the Slice 2 FilterObject shape and produces NOTHING new on the wire. We
// prove that by building filters with f()/and()/or()/not(), feeding `.build()` straight through
// buildQueryString, and parsing the result with the REAL parseQuery from @conti/api (no network, no
// mocks). Each builder expression must equal the hand-written FilterObject it sugars AND round-trip to
// the engine's where-tree the equivalent literal produces.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildQueryString, f, and, or, not, type QueryParams, type FilterObject } from '@conti/sdk';

import {
  parseQuery,
  type RelationParseContext,
  type ParsedQuery,
} from '../../api/src/store/query.parser.ts';
import type { FieldDef } from '../../api/src/store/table.ts';

const articleFields: FieldDef[] = [
  { name: 'id', type: 'i32' },
  { name: 'title', type: 'string' },
  { name: 'status', type: 'string' },
  { name: 'views', type: 'i32' },
  { name: 'published', type: 'bool' },
  { name: 'createdAt', type: 'date' },
];

const ctx: RelationParseContext = {
  fields: articleFields,
  relations: new Map(),
  resolveTarget: () => undefined,
};

function parse(filters: FilterObject): ParsedQuery {
  return parseQuery(ctx, buildQueryString({ filters } as QueryParams));
}

// === each comparison operator builds the same object the literal would =========================

test('every operator method builds the equivalent FilterCondition', () => {
  const cases: Array<{ got: FilterObject; want: FilterObject }> = [
    { got: f('views').eq(5).build(), want: { views: { $eq: 5 } } },
    { got: f('views').ne(5).build(), want: { views: { $ne: 5 } } },
    { got: f('views').gt(5).build(), want: { views: { $gt: 5 } } },
    { got: f('views').gte(5).build(), want: { views: { $gte: 5 } } },
    { got: f('views').lt(5).build(), want: { views: { $lt: 5 } } },
    { got: f('views').lte(5).build(), want: { views: { $lte: 5 } } },
    { got: f('title').eqi('hi').build(), want: { title: { $eqi: 'hi' } } },
    { got: f('title').nei('hi').build(), want: { title: { $nei: 'hi' } } },
    { got: f('views').between(10, 20).build(), want: { views: { $between: [10, 20] } } },
    { got: f('views').in([1, 2, 3]).build(), want: { views: { $in: [1, 2, 3] } } },
    { got: f('views').notIn([1, 2]).build(), want: { views: { $notIn: [1, 2] } } },
    { got: f('title').null().build(), want: { title: { $null: true } } },
    { got: f('title').notNull().build(), want: { title: { $notNull: true } } },
    { got: f('title').contains('x').build(), want: { title: { $contains: 'x' } } },
    { got: f('title').containsi('x').build(), want: { title: { $containsi: 'x' } } },
    { got: f('title').notContains('x').build(), want: { title: { $notContains: 'x' } } },
    { got: f('title').notContainsi('x').build(), want: { title: { $notContainsi: 'x' } } },
    { got: f('title').startsWith('x').build(), want: { title: { $startsWith: 'x' } } },
    { got: f('title').startsWithi('x').build(), want: { title: { $startsWithi: 'x' } } },
    { got: f('title').endsWith('x').build(), want: { title: { $endsWith: 'x' } } },
    { got: f('title').endsWithi('x').build(), want: { title: { $endsWithi: 'x' } } },
  ];
  for (const c of cases) {
    assert.deepEqual(c.got, c.want);
    assert.doesNotThrow(() => parse(c.got), `${JSON.stringify(c.want)} must parse`);
  }
});

// === and/or/not round-trip to the engine combiner tree =========================================

test('f().and(f()) round-trips to an AND of two leaves', () => {
  const built = f('views').gte(100).and(f('status').eq('published')).build();
  assert.deepEqual(built, {
    $and: [{ views: { $gte: 100 } }, { status: { $eq: 'published' } }],
  });
  const parsed = parse(built);
  assert.deepEqual(parsed.where, {
    op: 'and',
    children: [
      { leaf: { field: 'views', op: 'gte', value: 100 } },
      { leaf: { field: 'status', op: 'eq', value: 'published' } },
    ],
  });
});

test('chained .and() flattens into a single $and (no nesting)', () => {
  const built = f('views').gt(1).and(f('views').lt(10)).and(f('published').eq(true)).build();
  assert.deepEqual(built, {
    $and: [{ views: { $gt: 1 } }, { views: { $lt: 10 } }, { published: { $eq: true } }],
  });
  const parsed = parse(built);
  assert.equal((parsed.where as { op: string; children: unknown[] }).children.length, 3);
});

test('top-level and()/or()/not() helpers build and parse', () => {
  const built = and(f('views').gte(100), or(f('status').eq('a'), f('status').eq('b'))).build();
  assert.deepEqual(built, {
    $and: [{ views: { $gte: 100 } }, { $or: [{ status: { $eq: 'a' } }, { status: { $eq: 'b' } }] }],
  });
  const parsed = parse(built);
  assert.deepEqual(parsed.where, {
    op: 'and',
    children: [
      { leaf: { field: 'views', op: 'gte', value: 100 } },
      {
        op: 'or',
        children: [
          { leaf: { field: 'status', op: 'eq', value: 'a' } },
          { leaf: { field: 'status', op: 'eq', value: 'b' } },
        ],
      },
    ],
  });
});

test('not() wraps in $not and round-trips', () => {
  const built = not(f('published').eq(false)).build();
  assert.deepEqual(built, { $not: { published: { $eq: false } } });
  const parsed = parse(built);
  assert.deepEqual(parsed.where, {
    op: 'not',
    children: [{ leaf: { field: 'published', op: 'eq', value: false } }],
  });
});

test('a builder accepts raw FilterObjects mixed in', () => {
  const built = f('views').gte(100).and({ status: { $eq: 'published' } }).build();
  assert.deepEqual(built, {
    $and: [{ views: { $gte: 100 } }, { status: { $eq: 'published' } }],
  });
  assert.doesNotThrow(() => parse(built));
});
