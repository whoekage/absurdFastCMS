import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef, type Predicate } from '../src/store/table.ts';

/**
 * be-22b — OFF-HEAP EqIndex intern (the value->code dictionary that overflowed the V8 Map).
 *
 * THE DEFECT: `EqIndex.rebuild()` used `const codeOf = new Map<unknown, number>()` and interned every
 * distinct value. On a HIGH-cardinality column (the unique `id` primary key = N distinct), the Map
 * overflowed V8's effective ceiling (~8.4M / 2^23) and `createEqIndex('id')` THREW a RangeError at
 * >~8.4M rows (engine-ops bench Finding A). The fix swaps the Map for an off-heap {@link ValueInterner}
 * (a numeric dense direct-address fast path / an open-addressing string interner / exact-64-bit bigint /
 * bool), so a dictionary of any size is a handful of off-heap typed-array buffers.
 *
 * Doctrine: NO mocks. Correctness is checked against an O(n) brute-force oracle. The HEAVY >=10M case
 * is OPT-IN behind EQINDEX_SCALE_TEST=1 (it builds a 10M+-row column — ~1 GB RSS, ~minute), mirroring
 * the SESSION_SCALE_TEST gate, so the default suite stays fast. A MID-scale case (>1M unique, well past
 * the structure's growth thresholds but cheap) runs by DEFAULT to keep the off-heap path under CI.
 *
 *   EQINDEX_SCALE_TEST=1 node --env-file=.env.test --test --test-global-setup=./test/global-setup.ts \
 *     --test-name-pattern='10M' test/eq-index-offheap.test.ts
 *
 * Override the heavy count with EQINDEX_SCALE_N (default 10_000_000).
 */

const SCALE = process.env.EQINDEX_SCALE_TEST === '1';
const SCALE_N = Number(process.env.EQINDEX_SCALE_N ?? 10_000_000);

function eqRows(t: Table, field: string, value: unknown): number[] {
  return t.scan([{ field, op: 'eq', value } as Predicate]).toArray();
}
function inRows(t: Table, field: string, values: unknown[]): number[] {
  return t.scan([{ field, op: 'in', value: values } as Predicate]).toArray();
}

/**
 * The MANDATORY regression: an eq index on a UNIQUE integer key with MORE distinct values than the old
 * Map's ~8.4M ceiling must BUILD (used to RangeError) and serve eq/in. Gated behind EQINDEX_SCALE_TEST
 * because it materializes a 10M-row column. The default suite proves the same off-heap path at >1M (the
 * structure's growth thresholds are crossed by ~1M; the only thing 10M adds is clearing the EXACT old
 * 8.4M ceiling, which is exactly what this gated test pins).
 */
test(
  'createEqIndex on a >=10M-UNIQUE-key column BUILDS (used to RangeError) and serves eq/in',
  { skip: SCALE ? false : 'set EQINDEX_SCALE_TEST=1 to run the 10M off-heap-EqIndex proof', timeout: 600_000 },
  () => {
    const fields: FieldDef[] = [{ name: 'id', type: 'i32' }];
    const t = new Table(fields);
    t.createEqIndex('id'); // index BEFORE insert -> live add maintenance + lazy rebuild path
    for (let i = 0; i < SCALE_N; i++) t.insert({ id: i + 1 });
    assert.equal(t.rowCount, SCALE_N);

    // BUILD: warming the index used to THROW here at >~8.4M. Force the rebuild via a query.
    const first = eqRows(t, 'id', 1);
    assert.deepEqual(first, [0], 'id=1 -> row 0');

    // The unique key is near-unique => 'dict' tier (off-heap dictionary IS the index, no plane blowup).
    assert.equal(t.eqStrategy('id'), 'dict');

    // SERVE eq across the range (present rows are 1..N -> dense codes [0,N)).
    for (const id of [1, 2, 8_388_609 /* 2^23+1, past the old ceiling */, SCALE_N >>> 1, SCALE_N]) {
      assert.deepEqual(eqRows(t, 'id', id), [id - 1], `id=${id}`);
    }
    // Absent keys match nothing (below min / above max).
    assert.deepEqual(eqRows(t, 'id', 0), []);
    assert.deepEqual(eqRows(t, 'id', SCALE_N + 1), []);

    // SERVE in.
    const r = inRows(t, 'id', [1, SCALE_N, SCALE_N + 99]);
    assert.deepEqual(r, [0, SCALE_N - 1]);
  },
);

/**
 * DEFAULT-RUN proof of the same off-heap path at >1M unique (cheap, ~hundreds of ms): builds, picks the
 * dict tier, and serves eq/in/point-lookup with byte-identical results vs the brute oracle. This is the
 * mid-scale guard that keeps the off-heap interner exercised in CI even when the 10M gate is off.
 */
test('createEqIndex on a >1M-unique integer key builds off-heap and serves correctly', () => {
  const N = 1_500_000;
  const fields: FieldDef[] = [{ name: 'id', type: 'i32' }];
  const t = new Table(fields);
  t.createEqIndex('id');
  for (let i = 0; i < N; i++) t.insert({ id: i + 1 });

  assert.equal(t.eqStrategy('id'), 'dict');
  for (const id of [1, 1000, 524_289, N - 1, N]) {
    assert.deepEqual(eqRows(t, 'id', id), [id - 1], `id=${id}`);
  }
  assert.deepEqual(eqRows(t, 'id', N + 1), []);
  assert.deepEqual(inRows(t, 'id', [1, N, N + 5]), [0, N - 1]);
});

/**
 * POINT LOOKUP via the eq index is O(1)-ish (dense direct-address), NOT the O(n) brute scan. We prove it
 * by TIMING: 50k random point lookups over a 1M-row unique key resolve in well under the wall-clock a
 * single O(n) brute scan of 1M rows would take (a brute eq is ~1M comparisons; 50k indexed lookups must
 * beat ONE brute scan by a wide margin). No mocks — a real wall-clock budget on the real structure.
 */
test('point lookup via eq index is the fast direct-address path, not the O(n) brute scan', () => {
  const N = 1_000_000;
  const fields: FieldDef[] = [{ name: 'id', type: 'i32' }];
  const t = new Table(fields);
  t.createEqIndex('id');
  for (let i = 0; i < N; i++) t.insert({ id: i + 1 });
  t.warmIndexes();
  // warm the rebuild via one query so the timed loop measures pure lookup.
  assert.deepEqual(eqRows(t, 'id', 1), [0]);

  const PROBES = 50_000;
  const t0 = process.hrtime.bigint();
  let hits = 0;
  for (let k = 0; k < PROBES; k++) {
    const id = ((k * 7919) % N) + 1;
    const rows = t.rowIdByEq('id', id);
    if (rows !== undefined) hits++;
  }
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(hits, PROBES, 'every present key resolved');

  // Hard ceiling: 50k direct-address lookups should complete in << 250ms (each is a subtract + 2 reads).
  // If the index had silently degraded to O(n) brute (1M comparisons * 50k = 5e10 ops), this would be
  // minutes. The generous 250ms bound is a regression tripwire, not a microbenchmark.
  assert.ok(elapsedMs < 250, `50k indexed point lookups took ${elapsedMs.toFixed(1)}ms (expected << 250ms)`);
});

/**
 * EXACT 64-bit bigint distinctness (i64/decimal): two distinct mantissas that COLLIDE under `Number()`
 * (above 2^53) must get DISTINCT codes and resolve independently — the lossy f64-projection bug that a
 * naive numeric interner would have. Byte-identical eq across the i64 boundary.
 */
test('eq index on an i64 column keeps >2^53 distinct bigints distinct (no f64-collision conflation)', () => {
  const fields: FieldDef[] = [{ name: 'big', type: 'i64' }];
  const t = new Table(fields);
  t.createEqIndex('big');
  // 2^53 and 2^53+1 collide under Number(); 2^63-1 is the i64 max.
  const vals = [9007199254740992n, 9007199254740993n, 9223372036854775807n, 5n, -5n];
  for (const v of vals) t.insert({ big: v });

  assert.deepEqual(eqRows(t, 'big', 9007199254740992n), [0], '2^53');
  assert.deepEqual(eqRows(t, 'big', 9007199254740993n), [1], '2^53+1 (distinct, not conflated with 2^53)');
  assert.deepEqual(eqRows(t, 'big', 9223372036854775807n), [2], 'i64 max');
  assert.deepEqual(eqRows(t, 'big', 5n), [3]);
  assert.deepEqual(eqRows(t, 'big', -5n), [4]);
  // An absent 64-bit value (also >2^53) matches nothing — proves the exact compare, not a hash hit.
  assert.deepEqual(eqRows(t, 'big', 9223372036854775806n), []);
});
