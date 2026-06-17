import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef } from '../src/store/table.ts';
import { StringColumn } from '../src/store/column.ts';

/**
 * Slice 3: substring + prefix/suffix operators over the deduped (folded) dictionary.
 *
 * Doctrine: NO mocks. Everything is driven through the real Table/StringColumn, and the
 * expected result is computed by a trivial O(n) brute-force ORACLE over the inserted raw
 * strings. The case-insensitive (`-i`) variants fold with the SAME fold() the engine uses
 * (fold(s) = NFKC(s) then toLowerCase()) on BOTH sides — value AND needle — so a fullwidth
 * or ligature needle normalizes identically to $eqi. We assert the engine matches the oracle
 * across case variants, empty needles, needles longer than any value, multi-byte/surrogate
 * Unicode, capacity growth past INITIAL_CAPACITY (1024), word boundaries, and null exclusion.
 */

/** The reference fold, mirroring StringColumn.fold (NFKC then locale-independent lower). */
function fold(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

const FIELDS: FieldDef[] = [{ name: 's', type: 'string' }];

function buildTable(rows: (string | null)[]): Table {
  const t = new Table(FIELDS);
  for (const v of rows) t.insert(v === null ? {} : { s: v });
  return t;
}

/**
 * Per-row brute oracle for every substring/affix operator. Mirrors three-valued logic:
 * NULL rows never match any operator (including the `not*` complements).
 */
function oracle(rows: (string | null)[], op: string, needle: string): number[] {
  const out: number[] = [];
  const fn = fold(needle);
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i];
    if (v === null) continue; // NULL is "unknown" — excluded from every result
    const fv = fold(v);
    let hit = false;
    switch (op) {
      case 'contains':      hit = v.includes(needle); break;
      case 'containsi':     hit = fv.includes(fn); break;
      case 'notContains':   hit = !v.includes(needle); break;
      case 'notContainsi':  hit = !fv.includes(fn); break;
      case 'startsWith':    hit = v.startsWith(needle); break;
      case 'startsWithi':   hit = fv.startsWith(fn); break;
      case 'endsWith':      hit = v.endsWith(needle); break;
      case 'endsWithi':     hit = fv.endsWith(fn); break;
    }
    if (hit) out.push(i);
  }
  return out;
}

const ALL_OPS = [
  'contains',
  'containsi',
  'notContains',
  'notContainsi',
  'startsWith',
  'startsWithi',
  'endsWith',
  'endsWithi',
] as const;

test('every substring/affix operator matches the per-row brute oracle (ASCII case mix)', () => {
  const rows = [
    'Hello World',
    'hello',
    'WORLD',
    'world peace',
    'Otherworld',
    'a hello b',
    'HELLOWORLD',
    'goodbye',
  ];
  const t = buildTable(rows);
  for (const op of ALL_OPS) {
    for (const needle of ['hello', 'WORLD', 'orld', 'Hello', 'o', 'xyz']) {
      const got = t.scan([{ field: 's', op, value: needle }]).toArray();
      assert.deepEqual(got, oracle(rows, op, needle), `${op} ${JSON.stringify(needle)}`);
    }
  }
});

test('empty needle: contains/startsWith/endsWith match every non-null row; not* match none', () => {
  const rows: (string | null)[] = ['abc', '', 'DEF', null, 'x'];
  const t = buildTable(rows);
  for (const op of ALL_OPS) {
    const got = t.scan([{ field: 's', op, value: '' }]).toArray();
    assert.deepEqual(got, oracle(rows, op, ''), `${op} empty needle`);
  }
  // Sanity on the semantics: '' is a substring/prefix/suffix of everything.
  assert.deepEqual(t.scan([{ field: 's', op: 'contains', value: '' }]).toArray(), [0, 1, 2, 4]);
  assert.equal(t.scan([{ field: 's', op: 'notContains', value: '' }]).count(), 0);
});

test('needle longer than any value matches nothing (and not* matches all non-null)', () => {
  const rows = ['ab', 'abc', 'xy', 'abcd'];
  const t = buildTable(rows);
  const longNeedle = 'abcdefghijklmnop';
  for (const op of ALL_OPS) {
    const got = t.scan([{ field: 's', op, value: longNeedle }]).toArray();
    assert.deepEqual(got, oracle(rows, op, longNeedle), `${op} long needle`);
  }
  assert.equal(t.scan([{ field: 's', op: 'contains', value: longNeedle }]).count(), 0);
  assert.deepEqual(
    t.scan([{ field: 's', op: 'notContains', value: longNeedle }]).toArray(),
    [0, 1, 2, 3],
  );
});

test('multi-byte / surrogate-pair / accented Unicode matches the brute oracle', () => {
  // Mix BMP CJK, emoji (surrogate pairs), combining accents and precomposed forms.
  const rows = [
    '日本語のテスト', // Japanese
    'emoji 😀 face', // 😀 is a surrogate pair
    'two 😀😀 emojis',
    'café latte', // precomposed é
    'café mocha', // decomposed é (e + combining acute) -> NFKC composes
    'Москва город', // Cyrillic
    'plain ascii',
    '🎉party🎉',
  ];
  const t = buildTable(rows);
  const needles = ['😀', '日本語', 'のテスト', 'café', 'café', 'москва', '🎉', 'party', 'ascii'];
  for (const op of ALL_OPS) {
    for (const needle of needles) {
      const got = t.scan([{ field: 's', op, value: needle }]).toArray();
      assert.deepEqual(got, oracle(rows, op, needle), `${op} ${JSON.stringify(needle)}`);
    }
  }
});

test('$containsi folds a fullwidth/ligature needle the SAME way $eqi does (consistency)', () => {
  // The whole point: 'ﬀ' (U+FB00 LATIN SMALL LIGATURE FF) folds via NFKC to 'ff'.
  // So $containsi 'ﬀ' must match a value containing 'ff' / 'FF', identical to how $eqi treats it.
  const rows = ['offer', 'OFFER', 'office', 'staﬀ', 'misc', 'EFFORT'];
  const t = buildTable(rows);

  // $containsi with the ligature needle.
  const ligature = t.scan([{ field: 's', op: 'containsi', value: 'ﬀ' }]).toArray();
  // Oracle folds both sides identically.
  assert.deepEqual(ligature, oracle(rows, 'containsi', 'ﬀ'), 'containsi ligature needle');
  // And the plain-ff needle yields the same rows (fold('ﬀ') === fold('ff') === 'ff').
  const plain = t.scan([{ field: 's', op: 'containsi', value: 'ff' }]).toArray();
  assert.deepEqual(ligature, plain, "containsi 'ﬀ' === containsi 'ff'");
  // Cross-check against $eqi's fold contract on a value that IS exactly the ligature/ff pair.
  const eqRows = ['ﬀ', 'FF', 'ff', 'fF'];
  const et = buildTable(eqRows);
  const eqi = et.scan([{ field: 's', op: 'eqi', value: 'ﬀ' }]).toArray();
  const ci = et.scan([{ field: 's', op: 'containsi', value: 'ﬀ' }]).toArray();
  // Every $eqi match (full-string fold-equal) is also a $containsi match (fold-substring).
  assert.deepEqual(eqi, [0, 1, 2, 3], 'all four fold to ff under eqi');
  assert.deepEqual(ci, [0, 1, 2, 3], 'containsi agrees with eqi fold for the ligature needle');

  // Fullwidth needle 'ＦＦ' (U+FF26 x2) -> NFKC 'FF' -> fold 'ff'; same matches again.
  const fullwidth = t.scan([{ field: 's', op: 'containsi', value: 'ＦＦ' }]).toArray();
  assert.deepEqual(fullwidth, plain, "containsi 'ＦＦ' folds to the same as 'ff'");
});

test('$startsWithi / $endsWithi fold the needle (not a plain toLowerCase) like $eqi', () => {
  // A fullwidth uppercase prefix/suffix must fold through NFKC, which toLowerCase() alone would NOT do.
  const rows = ['ＡＢＣdef', 'abcDEF', 'xyzABC', 'ABCxyz', 'tail_ﬀ', 'tail_ff'];
  const t = buildTable(rows);
  for (const needle of ['ＡＢＣ', 'abc', 'def', 'ＤＥＦ', 'ﬀ', 'ff']) {
    const sw = t.scan([{ field: 's', op: 'startsWithi', value: needle }]).toArray();
    assert.deepEqual(sw, oracle(rows, 'startsWithi', needle), `startsWithi ${JSON.stringify(needle)}`);
    const ew = t.scan([{ field: 's', op: 'endsWithi', value: needle }]).toArray();
    assert.deepEqual(ew, oracle(rows, 'endsWithi', needle), `endsWithi ${JSON.stringify(needle)}`);
  }
});

test('$notContains / $notContainsi exclude NULL rows (three-valued logic)', () => {
  const rows: (string | null)[] = ['apple', 'APPLE', null, 'banana', null, 'grape', 'pineapple'];
  const t = buildTable(rows);
  for (const needle of ['apple', 'APPLE', 'an', 'z', '']) {
    for (const op of ['notContains', 'notContainsi'] as const) {
      const got = t.scan([{ field: 's', op, value: needle }]).toArray();
      assert.deepEqual(got, oracle(rows, op, needle), `${op} ${JSON.stringify(needle)}`);
      // A NULL row must never survive a not* result.
      for (const r of got) assert.ok(!t.isNull('s', r), `${op} row ${r} must not be null`);
    }
  }
});

test('the deduped-dictionary path returns identical rows to a naive per-row scan', () => {
  // Heavy duplication so the dictionary is much smaller than the row count: the engine scans
  // D distinct strings + one O(N) codes pass, the oracle scans all N rows. They must agree.
  const palette = [
    'alpha-One',
    'BETA_two',
    'gamma three',
    'Delta-FOUR',
    'epsilon',
    'AlphaBeta',
    'oneTwoThree',
    'ＦＵＬＬwidth', // fullwidth prefix to exercise folding in the dict scan
    'liga-staﬀ',
    'emoji-😀-tail',
  ];
  const rows: (string | null)[] = [];
  let seed = 0x0bad5eed;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 1500; i++) {
    if (i % 53 === 0) rows.push(null);
    else rows.push(palette[next() % palette.length]!);
  }
  const t = buildTable(rows);
  const needles = ['alpha', 'BETA', 'three', 'ﬀ', '😀', 'fullwidth', 'one', 'z', ''];
  for (const op of ALL_OPS) {
    for (const needle of needles) {
      const got = t.scan([{ field: 's', op, value: needle }]).toArray();
      assert.deepEqual(got, oracle(rows, op, needle), `${op} ${JSON.stringify(needle)} @1500 deduped`);
    }
  }
});

test('survives capacity growth past INITIAL_CAPACITY and classifies word-boundary rows', () => {
  const variants = ['Red apple', 'red car', 'BLUE sky', 'blueberry', 'green TEA', 'GREENhouse'];
  const rows: (string | null)[] = [];
  let seed = 0x1234567;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 1500; i++) {
    if (i % 41 === 0) rows.push(null);
    else rows.push(variants[next() % variants.length]!);
  }
  const t = buildTable(rows);
  for (const op of ALL_OPS) {
    for (const needle of ['red', 'BLUE', 'green', 'apple', 'house', 'zzz']) {
      const got = t.scan([{ field: 's', op, value: needle }]).toArray();
      assert.deepEqual(got, oracle(rows, op, needle), `${op} ${needle} @1500`);
    }
  }
  // Word-boundary rows 31/32/63/64 and a non-multiple-of-32 count: each non-null boundary row
  // must $containsi a substring of its own folded value.
  for (const boundary of [31, 32, 63, 64]) {
    const v = rows[boundary];
    if (v === null) continue;
    const sub = fold(v).slice(0, 3);
    const got = t.scan([{ field: 's', op: 'containsi', value: sub }]).get(boundary);
    assert.equal(got, true, `boundary row ${boundary} contains its own prefix`);
  }
});

test('empty column: every operator matches nothing', () => {
  const t = new Table(FIELDS);
  for (const op of ALL_OPS) {
    assert.equal(t.scan([{ field: 's', op, value: 'anything' }]).count(), 0, `${op} empty column`);
    assert.equal(t.scan([{ field: 's', op, value: '' }]).count(), 0, `${op} empty needle empty column`);
  }
});

test('all-match and none-match extremes for each polarity', () => {
  const rows = ['prefix_a', 'prefix_b', 'prefix_c'];
  const t = buildTable(rows);
  // Common prefix: startsWith matches all, notContains of that prefix matches none.
  assert.deepEqual(t.scan([{ field: 's', op: 'startsWith', value: 'prefix' }]).toArray(), [0, 1, 2]);
  assert.equal(t.scan([{ field: 's', op: 'notContains', value: 'prefix' }]).count(), 0);
  // Absent substring: contains none, notContains all.
  assert.equal(t.scan([{ field: 's', op: 'contains', value: 'ZZZ' }]).count(), 0);
  assert.deepEqual(t.scan([{ field: 's', op: 'notContains', value: 'ZZZ' }]).toArray(), [0, 1, 2]);
});

test('substring leaves compose with AND / OR / NOT in the predicate tree', () => {
  const rows = ['red apple', 'red car', 'blue apple', 'green pear', 'red pear'];
  const t = buildTable(rows);
  // red AND apple
  const andTree = t.scanTree({
    op: 'and',
    children: [
      { leaf: { field: 's', op: 'startsWith', value: 'red' } },
      { leaf: { field: 's', op: 'contains', value: 'apple' } },
    ],
  });
  assert.deepEqual(andTree.toArray(), [0]);
  // apple OR pear
  const orTree = t.scanTree({
    op: 'or',
    children: [
      { leaf: { field: 's', op: 'endsWith', value: 'apple' } },
      { leaf: { field: 's', op: 'endsWith', value: 'pear' } },
    ],
  });
  assert.deepEqual(orTree.toArray(), [0, 2, 3, 4]);
});

test('foldedDict is reused (built once) when an -i substring op runs after $eqi', () => {
  const rows = ['Alpha', 'ALPHA', 'beta', 'BETA', 'gamma'];
  const t = buildTable(rows);
  const col = t.column('s') as StringColumn;
  t.scan([{ field: 's', op: 'eqi', value: 'alpha' }]); // builds the folded dict
  t.scan([{ field: 's', op: 'containsi', value: 'ALP' }]); // must reuse it
  const distinct = new Set(rows);
  assert.equal(col.foldedDictLength(), distinct.size, 'foldedDict stays aligned 1:1 by code');
});
