import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef, type Predicate } from '../src/store/table.ts';

// Deterministic pseudo-randomness (seeded LCG) — no Math.random, mirrors slice0/btree precedent.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// A row in the oracle: a plain object whose field is either a real value or `null` (NULL).
type OracleRow = Record<string, number | string | boolean | null>;

/**
 * Brute-force leaf oracle implementing three-valued logic.
 *
 * The contract under test: any comparison op against a NULL field is "unknown" and therefore
 * NEVER matches (both positive ops like $eq and negative ops like $ne/$notIn). $null/$notNull
 * are the only ops that read the null-ness itself.
 */
function leafMatch(p: Predicate, row: OracleRow): boolean {
  const v = row[p.field]!;
  const isNull = v === null;
  switch (p.op) {
    case 'null':
      return isNull;
    case 'notNull':
      return !isNull;
    default:
      break;
  }
  // Every comparison op: NULL is unknown, never a match.
  if (isNull) return false;
  const t = p.value;
  switch (p.op) {
    case 'eq':
    case 'eqi':
      return v === t;
    case 'ne':
    case 'nei':
      return v !== t;
    case 'gt': return (v as number) > (t as number);
    case 'gte': return (v as number) >= (t as number);
    case 'lt': return (v as number) < (t as number);
    case 'lte': return (v as number) <= (t as number);
    case 'in': return (t as unknown[]).includes(v);
    case 'notIn': return !(t as unknown[]).includes(v);
    default:
      throw new Error(`oracle has no case for op "${p.op}"`);
  }
}

function oracle(rows: OracleRow[], p: Predicate): number[] {
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) if (leafMatch(p, rows[i]!)) out.push(i);
  return out;
}

// --- $in / $notIn over a NUMERIC column (with nulls) ----------------------

test('$in / $notIn over a numeric column match a three-valued-logic oracle', () => {
  const t = new Table([{ name: 'n', type: 'i32' }]);
  const rows: OracleRow[] = [];
  const rng = lcg(11);
  const N = 1300; // past INITIAL_CAPACITY (1024) and across many 32-bit word boundaries
  for (let i = 0; i < N; i++) {
    if (rng() < 0.25) {
      t.insert({ n: null });
      rows.push({ n: null });
    } else {
      const v = Math.floor(rng() * 20); // includes 0, the sentinel-colliding value
      t.insert({ n: v });
      rows.push({ n: v });
    }
  }

  const sets: number[][] = [
    [],                 // empty IN list => $in none, $notIn all-non-null
    [0],                // 0 collides with the NULL sentinel — nulls must stay excluded
    [3, 7, 19],
    [1000, 2000],       // values entirely absent from the column
    [0, 5, 10, 999],
  ];
  for (const set of sets) {
    for (const op of ['in', 'notIn'] as const) {
      const p: Predicate = { field: 'n', op, value: set };
      assert.deepEqual(t.scan([p]).toArray(), oracle(rows, p), `n ${op} [${set}]`);
    }
  }
});

// --- $in / $notIn over a STRING column (with nulls) -----------------------

test('$in / $notIn over a string column match a three-valued-logic oracle', () => {
  const VALUES = ['draft', 'published', 'archived', 'review', ''];
  const t = new Table([{ name: 's', type: 'string' }]);
  const rows: OracleRow[] = [];
  const rng = lcg(29);
  const N = 1100;
  for (let i = 0; i < N; i++) {
    if (rng() < 0.25) {
      t.insert({ s: null });
      rows.push({ s: null });
    } else {
      const v = VALUES[Math.floor(rng() * VALUES.length)]!; // includes '' — sentinel-colliding
      t.insert({ s: v });
      rows.push({ s: v });
    }
  }

  const sets: string[][] = [
    [],                            // empty
    [''],                          // '' collides with the NULL sentinel — nulls excluded
    ['published'],
    ['draft', 'archived'],
    ['nope', 'missing'],           // entirely absent from the dictionary
    ['', 'published', 'absent'],
  ];
  for (const set of sets) {
    for (const op of ['in', 'notIn'] as const) {
      const p: Predicate = { field: 's', op, value: set };
      assert.deepEqual(t.scan([p]).toArray(), oracle(rows, p), `s ${op} [${set}]`);
    }
  }
});

// --- CRITICAL sentinel tests ----------------------------------------------

test('$eq 0 on a numeric column does NOT match NULL rows (sentinel 0)', () => {
  const t = new Table([{ name: 'n', type: 'i32' }]);
  const rows: OracleRow[] = [];
  // Deliberately interleave real-0 rows with null rows across word boundaries.
  const nullRows = new Set([1, 31, 32, 33, 63, 64, 100]);
  const N = 130;
  for (let i = 0; i < N; i++) {
    if (nullRows.has(i)) {
      t.insert({ n: null });
      rows.push({ n: null });
    } else {
      // Half the non-null rows are a genuine 0 (the value that collides with the sentinel).
      const v = i % 2 === 0 ? 0 : i;
      t.insert({ n: v });
      rows.push({ n: v });
    }
  }
  const p: Predicate = { field: 'n', op: 'eq', value: 0 };
  const got = t.scan([p]).toArray();
  assert.deepEqual(got, oracle(rows, p));
  // No null row leaked in.
  for (const r of got) assert.equal(t.isNull('n', r), false, `row ${r} must not be null`);
});

test("$eq '' on a string column does NOT match NULL rows (sentinel '')", () => {
  const t = new Table([{ name: 's', type: 'string' }]);
  const rows: OracleRow[] = [];
  const nullRows = new Set([0, 31, 32, 64, 70]);
  const N = 100;
  for (let i = 0; i < N; i++) {
    if (nullRows.has(i)) {
      t.insert({ s: null });
      rows.push({ s: null });
    } else {
      const v = i % 2 === 0 ? '' : `v${i}`; // genuine empty strings collide with the sentinel
      t.insert({ s: v });
      rows.push({ s: v });
    }
  }
  const p: Predicate = { field: 's', op: 'eq', value: '' };
  const got = t.scan([p]).toArray();
  assert.deepEqual(got, oracle(rows, p));
  for (const r of got) assert.equal(t.isNull('s', r), false, `row ${r} must not be null`);
});

test('$ne 5 and $notIn EXCLUDE null rows (three-valued logic)', () => {
  const t = new Table([{ name: 'n', type: 'i32' }]);
  const rows: OracleRow[] = [];
  const rng = lcg(43);
  const N = 1050;
  for (let i = 0; i < N; i++) {
    if (rng() < 0.3) {
      t.insert({ n: null });
      rows.push({ n: null });
    } else {
      const v = Math.floor(rng() * 10);
      t.insert({ n: v });
      rows.push({ n: v });
    }
  }
  const ne: Predicate = { field: 'n', op: 'ne', value: 5 };
  const notIn: Predicate = { field: 'n', op: 'notIn', value: [5, 3] };
  for (const p of [ne, notIn]) {
    const got = t.scan([p]).toArray();
    assert.deepEqual(got, oracle(rows, p), p.op);
    for (const r of got) assert.equal(t.isNull('n', r), false, `${p.op}: row ${r} must not be null`);
  }
});

test('$ne on a string column excludes null rows whose sentinel is the empty string', () => {
  const t = new Table([{ name: 's', type: 'string' }]);
  const rows: OracleRow[] = [];
  const rng = lcg(57);
  const N = 600;
  const VALUES = ['a', 'b', 'c', ''];
  for (let i = 0; i < N; i++) {
    if (rng() < 0.3) {
      t.insert({ s: null });
      rows.push({ s: null });
    } else {
      const v = VALUES[Math.floor(rng() * VALUES.length)]!;
      t.insert({ s: v });
      rows.push({ s: v });
    }
  }
  // $ne 'a' must keep real '' rows but drop NULL rows (whose sentinel is also '').
  const p: Predicate = { field: 's', op: 'ne', value: 'a' };
  const got = t.scan([p]).toArray();
  assert.deepEqual(got, oracle(rows, p));
  for (const r of got) assert.equal(t.isNull('s', r), false, `row ${r} must not be null`);
});

// --- $null / $notNull -----------------------------------------------------

test('$null returns exactly the null rows and $notNull exactly the rest', () => {
  const t = new Table([
    { name: 'n', type: 'i32' },
    { name: 's', type: 'string' },
  ]);
  const rng = lcg(71);
  const nNull: boolean[] = [];
  const sNull: boolean[] = [];
  const N = 1090; // past capacity + word boundaries
  for (let i = 0; i < N; i++) {
    const nIsNull = rng() < 0.5;
    const sIsNull = rng() < 0.5;
    nNull.push(nIsNull);
    sNull.push(sIsNull);
    t.insert({ n: nIsNull ? null : 0, s: sIsNull ? null : '' }); // sentinel-colliding values
  }

  const expectN: number[] = [];
  const expectNotN: number[] = [];
  for (let i = 0; i < N; i++) (nNull[i] ? expectN : expectNotN).push(i);
  assert.deepEqual(t.scan([{ field: 'n', op: 'null', value: undefined }]).toArray(), expectN);
  assert.deepEqual(t.scan([{ field: 'n', op: 'notNull', value: undefined }]).toArray(), expectNotN);

  // $null + $notNull partition the row space exactly.
  assert.equal(expectN.length + expectNotN.length, N);

  // A second field is independent.
  const expectS: number[] = [];
  for (let i = 0; i < N; i++) if (sNull[i]) expectS.push(i);
  assert.deepEqual(t.scan([{ field: 's', op: 'null', value: undefined }]).toArray(), expectS);
});

test('$null / $notNull on a column that never saw a null', () => {
  const t = new Table([{ name: 'n', type: 'i32' }]);
  const N = 200;
  for (let i = 0; i < N; i++) t.insert({ n: i });
  assert.equal(t.scan([{ field: 'n', op: 'null', value: undefined }]).count(), 0);
  assert.equal(t.scan([{ field: 'n', op: 'notNull', value: undefined }]).count(), N);
});

// --- combining null-aware leaves with AND / OR / NOT ----------------------

test('$notNull AND a range stays null-correct (no null leaks through the AND)', () => {
  const t = new Table([{ name: 'n', type: 'i32' }]);
  const rows: OracleRow[] = [];
  const rng = lcg(83);
  const N = 800;
  for (let i = 0; i < N; i++) {
    if (rng() < 0.4) {
      t.insert({ n: null });
      rows.push({ n: null });
    } else {
      const v = Math.floor(rng() * 100);
      t.insert({ n: v });
      rows.push({ n: v });
    }
  }
  const gte: Predicate = { field: 'n', op: 'gte', value: 50 };
  // Range alone is already null-correct; AND-ing $notNull must not change that.
  const expected = oracle(rows, gte);
  const viaAnd = t
    .scanTree({
      op: 'and',
      children: [{ leaf: gte }, { leaf: { field: 'n', op: 'notNull', value: undefined } }],
    })
    .toArray();
  assert.deepEqual(viaAnd, expected);
  assert.deepEqual(t.scan([gte]).toArray(), expected);
});

// --- indexed vs non-indexed equivalence (null masking on the index paths) -

test('null masking is identical on the hash/sorted index paths and the scan path', () => {
  const FIELDS: FieldDef[] = [
    { name: 'price', type: 'f64' },
    { name: 'status', type: 'string' },
  ];
  const rng = lcg(101);
  const N = 1400;
  const plain = new Table(FIELDS);
  const indexed = new Table(FIELDS);
  indexed.createHashIndex('status');
  indexed.createSortedIndex('price');

  const rows: OracleRow[] = [];
  const STATUSES = ['draft', 'published', 'archived', ''];
  for (let i = 0; i < N; i++) {
    const priceNull = rng() < 0.2;
    const statusNull = rng() < 0.2;
    const price = priceNull ? null : Math.floor(rng() * 200); // includes 0
    const status = statusNull ? null : STATUSES[Math.floor(rng() * STATUSES.length)]!;
    const row = { price, status };
    rows.push(row);
    const insertRow: Record<string, unknown> = {};
    if (!priceNull) insertRow.price = price;
    if (!statusNull) insertRow.status = status;
    plain.insert(insertRow);
    indexed.insert(insertRow);
  }

  const preds: Predicate[] = [
    { field: 'status', op: 'eq', value: 'published' }, // hash-index path
    { field: 'status', op: 'eq', value: '' },          // hash-index path, sentinel-colliding
    { field: 'status', op: 'ne', value: 'draft' },
    { field: 'status', op: 'in', value: ['published', 'archived'] },
    { field: 'status', op: 'notIn', value: ['draft'] },
    { field: 'status', op: 'null', value: undefined },
    { field: 'status', op: 'notNull', value: undefined },
    { field: 'price', op: 'gte', value: 50 },          // sorted-index path
    { field: 'price', op: 'lt', value: 50 },
    { field: 'price', op: 'eq', value: 0 },             // sentinel-colliding
    { field: 'price', op: 'null', value: undefined },
    { field: 'price', op: 'notNull', value: undefined },
  ];
  for (const p of preds) {
    const expected = oracle(rows, p);
    assert.deepEqual(plain.scan([p]).toArray(), expected, `plain ${p.field} ${p.op}`);
    assert.deepEqual(indexed.scan([p]).toArray(), expected, `indexed ${p.field} ${p.op}`);
  }
});

// --- StringColumn no longer throws on the extended operator surface --------

test('string column resolves the extended operator surface without throwing', () => {
  const t = new Table([{ name: 's', type: 'string' }]);
  const data = ['Apple', 'banana', 'Cherry', 'apple pie', 'BANANA bread', ''];
  const rows: OracleRow[] = [];
  for (const s of data) {
    t.insert({ s });
    rows.push({ s });
  }
  t.insert({ s: null });
  rows.push({ s: null });

  // Every one of these previously threw; now they resolve (brute fallback) and stay null-correct.
  const cases: { p: Predicate; want: number[] }[] = [
    { p: { field: 's', op: 'contains', value: 'an' }, want: [1] },
    { p: { field: 's', op: 'containsi', value: 'APPLE' }, want: [0, 3] },
    { p: { field: 's', op: 'startsWith', value: 'app' }, want: [3] },
    { p: { field: 's', op: 'startsWithi', value: 'app' }, want: [0, 3] },
    { p: { field: 's', op: 'endsWith', value: 'a' }, want: [1] },
    { p: { field: 's', op: 'endsWithi', value: 'A' }, want: [1] },
    { p: { field: 's', op: 'eqi', value: 'apple' }, want: [0] },
    { p: { field: 's', op: 'nei', value: 'apple' }, want: [1, 2, 3, 4, 5] }, // not the null row
  ];
  for (const { p, want } of cases) {
    assert.deepEqual(t.scan([p]).toArray(), want, `${p.op} ${String(p.value)}`);
  }
});
