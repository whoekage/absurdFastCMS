// @absurd/sdk — Slice 2 query-string builder, MOCK-FREE round-trip verification.
//
// The builder (buildQueryString) is the inverse of the api's parseParams over the supported surface.
// We prove that by feeding the builder's OUTPUT straight into the REAL parseQuery from
// packages/api/src/store/query.parser.ts (no network, no mocks, no stubbed parser). Every supported
// input must parse without throwing AND yield the structure we expect (where tree / options / populate).
//
// Encoding contract under test: VALUES are encodeURIComponent-escaped; bracket KEYS stay literal — the
// parser splitKey()s the literal brackets, then decodes key + value of each pair. A handful of exact
// wire-string assertions pin that contract byte-for-byte (e.g. filters[title][$containsi]=hi).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildQueryString, type QueryParams } from '@absurd/sdk';

// REAL parser + its types (relative import into the api package source — type-stripped at runtime).
import {
  parseQuery,
  type RelationParseContext,
  type ParsedQuery,
} from '../../api/src/store/query.parser.ts';
import type { FieldDef } from '../../api/src/store/table.ts';

// === schema/context the parser validates against ================================================
// Scalar fields cover every coercion arm the operator matrix touches (string/text/i32/i64/f64/bool/
// date/decimal). A relation `author` → target type `user` exercises the relation-filter + populate paths.

const articleFields: FieldDef[] = [
  { name: 'id', type: 'i32' },
  { name: 'title', type: 'string' },
  { name: 'body', type: 'text' },
  { name: 'views', type: 'i32' },
  { name: 'big', type: 'i64' },
  { name: 'rating', type: 'f64' },
  { name: 'published', type: 'bool' },
  { name: 'createdAt', type: 'date' },
  { name: 'price', type: 'decimal', scale: 2, precision: 10 },
];

const userFields: FieldDef[] = [
  { name: 'id', type: 'i32' },
  { name: 'name', type: 'string' },
  { name: 'age', type: 'i32' },
];

const userCtx: RelationParseContext = {
  fields: userFields,
  relations: new Map(),
  resolveTarget: () => undefined,
};

const ctx: RelationParseContext = {
  fields: articleFields,
  // `author` relation → target apiId 'user'; `tags` relation → target apiId 'user' (reuse for populate).
  relations: new Map([
    ['author', 'user'],
    ['tags', 'user'],
  ]),
  resolveTarget: (apiId) => (apiId === 'user' ? userCtx : undefined),
};

/** parseQuery over the BUILT string — the whole point: builder output ⇒ real parser, no throw. */
function roundTrip(params: QueryParams): ParsedQuery {
  const qs = buildQueryString(params);
  return parseQuery(ctx, qs);
}

// === all 21 operators ===========================================================================
// One representative field per operator's value-class. The assertion is structural: the parser produced
// a `where` tree at all (it would THROW on an unknown op / type-mismatch / bad arity). We spot-check a
// few coerced leaf values too (numbers coerce to numbers, i64 to bigint, between to a 2-tuple, etc).

test('every comparison operator round-trips through the real parser', () => {
  const cases: Array<{ name: string; params: QueryParams; check?: (p: ParsedQuery) => void }> = [
    { name: '$eq', params: { filters: { views: { $eq: 5 } } } },
    { name: '$ne', params: { filters: { views: { $ne: 5 } } } },
    { name: '$gt', params: { filters: { views: { $gt: 5 } } } },
    { name: '$gte', params: { filters: { views: { $gte: 5 } } } },
    { name: '$lt', params: { filters: { views: { $lt: 5 } } } },
    { name: '$lte', params: { filters: { views: { $lte: 5 } } } },
    { name: '$eqi', params: { filters: { title: { $eqi: 'Hello' } } } },
    { name: '$nei', params: { filters: { title: { $nei: 'Hello' } } } },
    { name: '$contains', params: { filters: { title: { $contains: 'lo' } } } },
    { name: '$containsi', params: { filters: { title: { $containsi: 'lo' } } } },
    { name: '$notContains', params: { filters: { title: { $notContains: 'lo' } } } },
    { name: '$notContainsi', params: { filters: { title: { $notContainsi: 'lo' } } } },
    { name: '$startsWith', params: { filters: { title: { $startsWith: 'He' } } } },
    { name: '$startsWithi', params: { filters: { title: { $startsWithi: 'he' } } } },
    { name: '$endsWith', params: { filters: { title: { $endsWith: 'lo' } } } },
    { name: '$endsWithi', params: { filters: { title: { $endsWithi: 'LO' } } } },
  ];
  for (const c of cases) {
    assert.doesNotThrow(() => roundTrip(c.params), `${c.name} must parse`);
    const parsed = roundTrip(c.params);
    assert.ok(parsed.where !== undefined, `${c.name}: where present`);
  }
});

test('$in / $notIn coerce to an array of typed values', () => {
  const inParsed = roundTrip({ filters: { views: { $in: [1, 2, 3] } } });
  assert.deepEqual(inParsed.where, { leaf: { field: 'views', op: 'in', value: [1, 2, 3] } });

  const notInParsed = roundTrip({ filters: { title: { $notIn: ['a', 'b'] } } });
  assert.deepEqual(notInParsed.where, { leaf: { field: 'title', op: 'notIn', value: ['a', 'b'] } });
});

test('$between coerces to exactly a 2-tuple', () => {
  const parsed = roundTrip({ filters: { views: { $between: [10, 20] } } });
  assert.deepEqual(parsed.where, { leaf: { field: 'views', op: 'between', value: [10, 20] } });
});

test('$null / $notNull emit the literal true flag', () => {
  const nul = roundTrip({ filters: { title: { $null: true } } });
  assert.deepEqual(nul.where, { leaf: { field: 'title', op: 'null', value: true } });

  const notNul = roundTrip({ filters: { title: { $notNull: true } } });
  assert.deepEqual(notNul.where, { leaf: { field: 'title', op: 'notNull', value: true } });

  // A `false` flag must emit NOTHING (no clause) — so the query is empty and `where` is undefined.
  const off = roundTrip({ filters: { title: { $null: false } } });
  assert.equal(off.where, undefined);
});

test('typed coercions: i64→bigint, f64→number, bool, date→epoch', () => {
  const big = roundTrip({ filters: { big: { $eq: 9223372036854775807n } } });
  assert.deepEqual(big.where, { leaf: { field: 'big', op: 'eq', value: 9223372036854775807n } });

  const f = roundTrip({ filters: { rating: { $gte: 4.5 } } });
  assert.deepEqual(f.where, { leaf: { field: 'rating', op: 'gte', value: 4.5 } });

  const b = roundTrip({ filters: { published: { $eq: true } } });
  assert.deepEqual(b.where, { leaf: { field: 'published', op: 'eq', value: true } });

  const d = new Date('2024-01-02T03:04:05.000Z');
  const dt = roundTrip({ filters: { createdAt: { $gt: d } } });
  // coerceDate returns epoch ms for an ISO string.
  assert.deepEqual(dt.where, { leaf: { field: 'createdAt', op: 'gt', value: d.getTime() } });

  const price = roundTrip({ filters: { price: { $eq: '12.34' } } });
  assert.ok(price.where !== undefined, 'decimal $eq parses (coerced to scaled mantissa)');
});

// === short form (bare value → $eq) ==============================================================

test('short form filters[field]=value parses as $eq', () => {
  const parsed = roundTrip({ filters: { title: 'hello' } });
  assert.deepEqual(parsed.where, { leaf: { field: 'title', op: 'eq', value: 'hello' } });
});

// === logical combinators $and / $or / $not ======================================================

test('$and / $or / $not nest into the engine combiner tree', () => {
  const params: QueryParams = {
    filters: {
      $and: [
        { title: { $containsi: 'rust' } },
        {
          $or: [
            { views: { $gte: 100 } },
            { $not: { published: { $eq: false } } },
          ],
        },
      ],
    },
  };
  const parsed = roundTrip(params);
  assert.deepEqual(parsed.where, {
    op: 'and',
    children: [
      { leaf: { field: 'title', op: 'containsi', value: 'rust' } },
      {
        op: 'or',
        children: [
          { leaf: { field: 'views', op: 'gte', value: 100 } },
          { op: 'not', children: [{ leaf: { field: 'published', op: 'eq', value: false } }] },
        ],
      },
    ],
  });
});

// === relation filter (filters[rel][field][$op]) =================================================

test('relation sub-filter parses into a {relation, sub} EXISTS leaf', () => {
  const params: QueryParams = {
    filters: { author: { name: { $eq: 'Ada' } } } as QueryParams['filters'],
  };
  const parsed = roundTrip(params);
  assert.deepEqual(parsed.where, {
    relation: 'author',
    sub: { leaf: { field: 'name', op: 'eq', value: 'Ada' } },
  });
});

test('relation sub-filter combined with a scalar (implicit AND of siblings)', () => {
  const params: QueryParams = {
    filters: {
      published: true,
      author: { age: { $gte: 18 } },
    } as QueryParams['filters'],
  };
  const parsed = roundTrip(params);
  assert.deepEqual(parsed.where, {
    op: 'and',
    children: [
      { leaf: { field: 'published', op: 'eq', value: true } },
      { relation: 'author', sub: { leaf: { field: 'age', op: 'gte', value: 18 } } },
    ],
  });
});

// === pagination — all 3 modes (incl withCount) ==================================================

test('page-based pagination → offset/limit', () => {
  const parsed = roundTrip({ pagination: { page: 3, pageSize: 10 } });
  assert.equal(parsed.options.offset, 20);
  assert.equal(parsed.options.limit, 10);
});

test('offset-based pagination passes through', () => {
  const parsed = roundTrip({ pagination: { start: 40, limit: 20 } });
  assert.equal(parsed.options.offset, 40);
  assert.equal(parsed.options.limit, 20);
});

test('keyset pagination (cursor + pageSize + withCount) → raw keyset request', () => {
  const parsed = roundTrip({ pagination: { cursor: 'opaqueTok', pageSize: 15, withCount: true } });
  assert.deepEqual(parsed.options.keysetRaw, {
    pageSize: 15,
    withCount: true,
    cursorToken: 'opaqueTok',
  });
  assert.equal(parsed.options.offset, undefined);
  assert.equal(parsed.options.limit, undefined);
});

test('keyset bootstrap (empty cursor) and backward (before) both parse', () => {
  const head = roundTrip({ pagination: { cursor: '', pageSize: 5 } });
  assert.deepEqual(head.options.keysetRaw, { pageSize: 5, withCount: false, cursorToken: '' });

  const back = roundTrip({ pagination: { before: 'prevTok', pageSize: 5, withCount: true } });
  assert.deepEqual(back.options.keysetRaw, { pageSize: 5, withCount: true, beforeToken: 'prevTok' });
});

// === sort — single + multi-key ==================================================================

test('multi-key sort parses in order', () => {
  const parsed = roundTrip({ sort: ['views:desc', 'id:asc'] });
  assert.deepEqual(parsed.options.sort, [
    { field: 'views', dir: 'desc' },
    { field: 'id', dir: 'asc' },
  ]);
});

test('single-key sort string parses (bare field → asc)', () => {
  const parsed = roundTrip({ sort: 'title' });
  assert.deepEqual(parsed.options.sort, [{ field: 'title', dir: 'asc' }]);
});

// === fields (validated, not projected) ==========================================================

test('fields projection is accepted (validated against schema)', () => {
  assert.doesNotThrow(() => roundTrip({ fields: ['title', 'views'] }));
});

// === populate — string / array / '*' / nested ===================================================

test("populate '*' wildcard parses to a single '*' node", () => {
  const parsed = roundTrip({ populate: '*' });
  assert.deepEqual(parsed.populate, [{ field: '*', children: [] }]);
});

test('populate comma string parses to leaf nodes', () => {
  const parsed = roundTrip({ populate: 'author,tags' });
  assert.deepEqual(parsed.populate, [
    { field: 'author', children: [] },
    { field: 'tags', children: [] },
  ]);
});

test('populate array parses to leaf nodes', () => {
  const parsed = roundTrip({ populate: ['author', 'tags'] });
  assert.deepEqual(parsed.populate, [
    { field: 'author', children: [] },
    { field: 'tags', children: [] },
  ]);
});

test('populate object leaf (true) parses to an empty-children node', () => {
  const parsed = roundTrip({ populate: { author: true } });
  assert.deepEqual(parsed.populate, [{ field: 'author', children: [] }]);
});

test('nested populate (populate[rel][populate][sub]) parses recursively', () => {
  const parsed = roundTrip({ populate: { author: { populate: 'tags' } } });
  assert.deepEqual(parsed.populate, [
    { field: 'author', children: [{ field: 'tags', children: [] }] },
  ]);
});

test("nested populate with '*' sub-spec parses", () => {
  const parsed = roundTrip({ populate: { author: { populate: '*' } } });
  assert.deepEqual(parsed.populate, [
    { field: 'author', children: [{ field: '*', children: [] }] },
  ]);
});

// === a big combined query (everything at once) ==================================================

test('a kitchen-sink query (filters+relation+sort+pagination+fields+populate) parses whole', () => {
  const params: QueryParams = {
    filters: {
      $and: [{ title: { $containsi: 'hi' } }, { author: { name: { $eq: 'Ada' } } }],
    } as QueryParams['filters'],
    sort: ['views:desc', 'id:asc'],
    pagination: { page: 2, pageSize: 5 },
    fields: ['title', 'views'],
    populate: { author: { populate: '*' } },
  };
  const parsed = roundTrip(params);
  assert.ok(parsed.where !== undefined);
  assert.equal(parsed.options.offset, 5);
  assert.equal(parsed.options.limit, 5);
  assert.deepEqual(parsed.options.sort, [
    { field: 'views', dir: 'desc' },
    { field: 'id', dir: 'asc' },
  ]);
  assert.deepEqual(parsed.populate, [
    { field: 'author', children: [{ field: '*', children: [] }] },
  ]);
});

// === exact wire-string assertions (the encoding contract, byte-for-byte) =========================

test('exact string: filters[title][$containsi]=hi (value encoded, keys literal)', () => {
  assert.equal(
    buildQueryString({ filters: { title: { $containsi: 'hi' } } }),
    'filters[title][$containsi]=hi',
  );
});

test('exact string: value with reserved chars is percent-encoded, bracket keys stay literal', () => {
  // A space and an ampersand in the value MUST be escaped so they cannot corrupt the key grammar.
  assert.equal(
    buildQueryString({ filters: { title: { $eq: 'a b&c' } } }),
    'filters[title][$eq]=a%20b%26c',
  );
});

test('exact string: $in emits indexed brackets', () => {
  assert.equal(
    buildQueryString({ filters: { views: { $in: [1, 2] } } }),
    'filters[views][$in][0]=1&filters[views][$in][1]=2',
  );
});

test('exact string: $between emits two positional bounds', () => {
  assert.equal(
    buildQueryString({ filters: { views: { $between: [10, 20] } } }),
    'filters[views][$between][0]=10&filters[views][$between][1]=20',
  );
});

test('exact string: $null emits the literal true flag', () => {
  assert.equal(
    buildQueryString({ filters: { title: { $null: true } } }),
    'filters[title][$null]=true',
  );
});

test('exact string: nested $and indexed sub-trees', () => {
  assert.equal(
    buildQueryString({ filters: { $and: [{ title: 'x' }, { views: { $gt: 1 } }] } }),
    'filters[$and][0][title]=x&filters[$and][1][views][$gt]=1',
  );
});

test('exact string: relation sub-filter key path', () => {
  assert.equal(
    buildQueryString({ filters: { author: { name: { $eq: 'Ada' } } } as QueryParams['filters'] }),
    'filters[author][name][$eq]=Ada',
  );
});

test('exact string: pagination + sort + fields + populate fixed-order output', () => {
  assert.equal(
    buildQueryString({
      sort: ['views:desc', 'id:asc'],
      pagination: { page: 2, pageSize: 5 },
      fields: ['title', 'views'],
      populate: '*',
    }),
    'sort=views%3Adesc%2Cid%3Aasc&pagination[page]=2&pagination[pageSize]=5&fields=title%2Cviews&populate=*',
  );
});

test('empty params → empty string', () => {
  assert.equal(buildQueryString({}), '');
});
