import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OffHeapSessionStore } from '../src/auth/session.store.ts';

/**
 * Pure data-structure tests for the OFF-HEAP session store — no Postgres, no mocks. The store is
 * verified against a plain `Map` ORACLE across heavy insert/update/delete churn and forced rebuilds, so
 * its open-addressing probe, tombstone reuse, arena compaction, and growth are all exercised for real.
 * The whole point of the structure (replacing a JS `Map` to dodge GC / the 2^24 ceiling) means the
 * scale test must actually push well past a toy size while staying byte-exact with the oracle.
 */

/** A deterministic LCG so the churn pattern is reproducible (no Math.random). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('insert / get / miss', () => {
  const s = new OffHeapSessionStore();
  assert.equal(s.size(), 0);
  assert.equal(s.get('nope'), null);

  s.set('tok-a', 'user-1', 1000);
  s.set('tok-b', 'user-2', 2000);
  assert.equal(s.size(), 2);
  assert.deepEqual(s.get('tok-a'), { userId: 'user-1', expiresAt: 1000 });
  assert.deepEqual(s.get('tok-b'), { userId: 'user-2', expiresAt: 2000 });
  assert.equal(s.get('tok-c'), null);
});

test('re-set of a known token updates expiry/userId in place (no duplicate, no size growth)', () => {
  const s = new OffHeapSessionStore();
  s.set('tok', 'user-1', 1000);
  assert.equal(s.size(), 1);
  s.set('tok', 'user-1', 5000); // refresh expiry
  assert.equal(s.size(), 1);
  assert.deepEqual(s.get('tok'), { userId: 'user-1', expiresAt: 5000 });
  s.set('tok', 'user-RENAMED', 6000); // defensive userId overwrite
  assert.equal(s.size(), 1);
  assert.deepEqual(s.get('tok'), { userId: 'user-RENAMED', expiresAt: 6000 });
});

test('delete tombstones the slot; get misses; re-insert reuses the slot', () => {
  const s = new OffHeapSessionStore();
  s.set('tok', 'user-1', 1000);
  assert.equal(s.delete('tok'), true);
  assert.equal(s.size(), 0);
  assert.equal(s.get('tok'), null);
  assert.equal(s.delete('tok'), false); // idempotent
  s.set('tok', 'user-2', 2000); // reuse
  assert.equal(s.size(), 1);
  assert.deepEqual(s.get('tok'), { userId: 'user-2', expiresAt: 2000 });
});

test('variable-length / non-ASCII tokens and userIds round-trip exactly', () => {
  const s = new OffHeapSessionStore();
  const cases: [string, string, number][] = [
    ['', 'empty-token-user', 1], // empty token is a valid distinct key
    ['x', 'u', 2],
    ['a'.repeat(512), 'long-user-' + 'b'.repeat(300), 3],
    ['токен-ключ-🔑', 'пользователь-🙂', 4], // multi-byte UTF-8 both sides
  ];
  for (const [t, u, e] of cases) s.set(t, u, e);
  assert.equal(s.size(), cases.length);
  for (const [t, u, e] of cases) assert.deepEqual(s.get(t), { userId: u, expiresAt: e });
});

test('forced collisions: many tokens in a tiny initial table stay correct through growth', () => {
  // Start at the minimum so the table MUST rebuild/grow repeatedly while we insert.
  const s = new OffHeapSessionStore(2);
  const oracle = new Map<string, { userId: string; expiresAt: number }>();
  for (let i = 0; i < 5000; i++) {
    const tok = `session_token_${i}_${i * 7}`;
    const v = { userId: `u${i}`, expiresAt: 1_700_000_000_000 + i };
    s.set(tok, v.userId, v.expiresAt);
    oracle.set(tok, v);
  }
  assert.equal(s.size(), oracle.size);
  for (const [tok, v] of oracle) assert.deepEqual(s.get(tok), v);
});

test('heavy churn (insert/update/delete) stays byte-exact with a Map oracle, across rebuilds', () => {
  const s = new OffHeapSessionStore(8);
  const oracle = new Map<string, { userId: string; expiresAt: number }>();
  const rng = lcg(42);
  const N = 40_000;
  for (let i = 0; i < N; i++) {
    const key = `tok-${(rng() * 4000) | 0}`; // small key space => lots of updates + tombstone reuse
    const r = rng();
    if (r < 0.55) {
      const v = { userId: `user-${(rng() * 1000) | 0}`, expiresAt: (rng() * 1e12) | 0 };
      s.set(key, v.userId, v.expiresAt);
      oracle.set(key, v);
    } else if (r < 0.8) {
      const had = oracle.delete(key);
      assert.equal(s.delete(key), had);
    } else {
      // read-verify mid-stream
      assert.deepEqual(s.get(key) ?? null, oracle.get(key) ?? null);
    }
    // periodic full reconciliation
    if (i % 9973 === 0) {
      assert.equal(s.size(), oracle.size);
    }
  }
  assert.equal(s.size(), oracle.size);
  for (const [k, v] of oracle) assert.deepEqual(s.get(k), v);
  // every deleted-and-absent key really misses
  for (let j = 0; j < 4000; j++) {
    const k = `tok-${j}`;
    assert.deepEqual(s.get(k) ?? null, oracle.get(k) ?? null);
  }
});

test('pruneExpired evicts only expired entries; live ones survive; full pass covers all', () => {
  const s = new OffHeapSessionStore();
  const NOW = 1_800_000_000_000;
  // even i: already expired (NOW - 1); odd i: live (NOW + hour)
  for (let i = 0; i < 1000; i++) s.set(`t${i}`, `u${i}`, i % 2 === 0 ? NOW - 1 : NOW + 3_600_000);
  assert.equal(s.size(), 1000);

  // sweep the whole store in slices; a small budget proves incrementality (no single O(n) pass)
  let totalExpired = 0;
  for (let pass = 0; pass < 20; pass++) totalExpired += s.pruneExpired(NOW, 100).expired;
  assert.equal(totalExpired, 500, 'exactly the 500 expired entries are evicted');
  assert.equal(s.size(), 500, 'only the 500 live entries remain');

  for (let i = 0; i < 1000; i++) {
    const hit = s.get(`t${i}`);
    if (i % 2 === 0) assert.equal(hit, null, `expired t${i} must be gone`);
    else assert.deepEqual(hit, { userId: `u${i}`, expiresAt: NOW + 3_600_000 }, `live t${i} must survive`);
  }
  // re-sweeping finds nothing new
  assert.equal(s.pruneExpired(NOW, 2000).expired, 0);
});

test('sustained login/logout churn keeps recordCount bounded (compaction fires)', () => {
  // Constant live size with heavy delete+insert of DISTINCT tokens — the case where tombstone SLOTS are
  // reused so the load-factor trigger never fires. Without the recCount compaction trigger, recordCount
  // (and the arenas) would grow ~linearly with the 100k inserts; with it, it tracks the live set.
  const s = new OffHeapSessionStore();
  const oracle = new Map<string, number>();
  const rng = lcg(7);
  let uniq = 0;
  for (let i = 0; i < 100_000; i++) {
    if (oracle.size >= 2000 || (oracle.size > 0 && rng() < 0.5)) {
      // delete a present key
      const key = oracle.keys().next().value as string;
      oracle.delete(key);
      s.delete(key);
    } else {
      const key = `tok_${uniq++}`; // always a fresh, distinct token => a new record append
      oracle.set(key, uniq);
      s.set(key, `u${uniq}`, 2_000_000_000_000);
    }
  }
  assert.equal(s.size(), oracle.size, 'live count matches the oracle through churn');
  // The proof: records on hand track the live set, NOT the ~50k cumulative inserts.
  assert.ok(
    s.recordCount() <= (s.size() + 1) * 3,
    `recordCount ${s.recordCount()} must stay bounded near live ${s.size()} (no churn leak)`,
  );
  for (const [k, v] of oracle) assert.deepEqual(s.get(k), { userId: `u${v}`, expiresAt: 2_000_000_000_000 });
});

test('scale: 1,000,000 live sessions resident off-heap, all retrievable (no Map ceiling)', () => {
  const s = new OffHeapSessionStore();
  const N = 1_000_000;
  for (let i = 0; i < N; i++) {
    // realistic base64url-ish token shape
    s.set(`Hb7${i.toString(36)}x${(i * 2654435761 >>> 0).toString(36)}`, `usr_${i}`, 1_800_000_000_000 + i);
  }
  assert.equal(s.size(), N);
  // spot-check a deterministic spread of keys
  for (let i = 0; i < N; i += 7919) {
    const tok = `Hb7${i.toString(36)}x${(i * 2654435761 >>> 0).toString(36)}`;
    assert.deepEqual(s.get(tok), { userId: `usr_${i}`, expiresAt: 1_800_000_000_000 + i });
  }
  // deleting half compacts on the next growth without losing the survivors
  for (let i = 0; i < N; i += 2) {
    s.delete(`Hb7${i.toString(36)}x${(i * 2654435761 >>> 0).toString(36)}`);
  }
  assert.equal(s.size(), N / 2);
  for (let i = 1; i < N; i += 2 * 7919 + 1) {
    const tok = `Hb7${i.toString(36)}x${(i * 2654435761 >>> 0).toString(36)}`;
    if (i % 2 === 1) assert.deepEqual(s.get(tok), { userId: `usr_${i}`, expiresAt: 1_800_000_000_000 + i });
  }
});
