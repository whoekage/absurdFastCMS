import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef } from '../src/store/table.ts';
import { TextColumn } from '../src/store/column.ts';
import { SubstringIndex } from '../src/store/substring.index.ts';

/**
 * API-Vertical Slice 4 — trigram verification from the off-heap TEXT arena.
 *
 * Doctrine (non-negotiable): NO mocks. Everything is driven through the real Table / TextColumn /
 * SubstringIndex. A 'text' column has no dictionary, so its trigram postings are over ROW IDS and
 * verification decodes the candidate row's body FROM THE ARENA (TextColumn.at) and runs includes().
 *
 * Correctness is proven THREE ways for every input:
 *   1. The accelerated table (substring index enabled on the text column) must equal a SEPARATE
 *      brute table (index disabled — the AV0 floor) row-for-row, and
 *   2. both must equal an independent O(n) per-row brute ORACLE over the inserted bodies, and
 *   3. real counters (`substringAccelHits` + `arenaVerifyReads`, NOT mocks) prove the trigram path
 *      fired AND that verification read bodies from the arena, while the rows still match brute.
 *
 * Over-generating candidates is fine (verification removes false positives); under-generating
 * (missing a real match) would be a bug. We cover >=3 and <3 unit needles, no-match, mid-word,
 * boundary, folded -i, surrogate-pair/Unicode, NULL exclusion (three-valued), a deliberate trigram
 * false-positive decoy, and arena growth past INITIAL_CAPACITY (1024 rows).
 */

// Deterministic pseudo-random source (seeded LCG) — no Math.random, per the testing doctrine.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904229) >>> 0;
    return s / 0x100000000;
  };
}

/** The reference fold, mirroring TextColumn/StringColumn fold (NFKC then locale-independent lower). */
function fold(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

const FIELDS: FieldDef[] = [{ name: 'body', type: 'text' }];

/** Build a table; `accel` opts the `body` text column into the trigram accelerator (else brute). */
function buildTable(rows: (string | null)[], accel: boolean): Table {
  const t = new Table(FIELDS);
  if (accel) t.enableSubstringIndex('body');
  for (const v of rows) t.insert(v === null ? {} : { body: v });
  return t;
}

const CONTAINS_OPS = ['contains', 'containsi', 'notContains', 'notContainsi'] as const;
const AFFIX_OPS = ['startsWith', 'startsWithi', 'endsWith', 'endsWithi'] as const;
type AnyOp = (typeof CONTAINS_OPS)[number] | (typeof AFFIX_OPS)[number];

/**
 * Per-row brute oracle. Mirrors three-valued logic: NULL rows never match any operator (including
 * the not* complements). Case-insensitive folds BOTH sides identically.
 */
function oracle(rows: (string | null)[], op: AnyOp, needle: string): number[] {
  const out: number[] = [];
  const fn = fold(needle);
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i];
    if (v === null) continue;
    const fv = fold(v);
    let hit = false;
    switch (op) {
      case 'contains':     hit = v.includes(needle); break;
      case 'containsi':    hit = fv.includes(fn); break;
      case 'notContains':  hit = !v.includes(needle); break;
      case 'notContainsi': hit = !fv.includes(fn); break;
      case 'startsWith':   hit = v.startsWith(needle); break;
      case 'startsWithi':  hit = fv.startsWith(fn); break;
      case 'endsWith':     hit = v.endsWith(needle); break;
      case 'endsWithi':    hit = fv.endsWith(fn); break;
    }
    if (hit) out.push(i);
  }
  return out;
}

/** Assert accel == brute == oracle for one (op, needle), returning the row list. */
function assertEquivalent(
  rows: (string | null)[],
  accel: Table,
  brute: Table,
  op: AnyOp,
  needle: string,
  label: string,
): number[] {
  const a = accel.scan([{ field: 'body', op, value: needle }]).toArray();
  const b = brute.scan([{ field: 'body', op, value: needle }]).toArray();
  const o = oracle(rows, op, needle);
  assert.deepEqual(b, o, `BRUTE floor ${label}`);
  assert.deepEqual(a, o, `ACCEL ${label}`);
  assert.deepEqual(a, b, `accel==brute ${label}`);
  return a;
}

// ── SubstringIndex.over: row-id postings + null/short/absent deferral ───────────────────────────

test('SubstringIndex.over: postings are row ids, short/absent needles defer (return null)', () => {
  const bodies = ['hello world', 'foobar baz', 'trigram engine test'];
  const idx = SubstringIndex.over(bodies.length, (row) => bodies[row]!);
  // < 3 code units -> no trigram to key on -> defer to brute.
  assert.equal(idx.candidates(''), null);
  assert.equal(idx.candidates('a'), null);
  assert.equal(idx.candidates('lo'), null);
  // A trigram that never occurs anywhere -> defer to brute.
  assert.equal(idx.candidates('zzz'), null);
  // 'foo' occurs only in row 1 -> candidate row id 1 (a superset; here exact).
  assert.deepEqual(idx.candidates('foo'), [1]);
  // 'ell' occurs only in row 0.
  assert.deepEqual(idx.candidates('ell'), [0]);
  // candidateCodes is the back-compat alias of candidates.
  assert.deepEqual(idx.candidateCodes('foo'), idx.candidates('foo'));
});

test('SubstringIndex.over: empty input builds cleanly and defers every needle', () => {
  const idx = SubstringIndex.over(0, () => '');
  assert.equal(idx.trigramCount, 0);
  assert.equal(idx.candidates('abc'), null);
});

// ── Equivalence over randomized bodies + needles ─────────────────────────────────────────────────

test('AV4: accelerated text contains/containsi == brute == oracle over randomized needles', () => {
  const rng = lcg(0x4F2A); // deterministic seed
  const WORDS = [
    'absurd', 'columnar', 'engine', 'trigram', 'arena', 'verify', 'café', 'STRASSE',
    'Ångström', 'naïve', 'ﬀ-ligature', 'こんにちは', 'emoji😀tail', 'mid-word', 'boundary',
  ];
  const rows: (string | null)[] = [];
  for (let i = 0; i < 400; i++) {
    if (rng() < 0.15) { rows.push(null); continue; }
    const n = 1 + Math.floor(rng() * 5);
    const parts: string[] = [];
    for (let k = 0; k < n; k++) parts.push(WORDS[Math.floor(rng() * WORDS.length)]!);
    rows.push(parts.join(' ') + ' row' + i);
  }

  const accel = buildTable(rows, true);
  const brute = buildTable(rows, false);
  const col = accel.column('body') as TextColumn;

  // Needle pool: short (<3), no-match, mid-word, boundary, folded variants, surrogate/Unicode.
  const needles = [
    '', 'a', 'ab', 'absurd', 'col', 'rig', 'ena', 'verify', 'zzzzz', 'no-such',
    'CAFÉ', 'café', 'STRASSE', 'strasse', 'ångström', 'ÅNGSTRÖM', 'naïve', 'NAÏVE',
    'ﬀ', 'ff', 'こんに', 'んにち', '😀', 'emoji😀', 'row1', 'row99', ' ',
  ];
  // Plus randomized substrings drawn from real bodies (>=3 units) so the accel path fires a lot.
  for (let k = 0; k < 60; k++) {
    const src = rows[Math.floor(rng() * rows.length)];
    if (src === null || src.length < 3) continue;
    const start = Math.floor(rng() * (src.length - 2));
    const len = 3 + Math.floor(rng() * Math.min(8, src.length - start - 3 + 1));
    needles.push(src.slice(start, start + len));
  }

  const hitsBefore = col.substringAccelHits;
  const readsBefore = col.arenaVerifyReads;
  let acceleratableNeedles = 0;

  for (const needle of needles) {
    for (const op of ['contains', 'containsi'] as const) {
      assertEquivalent(rows, accel, brute, op, needle, `op=${op} needle=${JSON.stringify(needle)}`);
    }
    // A needle of >=3 units whose every (folded) trigram exists in some body is acceleratable.
    if (needle.length >= 3) acceleratableNeedles++;
  }

  // Real seams (not mocks): the accelerator fired for many needles, and verification decoded
  // candidate bodies from the arena. A nonzero arenaVerifyReads with correct rows proves the
  // verification source was the off-heap arena (the text column has NO heap dictionary).
  assert.ok(col.substringAccelHits > hitsBefore, 'trigram accelerator fired on the text column');
  assert.ok(col.arenaVerifyReads > readsBefore, 'verification read candidate bodies from the arena');
  assert.ok(acceleratableNeedles > 0, 'sanity: some needles were acceleratable');
});

test('AV4: affix + not* over the SAME text bodies stay byte-identical to brute (regression-safe)', () => {
  const rng = lcg(0x1357);
  const rows: (string | null)[] = [];
  for (let i = 0; i < 200; i++) {
    if (rng() < 0.2) { rows.push(null); continue; }
    rows.push(`Prefix-${i % 7} middle café STRASSE suffix-${i % 5}`);
  }
  const accel = buildTable(rows, true);
  const brute = buildTable(rows, false);

  const needles = ['Prefix', 'prefix', 'suffix-1', 'SUFFIX-1', 'café', 'CAFÉ', 'no', 'xyz123', 'mid'];
  for (const needle of needles) {
    for (const op of [...CONTAINS_OPS, ...AFFIX_OPS]) {
      assertEquivalent(rows, accel, brute, op, needle, `op=${op} needle=${JSON.stringify(needle)}`);
    }
  }
});

// ── Trigram false-positive decoy: trigrams co-occur but not contiguously ─────────────────────────

test('AV4: arena verification excludes a trigram false-positive decoy', () => {
  // Needle 'abcdef' has trigrams abc, bcd, cde, def. The decoy body contains every one of those
  // trigrams (so the trigram intersection yields it as a CANDIDATE) but never the contiguous
  // 'abcdef'. Only arena-decode verification can reject it. A real match row is mixed in.
  const rows: (string | null)[] = [
    'abc xyz bcd qqq cde rrr def',     // 0: all needle trigrams present, NOT contiguous -> decoy, reject
    'zzz abcdef zzz',                  // 1: real contiguous match -> accept
    'cde abc def bcd',                 // 2: trigrams present, scrambled -> decoy, reject
    null,                              // 3: null -> never matches
    'nothing relevant here at all',    // 4: no needle trigrams -> not even a candidate
  ];
  const needle = 'abcdef';

  const accel = buildTable(rows, true);
  const brute = buildTable(rows, false);
  const col = accel.column('body') as TextColumn;

  const hitsBefore = col.substringAccelHits;
  const readsBefore = col.arenaVerifyReads;

  const a = accel.scan([{ field: 'body', op: 'contains', value: needle }]).toArray();
  const b = brute.scan([{ field: 'body', op: 'contains', value: needle }]).toArray();
  const o = oracle(rows, 'contains', needle);

  assert.deepEqual(a, [1], 'only the contiguous match survives');
  assert.deepEqual(o, [1], 'oracle agrees');
  assert.deepEqual(a, b, 'accel == brute on the decoy');
  // The accel path fired and decoded candidates (including the decoys) from the arena to reject them.
  assert.ok(col.substringAccelHits > hitsBefore, 'accelerator fired');
  assert.ok(col.arenaVerifyReads >= readsBefore + 2, 'decoys were decoded from the arena and rejected');
});

// ── Short needle / absent trigram fall back to brute (accel does NOT fire) ────────────────────────

test('AV4: short needle and absent trigram defer to brute (accelerator does not fire)', () => {
  const rows = ['the quick brown fox', 'jumps over the lazy dog', 'columnar arena engine'];
  const accel = buildTable(rows, true);
  const brute = buildTable(rows, false);
  const col = accel.column('body') as TextColumn;

  // Warm the index, then snapshot the counter.
  accel.scan([{ field: 'body', op: 'contains', value: 'arena' }]);
  const hitsAfterWarm = col.substringAccelHits;

  // Short needle (<3 units): never acceleratable, brute floor handles it.
  assertEquivalent(rows, accel, brute, 'contains', 'th', 'short needle');
  // Absent trigram: 'zzz' exists in no body -> defer to brute.
  assertEquivalent(rows, accel, brute, 'contains', 'zzzqqq', 'absent trigram');
  assert.equal(col.substringAccelHits, hitsAfterWarm, 'no accel hit for short/absent-trigram needles');
});

// ── Arena growth past INITIAL_CAPACITY (1024 rows) + lazy rebuild ─────────────────────────────────

test('AV4: accelerator stays correct as the arena grows past 1024 rows (lazy rebuild)', () => {
  const rng = lcg(0xBEEF);
  const accel = new Table(FIELDS);
  accel.enableSubstringIndex('body');
  const brute = new Table(FIELDS);
  const rows: (string | null)[] = [];

  const SEGMENTS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  const col = accel.column('body') as TextColumn;

  // Insert in two batches with a query in between, so the index is built at one size then rebuilt
  // at a larger size (arena grew past 1024). Correctness must hold across the rebuild.
  function insertBatch(count: number): void {
    for (let i = 0; i < count; i++) {
      if (rng() < 0.1) { rows.push(null); accel.insert({}); brute.insert({}); continue; }
      const w = SEGMENTS[Math.floor(rng() * SEGMENTS.length)]!;
      const body = `${w}-${rows.length} payload café ${SEGMENTS[Math.floor(rng() * SEGMENTS.length)]}`;
      rows.push(body);
      accel.insert({ body });
      brute.insert({ body });
    }
  }

  insertBatch(500);
  // Build the index at ~500 rows.
  assertEquivalent(rows, accel, brute, 'contains', 'payload', 'before growth');
  const builtSmall = col.rawTrigramCount();
  assert.ok(builtSmall > 0, 'index built at small size');

  insertBatch(900); // total ~1400 > INITIAL_CAPACITY (1024) -> arena doubled
  assert.ok(rows.length > 1024, 'crossed INITIAL_CAPACITY');

  // After growth the index must lazily rebuild to cover the new rows; results stay byte-identical.
  for (const needle of ['payload', 'alpha', 'café', 'CAFÉ', 'foxtrot', 'zzz']) {
    for (const op of ['contains', 'containsi'] as const) {
      assertEquivalent(rows, accel, brute, op, needle, `after growth op=${op} needle=${needle}`);
    }
  }
  assert.ok(col.arenaVerifyReads > 0, 'verification used the arena across the rebuild');
});

// ── enableSubstringIndex wiring on a text field, and the rejection on unsupported types ──────────

test('AV4: enableSubstringIndex accepts a text field and rejects numeric/bool/date', () => {
  const t = new Table([
    { name: 'body', type: 'text' },
    { name: 'n', type: 'i32' },
    { name: 'flag', type: 'bool' },
    { name: 'when', type: 'date' },
  ]);
  // text + string are accepted (no throw).
  assert.doesNotThrow(() => t.enableSubstringIndex('body'));
  // unsupported column types throw, message still mentions a string field (regression with Slice 8).
  assert.throws(() => t.enableSubstringIndex('n'), /string field/);
  assert.throws(() => t.enableSubstringIndex('flag'), /string field/);
  assert.throws(() => t.enableSubstringIndex('when'), /string field/);
});

// ── All-null / all-match / none-match edges with NULL exclusion (three-valued) ───────────────────

test('AV4: empty/all-null/all-match edges hold (NULLs excluded, three-valued)', () => {
  // Empty table.
  {
    const accel = buildTable([], true);
    const brute = buildTable([], false);
    assertEquivalent([], accel, brute, 'contains', 'abc', 'empty table');
    assertEquivalent([], accel, brute, 'notContains', 'abc', 'empty table not');
  }
  // All null.
  {
    const rows: (string | null)[] = [null, null, null];
    const accel = buildTable(rows, true);
    const brute = buildTable(rows, false);
    assertEquivalent(rows, accel, brute, 'contains', 'abc', 'all null contains');
    assertEquivalent(rows, accel, brute, 'notContains', 'abc', 'all null notContains');
  }
  // All rows contain the needle; a null is interleaved and must be excluded everywhere.
  {
    const rows: (string | null)[] = ['xxabcyy', 'abcabc', null, 'zzabczz'];
    const accel = buildTable(rows, true);
    const brute = buildTable(rows, false);
    assertEquivalent(rows, accel, brute, 'contains', 'abc', 'all-match contains');
    assertEquivalent(rows, accel, brute, 'notContains', 'abc', 'all-match notContains excludes null');
  }
});

// ── Word-boundary row counts (rowCount % 32 != 0 and exactly at 31/32/63/64) ─────────────────────

test('AV4: correctness at bitset word boundaries (31/32/63/64 rows)', () => {
  for (const n of [31, 32, 33, 63, 64, 65]) {
    const rows: (string | null)[] = [];
    for (let i = 0; i < n; i++) rows.push(i % 5 === 0 ? null : `needle-haystack-${i} body content`);
    const accel = buildTable(rows, true);
    const brute = buildTable(rows, false);
    for (const op of CONTAINS_OPS) {
      assertEquivalent(rows, accel, brute, op, 'haystack', `n=${n} op=${op}`);
    }
  }
});
