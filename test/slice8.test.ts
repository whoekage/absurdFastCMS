import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef } from '../src/store/table.ts';
import { StringColumn } from '../src/store/column.ts';
import { SubstringIndex } from '../src/store/substring-index.ts';

/**
 * Slice 8: trigram (3-gram) substring accelerator (gated, build-on-publish).
 *
 * Doctrine (non-negotiable): NO mocks. Everything is driven through the real Table / StringColumn
 * / SubstringIndex. Correctness is proven THREE ways for every input:
 *   1. The accelerated table (substring index enabled) must equal a SEPARATE brute table (index
 *      disabled — the Slice-3 floor) row-for-row, and
 *   2. both must equal an independent O(n) per-row brute ORACLE over the inserted raw strings.
 *   3. A real usage counter (`substringAccelHits`, NOT a mock) proves the trigram path actually
 *      fired when it should — while the rows still match brute.
 *
 * The accelerator is purely a speed optimization: it must return BYTE-IDENTICAL rows to brute for
 * every needle (>=3 and <3 chars, no-match, mid-word, boundary, case-insensitive/folded, surrogate
 * pairs, the not* complements excluding nulls, and the includes()-verification killing trigram
 * false positives). Under-generating candidates would be a correctness bug; over-generating is fine
 * because every candidate is includes()-verified.
 */

/** The reference fold, mirroring StringColumn.fold (NFKC then locale-independent lower). */
function fold(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

const FIELDS: FieldDef[] = [{ name: 's', type: 'string' }];

/** Build a table; `accel` opts the `s` column into the trigram accelerator (else pure brute). */
function buildTable(rows: (string | null)[], accel: boolean): Table {
  const t = new Table(FIELDS);
  if (accel) t.enableSubstringIndex('s');
  for (const v of rows) t.insert(v === null ? {} : { s: v });
  return t;
}

/**
 * Per-row brute oracle for the contains family. Mirrors three-valued logic: NULL rows never match
 * any operator (including the not* complements). Case-insensitive folds BOTH sides identically.
 */
function oracle(rows: (string | null)[], op: string, needle: string): number[] {
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
    }
    if (hit) out.push(i);
  }
  return out;
}

const CONTAINS_OPS = ['contains', 'containsi', 'notContains', 'notContainsi'] as const;

/** Assert accel == brute == oracle for one (op, needle), returning the row list. */
function assertEquivalent(
  rows: (string | null)[],
  accel: Table,
  brute: Table,
  op: (typeof CONTAINS_OPS)[number],
  needle: string,
  label: string,
): number[] {
  const a = accel.scan([{ field: 's', op, value: needle }]).toArray();
  const b = brute.scan([{ field: 's', op, value: needle }]).toArray();
  const o = oracle(rows, op, needle);
  assert.deepEqual(b, o, `BRUTE floor ${label}`);
  assert.deepEqual(a, o, `ACCEL ${label}`);
  assert.deepEqual(a, b, `accel==brute ${label}`);
  return a;
}

test('SubstringIndex: short needle (<3 units) and absent trigram both defer (return null)', () => {
  const idx = new SubstringIndex(['hello world', 'foobar', 'trigram test']);
  // < 3 code units -> no trigram to key on -> defer to brute.
  assert.equal(idx.candidateCodes(''), null);
  assert.equal(idx.candidateCodes('a'), null);
  assert.equal(idx.candidateCodes('ab'), null);
  // A trigram that never occurs anywhere -> defer to brute (and verify removes everything anyway).
  assert.equal(idx.candidateCodes('zzz'), null);
  // A present trigram -> a (possibly over-generated) candidate array, never null.
  const cands = idx.candidateCodes('ell');
  assert.ok(Array.isArray(cands));
  assert.ok(cands!.includes(0), 'code 0 ("hello world") is a candidate for "ell"');
});

test('SubstringIndex: candidates are a SUPERSET of the true matches (never under-generate)', () => {
  // Strings whose trigrams overlap so intersection over-generates; verify the superset property.
  const dict = ['abcdef', 'xabcy', 'qrsabc', 'abxcd', 'no match here', 'abcabc'];
  const idx = new SubstringIndex(dict);
  let seed = 0x51ce8;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  const needles = ['abc', 'bcd', 'abcd', 'abcdef', 'abcabc', 'xab', 'rsa'];
  for (let r = 0; r < 50; r++) {
    const base = dict[next() % dict.length]!;
    const start = next() % base.length;
    const len = 3 + (next() % 4);
    needles.push(base.slice(start, start + len));
  }
  for (const needle of needles) {
    if (needle.length < 3) continue;
    const cands = idx.candidateCodes(needle);
    if (cands === null) {
      // null means defer-to-brute; the true matches must then also be empty for an absent trigram,
      // but a needle drawn from a real value always has present trigrams, so this is only for the
      // hand-written ones. Just assert no real match is silently dropped via the brute set below.
      const truth = dict.map((s, i) => (s.includes(needle) ? i : -1)).filter((i) => i >= 0);
      assert.deepEqual(truth, [], `null candidates must mean zero matches for ${JSON.stringify(needle)}`);
      continue;
    }
    const candSet = new Set(cands);
    for (let i = 0; i < dict.length; i++) {
      if (dict[i]!.includes(needle)) {
        assert.ok(candSet.has(i), `true match code ${i} missing from candidates for ${JSON.stringify(needle)}`);
      }
    }
  }
});

test('accelerated $contains*/$notContains* equal brute and the oracle (ASCII case mix)', () => {
  const rows = [
    'Hello World',
    'hello',
    'WORLD',
    'world peace',
    'Otherworld',
    'a hello b',
    'HELLOWORLD',
    'goodbye',
    'contains the needle xyzzy here',
  ];
  const accel = buildTable(rows, true);
  const brute = buildTable(rows, false);
  for (const op of CONTAINS_OPS) {
    for (const needle of ['hello', 'WORLD', 'orld', 'Hello', 'o', 'ab', 'xyz', 'xyzzy', '']) {
      assertEquivalent(rows, accel, brute, op, needle, `${op} ${JSON.stringify(needle)}`);
    }
  }
});

test('needle mid-word and at boundaries (prefix/suffix substrings) accel == brute == oracle', () => {
  const rows = ['prefixMIDsuffix', 'MIDonly', 'endsWithMID', 'MIDatStart', 'no overlap', 'midcase'];
  const accel = buildTable(rows, true);
  const brute = buildTable(rows, false);
  for (const op of CONTAINS_OPS) {
    for (const needle of ['MID', 'pre', 'fix', 'suffix', 'Start', 'mid', 'overlap']) {
      assertEquivalent(rows, accel, brute, op, needle, `${op} ${JSON.stringify(needle)}`);
    }
  }
});

test('needles with no matches return empty contains / all-non-null notContains', () => {
  const rows: (string | null)[] = ['alpha', 'beta', null, 'gamma', 'delta'];
  const accel = buildTable(rows, true);
  const brute = buildTable(rows, false);
  for (const needle of ['zzz', 'qqq', 'XYZ123', 'nomatch']) {
    const c = assertEquivalent(rows, accel, brute, 'contains', needle, `contains ${needle}`);
    assert.deepEqual(c, [], `contains ${needle} matches nothing`);
    const nc = assertEquivalent(rows, accel, brute, 'notContains', needle, `notContains ${needle}`);
    assert.deepEqual(nc, [0, 1, 3, 4], `notContains ${needle} = all non-null`);
  }
});

test('case-insensitive ($containsi/$notContainsi) folds value AND needle, accel == brute == oracle', () => {
  const rows = ['OFFER', 'office', 'staﬀ', 'EFFORT', 'misc', 'ＦＵＬＬ width', 'café latte', 'CAFÉ'];
  const accel = buildTable(rows, true);
  const brute = buildTable(rows, false);
  // ligature 'ﬀ' folds (NFKC) to 'ff'; fullwidth folds; accented é collapses — same as $eqi.
  for (const op of ['containsi', 'notContainsi'] as const) {
    for (const needle of ['off', 'OFF', 'ﬀ', 'ff', 'ＦＵＬＬ', 'full', 'café', 'CAFÉ', 'mis']) {
      assertEquivalent(rows, accel, brute, op, needle, `${op} ${JSON.stringify(needle)}`);
    }
  }
});

test('surrogate-pair / Unicode needles accel == brute == oracle (granularity, not correctness)', () => {
  const rows = [
    'emoji 😀 face',
    'two 😀😀 emojis',
    '🎉party🎉',
    '日本語のテスト',
    'Москва город',
    'plain ascii text',
    'mixed 😀 ascii',
  ];
  const accel = buildTable(rows, true);
  const brute = buildTable(rows, false);
  for (const op of CONTAINS_OPS) {
    for (const needle of ['😀', '😀😀', '🎉party', '日本語', 'のテスト', 'москва', 'ascii', 'text']) {
      assertEquivalent(rows, accel, brute, op, needle, `${op} ${JSON.stringify(needle)}`);
    }
  }
});

test('VERIFICATION removes trigram false positives (trigrams co-occur but not contiguously)', () => {
  // Construct a value whose characters yield the trigrams of "abcdef" scattered across the string
  // but never as the contiguous substring "abcdef". The trigram intersection will surface this
  // value as a CANDIDATE; includes()-verification MUST exclude it.
  // "abc...def" trigrams of needle "abcdef": abc, bcd, cde, def. Put abc and def far apart with the
  // bridging bcd/cde present elsewhere so intersection finds the row, but it does NOT contain abcdef.
  const decoy = 'abcXcdeXbcdXdefX'; // contains abc, bcd, cde, def as 3-grams, but NOT "abcdef"
  const real = 'zzzabcdefzzz'; // genuinely contains "abcdef"
  const rows = [decoy, real, 'unrelated', 'abc only', 'def only'];
  assert.ok(!decoy.includes('abcdef'), 'precondition: decoy lacks the contiguous needle');
  assert.ok(real.includes('abcdef'), 'precondition: real has the contiguous needle');

  const accel = buildTable(rows, true);
  const col = accel.column('s') as StringColumn;
  // Prove the decoy IS a trigram candidate (so verification is what excludes it, not the index).
  const idxCandidates = new SubstringIndex(rows).candidateCodes('abcdef');
  assert.ok(idxCandidates !== null, 'all needle trigrams present -> acceleration applies');
  assert.ok(idxCandidates!.includes(0), 'decoy (code 0) is a trigram candidate (false positive)');

  const before = col.substringAccelHits;
  const got = accel.scan([{ field: 's', op: 'contains', value: 'abcdef' }]).toArray();
  assert.ok(col.substringAccelHits > before, 'the trigram accelerator actually fired');
  // Only the REAL row survives verification; the decoy false positive is removed.
  assert.deepEqual(got, [1], 'includes()-verification excludes the trigram false positive');
  // And it agrees with brute + oracle.
  const brute = buildTable(rows, false);
  assert.deepEqual(got, brute.scan([{ field: 's', op: 'contains', value: 'abcdef' }]).toArray());
  assert.deepEqual(got, oracle(rows, 'contains', 'abcdef'));
});

test('the accelerator is ACTUALLY USED on a large-distinct column (real counter, not a mock)', () => {
  // A high-distinct column: every row a unique-ish string so the dictionary is large. The trigram
  // path must fire for >=3-char needles and stay byte-identical to brute.
  const rows: string[] = [];
  let seed = 0xc0ffee;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  for (let i = 0; i < 1500; i++) {
    const a = words[next() % words.length]!;
    const b = words[next() % words.length]!;
    rows.push(`${a}-${i}-${b}-${next() % 9999}`); // large distinct count
  }
  const accel = buildTable(rows, true);
  const brute = buildTable(rows, false);
  const col = accel.column('s') as StringColumn;

  // Derive needles from ACTUAL inserted values (3..6 units) so every needle's trigrams are
  // guaranteed present in the dictionary and the accelerator must engage (not defer to brute).
  const needles: string[] = [];
  for (let k = 0; k < 8; k++) {
    const v = rows[next() % rows.length]!;
    const start = next() % Math.max(1, v.length - 6);
    needles.push(v.slice(start, start + 3 + (next() % 4)));
  }

  const before = col.substringAccelHits;
  for (const needle of needles) {
    const got = accel.scan([{ field: 's', op: 'contains', value: needle }]).toArray();
    assert.deepEqual(got, brute.scan([{ field: 's', op: 'contains', value: needle }]).toArray(), needle);
    assert.deepEqual(got, oracle(rows, 'contains', needle), `oracle ${needle}`);
  }
  // Every needle was taken from a real value, so its trigrams exist => the accel path fired each time.
  assert.equal(col.substringAccelHits, before + needles.length, 'trigram path fired for every needle drawn from real data');
  assert.ok(col.rawTrigramCount() > 50, 'a real, non-trivial trigram index was built');

  // A < 3 char needle must NOT take the accel path (it defers to brute) yet stay correct.
  const hits = col.substringAccelHits;
  const two = accel.scan([{ field: 's', op: 'contains', value: 'al' }]).toArray();
  assert.equal(col.substringAccelHits, hits, '<3-char needle did not fire the accelerator');
  assert.deepEqual(two, brute.scan([{ field: 's', op: 'contains', value: 'al' }]).toArray());
  assert.deepEqual(two, oracle(rows, 'contains', 'al'));
});

test('randomized equivalence: many needles, accel == brute == oracle (incl. nulls, capacity growth)', () => {
  const palette = [
    'alpha-One',
    'BETA_two',
    'gamma three',
    'Delta-FOUR',
    'epsilon value',
    'AlphaBeta gamma',
    'oneTwoThree four',
    'ＦＵＬＬwidth text',
    'liga-staﬀ end',
    'emoji-😀-tail',
    'Москва город',
    '日本語のテスト row',
  ];
  const rows: (string | null)[] = [];
  let seed = 0x0bad5eed;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 2100; i++) {
    // Past INITIAL_CAPACITY (1024) and not a multiple of 32 (2100) for word-boundary coverage.
    if (i % 53 === 0) rows.push(null);
    else rows.push(palette[next() % palette.length]!);
  }
  const accel = buildTable(rows, true);
  const brute = buildTable(rows, false);

  // A mix of >=3 and <3 needles, no-match, mid-word, boundary, folded, surrogate/Unicode.
  const needles = [
    'alpha', 'BETA', 'three', 'ﬀ', '😀', 'fullwidth', 'one', 'gamma', 'value',
    'москва', '日本語', 'のテスト', 'staﬀ', 'al', 'B', '', 'zzz', 'four', 'Two', 'pha', 'idt',
  ];
  for (const op of CONTAINS_OPS) {
    for (const needle of needles) {
      assertEquivalent(rows, accel, brute, op, needle, `${op} ${JSON.stringify(needle)} @2100`);
    }
  }
  // A NULL row must never survive a not* result on the accelerated path.
  for (const op of ['notContains', 'notContainsi'] as const) {
    const got = accel.scan([{ field: 's', op, value: 'alpha' }]).toArray();
    for (const r of got) assert.ok(!accel.isNull('s', r), `${op} row ${r} must not be null`);
  }
});

test('word-boundary rows (31/32/63/64) each contain their own >=3 prefix on the accel path', () => {
  const variants = ['Redwood apple', 'crimson car', 'azure skyline', 'blueberry pie', 'emerald TEA'];
  const rows: (string | null)[] = [];
  let seed = 0x1234567;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 1500; i++) {
    if (i % 41 === 0) rows.push(null);
    else rows.push(variants[next() % variants.length]!);
  }
  const accel = buildTable(rows, true);
  const brute = buildTable(rows, false);
  for (const boundary of [31, 32, 63, 64]) {
    const v = rows[boundary];
    if (v === null) continue;
    const sub = v.slice(0, 3); // a >=3 prefix so the accelerator engages
    assert.equal(
      accel.scan([{ field: 's', op: 'contains', value: sub }]).get(boundary),
      true,
      `accel: boundary row ${boundary} contains its own prefix`,
    );
    // Full equivalence on that needle too.
    assertEquivalent(rows, accel, brute, 'contains', sub, `boundary ${boundary} contains ${sub}`);
  }
});

test('rebuild covers strings interned AFTER the first accelerated query', () => {
  // Build, query (builds the index over the current dict), then insert NEW distinct strings and
  // query again — the accelerator must rebuild to cover them and stay equal to brute + oracle.
  const initial = ['alpha widget', 'beta gadget', 'gamma gizmo'];
  const accel = buildTable(initial, true);
  accel.scan([{ field: 's', op: 'contains', value: 'wid' }]); // builds the index over the 3 strings
  // Now intern brand-new strings with brand-new trigrams.
  for (const v of ['delta sprocket', 'epsilon contraption', 'zeta doohickey']) accel.insert({ s: v });
  const rows = [...initial, 'delta sprocket', 'epsilon contraption', 'zeta doohickey'];

  const brute = buildTable(rows, false);
  for (const needle of ['spr', 'sprocket', 'contraption', 'doohickey', 'alpha', 'zzz']) {
    const got = accel.scan([{ field: 's', op: 'contains', value: needle }]).toArray();
    assert.deepEqual(got, brute.scan([{ field: 's', op: 'contains', value: needle }]).toArray(), needle);
    assert.deepEqual(got, oracle(rows, 'contains', needle), `oracle ${needle}`);
  }
});

test('empty accelerated column: every contains op matches nothing', () => {
  const accel = buildTable([], true);
  for (const op of CONTAINS_OPS) {
    assert.equal(accel.scan([{ field: 's', op, value: 'anything' }]).count(), 0, `${op} empty`);
    assert.equal(accel.scan([{ field: 's', op, value: '' }]).count(), 0, `${op} empty needle empty col`);
  }
});

test('accelerated substring leaves compose with AND / OR / NOT identically to brute', () => {
  const rows = ['red apple pie', 'red car door', 'blue apple jam', 'green pear tart', 'red pear cake'];
  const accel = buildTable(rows, true);
  const brute = buildTable(rows, false);
  const tree = (t: Table) => ({
    and: t.scanTree({
      op: 'and' as const,
      children: [
        { leaf: { field: 's', op: 'contains' as const, value: 'red' } },
        { leaf: { field: 's', op: 'contains' as const, value: 'apple' } },
      ],
    }).toArray(),
    or: t.scanTree({
      op: 'or' as const,
      children: [
        { leaf: { field: 's', op: 'contains' as const, value: 'pear' } },
        { leaf: { field: 's', op: 'contains' as const, value: 'apple' } },
      ],
    }).toArray(),
    not: t.scanTree({
      op: 'not' as const,
      children: [{ leaf: { field: 's', op: 'contains' as const, value: 'red' } }],
    }).toArray(),
  });
  const a = tree(accel);
  const b = tree(brute);
  assert.deepEqual(a.and, b.and, 'AND');
  assert.deepEqual(a.or, b.or, 'OR');
  assert.deepEqual(a.not, b.not, 'NOT');
  assert.deepEqual(a.and, [0], 'red AND apple');
});

test('enableSubstringIndex on a non-string field throws', () => {
  const t = new Table([{ name: 'n', type: 'i32' }]);
  assert.throws(() => t.enableSubstringIndex('n'), /string field/);
});
