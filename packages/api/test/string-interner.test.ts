import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef } from '../src/store/table.ts';
import { StringColumn } from '../src/store/column.ts';
import { OffHeapStringInterner, OffHeapStringArena } from '../src/store/string-interner.ts';

/**
 * be-22 — off-heap StringColumn dictionary.
 *
 * THE DEFECT (memory/adaptive-string-encoding): a high-cardinality `string` column backed by a
 * `Map<string, number>` intern table + a `string[]` dict throws `RangeError: Map maximum size
 * exceeded` at V8's 2^24 (~16.7M) entry ceiling, and pins N long-lived heap strings. The fix is an
 * off-heap {@link OffHeapStringInterner} (open-addressing hash over an Int32Array + a UTF-8 byte
 * arena). The OPERATOR SURFACE is unchanged; only the dictionary STORAGE moved off-heap, so the
 * BYTE-IDENTICAL response guarantee must hold — a dict returns the SAME string values.
 *
 * Doctrine: NO mocks. Real Table / StringColumn / interner against real fixtures; results are
 * checked against a trivial O(n) brute oracle over the inserted strings.
 *
 * The decisive >16.7M-distinct case (the one that USED TO THROW) is HEAVY (minutes + GBs), so it is
 * OPT-IN behind STRING_SCALE_TEST=1 to keep the default suite fast — mirroring the session scale
 * test's SESSION_SCALE_TEST flag. The default suite carries a fast smaller high-card case that
 * exercises every interner code path (slot growth, arena growth) without the multi-million cost.
 *
 *   STRING_SCALE_TEST=1 node --env-file=.env.test --test \
 *     --test-global-setup=./test/global-setup.ts test/string-interner.test.ts
 *   # Override the distinct count with STRING_SCALE_N (default 17_000_000, just over the 2^24 ceiling).
 *
 * SEPARATELY, the interner's one RESIDUAL ceiling — a ~2 GiB arena (the Int32 offset lane) — is proven
 * to FAIL LOUD (named RangeError), never silently corrupt, behind STRING_ARENA_SCALE_TEST=1 (heavy:
 * allocates ~2 GiB before it throws).
 */

const SCALE = process.env.STRING_SCALE_TEST === '1';
const SCALE_N = Number(process.env.STRING_SCALE_N ?? 17_000_000);

const FIELDS: FieldDef[] = [{ name: 's', type: 'string' }];

function buildTable(rows: (string | null)[]): Table {
  const t = new Table(FIELDS);
  for (const v of rows) t.insert(v === null ? {} : { s: v });
  return t;
}

// ── the interner in isolation ────────────────────────────────────────────────────────────────

test('OffHeapStringInterner: intern dedups, assigns dense codes, decode round-trips byte-exact', () => {
  const it = new OffHeapStringInterner();
  const a = it.intern('alpha');
  const b = it.intern('beta');
  const a2 = it.intern('alpha'); // dedup -> same code
  assert.equal(a, 0);
  assert.equal(b, 1);
  assert.equal(a2, a, 'a repeated string returns its existing code');
  assert.equal(it.size(), 2, 'two distinct strings');
  assert.equal(it.decode(a), 'alpha');
  assert.equal(it.decode(b), 'beta');
  assert.equal(it.codeOf('alpha'), 0);
  assert.equal(it.codeOf('beta'), 1);
  assert.equal(it.codeOf('never-seen'), undefined, 'an un-interned value resolves to undefined');
});

test('OffHeapStringInterner: multi-byte UTF-8 and the empty string round-trip byte-exact', () => {
  const it = new OffHeapStringInterner();
  // ASCII, 2-byte (é), 3-byte (€, 中), 4-byte surrogate-pair (😀), and the empty string.
  const samples = ['', 'a', 'café', '€', '中文', '😀', 'mixed 中€😀 tail', 'café']; // 'café' twice => dedup
  const codes = samples.map((s) => it.intern(s));
  // 'café' deduped: 7 distinct strings, codes[2] === codes[7].
  assert.equal(it.size(), 7);
  assert.equal(codes[2], codes[7], 'duplicate multi-byte string deduped to one code');
  for (let i = 0; i < samples.length; i++) {
    assert.equal(it.decode(codes[i]!), samples[i], `decode round-trips ${JSON.stringify(samples[i])} exactly`);
  }
  // The empty string is a REAL code with a zero-length arena slice (NOT NULL — null is the Table's job).
  assert.equal(it.decode(codes[0]!), '');
  assert.equal(it.codeOf(''), codes[0]);
});

test('OffHeapStringInterner: survives slot-table + arena growth (10k distinct, dense long values)', () => {
  const it = new OffHeapStringInterner();
  const n = 10_000;
  // Long-ish, fully distinct values to force several arena doublings and slot-table doublings
  // (initial slots 256, initial arena 1 KiB).
  for (let i = 0; i < n; i++) it.intern(`value-${i}-${'x'.repeat((i % 17) + 1)}`);
  assert.equal(it.size(), n);
  // Spot-check a deterministic spread round-trips and resolves back to the same code.
  for (const i of [0, 1, 255, 256, 257, 4095, 4096, 9999]) {
    const s = `value-${i}-${'x'.repeat((i % 17) + 1)}`;
    const code = it.codeOf(s);
    assert.notEqual(code, undefined, `still resolvable after growth: ${i}`);
    assert.equal(it.decode(code!), s, `byte-exact after growth: ${i}`);
  }
  assert.equal(it.codeOf('value-10000-x'), undefined, 'an absent value is still a clean miss after growth');
});

test('OffHeapStringArena: code-aligned, NON-deduping (two equal folds keep distinct slots)', () => {
  // The folded mirror must keep one slot PER RAW CODE even when distinct raw strings fold equal,
  // so the arena (not the interner) backs it. Pushing 'a' twice yields codes 0 and 1, both decode 'a'.
  const ar = new OffHeapStringArena();
  assert.equal(ar.push('a'), 0);
  assert.equal(ar.push('b'), 1);
  assert.equal(ar.push('a'), 2, 'duplicate value still gets its own code-aligned slot (no dedup)');
  assert.equal(ar.push(''), 3);
  assert.equal(ar.size(), 4);
  assert.equal(ar.decode(0), 'a');
  assert.equal(ar.decode(2), 'a');
  assert.equal(ar.decode(3), '');
});

// ── low-card columns stay int-code-fast AND tiny (no memory regression) ────────────────────────

test('low-card column (3-value enum) costs ~KBs off-heap, not MBs', () => {
  const t = new Table(FIELDS);
  const enumVals = ['draft', 'published', 'archived'];
  for (let i = 0; i < 100_000; i++) t.insert({ s: enumVals[i % 3]! });
  const col = t.column('s') as StringColumn;
  const dictMem = col.dictionaryMemoryBytes();
  // 3 distinct short strings: a 256-slot table (1 KiB) + tiny lanes + a 1 KiB arena. Far under 64 KiB.
  assert.ok(dictMem < 64 * 1024, `low-card dict footprint is tiny: ${dictMem} bytes`);
  // And eq is still int-code-fast: the value resolves to ONE code, the scan is an int compare.
  const got = t.scan([{ field: 's', op: 'eq', value: 'published' }]).toArray();
  const expect: number[] = [];
  for (let i = 0; i < 100_000; i++) if (i % 3 === 1) expect.push(i);
  assert.deepEqual(got, expect, 'low-card $eq matches the oracle');
});

test('low-card operators (eq/ne/in/notIn) unchanged vs a brute oracle', () => {
  const vals = ['en', 'fr', 'de', 'es'];
  const rows: (string | null)[] = [];
  for (let i = 0; i < 5000; i++) rows.push(i % 11 === 0 ? null : vals[i % vals.length]!);
  const t = buildTable(rows);

  const oracleEq = (needle: string) =>
    rows.map((r, i) => [r, i] as const).filter(([r]) => r === needle).map(([, i]) => i);
  const oracleNe = (needle: string) =>
    rows.map((r, i) => [r, i] as const).filter(([r]) => r !== null && r !== needle).map(([, i]) => i);
  const oracleIn = (set: string[]) =>
    rows.map((r, i) => [r, i] as const).filter(([r]) => r !== null && set.includes(r)).map(([, i]) => i);
  const oracleNotIn = (set: string[]) =>
    rows.map((r, i) => [r, i] as const).filter(([r]) => r !== null && !set.includes(r)).map(([, i]) => i);

  assert.deepEqual(t.scan([{ field: 's', op: 'eq', value: 'fr' }]).toArray(), oracleEq('fr'));
  assert.deepEqual(t.scan([{ field: 's', op: 'ne', value: 'fr' }]).toArray(), oracleNe('fr'));
  assert.deepEqual(t.scan([{ field: 's', op: 'in', value: ['fr', 'de'] }]).toArray(), oracleIn(['fr', 'de']));
  assert.deepEqual(
    t.scan([{ field: 's', op: 'notIn', value: ['fr', 'de'] }]).toArray(),
    oracleNotIn(['fr', 'de']),
  );
  // An absent value: eq matches nothing, ne matches every non-null row.
  assert.deepEqual(t.scan([{ field: 's', op: 'eq', value: 'zz' }]).toArray(), []);
  assert.deepEqual(t.scan([{ field: 's', op: 'ne', value: 'zz' }]).toArray(), oracleNe('zz'));
});

// ── multi-byte UTF-8 + empty-string-vs-NULL round-trip exact through the Table/materialize ─────

test('multi-byte UTF-8 + empty-string vs NULL round-trip byte-exact through materialize', () => {
  // Row 0: a real empty string. Row 1: NULL (no field). The rest: multi-byte values incl. dups.
  const rows: (string | null)[] = ['', null, 'café', '中文', '😀', 'café', '', 'plain'];
  const t = buildTable(rows);
  for (let i = 0; i < rows.length; i++) {
    const mat = t.materialize(i);
    if (rows[i] === null) {
      assert.equal(mat['s'], null, `row ${i} is NULL (driven off the Table null bitset, not the dict)`);
    } else {
      assert.equal(mat['s'], rows[i], `row ${i} round-trips the exact string ${JSON.stringify(rows[i])}`);
      assert.equal(typeof mat['s'], 'string');
    }
  }
  // A real '' eq '' matches the two real empties (rows 0, 6) and NOT the NULL row (1).
  assert.deepEqual(t.scan([{ field: 's', op: 'eq', value: '' }]).toArray(), [0, 6]);
  // $null reads the null-ness off the bitset: only row 1.
  assert.deepEqual(t.scan([{ field: 's', op: 'null', value: undefined }]).toArray(), [1]);
});

// ── a fast smaller high-card case in the DEFAULT suite (near-unique titles/slugs) ──────────────

test('high-card column (200k near-unique slugs) BUILDS, serves a query, round-trips byte-exact', () => {
  const n = 200_000;
  const t = new Table(FIELDS);
  // Near-unique: a distinct slug per row (the title/slug shape that overflows the Map at scale).
  for (let i = 0; i < n; i++) t.insert({ s: `the-quick-brown-fox-${i}-jumps` });
  const col = t.column('s') as StringColumn;
  assert.equal(col.length, n);

  // eq resolves to exactly one row (near-unique), byte-exact materialize.
  const target = `the-quick-brown-fox-123456-jumps`;
  const hits = t.scan([{ field: 's', op: 'eq', value: target }]).toArray();
  assert.deepEqual(hits, [123456], 'a near-unique $eq finds its one row');
  assert.equal(t.materialize(123456)['s'], target, 'round-trips the exact slug');

  // A substring brute over the dictionary still works (D == N here): decode each distinct from the arena.
  const containsHits = t.scan([{ field: 's', op: 'contains', value: 'fox-99999-' }]).toArray();
  assert.deepEqual(containsHits, [99999]);

  // ordering brute (gt) over the off-heap dictionary matches a brute oracle on a small probe set.
  const gtNeedle = `the-quick-brown-fox-199998-jumps`;
  const gtHits = t.scan([{ field: 's', op: 'gt', value: gtNeedle }]).toArray();
  const gtOracle: number[] = [];
  for (let i = 0; i < n; i++) if (`the-quick-brown-fox-${i}-jumps` > gtNeedle) gtOracle.push(i);
  assert.deepEqual(gtHits, gtOracle, 'string ordering brute over the arena dict matches the oracle');
});

// ── the DECISIVE case: >16.7M near-unique values (USED to RangeError on the Map) ───────────────

test(
  'DECISIVE: a >16.7M-distinct string column BUILDS, serves, round-trips (used to RangeError)',
  { skip: SCALE ? false : 'set STRING_SCALE_TEST=1 to run the multi-million-distinct scale proof' },
  () => {
    // Build a near-unique dictionary just over V8's 2^24 (16,777,216) Map ceiling — the exact size
    // that made the old `Map<string, number>` throw "Map maximum size exceeded". The off-heap interner
    // holds it in a handful of ArrayBuffers. We work the interner directly (a Table of 17M rows would
    // also exercise the Int32Array codes lane; the dictionary is the structure under proof here).
    const n = SCALE_N;
    assert.ok(n > 16_777_216, 'the scale N must exceed the 2^24 Map ceiling to be decisive');
    const it = new OffHeapStringInterner();
    for (let i = 0; i < n; i++) it.intern(`slug-${i}`);
    assert.equal(it.size(), n, `all ${n} distinct strings interned (past the old 16.7M Map ceiling)`);

    // SERVES: resolve a deterministic spread of values back to codes, byte-exact.
    for (const i of [0, 1, 16_777_215, 16_777_216, 16_777_217, n - 1]) {
      if (i >= n) continue;
      const s = `slug-${i}`;
      const code = it.codeOf(s);
      assert.notEqual(code, undefined, `resolvable past the ceiling: ${i}`);
      assert.equal(it.decode(code!), s, `byte-exact round-trip past the ceiling: ${i}`);
    }
    // A never-interned value is still a clean miss (probe terminates on an EMPTY slot).
    assert.equal(it.codeOf(`slug-${n}`), undefined);
  },
);

// ── the ARENA-BYTE ceiling: >2 GiB of distinct text must FAIL LOUD, never corrupt ─────────────

const ARENA_SCALE = process.env.STRING_ARENA_SCALE_TEST === '1';

test(
  'ARENA CEILING: distinct text past 2 GiB throws a clean RangeError (NEVER silent wrong bytes)',
  {
    skip: ARENA_SCALE
      ? false
      : 'set STRING_ARENA_SCALE_TEST=1 to run the >2 GiB arena-overflow proof (heavy: allocates ~2 GiB)',
  },
  () => {
    // The arena offset lane is Int32Array, so the arena caps at 2^31-1 bytes of distinct UTF-8.
    // Push large distinct values until we cross 2 GiB; the interner MUST throw a named RangeError
    // BEFORE any offset wraps negative — it must NEVER return a byte-different decode. We assert both
    // that it throws AND that everything interned BEFORE the throw still decodes byte-exact.
    const it = new OffHeapStringInterner();
    const chunk = 1 << 20; // 1 MiB per value
    const big = 'x'.repeat(chunk);
    let lastCode = -1;
    let threw: unknown = null;
    let i = 0;
    try {
      for (; i < 4096; i++) {
        // distinct values: a 1 MiB run plus a unique tail so no two strings dedup.
        lastCode = it.intern(big + i);
      }
    } catch (e) {
      threw = e;
    }
    assert.ok(threw instanceof RangeError, 'crossing 2 GiB throws a RangeError, not silent corruption');
    assert.match((threw as Error).message, /exceeded 2 GiB/, 'the throw is the named arena-ceiling error');
    // Everything that DID intern before the throw is still byte-exact (no wrapped offsets).
    assert.ok(lastCode >= 0, 'at least one value interned before the ceiling');
    const probe = big + 0;
    assert.equal(it.decode(it.codeOf(probe)!), probe, 'an early value still round-trips byte-exact');
  },
);
