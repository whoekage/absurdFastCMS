import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/store/engine.ts';
import {
  ResponseCache,
  InProcessChangeBus,
  queryKey,
} from '../src/store/response.cache.ts';
import { type FieldDef, type QueryOptions } from '../src/store/table.ts';

/**
 * API-VERTICAL SLICE 1 — assembled-buffer response cache.
 *
 * Doctrine: NO mocks. A REAL Engine (real Table + columns + InProcessChangeBus) drives every test.
 * Correctness is proven by an equivalence ORACLE: the uncached (cache-disabled) assemble is the
 * source of truth, and a cache HIT must be BYTE-IDENTICAL to it. We further prove: a write
 * invalidates (no stale serve), the normalized key collapses trivially-reordered queries to one
 * entry, the bounded LRU never exceeds its caps and re-assembles an evicted query correctly, and the
 * ChangeBus drops only the written type. Deterministic seeded LCG, no Math.random.
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

function seed(n: number, seedNum: number, cacheEnabled = true): Engine {
  const engine = new Engine({ cache: { enabled: cacheEnabled } });
  const t = engine.define('article', FIELDS);
  t.createEqIndex('status');
  t.createSortedIndex('views');
  t.createSortedIndex('publishedAt');
  const rng = lcg(seedNum);
  const base = Date.UTC(2021, 0, 1);
  for (let i = 0; i < n; i++) {
    engine.insert('article', {
      title: rng() < 0.1 ? null : `Title "${i}" é 中`,
      status: STATUSES[(rng() * STATUSES.length) | 0]!,
      views: rng() < 0.08 ? null : (rng() * 100000) | 0,
      rating: rng() < 0.08 ? null : Math.round(rng() * 1000) / 100,
      active: rng() < 0.5,
      publishedAt: base + i * 3_600_000,
    });
  }
  t.warmIndexes();
  return engine;
}

const SORTS: QueryOptions['sort'][] = [
  undefined,
  [{ field: 'views', dir: 'desc' }],
  [{ field: 'publishedAt', dir: 'asc' }],
  [{ field: 'title', dir: 'asc' }],
];

function randomQuery(rng: () => number): QueryOptions {
  return {
    filters: rng() < 0.5 ? [{ field: 'status', op: 'eq', value: STATUSES[(rng() * 3) | 0]! }] : [],
    sort: SORTS[(rng() * SORTS.length) | 0],
    offset: (rng() * 30) | 0,
    limit: 1 + ((rng() * 25) | 0),
  };
}

// --- 1. cache hit == byte-identical cold assemble ---------------------------

test('cache hit is byte-identical to the cold assemble', () => {
  const engine = seed(400, 11);
  const rng = lcg(2024);
  for (let k = 0; k < 100; k++) {
    const opts = randomQuery(rng);
    const cold = engine.respond('article', opts); // miss -> assembles + stores
    const hot = engine.respond('article', opts); // hit -> returns cached buffer
    assert.equal(hot.toString('utf8'), cold.toString('utf8'), `query #${k} hit==cold`);
    assert.ok(hot.equals(cold), `query #${k} bytes equal`);
  }
});

// --- 2. equivalence vs the uncached path across randomized queries ----------

test('cached path equals the uncached path byte-for-byte across randomized queries', () => {
  const cached = seed(400, 7, true);
  const uncached = seed(400, 7, false); // same seed -> identical data
  const rng = lcg(99);
  for (let k = 0; k < 300; k++) {
    const opts = randomQuery(rng);
    // Run twice on the cached engine so the second is a real hit.
    cached.respond('article', opts);
    const fromCache = cached.respond('article', opts);
    const fromCold = uncached.respond('article', opts);
    assert.equal(fromCache.toString('utf8'), fromCold.toString('utf8'), `query #${k}`);
  }
  assert.ok(cached.cache.hits > 0, 'the cached engine actually served hits');
  assert.equal(uncached.cache.size, 0, 'a disabled cache never stores anything');
});

// --- 3. a write invalidates: no stale serve --------------------------------

test('a write to the type invalidates so the next read reflects the new row', () => {
  const engine = seed(50, 3);
  const opts: QueryOptions = { sort: [{ field: 'publishedAt', dir: 'asc' }], offset: 0, limit: 1000 };

  const before = engine.respond('article', opts);
  const beforeCount = JSON.parse(before.toString('utf8')).data.length;
  // Prime a hit so we KNOW a cache entry exists prior to the write.
  engine.respond('article', opts);
  assert.ok(engine.cache.size > 0, 'entry cached before write');

  engine.insert('article', {
    title: 'fresh',
    status: 'published',
    views: 42,
    rating: 1.5,
    active: true,
    publishedAt: Date.UTC(2099, 0, 1),
  });
  // The publish from insert must have dropped the type's entries.
  assert.equal(engine.cache.size, 0, 'write dropped the cached entry');

  const after = engine.respond('article', opts);
  const afterParsed = JSON.parse(after.toString('utf8'));
  assert.equal(afterParsed.data.length, beforeCount + 1, 'new row is reflected, not stale');
  assert.notEqual(after.toString('utf8'), before.toString('utf8'), 'bytes changed after write');
  // And it equals a freshly cold-assembled envelope (recompute via a disabled cache twin).
  engine.cache.enabled = false;
  const cold = engine.respond('article', opts);
  engine.cache.enabled = true;
  assert.equal(after.toString('utf8'), cold.toString('utf8'), 'post-write bytes == cold assemble');
});

// --- 4. normalized key: trivially-reordered queries hit the SAME entry ------

test('reordered AND filters and reordered in-set hit the SAME cache entry', () => {
  const engine = new Engine();
  const t = engine.define('item', [
    { name: 'status', type: 'string' },
    { name: 'kind', type: 'string' },
    { name: 'views', type: 'i32' },
  ]);
  for (let i = 0; i < 30; i++) {
    engine.insert('item', { status: STATUSES[i % 3]!, kind: i % 2 ? 'a' : 'b', views: i });
  }
  t.warmIndexes();

  const a: QueryOptions = {
    filters: [
      { field: 'status', op: 'eq', value: 'published' },
      { field: 'kind', op: 'eq', value: 'a' },
    ],
  };
  const b: QueryOptions = {
    // same two predicates, REVERSED order
    filters: [
      { field: 'kind', op: 'eq', value: 'a' },
      { field: 'status', op: 'eq', value: 'published' },
    ],
  };
  const r1 = engine.respond('item', a); // miss
  const r2 = engine.respond('item', b); // must be a HIT on the same normalized key
  assert.equal(engine.cache.size, 1, 'reordered AND filters share one entry');
  assert.equal(engine.cache.hits, 1, 'second query was a hit');
  assert.equal(r1.toString('utf8'), r2.toString('utf8'));

  // in-set order independence on the same single entry
  engine.cache.clear();
  engine.cache.hits = 0;
  const inA: QueryOptions = { filters: [{ field: 'views', op: 'in', value: [3, 1, 2] }] };
  const inB: QueryOptions = { filters: [{ field: 'views', op: 'in', value: [2, 3, 1] }] };
  engine.respond('item', inA);
  engine.respond('item', inB);
  assert.equal(engine.cache.size, 1, 'reordered in-set shares one entry');
  assert.equal(engine.cache.hits, 1);
});

test('queryKey: equivalent queries normalize equal; distinct ones differ', () => {
  // reordered AND filters
  assert.equal(
    queryKey('t', { filters: [{ field: 'a', op: 'eq', value: 1 }, { field: 'b', op: 'eq', value: 2 }] }),
    queryKey('t', { filters: [{ field: 'b', op: 'eq', value: 2 }, { field: 'a', op: 'eq', value: 1 }] }),
  );
  // default offset/limit normalize to the explicit defaults
  assert.equal(
    queryKey('t', {}),
    queryKey('t', { offset: 0, limit: Infinity, sort: [], filters: [] }),
  );
  // sort order is POSITIONAL -> different keys
  assert.notEqual(
    queryKey('t', { sort: [{ field: 'a', dir: 'asc' }, { field: 'b', dir: 'asc' }] }),
    queryKey('t', { sort: [{ field: 'b', dir: 'asc' }, { field: 'a', dir: 'asc' }] }),
  );
  // between is positional -> [1,2] != [2,1]
  assert.notEqual(
    queryKey('t', { filters: [{ field: 'a', op: 'between', value: [1, 2] }] }),
    queryKey('t', { filters: [{ field: 'a', op: 'between', value: [2, 1] }] }),
  );
  // different type name -> different key
  assert.notEqual(queryKey('a', {}), queryKey('b', {}));
});

// --- 5. bounded LRU: cap holds, evicts LRU, re-request re-assembles ---------

test('LRU bound: feeding > cap distinct queries keeps size at the cap, evicting LRU', () => {
  const CAP = 8;
  const engine = new Engine({ cache: { maxEntries: CAP } });
  const t = engine.define('doc', [{ name: 'n', type: 'i32' }]);
  for (let i = 0; i < 500; i++) engine.insert('doc', { n: i });
  t.warmIndexes();

  // Feed many DISTINCT queries (unique offset). Cache size must never exceed CAP.
  const N = 200;
  for (let i = 0; i < N; i++) {
    engine.respond('doc', { offset: i, limit: 1 });
    assert.ok(engine.cache.size <= CAP, `size ${engine.cache.size} <= cap ${CAP} after ${i}`);
  }
  assert.equal(engine.cache.size, CAP, 'cache settled exactly at the cap');
  assert.ok(engine.cache.evictions >= N - CAP, 'evictions happened');

  // The last CAP queries (offsets N-CAP .. N-1) are the survivors; an earlier one was evicted.
  const evictedOpts: QueryOptions = { offset: 0, limit: 1 };
  const re = engine.respond('doc', evictedOpts); // re-assembles after eviction
  engine.cache.enabled = false;
  const cold = engine.respond('doc', evictedOpts);
  engine.cache.enabled = true;
  assert.equal(re.toString('utf8'), cold.toString('utf8'), 'evicted-then-re-requested re-assembles correctly');
});

test('LRU recency: a re-touched entry survives eviction over an older untouched one', () => {
  const engine = new Engine({ cache: { maxEntries: 3 } });
  const t = engine.define('doc', [{ name: 'n', type: 'i32' }]);
  for (let i = 0; i < 20; i++) engine.insert('doc', { n: i });
  t.warmIndexes();

  const q = (off: number): QueryOptions => ({ offset: off, limit: 1 });
  engine.respond('doc', q(0)); // [0]
  engine.respond('doc', q(1)); // [0,1]
  engine.respond('doc', q(2)); // [0,1,2]
  engine.respond('doc', q(0)); // touch 0 -> [1,2,0] (0 now MRU)
  engine.respond('doc', q(3)); // overflow -> evict LRU = 1 -> [2,0,3]

  // 0 should still be cached (it was touched); 1 should have been evicted.
  const hitsBefore = engine.cache.hits;
  engine.respond('doc', q(0));
  assert.equal(engine.cache.hits, hitsBefore + 1, 'touched entry 0 survived (a hit)');
  assert.equal(engine.cache.size, 3, 'still at cap');
});

test('LRU byte bound: total cached bytes never exceeds maxBytes', () => {
  // Each response is at least a few dozen bytes; a tiny byte cap forces near-immediate eviction.
  const engine = new Engine({ cache: { maxEntries: 10_000, maxBytes: 200 } });
  const t = engine.define('doc', [{ name: 'n', type: 'i32' }]);
  for (let i = 0; i < 100; i++) engine.insert('doc', { n: i });
  t.warmIndexes();
  for (let i = 0; i < 100; i++) {
    engine.respond('doc', { offset: i, limit: 1 });
    assert.ok(engine.cache.byteSize <= 200, `byteSize ${engine.cache.byteSize} <= 200 at ${i}`);
  }
});

// --- 6. ChangeBus: publish drops the type; other types untouched -----------

test('ChangeBus: publish drops the published type only; other types untouched', () => {
  const engine = new Engine();
  engine.define('alpha', [{ name: 'n', type: 'i32' }]);
  engine.define('beta', [{ name: 'n', type: 'i32' }]);
  for (let i = 0; i < 10; i++) {
    engine.insert('alpha', { n: i });
    engine.insert('beta', { n: i });
  }
  engine.table('alpha').warmIndexes();
  engine.table('beta').warmIndexes();

  engine.respond('alpha', { limit: 100 });
  engine.respond('beta', { limit: 100 });
  assert.equal(engine.cache.size, 2, 'both types cached');

  engine.bus.publish('alpha'); // a manual publish (the seam) — no actual write
  assert.equal(engine.cache.size, 1, 'alpha dropped, beta survives');
  // beta still serves a hit
  const hitsBefore = engine.cache.hits;
  engine.respond('beta', { limit: 100 });
  assert.equal(engine.cache.hits, hitsBefore + 1, 'beta was still a hit');
});

test('InProcessChangeBus fans out to multiple subscribers', () => {
  const bus = new InProcessChangeBus();
  const seenA: string[] = [];
  const seenB: string[] = [];
  bus.subscribe((t) => seenA.push(t));
  bus.subscribe((t) => seenB.push(t));
  bus.publish('x');
  bus.publish('y');
  assert.deepEqual(seenA, ['x', 'y']);
  assert.deepEqual(seenB, ['x', 'y']);
});

// --- 7. cache toggle ---------------------------------------------------------

test('cache can be toggled off (no storage, always cold)', () => {
  const bus = new InProcessChangeBus();
  const cache = new ResponseCache(bus, { enabled: false });
  cache.set('k', 'doc', Buffer.from('hello'));
  assert.equal(cache.size, 0, 'disabled cache stores nothing');
  assert.equal(cache.get('k'), undefined, 'disabled cache never hits');
});
