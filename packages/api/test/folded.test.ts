import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef } from '../src/store/table.ts';
import { StringColumn } from '../src/store/column.ts';

/**
 * Slice 2: folded dictionary + case-insensitive equality ($eqi / $nei).
 *
 * Doctrine: NO mocks. Everything is driven through the real Table/StringColumn, and the
 * expected result is computed by a trivial O(n) brute-force ORACLE that folds the SAME way
 * the engine does — fold(s) = NFKC(s) then toLowerCase(). We assert the engine matches the
 * oracle across case variants, Unicode normalization, capacity growth, and word boundaries.
 */

/** The reference fold, mirroring StringColumn.fold (NFKC then locale-independent lower). */
function fold(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

const FIELDS: FieldDef[] = [{ name: 's', type: 'string' }];

/** Brute oracle: rows whose stored (non-null) string folds equal to the folded query. */
function oracleEqi(rows: (string | null)[], query: string): number[] {
  const q = fold(query);
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i];
    if (v !== null && fold(v) === q) out.push(i);
  }
  return out;
}

/** Brute oracle: $nei — folded value differs AND the row is not null (3-valued logic). */
function oracleNei(rows: (string | null)[], query: string): number[] {
  const q = fold(query);
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i];
    if (v !== null && fold(v) !== q) out.push(i);
  }
  return out;
}

function buildTable(rows: (string | null)[]): Table {
  const t = new Table(FIELDS);
  for (const v of rows) t.insert(v === null ? {} : { s: v });
  return t;
}

test('$eqi matches across ASCII case variants via brute oracle', () => {
  const rows = ['Draft', 'PUBLISHED', 'published', 'Published', 'ARCHIVED', 'archived'];
  const t = buildTable(rows);
  for (const q of ['draft', 'DRAFT', 'Published', 'pUbLiShEd', 'archived', 'MISSING']) {
    const got = t.scan([{ field: 's', op: 'eqi', value: q }]).toArray();
    assert.deepEqual(got, oracleEqi(rows, q), `eqi ${q}`);
  }
});

test('$eqi folds Unicode normalization + eszett (STRASSE vs strasse, ligatures, fullwidth)', () => {
  // NFKC collapses the 'ﬀ' ligature -> 'ff' and fullwidth 'Ａ' -> 'A'; lowering then unifies case.
  // Eszett: 'STRASSE' lowercases to 'strasse'; the literal 'straße' does NOT (ß stays ß), so
  // the oracle and engine MUST agree on that distinction — we assert it explicitly below.
  const rows = [
    'STRASSE',
    'strasse',
    'Strasse',
    'straße', // ß is NOT 'ss' under simple lowering — must fold distinctly from 'strasse'
    'CAFÉ',
    'café',
    'café', // decomposed é (e + combining acute) -> NFKC composes to 'café'
    'ﬀ oo', // 'ﬀ oo' ligature -> NFKC 'ff oo'
    'FF oo',
    'ＡＢＣ', // fullwidth ABC -> NFKC 'ABC'
    'abc',
  ];
  const t = buildTable(rows);
  const queries = ['strasse', 'STRASSE', 'straße', 'café', 'CAFÉ', 'café', 'ff oo', 'ABC', 'abc', 'ＡＢＣ'];
  for (const q of queries) {
    const got = t.scan([{ field: 's', op: 'eqi', value: q }]).toArray();
    assert.deepEqual(got, oracleEqi(rows, q), `eqi ${JSON.stringify(q)}`);
  }
  // Explicit: 'straße' and 'strasse' do NOT collapse under this fold.
  const straße = t.scan([{ field: 's', op: 'eqi', value: 'straße' }]).toArray();
  assert.deepEqual(straße, [3], 'straße folds only to itself');
});

test('$nei excludes folded matches AND null rows', () => {
  const rows: (string | null)[] = ['Alpha', 'ALPHA', null, 'beta', 'BETA', null, 'Gamma'];
  const t = buildTable(rows);
  for (const q of ['alpha', 'ALPHA', 'beta', 'gamma', 'absent']) {
    const got = t.scan([{ field: 's', op: 'nei', value: q }]).toArray();
    const expected = oracleNei(rows, q);
    assert.deepEqual(got, expected, `nei ${q}`);
    // No null row may ever appear in a $nei result.
    for (const r of got) assert.ok(!t.isNull('s', r), `row ${r} must not be null`);
  }
});

test('$eqi never matches a null row (sentinel must not leak)', () => {
  // Null rows carry the reserved '' code; an $eqi on '' must still exclude them.
  const rows: (string | null)[] = ['x', null, 'X', null, ''];
  const t = buildTable(rows);
  // The empty-string row (index 4) is a REAL empty string, not null.
  const got = t.scan([{ field: 's', op: 'eqi', value: '' }]).toArray();
  assert.deepEqual(got, oracleEqi(rows, ''), 'eqi "" matches the real empty string, not nulls');
  // And eqi 'x' matches the two real-string rows only.
  const gx = t.scan([{ field: 's', op: 'eqi', value: 'X' }]).toArray();
  assert.deepEqual(gx, [0, 2]);
});

test('folded dictionary is built ONCE and aligned 1:1 with the raw dictionary by code', () => {
  // Distinct raw strings; several fold to the same key but each keeps its own code+slot.
  const rows = ['A', 'a', 'B', 'b', 'A', 'STRASSE', 'strasse', 'café', 'CAFÉ'];
  const t = buildTable(rows);
  const col = t.column('s') as StringColumn;
  // Trigger a folded build via an $eqi query.
  t.scan([{ field: 's', op: 'eqi', value: 'a' }]);
  // foldedDict length == raw dict length (one folded slot per distinct interned string).
  const distinct = new Set(rows.filter((r): r is string => r !== null));
  assert.equal(col.foldedDictLength(), distinct.size, 'foldedDict aligned by code with dict');
});

test('$eqi survives capacity growth past INITIAL_CAPACITY (1024) and word boundaries', () => {
  // Deterministic pseudo-data via a seeded LCG; mix case so folding is exercised.
  const variants = ['red', 'Red', 'RED', 'green', 'GREEN', 'Blue', 'blue', 'BLUE'];
  const rows: (string | null)[] = [];
  let seed = 0x1234567;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  // 1500 rows -> several Int32Array grows; nulls scattered to hit 3-valued logic too.
  for (let i = 0; i < 1500; i++) {
    if (i % 37 === 0) rows.push(null);
    else rows.push(variants[next() % variants.length]!);
  }
  const t = buildTable(rows);
  for (const q of ['red', 'GREEN', 'blue', 'Red', 'absent']) {
    const eqi = t.scan([{ field: 's', op: 'eqi', value: q }]).toArray();
    assert.deepEqual(eqi, oracleEqi(rows, q), `eqi ${q} @1500`);
    const nei = t.scan([{ field: 's', op: 'nei', value: q }]).toArray();
    assert.deepEqual(nei, oracleNei(rows, q), `nei ${q} @1500`);
  }
  // Word-boundary probe: rows 31/32/63/64 must be classified correctly.
  for (const boundary of [31, 32, 63, 64]) {
    const v = rows[boundary];
    if (v === null) continue;
    const got = t.scan([{ field: 's', op: 'eqi', value: v }]).get(boundary);
    assert.equal(got, true, `boundary row ${boundary} matches its own value`);
  }
});

test('$eqi on an empty column matches nothing (empty-input edge)', () => {
  const t = new Table(FIELDS);
  assert.equal(t.scan([{ field: 's', op: 'eqi', value: 'anything' }]).count(), 0);
  assert.equal(t.scan([{ field: 's', op: 'nei', value: 'anything' }]).count(), 0);
});

test('$eqi all-match and none-match extremes', () => {
  const rows = ['Same', 'SAME', 'same', 'sAmE'];
  const t = buildTable(rows);
  assert.deepEqual(t.scan([{ field: 's', op: 'eqi', value: 'same' }]).toArray(), [0, 1, 2, 3]);
  assert.equal(t.scan([{ field: 's', op: 'eqi', value: 'other' }]).count(), 0);
  // $nei of the only (folded) value present => none match.
  assert.equal(t.scan([{ field: 's', op: 'nei', value: 'SAME' }]).count(), 0);
  // $nei of an absent value => all (non-null) rows match.
  assert.deepEqual(t.scan([{ field: 's', op: 'nei', value: 'other' }]).toArray(), [0, 1, 2, 3]);
});
