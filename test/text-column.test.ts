import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef } from '../src/store/table.ts';
import { TextColumn, createColumn } from '../src/store/column.ts';

/**
 * Slice AV0 — 'text' COLUMN TYPE (off-heap UTF-8 arena, brute substring/affix scan).
 *
 * Doctrine: NO mocks, deterministic seeded LCG, equivalence ORACLES. The TextColumn / Table are
 * driven for real. Round-trip (insert -> at/materialize) is proven for ASCII, multi-byte/CJK,
 * surrogate-pair/emoji, empty string, ~10KB body, and NULL (materialize -> null; `at` returns ''
 * for both a null sentinel and a real '' — the null bit is the source of truth). The substring/
 * affix operators (incl. -i folding consistent with $eqi, and notContains-variants/ne excluding nulls) equal
 * a per-row brute oracle. Arena correctness is checked past 1024 rows and at bitset word boundaries.
 */

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Reference fold, mirroring column.ts `fold` (NFKC then locale-independent lower). */
function fold(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

test('createColumn("text") returns a TextColumn; type tag is "text"', () => {
  const col = createColumn('text');
  assert.equal(col.type, 'text');
  assert.equal(col instanceof TextColumn, true);
});

test('TextColumn round-trip: ASCII, CJK, surrogate/emoji, empty, ~10KB body', () => {
  const col = new TextColumn();
  const values = [
    'hello world', // ASCII
    '日本語のテキスト', // CJK multi-byte
    'emoji 👨‍👩‍👧‍👦 family 😀 and 𝕏 math', // surrogate pairs / ZWJ sequences
    '', // empty string
    'café ﬀ Ａ', // accent + ligature + fullwidth (NFKC-relevant)
    'x'.repeat(10_240), // ~10KB long body
    'tail',
  ];
  for (const v of values) col.push(v);
  assert.equal(col.length, values.length);
  for (let i = 0; i < values.length; i++) assert.equal(col.at(i), values[i], `row ${i}`);
});

test('TextColumn: arena grows past INITIAL_CAPACITY (1024 rows) preserving every value', () => {
  const col = new TextColumn();
  const rng = lcg(7);
  const expected: string[] = [];
  const N = 1500; // > 1024 rows; varying lengths force the byte arena to double several times
  for (let i = 0; i < N; i++) {
    const len = (rng() * 200) | 0;
    let s = `row${i}:`;
    while (s.length < len) s += rng() < 0.3 ? '日' : 'a';
    expected.push(s);
    col.push(s);
  }
  for (let i = 0; i < N; i++) assert.equal(col.at(i), expected[i], `row ${i}`);
});

test('Table: text materialize returns the string, or null for a NULL row; "" vs null distinguished', () => {
  const t = new Table([{ name: 'body', type: 'text' }]);
  t.insert({ body: 'real content' }); // row 0
  t.insert({ body: '' }); // row 1: genuine empty string, NOT null
  t.insert({ body: null }); // row 2: explicit null
  t.insert({}); // row 3: missing -> null
  t.insert({ body: '日本 🎉' }); // row 4

  assert.equal(t.isNull('body', 1), false, 'real "" is not null');
  assert.equal(t.isNull('body', 2), true);
  assert.equal(t.isNull('body', 3), true);

  assert.deepEqual(t.materialize(0), { body: 'real content' });
  assert.deepEqual(t.materialize(1), { body: '' }); // empty string survives as ''
  assert.deepEqual(t.materialize(2), { body: null });
  assert.deepEqual(t.materialize(3), { body: null });
  assert.deepEqual(t.materialize(4), { body: '日本 🎉' });

  // The column's `at` returns '' for both the real-empty row and the null-sentinel rows; only the
  // null bit (consulted by materialize) tells them apart.
  const col = t.column('body') as TextColumn;
  assert.equal(col.at(1), '');
  assert.equal(col.at(2), '');
});

// --- substring / affix operators over a 'text' column, brute oracle ---------

const TEXT_OPS = [
  'contains',
  'containsi',
  'notContains',
  'notContainsi',
  'startsWith',
  'startsWithi',
  'endsWith',
  'endsWithi',
  'eq',
  'ne',
  'eqi',
  'nei',
] as const;

type TextOp = (typeof TEXT_OPS)[number];

/** Per-row brute oracle. NULL rows never match any operator (three-valued logic). */
function oracle(rows: (string | null)[], op: TextOp, needle: string): number[] {
  const out: number[] = [];
  const fn = fold(needle);
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i];
    if (v === null) continue;
    const fv = fold(v);
    let hit = false;
    switch (op) {
      case 'contains': hit = v.includes(needle); break;
      case 'containsi': hit = fv.includes(fn); break;
      case 'notContains': hit = !v.includes(needle); break;
      case 'notContainsi': hit = !fv.includes(fn); break;
      case 'startsWith': hit = v.startsWith(needle); break;
      case 'startsWithi': hit = fv.startsWith(fn); break;
      case 'endsWith': hit = v.endsWith(needle); break;
      case 'endsWithi': hit = fv.endsWith(fn); break;
      case 'eq': hit = v === needle; break;
      case 'ne': hit = v !== needle; break;
      case 'eqi': hit = fv === fn; break;
      case 'nei': hit = fv !== fn; break;
    }
    if (hit) out.push(i);
  }
  return out;
}

function buildTable(rows: (string | null)[]): Table {
  const t = new Table([{ name: 'body', type: 'text' }]);
  for (const v of rows) t.insert(v === null ? {} : { body: v });
  return t;
}

test('text operators equal the per-row brute oracle, with NULLs excluded by three-valued logic', () => {
  const rng = lcg(123);
  const FRAGS = ['Lorem', 'ipsum', 'DOLOR', 'café', 'ﬀ', '日本', '😀', 'sit', 'amet', 'AB'];
  const rows: (string | null)[] = [];
  const N = 200;
  for (let i = 0; i < N; i++) {
    if (rng() < 0.15) {
      rows.push(null);
      continue;
    }
    let s = '';
    const parts = 1 + ((rng() * 4) | 0);
    for (let p = 0; p < parts; p++) s += (p > 0 ? ' ' : '') + FRAGS[(rng() * FRAGS.length) | 0]!;
    rows.push(s);
  }
  const t = buildTable(rows);

  const needles = ['Lorem', 'lorem', 'DOLOR', 'dolor', 'café', 'CAFÉ', 'ﬀ', 'ff', '日本', '😀', 'AB', 'ab', 'zzz', '', 'sit amet'];
  for (const op of TEXT_OPS) {
    for (const needle of needles) {
      const got = t.scan([{ field: 'body', op, value: needle }]).toArray();
      const exp = oracle(rows, op, needle);
      assert.deepEqual(got, exp, `op=${op} needle=${JSON.stringify(needle)}`);
    }
  }
});

test('text -i folding is consistent with $eqi (ligature/fullwidth/accent collapse the same)', () => {
  const rows = ['ﬀoo', 'ffoo', 'CAFÉ here', 'Ａbc', 'plain'];
  const t = buildTable(rows);
  // 'ﬀ' folds to 'ff' -> containsi 'ff' must match both the ligature and the literal-ff rows.
  assert.deepEqual(t.scan([{ field: 'body', op: 'containsi', value: 'ff' }]).toArray(), oracle(rows, 'containsi', 'ff'));
  assert.deepEqual(t.scan([{ field: 'body', op: 'containsi', value: 'ﬀ' }]).toArray(), oracle(rows, 'containsi', 'ﬀ'));
  // fullwidth 'Ａ' (U+FF21) NFKC-folds to 'a'
  assert.deepEqual(t.scan([{ field: 'body', op: 'startsWithi', value: 'abc' }]).toArray(), oracle(rows, 'startsWithi', 'abc'));
  // accented eqi
  assert.deepEqual(t.scan([{ field: 'body', op: 'containsi', value: 'café' }]).toArray(), oracle(rows, 'containsi', 'café'));
});

test('notContains / notContainsi / ne / nei exclude NULL rows at the Table boundary', () => {
  const rows: (string | null)[] = ['alpha', null, 'beta', null, 'ALPHA', ''];
  const t = buildTable(rows);
  for (const op of ['notContains', 'notContainsi', 'ne', 'nei'] as const) {
    const got = t.scan([{ field: 'body', op, value: 'alpha' }]).toArray();
    const exp = oracle(rows, op, 'alpha');
    assert.deepEqual(got, exp, `op=${op}`);
    // NULL rows (1, 3) must never appear.
    assert.equal(got.includes(1), false, `${op} excludes null row 1`);
    assert.equal(got.includes(3), false, `${op} excludes null row 3`);
  }
});

test('text arena: operators correct past 1024 rows and at bitset word boundaries', () => {
  const rng = lcg(99);
  const rows: (string | null)[] = [];
  const N = 1100; // > INITIAL_CAPACITY and across many 32-bit word boundaries
  const boundaryHits = new Set([31, 32, 33, 63, 64, 1023, 1024, 1025]);
  for (let i = 0; i < N; i++) {
    if (rng() < 0.1) {
      rows.push(null);
      continue;
    }
    // Make the special needle 'NEEDLE' land exactly on word-boundary rows so the mask must be
    // correct there; everything else is filler that does NOT contain it.
    if (boundaryHits.has(i)) rows.push(`pre NEEDLE post ${i}`);
    else rows.push(`filler text ${i} ${rng() < 0.3 ? '日本' : 'xyz'}`);
  }
  const t = buildTable(rows);
  for (const op of ['contains', 'containsi', 'notContains', 'notContainsi'] as const) {
    assert.deepEqual(
      t.scan([{ field: 'body', op, value: 'NEEDLE' }]).toArray(),
      oracle(rows, op, 'NEEDLE'),
      `op=${op} past capacity`,
    );
  }
  // Sanity: the contains hits are exactly the boundary rows that aren't null.
  const containsRows = t.scan([{ field: 'body', op: 'contains', value: 'NEEDLE' }]).toArray();
  assert.deepEqual(containsRows, [...boundaryHits].filter((r) => rows[r] !== null).sort((a, b) => a - b));
});

test('text column: scanTree combines a text predicate with another column correctly', () => {
  const t = new Table([
    { name: 'body', type: 'text' },
    { name: 'status', type: 'string' },
  ]);
  const rows = [
    { body: 'hello world', status: 'published' },
    { body: 'hello there', status: 'draft' },
    { body: 'goodbye world', status: 'published' },
    {}, // both null
  ];
  for (const r of rows) t.insert(r);
  const got = t
    .scanTree({
      op: 'and',
      children: [
        { leaf: { field: 'body', op: 'contains', value: 'hello' } },
        { leaf: { field: 'status', op: 'eq', value: 'published' } },
      ],
    })
    .toArray();
  assert.deepEqual(got, [0]); // only row 0 has both 'hello' and published
});
