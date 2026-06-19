import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/store/engine.ts';
import { queryKey } from '../src/store/response.cache.ts';
import { type FieldDef, type FilterNode, type Predicate } from '../src/store/table.ts';
import {
  parseQuery,
  parseParams,
  splitKey,
  QueryParseError,
} from '../src/store/query.parser.ts';

/**
 * API-VERTICAL SLICE 2 — the Strapi v5 query parser, wired end-to-end.
 *
 * Doctrine: NO mocks. The parser is a pure function over (schema, params); correctness is proven by
 * EQUIVALENCE ORACLES — parsed structures are deep-equaled against hand-built FilterNode trees /
 * QueryOptions, and the parsed query, run through the REAL Engine, is deep-equaled against a trivial
 * O(n) brute oracle over the inserted rows. Malformed / unknown / type-mismatched inputs MUST throw.
 * The cache+tree path is proven via the hit counter. Deterministic seeded LCG, no Math.random.
 */

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const FIELDS: FieldDef[] = [
  { name: 'title', type: 'string' },
  { name: 'status', type: 'string' },
  { name: 'views', type: 'i32' },
  { name: 'rating', type: 'f64' },
  { name: 'active', type: 'bool' },
  { name: 'publishedAt', type: 'date' },
];
const STATUSES = ['draft', 'published', 'archived'];

interface Row {
  title: string | null;
  status: string;
  views: number | null;
  rating: number | null;
  active: boolean;
  publishedAt: number; // epoch-ms
}

function seedEngine(n: number, seedNum: number): { engine: Engine; rows: Row[] } {
  const engine = new Engine();
  const t = engine.define('article', FIELDS);
  t.createEqIndex('status');
  t.createSortedIndex('views');
  t.createSortedIndex('publishedAt');
  const rng = lcg(seedNum);
  const base = Date.UTC(2021, 0, 1);
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const row: Row = {
      title: rng() < 0.1 ? null : `Title ${i} status`,
      status: STATUSES[(rng() * STATUSES.length) | 0]!,
      views: rng() < 0.08 ? null : (rng() * 100000) | 0,
      rating: rng() < 0.08 ? null : Math.round(rng() * 1000) / 100,
      active: rng() < 0.5,
      publishedAt: base + i * 3_600_000,
    };
    rows.push(row);
    engine.insert('article', row);
  }
  t.warmIndexes();
  return { engine, rows };
}

// --- a trivial O(n) brute-force ORACLE for a FilterNode tree ----------------

function matchPredicate(row: Row, p: Predicate): boolean {
  const v = (row as unknown as Record<string, unknown>)[p.field];
  // Three-valued logic: NULL matches NOTHING except $null.
  if (p.op === 'null') return v === null;
  if (p.op === 'notNull') return v !== null;
  if (v === null) return false;
  switch (p.op) {
    case 'eq':
      return v === p.value;
    case 'ne':
      return v !== p.value;
    case 'gt':
      return (v as number) > (p.value as number);
    case 'gte':
      return (v as number) >= (p.value as number);
    case 'lt':
      return (v as number) < (p.value as number);
    case 'lte':
      return (v as number) <= (p.value as number);
    case 'between': {
      const [lo, hi] = p.value as [number, number];
      return (v as number) >= lo && (v as number) <= hi;
    }
    case 'in':
      return (p.value as unknown[]).includes(v);
    case 'notIn':
      return !(p.value as unknown[]).includes(v);
    case 'eqi':
      return String(v).toLowerCase() === String(p.value).toLowerCase();
    case 'nei':
      return String(v).toLowerCase() !== String(p.value).toLowerCase();
    case 'contains':
      return String(v).includes(String(p.value));
    case 'containsi':
      return String(v).toLowerCase().includes(String(p.value).toLowerCase());
    case 'notContains':
      return !String(v).includes(String(p.value));
    case 'notContainsi':
      return !String(v).toLowerCase().includes(String(p.value).toLowerCase());
    case 'startsWith':
      return String(v).startsWith(String(p.value));
    case 'startsWithi':
      return String(v).toLowerCase().startsWith(String(p.value).toLowerCase());
    case 'endsWith':
      return String(v).endsWith(String(p.value));
    case 'endsWithi':
      return String(v).toLowerCase().endsWith(String(p.value).toLowerCase());
    default:
      throw new Error(`oracle missing op ${p.op}`);
  }
}

function matchTree(row: Row, node: FilterNode): boolean {
  if ('leaf' in node) return matchPredicate(row, node.leaf);
  if (node.op === 'not') return !matchTree(row, node.children[0]);
  if (node.op === 'and') return node.children.every((c) => matchTree(row, c));
  return node.children.some((c) => matchTree(row, c)); // or
}

// --- 1. PARSE equivalence vs hand-built structures --------------------------

test('parse: nested $and/$or/$not tree equals a hand-built FilterNode', () => {
  const q = parseQuery(
    FIELDS,
    'filters[$and][0][status][$eq]=published' +
      '&filters[$and][1][$or][0][views][$gt]=100' +
      '&filters[$and][1][$or][1][active][$eq]=true' +
      '&filters[$and][2][$not][status][$eq]=archived',
  );
  const expected: FilterNode = {
    op: 'and',
    children: [
      { leaf: { field: 'status', op: 'eq', value: 'published' } },
      {
        op: 'or',
        children: [
          { leaf: { field: 'views', op: 'gt', value: 100 } },
          { leaf: { field: 'active', op: 'eq', value: true } },
        ],
      },
      { op: 'not', children: [{ leaf: { field: 'status', op: 'eq', value: 'archived' } }] },
    ],
  };
  assert.deepEqual(q.where, expected);
  assert.deepEqual(q.options.where, expected);
});

test('parse: every operator coerces value per field type', () => {
  const cases: Array<[string, Predicate]> = [
    ['status[$eq]=published', { field: 'status', op: 'eq', value: 'published' }],
    ['status[$ne]=draft', { field: 'status', op: 'ne', value: 'draft' }],
    ['views[$gt]=5', { field: 'views', op: 'gt', value: 5 }],
    ['views[$gte]=5', { field: 'views', op: 'gte', value: 5 }],
    ['views[$lt]=9', { field: 'views', op: 'lt', value: 9 }],
    ['views[$lte]=9', { field: 'views', op: 'lte', value: 9 }],
    ['views[$between]=10,20', { field: 'views', op: 'between', value: [10, 20] }],
    ['views[$in]=1,2,3', { field: 'views', op: 'in', value: [1, 2, 3] }],
    ['views[$notIn]=1,2', { field: 'views', op: 'notIn', value: [1, 2] }],
    ['views[$null]=true', { field: 'views', op: 'null', value: true }],
    ['views[$notNull]=true', { field: 'views', op: 'notNull', value: true }],
    ['rating[$gt]=1.5', { field: 'rating', op: 'gt', value: 1.5 }],
    ['active[$eq]=false', { field: 'active', op: 'eq', value: false }],
    ['status[$eqi]=PUB', { field: 'status', op: 'eqi', value: 'PUB' }],
    ['status[$nei]=PUB', { field: 'status', op: 'nei', value: 'PUB' }],
    ['title[$contains]=abc', { field: 'title', op: 'contains', value: 'abc' }],
    ['title[$containsi]=abc', { field: 'title', op: 'containsi', value: 'abc' }],
    ['title[$notContains]=abc', { field: 'title', op: 'notContains', value: 'abc' }],
    ['title[$startsWith]=Ti', { field: 'title', op: 'startsWith', value: 'Ti' }],
    ['title[$startsWithi]=ti', { field: 'title', op: 'startsWithi', value: 'ti' }],
    ['title[$endsWith]=us', { field: 'title', op: 'endsWith', value: 'us' }],
    ['title[$endsWithi]=US', { field: 'title', op: 'endsWithi', value: 'US' }],
  ];
  for (const [qs, pred] of cases) {
    // each case is `field[$op]=v`; wrap the field in filters[...] -> filters[field][$op]=v
    const wrapped = 'filters[' + qs.replace('[', '][');
    const q = parseQuery(FIELDS, wrapped);
    assert.deepEqual(q.where, { leaf: pred }, wrapped);
  }
});

test('parse: date $between and $eq coerce ISO strings to epoch-ms', () => {
  const iso = '2021-06-01T00:00:00.000Z';
  const q = parseQuery(FIELDS, `filters[publishedAt][$eq]=${encodeURIComponent(iso)}`);
  assert.deepEqual(q.where, { leaf: { field: 'publishedAt', op: 'eq', value: Date.parse(iso) } });

  const lo = '2021-01-01T00:00:00.000Z';
  const hi = '2021-02-01T00:00:00.000Z';
  const q2 = parseQuery(FIELDS, `filters[publishedAt][$between]=${encodeURIComponent(lo)},${encodeURIComponent(hi)}`);
  assert.deepEqual(q2.where, {
    leaf: { field: 'publishedAt', op: 'between', value: [Date.parse(lo), Date.parse(hi)] },
  });
});

test('parse: date accepts a bare epoch-ms integer string (not only ISO)', () => {
  const iso = '2021-01-01T00:00:00.000Z';
  const ms = Date.parse(iso); // an epoch-ms number
  const q = parseQuery(FIELDS, `filters[publishedAt][$gt]=${ms}`);
  assert.deepEqual(q.where, { leaf: { field: 'publishedAt', op: 'gt', value: ms } });
  // The epoch-ms string and the equivalent ISO string coerce to the SAME instant.
  const qIso = parseQuery(FIELDS, `filters[publishedAt][$gt]=${encodeURIComponent(iso)}`);
  assert.deepEqual(q.where, qIso.where);
});

test('parse: short form filters[field]=value means $eq', () => {
  const q = parseQuery(FIELDS, 'filters[status]=published');
  assert.deepEqual(q.where, { leaf: { field: 'status', op: 'eq', value: 'published' } });
});

test('parse: multiple ops on one field AND together', () => {
  const q = parseQuery(FIELDS, 'filters[views][$gte]=10&filters[views][$lt]=20');
  assert.deepEqual(q.where, {
    op: 'and',
    children: [
      { leaf: { field: 'views', op: 'gte', value: 10 } },
      { leaf: { field: 'views', op: 'lt', value: 20 } },
    ],
  });
});

test('parse: multiple sibling fields AND together (implicit AND)', () => {
  const q = parseQuery(FIELDS, 'filters[status][$eq]=published&filters[active][$eq]=true');
  assert.deepEqual(q.where, {
    op: 'and',
    children: [
      { leaf: { field: 'status', op: 'eq', value: 'published' } },
      { leaf: { field: 'active', op: 'eq', value: true } },
    ],
  });
});

test('parse: $in accepts both comma list and [] array form', () => {
  const a = parseQuery(FIELDS, 'filters[views][$in]=1,2,3');
  const b = parseQuery(FIELDS, 'filters[views][$in][0]=1&filters[views][$in][1]=2&filters[views][$in][2]=3');
  assert.deepEqual(a.where, { leaf: { field: 'views', op: 'in', value: [1, 2, 3] } });
  assert.deepEqual(b.where, a.where);
});

// --- 2. sort, pagination, fields, populate ----------------------------------

test('parse: single sort and multi-sort', () => {
  assert.deepEqual(parseQuery(FIELDS, 'sort=views:desc').options.sort, [{ field: 'views', dir: 'desc' }]);
  // bare field defaults to asc
  assert.deepEqual(parseQuery(FIELDS, 'sort=title').options.sort, [{ field: 'title', dir: 'asc' }]);
  const multi = parseQuery(FIELDS, 'sort[0]=views:desc&sort[1]=title:asc');
  assert.deepEqual(multi.options.sort, [
    { field: 'views', dir: 'desc' },
    { field: 'title', dir: 'asc' },
  ]);
});

test('parse: page-based pagination maps to offset/limit with meta.page recoverable', () => {
  const q = parseQuery(FIELDS, 'pagination[page]=3&pagination[pageSize]=10');
  assert.equal(q.options.offset, 20);
  assert.equal(q.options.limit, 10);
  // meta.page derives back from offset/limit: floor(20/10)+1 === 3 (the REQUESTED page).
  assert.equal(Math.floor(q.options.offset! / q.options.limit!) + 1, 3);
});

test('parse: page 1 and default pageSize', () => {
  const q = parseQuery(FIELDS, 'pagination[page]=1&pagination[pageSize]=25');
  assert.equal(q.options.offset, 0);
  assert.equal(q.options.limit, 25);
});

test('parse: offset-based pagination passes through directly', () => {
  const q = parseQuery(FIELDS, 'pagination[start]=40&pagination[limit]=15');
  assert.equal(q.options.offset, 40);
  assert.equal(q.options.limit, 15);
});

test('parse: fields and populate', () => {
  // Relations Slice 5: the populate plan is a recursive {field, children[]} node (children empty =
  // a depth-1 leaf relation). The previous flat {field, depth} shape is gone.
  const q = parseQuery(FIELDS, 'fields=title,status&populate=author,tags');
  assert.deepEqual(q.populate, [
    { field: 'author', children: [] },
    { field: 'tags', children: [] },
  ]);
  // be-02: the validated CSV selection is now CARRIED on the result (it used to be discarded).
  assert.deepEqual(q.fields, ['title', 'status']);
  // bracket-array form yields the same carried list; an empty/all-blank fields= is a no-op (absent).
  assert.deepEqual(parseQuery(FIELDS, 'fields[0]=title&fields[1]=status').fields, ['title', 'status']);
  assert.equal(parseQuery(FIELDS, 'fields=').fields, undefined);
  assert.equal(parseQuery(FIELDS, 'sort=title:asc').fields, undefined); // no fields param => absent (full-row path)
  // A nested populate records WHICH sub-relation to expand in `children` (not a single integer depth).
  const q2 = parseQuery(FIELDS, 'populate[author][populate]=profile');
  assert.deepEqual(q2.populate, [{ field: 'author', children: [{ field: 'profile', children: [] }] }]);
});

// --- 3. malformed / unknown / type-mismatch are REJECTED --------------------

test('parse: unknown field is rejected', () => {
  assert.throws(() => parseQuery(FIELDS, 'filters[nope][$eq]=1'), QueryParseError);
  assert.throws(() => parseQuery(FIELDS, 'sort=nope:asc'), QueryParseError);
  assert.throws(() => parseQuery(FIELDS, 'fields=nope'), QueryParseError);
});

test('parse: unknown operator is rejected', () => {
  assert.throws(() => parseQuery(FIELDS, 'filters[views][$wat]=1'), QueryParseError);
  assert.throws(() => parseQuery(FIELDS, 'filters[$nope][0][views][$eq]=1'), QueryParseError);
});

test('parse: type-mismatched value is rejected', () => {
  assert.throws(() => parseQuery(FIELDS, 'filters[views][$eq]=notanumber'), QueryParseError);
  assert.throws(() => parseQuery(FIELDS, 'filters[views][$eq]=1.5'), QueryParseError); // i32 not integer
  assert.throws(() => parseQuery(FIELDS, 'filters[active][$eq]=maybe'), QueryParseError);
  assert.throws(() => parseQuery(FIELDS, 'filters[publishedAt][$eq]=notadate'), QueryParseError);
});

test('parse: string-only op on a number field is rejected', () => {
  assert.throws(() => parseQuery(FIELDS, 'filters[views][$contains]=5'), QueryParseError);
  assert.throws(() => parseQuery(FIELDS, 'filters[views][$startsWith]=5'), QueryParseError);
  assert.throws(() => parseQuery(FIELDS, 'filters[views][$eqi]=5'), QueryParseError);
});

test('parse: $between with non-2 args is rejected', () => {
  assert.throws(() => parseQuery(FIELDS, 'filters[views][$between]=10'), QueryParseError);
  assert.throws(() => parseQuery(FIELDS, 'filters[views][$between]=10,20,30'), QueryParseError);
});

test('parse: malformed bracket syntax is rejected', () => {
  assert.throws(() => splitKey('filters[status'), QueryParseError); // unterminated
  assert.throws(() => splitKey('filters[]'), QueryParseError); // empty bracket
  assert.throws(() => splitKey('filters]bad['), QueryParseError); // stray ]
  assert.throws(() => splitKey('[head]'), QueryParseError); // empty head
  assert.throws(() => parseQuery(FIELDS, 'filters[status'), QueryParseError);
});

test('parse: unknown top-level param and pagination mixing are rejected', () => {
  assert.throws(() => parseQuery(FIELDS, 'bogus=1'), QueryParseError);
  assert.throws(
    () => parseQuery(FIELDS, 'pagination[page]=1&pagination[start]=0'),
    QueryParseError,
  );
  assert.throws(() => parseQuery(FIELDS, 'pagination[page]=0&pagination[pageSize]=10'), QueryParseError);
  assert.throws(() => parseQuery(FIELDS, 'filters[views][$null]=false'), QueryParseError);
});

// --- 4. END-TO-END: parsed query -> Engine.respond -> oracle ----------------

function oracle(rows: Row[], where: FilterNode | undefined, sort: { field: string; dir: 'asc' | 'desc' }[], offset: number, limit: number): Row[] {
  const idx = rows.map((r, i) => ({ r, i }));
  let matched = where === undefined ? idx : idx.filter((x) => matchTree(x.r, where));
  if (sort.length > 0) {
    matched = matched.slice().sort((a, b) => {
      for (const k of sort) {
        const va = (a.r as unknown as Record<string, unknown>)[k.field] as number | string | boolean;
        const vb = (b.r as unknown as Record<string, unknown>)[k.field] as number | string | boolean;
        if (va < vb) return k.dir === 'desc' ? 1 : -1;
        if (va > vb) return k.dir === 'desc' ? -1 : 1;
      }
      return a.i - b.i; // stable by insertion order
    });
  }
  const end = limit === Infinity ? matched.length : offset + limit;
  return matched.slice(offset, end).map((x) => x.r);
}

function rowToMaterialized(r: Row): Record<string, unknown> {
  return {
    title: r.title,
    status: r.status,
    views: r.views,
    rating: r.rating,
    active: r.active,
    publishedAt: new Date(r.publishedAt).toISOString(),
  };
}

test('end-to-end: parsed nested $or/$and/$not query == brute oracle over rows', () => {
  const { engine, rows } = seedEngine(500, 42);
  const qs =
    'filters[$and][0][$or][0][status][$eq]=published' +
    '&filters[$and][0][$or][1][views][$gt]=80000' +
    '&filters[$and][1][$not][active][$eq]=false' +
    '&sort[0]=publishedAt:asc' +
    '&pagination[page]=2&pagination[pageSize]=20';
  const q = parseQuery(FIELDS, qs);

  const buf = engine.respond('article', q.options);
  const parsed = JSON.parse(buf.toString('utf8'));

  const expected = oracle(rows, q.where, q.options.sort ?? [], q.options.offset ?? 0, q.options.limit ?? Infinity);
  assert.deepEqual(parsed.data, expected.map(rowToMaterialized));
  // meta.page reflects the REQUESTED page (2), not derived-from-offset wrongly.
  assert.equal(parsed.meta.pagination.page, 2);
  assert.equal(parsed.meta.pagination.pageSize, 20);
  const totalMatched = rows.filter((r) => matchTree(r, q.where!)).length;
  assert.equal(parsed.meta.pagination.total, totalMatched);
});

test('end-to-end: a battery of randomized parsed queries match the oracle', () => {
  const { engine, rows } = seedEngine(400, 7);
  const rng = lcg(2024);
  const fieldOps: Array<[string, string, () => string]> = [
    ['status', '$eq', () => STATUSES[(rng() * 3) | 0]!],
    ['status', '$ne', () => STATUSES[(rng() * 3) | 0]!],
    ['views', '$gt', () => String((rng() * 100000) | 0)],
    ['views', '$lte', () => String((rng() * 100000) | 0)],
    ['views', '$between', () => `${(rng() * 50000) | 0},${50000 + ((rng() * 50000) | 0)}`],
    ['views', '$in', () => `${(rng() * 100000) | 0},${(rng() * 100000) | 0}`],
    ['views', '$null', () => 'true'],
    ['rating', '$gte', () => String(Math.round(rng() * 1000) / 100)],
    ['title', '$contains', () => 'status'],
    ['title', '$notNull', () => 'true'],
  ];
  for (let k = 0; k < 200; k++) {
    const n = 1 + ((rng() * 3) | 0);
    const leaves: string[] = [];
    for (let j = 0; j < n; j++) {
      const [f, op, val] = fieldOps[(rng() * fieldOps.length) | 0]!;
      leaves.push(`filters[$or][${j}][${f}][${op}]=${val()}`);
    }
    const qs = leaves.join('&') + '&pagination[start]=' + ((rng() * 30) | 0) + '&pagination[limit]=' + (1 + ((rng() * 25) | 0));
    const q = parseQuery(FIELDS, qs);
    const buf = engine.respond('article', q.options);
    const parsed = JSON.parse(buf.toString('utf8'));
    const expected = oracle(rows, q.where, [], q.options.offset ?? 0, q.options.limit ?? Infinity);
    assert.deepEqual(parsed.data, expected.map(rowToMaterialized), `query #${k}: ${qs}`);
  }
});

// --- 5. CACHE + TREE: equivalent trees collapse; non-equivalent do not -------

test('cache+tree: a reordered-but-equivalent $or tree hits the SAME entry', () => {
  const { engine } = seedEngine(80, 5);
  engine.cache.clear();
  engine.cache.hits = 0;

  // Two $or trees with the SAME two children in REVERSED order — boolean-equivalent.
  const a = parseQuery(
    FIELDS,
    'filters[$or][0][status][$eq]=published&filters[$or][1][views][$gt]=100',
  );
  const b = parseQuery(
    FIELDS,
    'filters[$or][0][views][$gt]=100&filters[$or][1][status][$eq]=published',
  );

  const r1 = engine.respond('article', a.options); // miss
  const r2 = engine.respond('article', b.options); // must HIT the same normalized key
  assert.equal(engine.cache.size, 1, 'reordered $or children share one cache entry');
  assert.equal(engine.cache.hits, 1, 'second query was a hit');
  assert.equal(r1.toString('utf8'), r2.toString('utf8'));
});

test('cache+tree: a re-associated (non-equivalent SHAPE) tree does NOT falsely hit', () => {
  const { engine } = seedEngine(80, 5);
  engine.cache.clear();
  engine.cache.hits = 0;

  // and(and(a,b),c) vs and(a,b,c): same RESULT, different canonical SHAPE -> two entries, no false hit.
  const nested = parseQuery(
    FIELDS,
    'filters[$and][0][$and][0][status][$eq]=published' +
      '&filters[$and][0][$and][1][active][$eq]=true' +
      '&filters[$and][1][views][$gt]=10',
  );
  const flat = parseQuery(
    FIELDS,
    'filters[$and][0][status][$eq]=published' +
      '&filters[$and][1][active][$eq]=true' +
      '&filters[$and][2][views][$gt]=10',
  );
  engine.respond('article', nested.options); // miss
  engine.respond('article', flat.options); // a DIFFERENT shape -> miss, not a false hit
  assert.equal(engine.cache.hits, 0, 're-associated tree did not falsely hit');
  assert.equal(engine.cache.size, 2, 'two distinct cache entries');

  // ...but the RESULTS are identical (both correct), proving it was a correct miss not a wrong key.
  assert.equal(
    engine.respond('article', nested.options).toString('utf8'),
    engine.respond('article', flat.options).toString('utf8'),
  );
});

test('cache+tree: queryKey canonicalizes $or child order but distinguishes $not', () => {
  const orA: FilterNode = {
    op: 'or',
    children: [
      { leaf: { field: 'a', op: 'eq', value: 1 } },
      { leaf: { field: 'b', op: 'eq', value: 2 } },
    ],
  };
  const orB: FilterNode = {
    op: 'or',
    children: [
      { leaf: { field: 'b', op: 'eq', value: 2 } },
      { leaf: { field: 'a', op: 'eq', value: 1 } },
    ],
  };
  assert.equal(queryKey('t', {}, orA), queryKey('t', {}, orB));

  const notA: FilterNode = { op: 'not', children: [{ leaf: { field: 'a', op: 'eq', value: 1 } }] };
  assert.notEqual(queryKey('t', {}, notA), queryKey('t', {}, orA));
});

// --- 6. params splitter unit checks -----------------------------------------

test('parseParams: bracket-nested keys build a nested object; +-> space; %-decoded', () => {
  const p = parseParams('filters[status][$eq]=a+b&sort=views%3Adesc');
  assert.deepEqual(p, { filters: { status: { $eq: 'a b' } }, sort: 'views:desc' });
});
