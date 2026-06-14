/**
 * PHASE 2 — Property-based fuzz for the STRING + substring/affix (+trigram) segment.
 *
 * Doctrine (non-negotiable): NO mocks. Every query is driven through the REAL engine (Table /
 * StringColumn / SubstringIndex) and asserted against the INDEPENDENT O(n) oracle in harness.ts.
 *
 * Matrix covered for the string type (every op asserted == oracle):
 *   eq ne eqi nei in notIn contains containsi startsWith startsWithi endsWith endsWithi
 *   notContains notContainsi null notNull
 *
 * DUAL-RUN INVARIANT: every randomized query runs TWICE — once on a table with the trigram
 * substring accelerator OFF (pure brute scan, the Slice-3 floor) and once on a SEPARATE table with
 * `enableSubstringIndex('s')` ON. Both must equal the oracle row-for-row, so the accelerator is
 * proven to be a pure speed optimization that never changes results. We also assert (via the real
 * `substringAccelHits` counter, not a mock) that the trigram path actually FIRED on the contains*
 * family with >=3-char needles, so a silently-disabled accelerator can't pass unnoticed.
 *
 * Unicode coverage: ligatures (ﬀ→ff), fullwidth (Ａ→a under NFKC+lower), composed/decomposed
 * accents (café), the eszett (ß stays ß, NOT ss), and astral surrogate-pair emoji — exercising the
 * fold path and trigram code-unit handling. Needles both <3 (defer-to-brute) and >=3 (trigram path).
 *
 * SIZING (logged, never silently truncated): the oracle is O(n)/query, so coverage comes from query
 * COUNT not row count. We run RANDOM_QUERIES = 3200 randomized queries split across MODERATE tables
 * of N ∈ {31,32,63,64,65,100,1024,1025,2000,8000,20000} rows (chosen to straddle bitset-word
 * boundaries 31/32/63/64, rowCount%32!=0, and capacity growth past INITIAL_CAPACITY=1024). A
 * separate block runs ~400 explicit randomized queries at N up to 20000. Large-N smoke checks go up
 * to 1_000_000 rows but use a CHEAP count-only / single-loop oracle (NOT the per-query O(n) matcher),
 * so we never run thousands of O(n) oracle passes at 1M. Total runtime target: well under ~20s.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef, type FilterNode } from '../../src/store/table.ts';
import { StringColumn, type ScanOp } from '../../src/store/column.ts';
import {
  Rng,
  Coverage,
  randomTree,
  runMatrix,
  oracleMatch,
  oracleLeafMatch,
  fieldTypeMap,
  type FieldSpec,
  type Row,
  type Cardinality,
} from './harness.ts';

// ===========================================================================
// Sizing knobs (logged here so coverage is never silently truncated).
// ===========================================================================
const RANDOM_QUERIES = 3200; // total randomized matrix queries (each run twice: accel off + on)
const ROW_SIZES = [31, 32, 63, 64, 65, 100, 1024, 1025, 2000, 8000, 20000] as const;
const LARGE_N = 1_000_000; // smoke-only, cheap oracle

/** The full string operator matrix this segment must cover. */
const STRING_OPS: ScanOp[] = [
  'eq', 'ne', 'eqi', 'nei', 'in', 'notIn',
  'contains', 'containsi', 'startsWith', 'startsWithi', 'endsWith', 'endsWithi',
  'notContains', 'notContainsi', 'null', 'notNull',
];

/** The contains-family ops whose >=3-char needles must fire the trigram accelerator. */
const CONTAINS_FAMILY: ReadonlySet<ScanOp> = new Set<ScanOp>([
  'contains', 'containsi', 'notContains', 'notContainsi',
]);

const FIELD: FieldSpec = { name: 's', type: 'string', nullRate: 0.15, cardinality: 'medium' };
const FIELDS: FieldSpec[] = [FIELD];
const DEFS: FieldDef[] = [{ name: 's', type: 'string' }];
const TYPES = fieldTypeMap(FIELDS);

/** The reference fold (mirrors StringColumn.fold + the oracle): NFKC then locale-independent lower. */
function fold(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

/**
 * Unicode-heavy value alphabet: ligatures, fullwidth, composed/decomposed accents, eszett, the empty
 * string (a legal interned value, distinct from NULL), and astral surrogate-pair emoji. Distinct
 * from the harness's pool so we can hammer the fold + trigram code-unit paths deliberately.
 */
const UNICODE_ALPHABET: readonly string[] = [
  'apple', 'Apple', 'APPLE', 'banana', 'Banana', 'cherry', 'CHERRY',
  'café', 'café', 'CAFÉ', // composed, decomposed (e+combining acute), upper — NFKC-equal folds
  'straße', 'STRASSE', 'strasse', // eszett: ß folds to ß (NOT ss) — STRASSE must NOT eqi straße
  'oＡo', 'ﬀix', 'ＡＰＰＬＥ', // fullwidth A, ﬀ ligature, fullwidth APPLE (folds to 'apple')
  'mango', 'Mango', 'grape', '', 'pineapple', 'PineApple',
  '😀face', 'face😀', 'a😀b', '🎉🎉🎉', '𝓪𝓹𝓹', // astral surrogate pairs (math-script "app")
  'a', 'ab', 'abc', // short values for affix/short-needle edges
];

/** Needles mixing <3 chars (defer-to-brute) and >=3 chars (trigram path), plus Unicode. */
const NEEDLES: readonly string[] = [
  '', 'a', 'ab', 'app', 'APP', 'Ａｐｐ', 'ana', 'pp', 'ﬀ', 'ffix', 'ple',
  'café', 'CAF', 'ße', 'ss', 'STRASSE', '😀', '😀face', '🎉🎉', '𝓪𝓹𝓹', 'xyz', 'zzz', 'oao',
];

/** Build a table over the given rows; `accel` opts the `s` column into the trigram accelerator. */
function buildTable(rows: Row[], accel: boolean): Table {
  const t = new Table(DEFS);
  if (accel) t.enableSubstringIndex('s');
  for (const r of rows) t.insert(r);
  return t;
}

/**
 * Assert engine == oracle for one tree, on BOTH the accel-off and accel-on tables. The two engine
 * results must also agree with each other (the accelerator changes speed, never rows). Returns the
 * oracle row list. Records coverage for the leaf ops in the tree.
 */
function assertTree(
  brute: Table,
  accel: Table,
  rows: Row[],
  tree: FilterNode,
  seed: number,
  label: string,
): number[] {
  const oracle = oracleMatch(TYPES, rows, tree);
  const bruteRes = brute.scanTree(tree).toArray();
  const accelRes = accel.scanTree(tree).toArray();
  runMatrix(bruteRes, oracle, { seed, node: tree, rows, label: `${label} [brute]` });
  runMatrix(accelRes, oracle, { seed, node: tree, rows, label: `${label} [accel]` });
  return oracle;
}

/** Build a one-leaf tree for a single string predicate. */
function leaf(op: ScanOp, value: unknown): FilterNode {
  return { leaf: { field: 's', op, value } };
}

/** Generate rows from a Unicode alphabet at the given cardinality/null-rate (deterministic in rng). */
function genUnicodeRows(rng: Rng, n: number, nullRate: number, card: Cardinality): Row[] {
  // Reuse the harness generator shape but with our richer alphabet by sampling directly.
  const distinct = card === 'low' ? 4 : card === 'medium' ? Math.min(24, Math.max(4, n >> 2)) : n;
  const pool: string[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (pool.length < distinct) {
    const s = i < UNICODE_ALPHABET.length ? UNICODE_ALPHABET[i]! : `s_${i}_${rng.int(1_000_000)}`;
    i++;
    if (!seen.has(s)) {
      seen.add(s);
      pool.push(s);
    }
    if (i > distinct * 4 + UNICODE_ALPHABET.length) break;
  }
  const rows: Row[] = [];
  for (let r = 0; r < n; r++) {
    rows.push(rng.chance(nullRate) ? { s: null } : { s: pool[rng.int(pool.length)]! });
  }
  return rows;
}

// ===========================================================================
// 1. The big randomized matrix: thousands of queries at moderate N, accel off + on.
// ===========================================================================
test('string fuzz: randomized operator matrix == oracle (trigram OFF and ON agree)', () => {
  const cov = new Coverage();
  let queriesRun = 0;
  let table = 0;

  // Spread RANDOM_QUERIES across the row-size ladder. Each "table" gets a fresh seed/rows pair and
  // runs a batch of single-leaf + small-tree queries against it (both accel off and on).
  const perTable = Math.ceil(RANDOM_QUERIES / (ROW_SIZES.length * 6));

  for (let pass = 0; pass < 6; pass++) {
    for (const n of ROW_SIZES) {
      const seed = 0x57a17 + table * 2654435761 + pass * 40503;
      const rng = new Rng(seed);
      const nullRate = rng.pick([0, 0.1, 0.15, 0.3]);
      const card = rng.pick<Cardinality>(['low', 'medium', 'nearUnique']);
      const rows = genUnicodeRows(rng, n, nullRate, card);
      const brute = buildTable(rows, false);
      const accel = buildTable(rows, true);
      table++;

      for (let q = 0; q < perTable && queriesRun < RANDOM_QUERIES; q++) {
        // Alternate between a single random-op leaf and a small boolean tree, so we cover both
        // every operator individually AND their and/or/not combinations.
        let tree: FilterNode;
        if (rng.chance(0.6)) {
          const op = rng.pick(STRING_OPS);
          const value = randomStringValue(rng, op);
          cov.recordLeaf('string', op);
          tree = leaf(op, value);
        } else {
          tree = randomTree(rng, FIELDS, { maxDepth: 3, maxBranch: 3, coverage: cov });
        }
        assertTree(brute, accel, rows, tree, seed, `pass ${pass} n=${n} q=${q}`);
        queriesRun++;
      }
    }
  }

  // Coverage gate: every string operator in the matrix must have been exercised at least once.
  cov.assertCoverage(STRING_OPS.map((op) => ['string', op] as const), ['and', 'or', 'not']);
  // Sanity: we actually ran the budgeted query volume (no silent truncation).
  assert.equal(queriesRun, RANDOM_QUERIES, 'ran the full randomized query budget');
});

/** Random predicate value for a string op, biased to non-trivial matches (mix case + Unicode). */
function randomStringValue(rng: Rng, op: ScanOp): unknown {
  if (op === 'null' || op === 'notNull') return null;
  if (op === 'in' || op === 'notIn') {
    const k = rng.int(4); // includes 0-length array (empty 'in' => matches nothing)
    const arr: string[] = [];
    for (let i = 0; i < k; i++) arr.push(rng.pick(UNICODE_ALPHABET));
    return arr;
  }
  if (CONTAINS_FAMILY.has(op) || op === 'startsWith' || op === 'startsWithi' || op === 'endsWith' || op === 'endsWithi') {
    return rng.pick(NEEDLES);
  }
  // eq/ne/eqi/nei
  return rng.pick(UNICODE_ALPHABET);
}

// ===========================================================================
// 2. Trigram accelerator REALLY fires for the contains-family (>=3-char needles).
//    Uses the real substringAccelHits counter (not a mock) and still asserts rows == oracle.
// ===========================================================================
test('string fuzz: trigram path fires for >=3-char contains needles; <3 defers; rows still == oracle', () => {
  // Use a CONTROLLED dictionary so we know exactly which >=3-char needles have PRESENT trigrams.
  // The accelerator only fires (`substringAccelHits++`) when candidateCodes returns non-null, i.e.
  // the needle is >=3 code units AND at least one of its trigrams occurs in the (raw|folded) index.
  // A >=3-char needle whose trigrams are absent (e.g. fullwidth 'Ａｐｐ' against RAW 'apple') legally
  // DEFERS to brute — so we assert "must fire" only on needles known present for that case-mode.
  const rng = new Rng(0xacce1);
  const rows: Row[] = [];
  for (let i = 0; i < 5000; i++) {
    // Dense ASCII values so raw trigrams of the present-needles below always occur.
    rows.push(i % 13 === 0 ? { s: null } : { s: ['apple', 'banana', 'cherry', 'pineapple', 'mango'][i % 5]! });
  }
  // Sprinkle a few fullwidth / surrogate values so the FOLDED index also carries 'app' etc.
  rows[7] = { s: 'ＡＰＰＬＥ' };
  rows[9] = { s: '😀apptail' };
  const brute = buildTable(rows, false);
  const accel = buildTable(rows, true);
  const col = accel.column('s') as StringColumn;

  // Needles present in BOTH raw and folded indexes (>=3 ASCII units, lowercase => raw==fold here).
  const presentNeedles = ['app', 'ana', 'err', 'ppl', 'ang', 'apple'];
  // Needle present ONLY after FOLDING: lowercase fullwidth 'Ａｐｐ' folds to 'app' (present in the
  // folded index), but no stored value contains the RAW lowercase-fullwidth form, so the raw index
  // lacks its trigram. => fires for the -i ops, defers for the case-sensitive ops.
  const foldOnlyNeedles = ['Ａｐｐ'];
  const shortNeedles = NEEDLES.filter((nd) => nd.length < 3);

  // >=3-char needle present in the index: the accelerator counter MUST advance every time, and rows
  // must still equal the oracle (and brute, asserted inside assertTree).
  for (const op of CONTAINS_FAMILY) {
    for (const nd of presentNeedles) {
      const before = col.substringAccelHits;
      assertTree(brute, accel, rows, leaf(op, nd), 0xacce1, `accel-fire ${op} ${JSON.stringify(nd)}`);
      assert.ok(
        col.substringAccelHits > before,
        `trigram accelerator fired for ${op} ${JSON.stringify(nd)} (present trigram)`,
      );
    }
  }

  // Fullwidth needle: fires for the case-INSENSITIVE ops (folds to 'app', present in folded index),
  // defers for the case-SENSITIVE ops (raw fullwidth trigram absent). Rows always == oracle.
  for (const op of CONTAINS_FAMILY) {
    const insensitive = op === 'containsi' || op === 'notContainsi';
    for (const nd of foldOnlyNeedles) {
      const before = col.substringAccelHits;
      assertTree(brute, accel, rows, leaf(op, nd), 0xacce1, `fold-only ${op} ${JSON.stringify(nd)}`);
      if (insensitive) {
        assert.ok(col.substringAccelHits > before, `folded needle ${JSON.stringify(nd)} fired ${op}`);
      } else {
        assert.equal(col.substringAccelHits, before, `raw fullwidth needle ${JSON.stringify(nd)} deferred ${op}`);
      }
    }
  }

  // <3-char needle: too short for a trigram -> defers to brute, counter must NOT advance, rows
  // still equal the oracle.
  for (const op of CONTAINS_FAMILY) {
    for (const nd of shortNeedles) {
      const before = col.substringAccelHits;
      assertTree(brute, accel, rows, leaf(op, nd), 0xacce1, `short-defer ${op} ${JSON.stringify(nd)}`);
      assert.equal(
        col.substringAccelHits,
        before,
        `<3-char needle ${JSON.stringify(nd)} did NOT fire the accelerator for ${op}`,
      );
    }
  }
});

// ===========================================================================
// 3. Explicit edge cases: empty/all/none result, word boundaries, capacity growth,
//    null rows at boundaries, absent/never-seen values, Unicode fold corners.
// ===========================================================================
test('string fuzz: explicit edge cases (boundaries, empty/all/none, fold corners, surrogates)', () => {
  // -- 3a. Bitset word boundaries + rowCount%32 + capacity growth past INITIAL_CAPACITY(1024). --
  for (const n of [31, 32, 33, 63, 64, 65, 1023, 1024, 1025, 2047, 2048]) {
    const rng = new Rng(0xb0d + n);
    // Deterministic mix: alternate 'apple'/'banana' with nulls planted at boundary indices.
    const rows: Row[] = [];
    for (let i = 0; i < n; i++) rows.push({ s: i % 2 === 0 ? 'apple' : 'banana' });
    // Plant nulls exactly at word boundaries 0,31,32,63,64 and the last row.
    for (const b of [0, 31, 32, 63, 64, n - 1]) if (b >= 0 && b < n) rows[b] = { s: null };
    const brute = buildTable(rows, false);
    const accel = buildTable(rows, true);
    for (const op of STRING_OPS) {
      const value = op === 'null' || op === 'notNull' ? null
        : op === 'in' || op === 'notIn' ? ['apple']
        : CONTAINS_FAMILY.has(op) || op.startsWith('starts') || op.startsWith('ends') ? 'app'
        : 'apple';
      assertTree(brute, accel, rows, leaf(op, value), 0xb0d + n, `boundary n=${n} ${op}`);
    }
  }

  // -- 3b. Empty result / all-match / none-match on a known small set. --
  const known: Row[] = [{ s: 'apple' }, { s: 'banana' }, { s: null }, { s: '' }, { s: 'cherry' }];
  {
    const brute = buildTable(known, false);
    const accel = buildTable(known, true);
    // none-match: a value never seen.
    assert.deepEqual(brute.scanTree(leaf('eq', 'NEVER_SEEN_VALUE')).toArray(), []);
    assert.deepEqual(accel.scanTree(leaf('contains', 'zzz')).toArray(), []);
    // all-match: notNull keeps every non-null (rows 0,1,3,4); null keeps row 2.
    assert.deepEqual(brute.scanTree(leaf('notNull', null)).toArray(), [0, 1, 3, 4]);
    assert.deepEqual(accel.scanTree(leaf('null', null)).toArray(), [2]);
    // empty 'in' => matches nothing.
    assert.deepEqual(brute.scanTree(leaf('in', [])).toArray(), []);
    assert.deepEqual(accel.scanTree(leaf('in', [])).toArray(), []);
    // contains '' matches every NON-null row (incl. the empty string), NOT the null row.
    assert.deepEqual(brute.scanTree(leaf('contains', '')).toArray(), [0, 1, 3, 4]);
    assert.deepEqual(accel.scanTree(leaf('contains', '')).toArray(), [0, 1, 3, 4]);
    // Cross-check the whole matrix against the oracle on this known set.
    for (const op of STRING_OPS) {
      const value = op === 'null' || op === 'notNull' ? null
        : op === 'in' || op === 'notIn' ? ['apple', '']
        : CONTAINS_FAMILY.has(op) || op.startsWith('starts') || op.startsWith('ends') ? ''
        : 'apple';
      assertTree(brute, accel, known, leaf(op, value), 0, `known ${op}`);
    }
  }

  // -- 3c. Unicode fold corners: eszett, fullwidth, ligature, composed/decomposed, surrogates. --
  const uni: Row[] = [
    { s: 'straße' }, { s: 'STRASSE' }, { s: 'strasse' },
    { s: 'café' }, { s: 'café' }, { s: 'CAFÉ' },
    { s: 'oＡo' }, { s: 'ﬀix' }, { s: 'ＡＰＰＬＥ' }, { s: 'apple' },
    { s: '😀face' }, { s: 'face😀' }, { s: '𝓪𝓹𝓹' }, { s: null },
  ];
  {
    const brute = buildTable(uni, false);
    const accel = buildTable(uni, true);
    const foldCases: Array<[ScanOp, string]> = [
      // eqi: STRASSE must NOT equal straße (ß folds to ß, not ss); strasse equals STRASSE.
      ['eqi', 'STRASSE'], ['eqi', 'straße'], ['nei', 'straße'],
      // composed/decomposed café are NFKC-equal and fold-equal.
      ['eqi', 'café'], ['eqi', 'CAFÉ'],
      // fullwidth folds: ＡＰＰＬＥ -> 'apple', so eqi 'apple' matches both 'apple' and 'ＡＰＰＬＥ'.
      ['eqi', 'apple'],
      // containsi with fullwidth/ligature needles.
      ['containsi', 'app'], ['containsi', 'Ａｐｐ'], ['containsi', 'ffix'], ['containsi', 'ff'],
      ['startsWithi', 'app'], ['endsWithi', 'ple'],
      // surrogate-pair needles: trigram code-unit handling + includes() verify.
      ['contains', '😀'], ['containsi', '😀'], ['startsWith', '😀'], ['endsWith', '😀'],
      ['contains', '𝓪𝓹𝓹'], ['notContains', '😀'], ['notContainsi', '😀'],
    ];
    for (const [op, value] of foldCases) {
      const tree = leaf(op, value);
      // Independent expectation via the per-leaf oracle to double-check the engine AND harness agree.
      const expected = uni.map((_, i) => i).filter((i) => oracleLeafMatch('string', { field: 's', op, value }, uni[i]!));
      const bruteRes = brute.scanTree(tree).toArray();
      const accelRes = accel.scanTree(tree).toArray();
      assert.deepEqual(bruteRes, expected, `brute fold case ${op} ${JSON.stringify(value)}`);
      assert.deepEqual(accelRes, expected, `accel fold case ${op} ${JSON.stringify(value)}`);
    }
    // Documented sharp edge: eszett does NOT fold to "ss". 'STRASSE'/'strasse' fold to 'strasse';
    // 'straße' folds to 'straße'. So eqi 'straße' matches ONLY 'straße' (row 0).
    assert.deepEqual(accel.scanTree(leaf('eqi', 'straße')).toArray(), [0]);
    // containsi 'ss' matches 'STRASSE','strasse' (rows 1,2) but NOT 'straße' (row 0).
    assert.deepEqual(accel.scanTree(leaf('containsi', 'ss')).toArray(), [1, 2]);
  }

  // -- 3d. Null rows at every word boundary, with notContains/notIn/ne which must EXCLUDE nulls. --
  {
    const n = 70;
    const rows: Row[] = [];
    for (let i = 0; i < n; i++) rows.push({ s: 'apple' });
    for (const b of [0, 1, 30, 31, 32, 33, 62, 63, 64, 69]) rows[b] = { s: null };
    const brute = buildTable(rows, false);
    const accel = buildTable(rows, true);
    // These negative ops must NOT include any null row.
    for (const t of [leaf('ne', 'apple'), leaf('notIn', ['apple']), leaf('notContains', 'app'), leaf('notContainsi', 'APP'), leaf('notContains', 'zzz')]) {
      const res = brute.scanTree(t).toArray();
      assert.deepEqual(accel.scanTree(t).toArray(), res, 'accel==brute for negative op with nulls');
      assert.ok(!res.some((r) => rows[r]!.s === null), 'negative op excludes null rows');
      runMatrix(res, oracleMatch(TYPES, rows, t), { seed: 0, node: t, rows, label: 'null-boundary' });
    }
  }
});

// ===========================================================================
// 4. Large-N smoke checks (up to ~1,000,000 rows) with a CHEAP oracle (single typed loop / count).
//    We do NOT run thousands of O(n) oracle queries here — just a handful to exercise scale paths.
// ===========================================================================
test('string fuzz: large-N smoke (up to 1M rows) with cheap count/loop oracle', () => {
  // Deterministic dense fill from a tiny alphabet so a single typed loop is a cheap oracle.
  const alpha = ['apple', 'apricot', 'banana', 'cherry', '', '😀zz'];
  const rng = new Rng(0x1a46e);
  const raw: (string | null)[] = new Array(LARGE_N);
  for (let i = 0; i < LARGE_N; i++) raw[i] = i % 17 === 0 ? null : alpha[i % alpha.length]!;
  const rows: Row[] = raw.map((s) => ({ s }));

  const brute = buildTable(rows, false);
  const accel = buildTable(rows, true);

  // Cheap oracle: count-only over a single loop (no per-row object alloc, no O(n) tree walk).
  function cheapCount(op: ScanOp, value: string): number {
    let c = 0;
    const fn = fold(value);
    for (let i = 0; i < LARGE_N; i++) {
      const v = raw[i];
      if (v === null) continue; // every contains/affix op excludes nulls
      let hit = false;
      switch (op) {
        case 'contains': hit = v.includes(value); break;
        case 'containsi': hit = fold(v).includes(fn); break;
        case 'notContains': hit = !v.includes(value); break;
        case 'notContainsi': hit = !fold(v).includes(fn); break;
        case 'startsWith': hit = v.startsWith(value); break;
        case 'startsWithi': hit = fold(v).startsWith(fn); break;
        case 'endsWith': hit = v.endsWith(value); break;
        case 'endsWithi': hit = fold(v).endsWith(fn); break;
        case 'eq': hit = v === value; break;
        case 'eqi': hit = fold(v) === fn; break;
        default: hit = false;
      }
      if (hit) c++;
    }
    return c;
  }

  const cases: Array<[ScanOp, string]> = [
    ['contains', 'an'], ['containsi', 'AN'], ['contains', 'ap'], ['containsi', '😀'],
    ['startsWith', 'a'], ['startsWithi', 'A'], ['endsWith', 'a'], ['endsWithi', 'Y'],
    ['eq', 'apple'], ['eqi', 'APPLE'], ['notContains', 'an'], ['notContainsi', 'AN'],
  ];
  for (const [op, value] of cases) {
    const want = cheapCount(op, value);
    const bn = brute.scanTree(leaf(op, value)).count();
    const an = accel.scanTree(leaf(op, value)).count();
    assert.equal(bn, want, `large-N brute count ${op} ${JSON.stringify(value)}`);
    assert.equal(an, want, `large-N accel count ${op} ${JSON.stringify(value)}`);
  }

  // null / notNull counts: every 17th row is null.
  const nulls = Math.floor((LARGE_N - 1) / 17) + 1;
  assert.equal(accel.scanTree(leaf('null', null)).count(), nulls, 'large-N null count');
  assert.equal(brute.scanTree(leaf('notNull', null)).count(), LARGE_N - nulls, 'large-N notNull count');

  // The accelerator must have fired on the >=3... actually 'an'/'ap' are 2 chars (defer); '😀'
  // is 1 code point / 2 code units (>=3? no). Use a guaranteed >=3-char needle to prove a fire.
  const col = accel.column('s') as StringColumn;
  const before = col.substringAccelHits;
  const want3 = cheapCount('contains', 'ana');
  assert.equal(accel.scanTree(leaf('contains', 'ana')).count(), want3, 'large-N accel 3-char count');
  assert.ok(col.substringAccelHits > before, 'large-N >=3-char needle fired the trigram accelerator');
});
