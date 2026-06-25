import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, type PaginationMeta } from '../src/store/engine.ts';
import { Table, type FieldDef, type QueryOptions } from '../src/store/table.ts';

/**
 * Slice AV0 — OUTPUT LAYER (serialize-on-write arena + late-materialization assembly).
 *
 * Doctrine: NO mocks. The Engine drives the REAL Table + columns. Correctness is proven by an
 * equivalence ORACLE: the assembled Buffer must be BYTE-IDENTICAL to JSON.stringify of the
 * equivalent materialized Strapi-v5 envelope ({ data:[...], meta:{ pagination } }), and must
 * round-trip through JSON.parse back to that same object. Edges covered: empty/all/none results,
 * NULL fields rendering as null, single-item respondOne, pagination meta vs a brute count, and
 * arena correctness past INITIAL_CAPACITY (deep page over >1024 rows).
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
  { name: 'body', type: 'text' },
];
const STATUSES = ['draft', 'published', 'archived'];

/** Build an Engine seeded with `n` deterministic rows; some fields randomly NULL. */
function seed(n: number, seedNum: number): { engine: Engine; rows: Record<string, unknown>[] } {
  const engine = new Engine();
  const t = engine.define('article', FIELDS);
  t.createEqIndex('status');
  t.createSortedIndex('views');
  t.createSortedIndex('publishedAt');
  const rng = lcg(seedNum);
  const rows: Record<string, unknown>[] = [];
  const base = Date.UTC(2021, 0, 1);
  for (let i = 0; i < n; i++) {
    // Inject NULL/missing on assorted fields so the envelope must render `null`.
    const row: Record<string, unknown> = {
      title: rng() < 0.1 ? null : `Title "${i}" é 中`, // quote + accent + CJK -> exercises JSON escaping + UTF-8
      status: STATUSES[(rng() * STATUSES.length) | 0]!,
      views: rng() < 0.08 ? null : (rng() * 100000) | 0,
      rating: rng() < 0.08 ? null : Math.round(rng() * 1000) / 100,
      active: rng() < 0.5,
      publishedAt: base + i * 3_600_000,
      body: rng() < 0.05 ? null : `Body ${i}: ${'word '.repeat((rng() * 5) | 0)}`.trim(),
    };
    rows.push(row);
    engine.insert('article', row);
  }
  t.warmIndexes();
  return { engine, rows };
}

/** The ORACLE meta, computed exactly as the Engine documents (page/pageSize/pageCount/total). */
function oracleMeta(total: number, offset: number, limit: number): PaginationMeta {
  const pageSize = limit === Infinity ? (total === 0 ? 0 : total) : limit;
  const page = pageSize === 0 ? 1 : Math.floor(offset / pageSize) + 1;
  const pageCount = pageSize === 0 ? 0 : Math.ceil(total / pageSize);
  return { page, pageSize, pageCount, total };
}

/** The ORACLE envelope: materialize the page rows + the brute-counted meta, then JSON.stringify. */
function oracleEnvelope(t: Table, opts: QueryOptions): { json: string; obj: unknown } {
  const rowIds = t.query(opts);
  const total = t.scan(opts.filters ?? []).count();
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? Infinity;
  const obj = {
    data: rowIds.map((r) => t.materialize(r)),
    meta: { pagination: oracleMeta(total, offset, limit) },
  };
  return { json: JSON.stringify(obj), obj };
}

test('respond: assembled list bytes byte-equal JSON.stringify of the materialized envelope', () => {
  const { engine } = seed(600, 11);
  const t = engine.table('article');
  const rng = lcg(2024);
  const sorts: QueryOptions['sort'][] = [
    undefined,
    [{ field: 'views', dir: 'desc' }],
    [{ field: 'publishedAt', dir: 'asc' }],
    [{ field: 'title', dir: 'asc' }],
  ];
  for (let k = 0; k < 200; k++) {
    const opts: QueryOptions = {
      filters: rng() < 0.5 ? [{ field: 'status', op: 'eq', value: STATUSES[(rng() * 3) | 0]! }] : [],
      sort: sorts[(rng() * sorts.length) | 0],
      offset: (rng() * 30) | 0,
      limit: 1 + ((rng() * 25) | 0),
    };
    const assembled = engine.respond('article', opts);
    const { json, obj } = oracleEnvelope(t, opts);
    assert.equal(
      assembled.toString('utf8'),
      json,
      `query #${k} bytes`,
    );
    // Parse the assembled bytes and deep-compare to the oracle object.
    assert.deepEqual(JSON.parse(assembled.toString('utf8')), obj, `query #${k} parsed`);
  }
});

test('respond: NULL fields render as null in the assembled bytes', () => {
  const engine = new Engine();
  engine.define('article', FIELDS);
  engine.insert('article', { status: 'draft', active: false, publishedAt: 0 }); // title/views/rating/body missing
  engine.insert('article', {
    title: null,
    status: 'published',
    views: null,
    rating: null,
    active: true,
    publishedAt: Date.UTC(2022, 5, 1),
    body: null,
  });
  const buf = engine.respond('article', {});
  const parsed = JSON.parse(buf.toString('utf8'));
  assert.equal(parsed.data[0].title, null);
  assert.equal(parsed.data[0].views, null);
  assert.equal(parsed.data[0].rating, null);
  assert.equal(parsed.data[0].body, null);
  assert.equal(parsed.data[1].title, null);
  assert.equal(parsed.data[1].body, null);
  // byte-equality oracle
  const t = engine.table('article');
  assert.equal(buf.toString('utf8'), oracleEnvelope(t, {}).json);
});

test('respond: empty result is {"data":[],"meta":...} and round-trips', () => {
  const { engine } = seed(50, 5);
  const t = engine.table('article');
  const opts: QueryOptions = { filters: [{ field: 'status', op: 'eq', value: 'no-such-status' }] };
  const buf = engine.respond('article', opts);
  const s = buf.toString('utf8');
  assert.equal(s.startsWith('{"data":[]'), true, 'empty data array');
  assert.equal(s, oracleEnvelope(t, opts).json);
  const parsed = JSON.parse(s);
  assert.deepEqual(parsed.data, []);
  assert.equal(parsed.meta.pagination.total, 0);
});

test('respond: all-rows result (no filter) byte-equals oracle and total = rowCount', () => {
  const { engine } = seed(73, 9); // 73 -> not a multiple of 32, crosses word boundaries
  const t = engine.table('article');
  const opts: QueryOptions = { limit: 1000 };
  const buf = engine.respond('article', opts);
  assert.equal(buf.toString('utf8'), oracleEnvelope(t, opts).json);
  assert.equal(JSON.parse(buf.toString('utf8')).meta.pagination.total, 73);
});

test('respondOne: single-item envelope byte-equals JSON.stringify({ data, meta:{} })', () => {
  const { engine } = seed(120, 3);
  const t = engine.table('article');
  for (const rowId of [0, 1, 31, 32, 63, 64, 100, 119]) {
    const buf = engine.respondOne('article', rowId);
    const oracle = JSON.stringify({ data: t.materialize(rowId), meta: {} });
    assert.equal(buf.toString('utf8'), oracle, `row ${rowId}`);
    assert.deepEqual(JSON.parse(buf.toString('utf8')), { data: t.materialize(rowId), meta: {} });
  }
});

test('pagination meta: page/pageSize/pageCount/total vs a brute count across pages', () => {
  const { engine } = seed(500, 17);
  const t = engine.table('article');
  const filters = [{ field: 'status', op: 'eq', value: 'published' }] as const;
  const total = t.scan([...filters]).count();
  const pageSize = 25;
  const pageCount = Math.ceil(total / pageSize);
  for (let page = 1; page <= pageCount + 1; page++) {
    const opts: QueryOptions = { filters: [...filters], offset: (page - 1) * pageSize, limit: pageSize };
    const parsed = JSON.parse(engine.respond('article', opts).toString('utf8'));
    assert.equal(parsed.meta.pagination.total, total, `page ${page} total`);
    assert.equal(parsed.meta.pagination.pageSize, pageSize, `page ${page} pageSize`);
    assert.equal(parsed.meta.pagination.page, page, `page ${page} page`);
    assert.equal(parsed.meta.pagination.pageCount, pageCount, `page ${page} pageCount`);
    // The page's data length matches the brute slice length.
    const expectedLen = Math.max(0, Math.min(pageSize, total - (page - 1) * pageSize));
    assert.equal(parsed.data.length, expectedLen, `page ${page} data length`);
  }
});

test('arena correctness past INITIAL_CAPACITY: deep page over >1024 rows byte-equals oracle', () => {
  const { engine } = seed(3000, 42); // forces both the byte arena and offsets array to grow
  const t = engine.table('article');
  // A deep page far past the arena's initial capacity, sorted, filtered.
  const opts: QueryOptions = {
    filters: [{ field: 'status', op: 'eq', value: 'archived' }],
    sort: [{ field: 'views', dir: 'desc' }],
    offset: 200,
    limit: 50,
  };
  const buf = engine.respond('article', opts);
  const { json, obj } = oracleEnvelope(t, opts);
  assert.equal(buf.toString('utf8'), json, 'deep page bytes');
  assert.deepEqual(JSON.parse(buf.toString('utf8')), obj, 'deep page parsed');

  // Spot-check a high row id assembles correctly via respondOne too.
  const one = engine.respondOne('article', 2999);
  assert.equal(one.toString('utf8'), JSON.stringify({ data: t.materialize(2999), meta: {} }));
});

test('respond: limit larger than result and offset past the end behave like the oracle', () => {
  const { engine } = seed(40, 8);
  const t = engine.table('article');
  for (const opts of [
    { limit: 1000 } as QueryOptions,
    { offset: 100, limit: 10 } as QueryOptions,
    { offset: 39, limit: 5 } as QueryOptions,
  ]) {
    assert.equal(engine.respond('article', opts).toString('utf8'), oracleEnvelope(t, opts).json, JSON.stringify(opts));
  }
});

test('respond on a module with zero rows: empty data, total 0', () => {
  const engine = new Engine();
  engine.define('empty', [{ name: 'x', type: 'i32' }]);
  const buf = engine.respond('empty', {});
  const parsed = JSON.parse(buf.toString('utf8'));
  assert.deepEqual(parsed.data, []);
  assert.equal(parsed.meta.pagination.total, 0);
  assert.equal(buf.toString('utf8'), oracleEnvelope(engine.table('empty'), {}).json);
});
