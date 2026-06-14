import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Engine } from '../src/store/engine.ts';
import { createServer, type ListenToken } from '../src/http/app.ts';
import { handleRequest } from '../src/http/router.ts';
import { type FieldDef } from '../src/store/table.ts';

/**
 * uWS-MIGRATION SLICE 1 — the uWebSockets.js adapter, end-to-end over a REAL uWS server.
 *
 * Doctrine: NO mocks. A REAL Engine (real columns + indexes + response cache) is served by a REAL
 * uWS server bound to a FREE port (allocated by listening on :0 with node:net, reading the port,
 * closing, then handing that port to uWS — uWS binds with SO_REUSEPORT so the just-freed port is
 * immediately re-bindable). Requests go over the wire via global fetch(). Correctness is proven by:
 *  - a brute-force ORACLE recomputed with a trivial O(n) loop (filters/sort/pagination honored);
 *  - BYTE-IDENTITY: the 200 body bytes == handleRequest(engine,...).body == engine.respond(...);
 *  - JSON.parse deep-equality to the oracle.
 * CRITICAL: list + single bodies carry Unicode/surrogate-pair text to prove the offset-safe
 * res.end(new Uint8Array(buffer, byteOffset, byteLength)) sends EXACTLY the right bytes (the engine
 * Buffers are subarray views into a shared arena — a naive res.end(buffer) could send wrong bytes).
 * Deterministic seeded LCG. Server closed in after().
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
      // Unicode + surrogate pair (emoji) + quote in the serialized text path — the offset-safe-bytes proof.
      title: rng() < 0.1 ? null : `Title "${i}" e zh \u{1F600}\u{1F4A9}`,
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

/** Allocate a free TCP port: listen on :0, read the OS-assigned port, close, return it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new Error('no port assigned')));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

const ROWS = buildRows(250, 11);
const engine = seedEngine(ROWS);
const server = createServer(engine);
let token: ListenToken;
let base = '';

before(async () => {
  const port = await freePort();
  token = await server.listen(port);
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close(token);
});

// --- 1. LIST: pagination honored, byte-identical, deep-equal to oracle ------

test('GET /:type list -> 200, byte-identical to handleRequest & engine.respond, deep-equal oracle', async () => {
  const start = 50;
  const limit = 25;
  const res = await fetch(`${base}/article?pagination[start]=${start}&pagination[limit]=${limit}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const httpBytes = Buffer.from(await res.arrayBuffer());

  // Byte-identity vs the pure core and vs the engine directly.
  const core = handleRequest(engine, {
    method: 'GET',
    path: '/article',
    query: `pagination[start]=${start}&pagination[limit]=${limit}`,
  });
  assert.ok(httpBytes.equals(core.body), 'HTTP bytes == handleRequest body');
  const direct = engine.respond('article', { offset: start, limit });
  assert.ok(httpBytes.equals(direct), 'HTTP bytes == engine.respond');

  // Deep-equal to a brute oracle.
  const body = JSON.parse(httpBytes.toString('utf8'));
  assert.deepEqual(body.data, ROWS.slice(start, start + limit).map(materialize));
  assert.deepEqual(body.meta.pagination, {
    page: Math.floor(start / limit) + 1,
    pageSize: limit,
    pageCount: Math.ceil(ROWS.length / limit),
    total: ROWS.length,
  });
});

// --- 2. LIST: filter + sort honored end-to-end ------------------------------

test('GET /:type list with filter + sort matches a brute oracle', async () => {
  const res = await fetch(`${base}/article?filters[status][$eq]=published&sort=views:desc&pagination[limit]=1000`);
  assert.equal(res.status, 200);
  const body = await res.json();

  const matched = ROWS.filter((r) => r.status === 'published');
  assert.equal(body.data.length, matched.length);
  assert.equal(body.meta.pagination.total, matched.length);
  for (const d of body.data) assert.equal(d.status, 'published');
  const views = body.data.map((d: Record<string, unknown>) => d.views);
  const nonNull = views.filter((v: unknown) => v !== null) as number[];
  for (let i = 1; i < nonNull.length; i++) {
    assert.ok(nonNull[i - 1]! >= nonNull[i]!, `views desc at ${i}`);
  }
  const retSorted = nonNull.slice().sort((a, b) => a - b);
  const oracleSorted = matched.map((r) => r.views).filter((v) => v !== null).sort((a, b) => a! - b!);
  assert.deepEqual(retSorted, oracleSorted);
});

// --- 3. SINGLE: byte-identical to respondOne + Unicode/surrogate bytes proof -

test('GET /:type/:id -> 200, byte-identical to engine.respondById (surrogate-pair safe)', async () => {
  // Address by the PUBLIC primary key (ROWS[idx].id), not the dense array position.
  for (const idx of [0, 1, 63, 64, 200, 249]) {
    const id = ROWS[idx]!.id;
    const res = await fetch(`${base}/article/${id}`);
    assert.equal(res.status, 200, `id ${id} -> 200`);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const httpBytes = Buffer.from(await res.arrayBuffer());
    // Byte-identity proves the offset-safe res.end sent EXACTLY this row's arena bytes (no pooled
    // Buffer offset bug) — including the surrogate-pair emoji in `title`.
    assert.ok(httpBytes.equals(engine.respondById('article', id)!), `bytes == respondById for ${id}`);
    const body = JSON.parse(httpBytes.toString('utf8'));
    assert.deepEqual(body, { data: materialize(ROWS[idx]!), meta: {} });
  }
});

// --- 4. LIST with surrogate text: multi-row bytes are exactly right ---------

test('GET /:type list with surrogate-pair text -> bytes byte-identical to engine.respond', async () => {
  // A page that definitely includes non-null (emoji-bearing) titles; prove the multi-row concat is
  // byte-exact through the wire (catches any arena-offset / Buffer-pool send bug).
  const res = await fetch(`${base}/article?pagination[limit]=40`);
  assert.equal(res.status, 200);
  const httpBytes = Buffer.from(await res.arrayBuffer());
  assert.ok(httpBytes.equals(engine.respond('article', { limit: 40 })), 'multi-row bytes == engine.respond');
  const body = JSON.parse(httpBytes.toString('utf8'));
  assert.deepEqual(body.data, ROWS.slice(0, 40).map(materialize));
  // Sanity: at least one returned title carries the surrogate pair.
  assert.ok(body.data.some((d: Record<string, unknown>) => typeof d.title === 'string' && (d.title as string).includes('\u{1F600}')));
});

// --- 5. 404s ----------------------------------------------------------------

test('unknown content-type -> 404 with an error body', async () => {
  const list = await fetch(`${base}/widget`);
  assert.equal(list.status, 404);
  assert.match(list.headers.get('content-type') ?? '', /application\/json/);
  assert.ok(typeof (await list.json()).error === 'string');

  const single = await fetch(`${base}/widget/0`);
  assert.equal(single.status, 404);
  assert.ok(typeof (await single.json()).error === 'string');
});

test('unknown PK and non-canonical id -> 404; existing PK -> 200', async () => {
  // PKs are 1..250; 0 and 251 match no row, plus non-canonical forms.
  for (const bad of ['0', '251', '999', '-1', '1.5', 'abc', '01']) {
    const res = await fetch(`${base}/article/${bad}`);
    assert.equal(res.status, 404, `id "${bad}" -> 404`);
  }
  assert.equal((await fetch(`${base}/article/1`)).status, 200);
  assert.equal((await fetch(`${base}/article/250`)).status, 200);
});

// --- 6. 400 on a bad query ---------------------------------------------------

test('malformed / unknown-field query -> 400 with an error body', async () => {
  const cases = [
    '/article?filters[nope][$eq]=1',
    '/article?filters[views][$bogus]=1',
    '/article?filters[views][$eq]=notanumber',
    '/article?sort=nope:asc',
    '/article?filters[views][$between]=1',
    '/article?bogusparam=1',
  ];
  for (const q of cases) {
    const res = await fetch(`${base}${q}`);
    assert.equal(res.status, 400, `query "${q}" -> 400`);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = await res.json();
    assert.ok(typeof body.error === 'string' && body.error.length > 0, `error body for "${q}"`);
  }
});

// --- 7. edges: empty result + no query --------------------------------------

test('list with no query returns all rows (default page) deep-equal to oracle', async () => {
  const res = await fetch(`${base}/article?pagination[limit]=1000`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data, ROWS.map(materialize));
  assert.equal(body.meta.pagination.total, ROWS.length);
});

test('list whose filter matches NOTHING returns an empty data array', async () => {
  const res = await fetch(`${base}/article?filters[views][$gt]=999999999`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data, []);
  assert.equal(body.meta.pagination.total, 0);
});

// --- 8. non-GET on a known route -> 405 -------------------------------------

test('non-GET on a known route -> 405', async () => {
  const res = await fetch(`${base}/article`, { method: 'POST' });
  assert.equal(res.status, 405);
});
