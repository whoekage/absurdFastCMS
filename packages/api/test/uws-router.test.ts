import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/store/engine.ts';
import { handleRequest } from '../src/http/read.router.ts';
import { type FieldDef } from '../src/store/table.ts';

/**
 * uWS-MIGRATION SLICE 0 — the framework-agnostic request CORE, end-to-end.
 *
 * Doctrine: NO mocks. A REAL Engine (real columns + indexes + response cache) drives `handleRequest`
 * DIRECTLY — pure, in-process, no socket, no framework. Correctness is proven by a brute-force
 * ORACLE: we recompute the expected envelope with a trivial O(n) loop over the inserted rows and
 * assert the response body JSON.parse-deep-equals it (filters / sort / pagination / nested $or
 * honored). We also pin the bench-validated contract: the 200 body BYTES are byte-identical to
 * `engine.respond(...)` / `engine.respondOne(...)` directly (the core does not re-serialize).
 * Deterministic seeded LCG.
 */

function lcg(seedNum: number): () => number {
  let s = seedNum >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const FIELDS: FieldDef[] = [
  { name: 'id', type: 'i32' },
  { name: 'title', type: 'string' },
  { name: 'status', type: 'string' },
  { name: 'views', type: 'i32' },
  { name: 'rating', type: 'f64' },
  { name: 'active', type: 'bool' },
  { name: 'publishedAt', type: 'date' },
];
const STATUSES = ['draft', 'published', 'archived'];

interface Row {
  id: number;
  title: string | null;
  status: string;
  views: number | null;
  rating: number | null;
  active: boolean;
  publishedAt: number;
}

function buildRows(n: number, seedNum: number): Row[] {
  const rng = lcg(seedNum);
  const base = Date.UTC(2021, 0, 1);
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      id: i + 1, // 1-based serial PK, like a freshly-seeded Postgres table
      // Unicode + surrogate pair coverage in the serialized text path.
      title: rng() < 0.1 ? null : `Title "${i}" e zh \u{1F600}`,
      status: STATUSES[(rng() * STATUSES.length) | 0]!,
      views: rng() < 0.08 ? null : (rng() * 100000) | 0,
      rating: rng() < 0.08 ? null : Math.round(rng() * 1000) / 100,
      active: rng() < 0.5,
      publishedAt: base + i * 3_600_000,
    });
  }
  return rows;
}

function seedEngine(rows: Row[]): Engine {
  const engine = new Engine();
  const t = engine.define('article', FIELDS);
  t.createEqIndex('id');
  t.createEqIndex('status');
  t.createSortedIndex('views');
  t.createSortedIndex('publishedAt');
  for (const r of rows) engine.insert('article', r);
  t.warmIndexes();
  return engine;
}

/** The oracle's view of a materialized row (matches Table.materialize exactly). */
function materialize(r: Row): Record<string, unknown> {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    views: r.views,
    rating: r.rating,
    active: r.active,
    publishedAt: new Date(r.publishedAt).toISOString(),
  };
}

/** Run a GET list against the core, splitting `pathAndQuery` at the first '?'. */
function getList(engine: Engine, pathAndQuery: string) {
  const q = pathAndQuery.indexOf('?');
  const path = q === -1 ? pathAndQuery : pathAndQuery.slice(0, q);
  const query = q === -1 ? '' : pathAndQuery.slice(q + 1);
  return handleRequest(engine, { method: 'GET', path, query });
}

const JSON_CT = 'application/json; charset=utf-8';

// --- 1. LIST: plain page (start/limit style) deep-equals a brute oracle ------

test('GET /:type list (start/limit) -> 200, ct, body deep-equal to a brute oracle', () => {
  const rows = buildRows(250, 11);
  const engine = seedEngine(rows);

  const start = 50;
  const limit = 25;
  const res = getList(engine, `/article?pagination[start]=${start}&pagination[limit]=${limit}`);
  assert.equal(res.status, 200);
  assert.equal(res.contentType, JSON_CT);
  const body = JSON.parse(res.body.toString('utf8'));

  const expectedData = rows.slice(start, start + limit).map(materialize);
  assert.deepEqual(body.data, expectedData);
  assert.deepEqual(body.meta.pagination, {
    page: Math.floor(start / limit) + 1,
    pageSize: limit,
    pageCount: Math.ceil(rows.length / limit),
    total: rows.length,
  });

  // Byte-identity: the core does not re-serialize.
  const direct = engine.respond('article', { offset: start, limit });
  assert.ok(res.body.equals(direct), 'list body bytes == engine.respond');
});

// --- 1b. LIST: page/pageSize style ------------------------------------------

test('GET /:type list (page/pageSize) -> 200, deep-equal to a brute oracle', () => {
  const rows = buildRows(250, 17);
  const engine = seedEngine(rows);

  const page = 3;
  const pageSize = 20;
  const res = getList(engine, `/article?pagination[page]=${page}&pagination[pageSize]=${pageSize}`);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body.toString('utf8'));

  const offset = (page - 1) * pageSize;
  const expectedData = rows.slice(offset, offset + pageSize).map(materialize);
  assert.deepEqual(body.data, expectedData);
  assert.deepEqual(body.meta.pagination, {
    page,
    pageSize,
    pageCount: Math.ceil(rows.length / pageSize),
    total: rows.length,
  });
});

// --- 2. LIST: filter + sort honored end-to-end ------------------------------

test('GET /:type list with filter + sort matches a brute oracle', () => {
  const rows = buildRows(300, 7);
  const engine = seedEngine(rows);

  const res = getList(engine, '/article?filters[status][$eq]=published&sort=views:desc&pagination[limit]=1000');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body.toString('utf8'));

  const matched = rows.filter((r) => r.status === 'published');
  assert.equal(body.data.length, matched.length);
  assert.equal(body.meta.pagination.total, matched.length);
  for (const d of body.data) assert.equal(d.status, 'published');
  const views = body.data.map((d: Record<string, unknown>) => d.views);
  const nonNull = views.filter((v: unknown) => v !== null);
  for (let i = 1; i < nonNull.length; i++) {
    assert.ok(nonNull[i - 1] >= nonNull[i], `views desc at ${i}`);
  }
  const retSorted = views.slice().filter((v: unknown) => v !== null).sort((a: number, b: number) => a - b);
  const oracleSorted = matched.map((r) => r.views).filter((v) => v !== null).sort((a, b) => a! - b!);
  assert.deepEqual(retSorted, oracleSorted);
});

// --- 3. LIST: nested $or honored --------------------------------------------

test('GET /:type list with a nested $or matches a brute oracle', () => {
  const rows = buildRows(300, 23);
  const engine = seedEngine(rows);

  // status == draft OR views > 90000
  const q = '/article?filters[$or][0][status][$eq]=draft&filters[$or][1][views][$gt]=90000&pagination[limit]=1000';
  const res = getList(engine, q);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body.toString('utf8'));

  // Three-valued: NULL views never satisfies `> 90000`.
  const expected = rows.filter((r) => r.status === 'draft' || (r.views !== null && r.views > 90000));
  assert.equal(body.data.length, expected.length);
  assert.equal(body.meta.pagination.total, expected.length);
  assert.deepEqual(body.data, expected.map(materialize));
});

// --- 4. SINGLE: single-item envelope ----------------------------------------

test('GET /:type/:id -> 200 single-item envelope deep-equal to the oracle + byte-identical', () => {
  const rows = buildRows(120, 5);
  const engine = seedEngine(rows);

  // Address by the PUBLIC primary key (rows[idx].id), not the dense array position.
  for (const idx of [0, 1, 63, 64, 119]) {
    const id = rows[idx]!.id;
    const res = handleRequest(engine, { method: 'GET', path: `/article/${id}`, query: '' });
    assert.equal(res.status, 200, `id ${id} -> 200`);
    assert.equal(res.contentType, JSON_CT);
    const body = JSON.parse(res.body.toString('utf8'));
    assert.deepEqual(body, { data: materialize(rows[idx]!), meta: {} });
    assert.ok(res.body.equals(engine.respondById('article', id)!), `id ${id} byte-identical`);
  }
});

// --- 5. unknown type -> 404 -------------------------------------------------

test('unknown module -> 404 with { error }', () => {
  const engine = seedEngine(buildRows(10, 1));

  const list = handleRequest(engine, { method: 'GET', path: '/widget', query: '' });
  assert.equal(list.status, 404);
  assert.equal(list.contentType, JSON_CT);
  assert.equal(typeof JSON.parse(list.body.toString('utf8')).error, 'string');

  const single = handleRequest(engine, { method: 'GET', path: '/widget/0', query: '' });
  assert.equal(single.status, 404);
  assert.equal(typeof JSON.parse(single.body.toString('utf8')).error, 'string');
});

// --- 6. id validation: non-canonical -> 404; unknown PK -> 404; existing PK -> 200 ---

test('non-canonical id -> 404; unknown PK -> 404; existing PK -> 200', () => {
  const rows = buildRows(50, 2); // PKs 1..50
  const engine = seedEngine(rows);

  for (const bad of ['1.5', 'abc', '01', '00', '+1', ' 1', '0x1', '1e1', '-1']) {
    const res = handleRequest(engine, { method: 'GET', path: `/article/${bad}`, query: '' });
    assert.equal(res.status, 404, `id "${bad}" -> 404`);
  }
  // canonical integers that match no row (incl. 0, since the PK is 1-based) -> 404.
  for (const missing of ['0', '51', '999']) {
    assert.equal(handleRequest(engine, { method: 'GET', path: `/article/${missing}`, query: '' }).status, 404, `PK ${missing} -> 404`);
  }
  // existing PKs -> 200.
  assert.equal(handleRequest(engine, { method: 'GET', path: '/article/1', query: '' }).status, 200);
  assert.equal(handleRequest(engine, { method: 'GET', path: '/article/50', query: '' }).status, 200);
});

// --- 7. non-GET on a known route -> 405 -------------------------------------

test('non-GET on a known route -> 405', () => {
  const engine = seedEngine(buildRows(10, 1));
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'get' /* lowercase still GET */]) {
    const list = handleRequest(engine, { method, path: '/article', query: '' });
    const single = handleRequest(engine, { method, path: '/article/1', query: '' });
    if (method === 'get') {
      assert.equal(list.status, 200, 'lowercase get is GET');
      assert.equal(single.status, 200, 'lowercase get is GET');
    } else {
      assert.equal(list.status, 405, `${method} list -> 405`);
      assert.equal(single.status, 405, `${method} single -> 405`);
    }
  }
});

// --- 8. malformed / unknown-field query -> 400 with { error } ---------------

test('malformed / unknown-field query -> 400 with { error }', () => {
  const engine = seedEngine(buildRows(20, 4));

  const cases = [
    '/article?filters[nope][$eq]=1', // unknown field
    '/article?filters[views][$bogus]=1', // unknown operator
    '/article?filters[views][$eq]=notanumber', // type mismatch
    '/article?sort=nope:asc', // unknown sort field
    '/article?filters[views][$between]=1', // between needs 2 bounds
    '/article?bogusparam=1', // unknown top-level param
  ];
  for (const q of cases) {
    const res = getList(engine, q);
    assert.equal(res.status, 400, `query "${q}" -> 400`);
    assert.equal(res.contentType, JSON_CT);
    const body = JSON.parse(res.body.toString('utf8'));
    assert.ok(typeof body.error === 'string' && body.error.length > 0, `error body for "${q}"`);
  }
});

// --- 9. query string with and without a leading '?' -------------------------

test('query string works with AND without a leading "?" (identical result)', () => {
  const rows = buildRows(120, 33);
  const engine = seedEngine(rows);

  const rawQuery = 'filters[status][$eq]=archived&pagination[limit]=1000';
  const without = handleRequest(engine, { method: 'GET', path: '/article', query: rawQuery });
  const withQ = handleRequest(engine, { method: 'GET', path: '/article', query: `?${rawQuery}` });

  assert.equal(without.status, 200);
  assert.equal(withQ.status, 200);
  assert.ok(without.body.equals(withQ.body), 'leading ? makes no difference');

  const expected = rows.filter((r) => r.status === 'archived').map(materialize);
  assert.deepEqual(JSON.parse(without.body.toString('utf8')).data, expected);
});

// --- 10. edges: no query, empty result, no route match ----------------------

test('list with no query returns all rows (default page) deep-equal to oracle', () => {
  const rows = buildRows(30, 6);
  const engine = seedEngine(rows);

  const res = handleRequest(engine, { method: 'GET', path: '/article', query: '' });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body.toString('utf8'));
  assert.deepEqual(body.data, rows.map(materialize));
  assert.equal(body.meta.pagination.total, rows.length);
});

test('list whose filter matches NOTHING returns an empty data array', () => {
  const rows = buildRows(30, 8);
  const engine = seedEngine(rows);

  const res = getList(engine, '/article?filters[views][$gt]=999999999');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body.toString('utf8'));
  assert.deepEqual(body.data, []);
  assert.equal(body.meta.pagination.total, 0);
});

test('root and over-deep paths -> 404 (no route match)', () => {
  const engine = seedEngine(buildRows(10, 1));
  for (const path of ['/', '', '/article/0/extra', '/a/b/c/d']) {
    const res = handleRequest(engine, { method: 'GET', path, query: '' });
    assert.equal(res.status, 404, `path "${path}" -> 404`);
  }
});
