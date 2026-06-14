import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef } from '../src/store/table.ts';
import { coerceDate } from '../src/store/column.ts';

/**
 * Temporal column tests (build-plan Slice 6). Honest, no mocks: everything is driven through the
 * real Table / DateColumn / SortedIndex, and every "expected" result is computed by a trivial O(n)
 * brute-force oracle over the inserted rows (the same equivalence style as test/index.test.ts).
 *
 * The shared truth a date column must honour: a `Date`, its ISO-8601 string, and its epoch-ms
 * number ALL coerce to the identical stored ms, so filtering and ORDER BY agree no matter which
 * shape the data (or the predicate) arrived in.
 */

const FIELDS: FieldDef[] = [
  { name: 'publishedAt', type: 'date' },
  { name: 'title', type: 'string' },
];

// A deterministic seeded LCG (no Math.random — the determinism mandate) producing day offsets.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s;
  };
}

const DAY_MS = 86_400_000;
const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00Z

/** Build `n` rows; every `nullEvery`-th row has a NULL publishedAt (a draft). */
function buildDates(n: number, nullEvery: number): { table: Table; ms: (number | null)[] } {
  const t = new Table(FIELDS);
  t.createSortedIndex('publishedAt');
  const rnd = lcg(12345);
  const ms: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const isNull = nullEvery > 0 && i % nullEvery === 0;
    if (isNull) {
      t.insert({ title: `t${i}` }); // publishedAt missing => NULL draft
      ms.push(null);
      continue;
    }
    const dayOffset = rnd() % 400; // spread across ~400 days
    const instant = BASE_MS + dayOffset * DAY_MS + (rnd() % DAY_MS);
    // Alternate the INSERT shape: Date object, ISO string, raw number — all must store the same ms.
    const shape = i % 3;
    const value = shape === 0 ? new Date(instant) : shape === 1 ? new Date(instant).toISOString() : instant;
    t.insert({ publishedAt: value, title: `t${i}` });
    ms.push(instant);
  }
  return { table: t, ms };
}

/** Brute oracle: rows (excluding NULLs) whose stored ms satisfies `op` against `boundMs`. */
function oracleRange(ms: (number | null)[], op: 'gt' | 'gte' | 'lt' | 'lte', boundMs: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < ms.length; i++) {
    const v = ms[i];
    if (v === null) continue; // NULL is "unknown", never matches a comparison (three-valued logic)
    if (op === 'gt' && v > boundMs) out.push(i);
    else if (op === 'gte' && v >= boundMs) out.push(i);
    else if (op === 'lt' && v < boundMs) out.push(i);
    else if (op === 'lte' && v <= boundMs) out.push(i);
  }
  return out;
}

function oracleBetween(ms: (number | null)[], loMs: number, hiMs: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < ms.length; i++) {
    const v = ms[i];
    if (v === null) continue;
    if (v >= loMs && v <= hiMs) out.push(i);
  }
  return out;
}

test('coerceDate: Date, ISO string and epoch-ms for the same instant all coerce equal', () => {
  const instant = Date.UTC(2026, 5, 13, 14, 30, 15, 500);
  const asDate = coerceDate(new Date(instant));
  const asIso = coerceDate(new Date(instant).toISOString());
  const asNum = coerceDate(instant);
  assert.equal(asDate, instant);
  assert.equal(asIso, instant);
  assert.equal(asNum, instant);
});

test('three input shapes for the same instant store the identical ms and filter/sort identically', () => {
  const instant = Date.UTC(2026, 2, 10, 8, 0, 0);
  const t = new Table(FIELDS);
  t.createSortedIndex('publishedAt');
  t.insert({ publishedAt: new Date(instant), title: 'a' }); // row 0: Date
  t.insert({ publishedAt: new Date(instant).toISOString(), title: 'b' }); // row 1: ISO
  t.insert({ publishedAt: instant, title: 'c' }); // row 2: number ms
  // All three round-trip to the same ISO string => same stored ms.
  const iso = new Date(instant).toISOString();
  for (const r of [0, 1, 2]) assert.equal(t.materialize(r).publishedAt, iso);

  // An $eq on any of the three predicate shapes selects all three rows.
  for (const pv of [new Date(instant), iso, instant]) {
    assert.deepEqual(t.scan([{ field: 'publishedAt', op: 'eq', value: pv }]).toArray(), [0, 1, 2]);
  }
});

test('$gt/$lt predicate value as Date / ISO / number all agree with a brute oracle', () => {
  const { table, ms } = buildDates(1500, 0);
  table.warmIndexes();
  const bounds = [
    BASE_MS,
    BASE_MS + 100 * DAY_MS,
    BASE_MS + 200 * DAY_MS + 12_000,
    BASE_MS + 399 * DAY_MS,
  ];
  const ops = ['gt', 'gte', 'lt', 'lte'] as const;
  for (const op of ops) {
    for (const boundMs of bounds) {
      const expected = oracleRange(ms, op, boundMs);
      // The same bound expressed three different ways must all equal the oracle.
      for (const pv of [boundMs, new Date(boundMs), new Date(boundMs).toISOString()]) {
        const got = table.scan([{ field: 'publishedAt', op, value: pv }]).toArray();
        assert.deepEqual(got, expected, `${op} bound=${String(pv)}`);
      }
    }
  }
});

test('$between with [Date, Date] / [ISO, ISO] / [number, number] equals the brute oracle', () => {
  const { table, ms } = buildDates(1500, 0);
  table.warmIndexes();
  const ranges: [number, number][] = [
    [BASE_MS, BASE_MS + 50 * DAY_MS],
    [BASE_MS + 100 * DAY_MS, BASE_MS + 300 * DAY_MS],
    [BASE_MS + 399 * DAY_MS, BASE_MS + 400 * DAY_MS], // narrow tail
    [BASE_MS + 300 * DAY_MS, BASE_MS + 100 * DAY_MS], // reversed => empty
  ];
  for (const [lo, hi] of ranges) {
    const expected = oracleBetween(ms, lo, hi);
    const pairs: [unknown, unknown][] = [
      [lo, hi],
      [new Date(lo), new Date(hi)],
      [new Date(lo).toISOString(), new Date(hi).toISOString()],
    ];
    for (const pair of pairs) {
      const got = table.scan([{ field: 'publishedAt', op: 'between', value: pair }]).toArray();
      assert.deepEqual(got, expected, `between ${JSON.stringify(pair)}`);
    }
  }
});

test('$between without a sorted index matches the indexed/oracle result (scan floor)', () => {
  const { table, ms } = buildDates(800, 0); // sorted index IS created in buildDates
  const noIdx = new Table(FIELDS); // no index at all -> DateColumn.scan floor
  for (let i = 0; i < ms.length; i++) noIdx.insert({ publishedAt: ms[i]!, title: `t${i}` });
  const lo = BASE_MS + 20 * DAY_MS;
  const hi = BASE_MS + 250 * DAY_MS;
  const expected = oracleBetween(ms, lo, hi);
  assert.deepEqual(
    noIdx.scan([{ field: 'publishedAt', op: 'between', value: [new Date(lo), new Date(hi)] }]).toArray(),
    expected,
  );
  assert.deepEqual(
    table.scan([{ field: 'publishedAt', op: 'between', value: [lo, hi] }]).toArray(),
    expected,
  );
});

test('NULL publishedAt is excluded from ranges and never matched by any comparison', () => {
  const { table, ms } = buildDates(900, 7); // every 7th row is a NULL draft
  table.warmIndexes();
  const nullRows = new Set<number>();
  for (let i = 0; i < ms.length; i++) if (ms[i] === null) nullRows.add(i);
  assert.ok(nullRows.size > 0);

  const boundMs = BASE_MS + 150 * DAY_MS;
  for (const op of ['gt', 'gte', 'lt', 'lte'] as const) {
    const got = table.scan([{ field: 'publishedAt', op, value: boundMs }]).toArray();
    assert.deepEqual(got, oracleRange(ms, op, boundMs), op);
    for (const r of got) assert.ok(!nullRows.has(r), `null row ${r} leaked into ${op}`);
  }
  // $between also excludes nulls.
  const lo = BASE_MS;
  const hi = BASE_MS + 400 * DAY_MS;
  const allInRange = table.scan([{ field: 'publishedAt', op: 'between', value: [lo, hi] }]).toArray();
  for (const r of allInRange) assert.ok(!nullRows.has(r));
  assert.deepEqual(allInRange, oracleBetween(ms, lo, hi));

  // $eq against the dense sentinel's instant (epoch 0 / 1970) must NOT match the NULL rows whose
  // stored sentinel is 0 — three-valued logic.
  assert.deepEqual(
    table.scan([{ field: 'publishedAt', op: 'eq', value: 0 }]).toArray(),
    [], // no real row is at epoch 0, and the NULL sentinels (0) are masked out
  );

  // $null / $notNull surface exactly the nulls / non-nulls.
  const gotNull = table.scan([{ field: 'publishedAt', op: 'null', value: null }]).toArray();
  assert.deepEqual(gotNull, [...nullRows].sort((a, b) => a - b));
  const gotNotNull = table.scan([{ field: 'publishedAt', op: 'notNull', value: null }]).toArray();
  assert.equal(gotNotNull.length, ms.length - nullRows.size);
  for (const r of gotNotNull) assert.ok(!nullRows.has(r));
});

test('ORDER BY publishedAt (filtered) sorts ascending/descending, NULLs excluded by the filter', () => {
  const { table, ms } = buildDates(1200, 11);
  table.warmIndexes();
  // Filter to the non-null universe via $notNull, then sort.
  const filter = [{ field: 'publishedAt', op: 'notNull' as const, value: null }];

  const asc = table.query({ filters: filter, sort: [{ field: 'publishedAt', dir: 'asc' }], limit: ms.length });
  const ascMs = asc.map((r) => table.column('publishedAt').at(r) as number);
  for (let i = 1; i < ascMs.length; i++) assert.ok(ascMs[i]! >= ascMs[i - 1]!);
  // None of the sorted rows is a NULL.
  for (const r of asc) assert.equal(ms[r] !== null, true);
  // Count equals the non-null oracle.
  const nonNull = ms.filter((v) => v !== null).length;
  assert.equal(asc.length, nonNull);

  const desc = table.query({ filters: filter, sort: [{ field: 'publishedAt', dir: 'desc' }], limit: ms.length });
  const descMs = desc.map((r) => table.column('publishedAt').at(r) as number);
  for (let i = 1; i < descMs.length; i++) assert.ok(descMs[i]! <= descMs[i - 1]!);
});

test('recency ORDER BY desc + limit returns the newest rows first (early termination)', () => {
  const { table, ms } = buildDates(2000, 9);
  table.warmIndexes();
  const top = table.query({
    filters: [{ field: 'publishedAt', op: 'notNull', value: null }],
    sort: [{ field: 'publishedAt', dir: 'desc' }],
    limit: 10,
  });
  // Brute oracle: the 10 largest stored ms (non-null), newest first.
  const ranked = ms
    .map((v, i) => ({ v, i }))
    .filter((x) => x.v !== null)
    .sort((a, b) => b.v! - a.v! || a.i - b.i)
    .slice(0, 10);
  const expectedMs = ranked.map((x) => x.v);
  const gotMs = top.map((r) => table.column('publishedAt').at(r) as number);
  assert.deepEqual(gotMs, expectedMs);
});

test('NaN and nanosecond-magnitude inputs throw at validation (insert and predicate)', () => {
  const t = new Table(FIELDS);
  t.createSortedIndex('publishedAt');

  // Unparseable string / Invalid Date / NaN number -> throw at insert.
  assert.throws(() => t.insert({ publishedAt: 'not-a-date', title: 'x' }), /did not parse/);
  assert.throws(() => t.insert({ publishedAt: new Date('garbage'), title: 'x' }), /did not parse/);
  assert.throws(() => t.insert({ publishedAt: NaN, title: 'x' }), /did not parse/);

  // Nanosecond-scale epoch (> 2^53) -> throw at insert.
  const nsLike = Date.now() * 1_000_000; // ms -> ns magnitude, ~1.78e18, far above 2^53
  assert.throws(() => t.insert({ publishedAt: nsLike, title: 'x' }), /out of range/);
  assert.throws(() => coerceDate(nsLike), /out of range/);
  assert.throws(() => coerceDate(NaN), /did not parse/);

  // Predicate values are validated the same way: a bad bound throws when the predicate runs.
  t.insert({ publishedAt: BASE_MS, title: 'ok' });
  t.warmIndexes();
  assert.throws(() => t.scan([{ field: 'publishedAt', op: 'gt', value: 'nope' }]), /did not parse/);
  assert.throws(() => t.scan([{ field: 'publishedAt', op: 'gt', value: nsLike }]), /out of range/);
});

test('materialize round-trips a date row to ISO-8601 and NULL dates surface as null', () => {
  const t = new Table(FIELDS);
  const instant = Date.UTC(2026, 5, 13, 9, 41, 7, 123);
  t.insert({ publishedAt: new Date(instant), title: 'published' });
  t.insert({ title: 'draft' }); // NULL publishedAt
  t.insert({ publishedAt: new Date(instant).toISOString(), title: 'iso' });

  assert.deepEqual(t.materialize(0), { publishedAt: new Date(instant).toISOString(), title: 'published' });
  assert.deepEqual(t.materialize(1), { publishedAt: null, title: 'draft' });
  assert.deepEqual(t.materialize(2), { publishedAt: new Date(instant).toISOString(), title: 'iso' });
  // materialize ∘ coerce is the identity: feeding the materialized ISO back coerces to the same ms.
  assert.equal(coerceDate(t.materialize(0).publishedAt as string), instant);
});

test('date filter + sort stay correct past INITIAL_CAPACITY (capacity growth, word boundaries)', () => {
  const N = 3000; // > 1024, forces several Float64Array grows; not a multiple of 32
  const { table, ms } = buildDates(N, 13);
  table.warmIndexes();
  assert.equal(table.rowCount, N);

  const lo = BASE_MS + 30 * DAY_MS;
  const hi = BASE_MS + 370 * DAY_MS;
  assert.deepEqual(
    table.scan([{ field: 'publishedAt', op: 'between', value: [new Date(lo), new Date(hi)] }]).toArray(),
    oracleBetween(ms, lo, hi),
  );
  // Sorted ORDER BY over all non-null rows is globally ordered after the grows.
  const ordered = table.query({
    filters: [{ field: 'publishedAt', op: 'notNull', value: null }],
    sort: [{ field: 'publishedAt', dir: 'asc' }],
    limit: N,
  });
  const orderedMs = ordered.map((r) => table.column('publishedAt').at(r) as number);
  for (let i = 1; i < orderedMs.length; i++) assert.ok(orderedMs[i]! >= orderedMs[i - 1]!);

  // Specifically exercise word-boundary row counts: a tiny table with rowCount 65.
  const small = new Table(FIELDS);
  small.createSortedIndex('publishedAt');
  for (let i = 0; i < 65; i++) small.insert({ publishedAt: BASE_MS + i * DAY_MS, title: `r${i}` });
  small.warmIndexes();
  assert.equal(
    small.scan([{ field: 'publishedAt', op: 'gte', value: new Date(BASE_MS + 64 * DAY_MS) }]).count(),
    1,
  );
  assert.equal(
    small.scan([{ field: 'publishedAt', op: 'lt', value: new Date(BASE_MS + 32 * DAY_MS) }]).count(),
    32,
  );
});

test('createSortedIndex accepts a date field; a date column reports type "date"', () => {
  const t = new Table(FIELDS);
  assert.equal(t.column('publishedAt').type, 'date');
  assert.doesNotThrow(() => t.createSortedIndex('publishedAt'));
});
