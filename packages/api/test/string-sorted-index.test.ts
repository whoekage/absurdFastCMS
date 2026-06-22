import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef } from '../src/store/table.ts';

/**
 * be-22c — string ORDER BY via the dict-rank StringSortedIndex. NO mocks: everything drives the real
 * Table/StringColumn/StringSortedIndex, and the ORACLE is the engine's OWN brute comparator path — a
 * second Table with NO sorted index on the string column, so `query()` falls to `Table.comparator`
 * (plain JS `<`/`>` on the decoded string + V8 stable Array.sort over the ascending-row-id match seed).
 * The indexed path MUST return the rows in the SAME VISIBLE ORDER (value sequence) as that brute path
 * — the live oracle the whole sort suite is pinned to (see sorted-index.test.ts). The dict-rank index
 * reuses the numeric sorted index's radix + reverse-walk verbatim, so it is BYTE-IDENTICAL to the
 * numeric sorted index, which IS the engine's real ORDER BY oracle.
 *
 * The CARDINAL INVARIANT: comparator (UTF-16 code-unit `<`/`>`, no fold/locale), NULL placement (a
 * NULL row stores the reserved `''` sentinel, so it sorts where the empty string sorts — first ASC,
 * last DESC), and tie-break: ASC keeps ascending row id (both engines agree, so the row-id permutation
 * is identical); DESC reverse-walks the ASC permutation => DESCENDING row id on ties. That DESC-tie
 * row-id order is the numeric sorted index's OWN accepted semantics — it diverges from the brute
 * comparator (which keeps ascending row id on a 0-compare), a PRE-EXISTING divergence the numeric
 * suite documents (sorted-index.test.ts:162-166, 210-212: equivalence asserted by VALUE sequence,
 * "ties may pick a different stable row id between the two sort engines"). The string index inherits
 * the IDENTICAL machinery, so it matches the numeric index, NOT a textbook stable brute desc. We
 * therefore assert VALUE-sequence equivalence to brute, plus exact-permutation where both agree (ASC),
 * plus the explicit numeric-index tie-break order on the all-ties case.
 */

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const FIELDS: FieldDef[] = [
  { name: 'id', type: 'i32' },
  { name: 'title', type: 'string' },
  { name: 'category', type: 'string' },
];

/** Build two tables over the SAME rows: `indexed` has the string sorted index, `oracle` does not. */
function buildPair(rows: Array<Record<string, unknown>>): { indexed: Table; oracle: Table } {
  const indexed = new Table(FIELDS);
  const oracle = new Table(FIELDS);
  indexed.createSortedIndex('title');
  indexed.createSortedIndex('category');
  for (const r of rows) {
    indexed.insert(r);
    oracle.insert(r);
  }
  indexed.warmIndexes();
  return { indexed, oracle };
}

/** The brute oracle order: the unindexed table's `query()` (its comparator fallback path). */
function oracleOrder(t: Table, field: string, dir: 'asc' | 'desc', offset: number, limit: number): number[] {
  return t.query({ sort: [{ field, dir }], offset, limit });
}

/** Decode each row id of `field` to its stored string — the VISIBLE value sequence a client sees. */
function values(t: Table, field: string, ids: number[]): string[] {
  const col = t.column(field);
  return ids.map((r) => col.at(r));
}

const UNICODE_POOL = [
  '', // empty string — sorts with the NULL sentinel
  'apple',
  'Apple',
  'APPLE',
  'banana',
  'Banana',
  'Æther', // mixed-case + astral-adjacent
  'zebra',
  'Zebra',
  'café',
  'cafe',
  'École',
  'élan',
  'É',
  'é',
  'è',
  '日本語',
  '🍎apple', // astral (surrogate pair) — exercises UTF-16 code-unit order
  '🍏pear',
  'ÀÀÀ',
];

function unicodeRows(n: number, seed: number): Array<Record<string, unknown>> {
  const rng = lcg(seed);
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i++) {
    const roll = rng();
    let title: string | null;
    if (roll < 0.1) title = null; // ~10% NULL
    else if (roll < 0.4) title = UNICODE_POOL[(i * 7) % UNICODE_POOL.length]!; // repeated => ties
    else title = `t-${(Math.imul(i, 2654435761) >>> 0).toString(36)}-${i % 3 === 0 ? 'Æ' : i % 3 === 1 ? 'z' : 'A'}`;
    const category = rng() < 0.05 ? null : `cat-${(Math.imul(i, 40503) >>> 0) % 12}`;
    out.push({ id: i, title, category });
  }
  return out;
}

// --- Core invariant: indexed order == brute oracle order, asc + desc, both columns ----------------

test('ORDER BY a string column returns the SAME visible value order as the brute comparator', () => {
  const rows = unicodeRows(3000, 11);
  const { indexed, oracle } = buildPair(rows);
  for (const field of ['title', 'category'] as const) {
    // ASC: both engines keep ascending row id on ties => the row-id PERMUTATION is byte-identical.
    const asc = indexed.query({ sort: [{ field, dir: 'asc' }], limit: rows.length });
    const ascWant = oracleOrder(oracle, field, 'asc', 0, rows.length);
    assert.deepEqual(asc, ascWant, `${field}/asc full permutation byte-identical to brute`);

    // DESC: value sequence is identical; row ids may differ on ties (the numeric sorted index's own
    // accepted semantics — reverse-walk gives descending row id). Assert the VISIBLE order.
    const desc = indexed.query({ sort: [{ field, dir: 'desc' }], limit: rows.length });
    const descWant = oracleOrder(oracle, field, 'desc', 0, rows.length);
    assert.deepEqual(
      values(indexed, field, desc),
      values(oracle, field, descWant),
      `${field}/desc visible value sequence matches brute`,
    );
    // And it IS globally non-increasing by value (a real total order, not just a coincidence).
    const seq = values(indexed, field, desc);
    for (let i = 1; i < seq.length; i++) assert.ok(seq[i]! <= seq[i - 1]!, `${field}/desc non-increasing`);
  }
});

test('NULLs sort where the empty-string sentinel sorts: FIRST on asc, LAST on desc (matches comparator)', () => {
  const rows = unicodeRows(2000, 22);
  const { indexed, oracle } = buildPair(rows);
  const nullIds = rows.filter((r) => r.title === null).map((r) => r.id as number);
  assert.ok(nullIds.length > 0, 'fixture has NULL titles');

  // ASC: the run of NULL rows + genuine '' rows occupies the FRONT of the result, exactly as the
  // comparator places them (it reads col.at(row) === '' for a null row, never the null bitset). Both
  // engines agree on ascending ties, so the permutation is byte-identical.
  const asc = indexed.query({ sort: [{ field: 'title', dir: 'asc' }], limit: rows.length });
  const ascOracle = oracleOrder(oracle, 'title', 'asc', 0, rows.length);
  assert.deepEqual(asc, ascOracle, 'asc full order incl. null placement matches brute');

  // DESC: NULLs (== '') sort LAST. Visible value sequence matches brute (ties may pick a different row).
  const desc = indexed.query({ sort: [{ field: 'title', dir: 'desc' }], limit: rows.length });
  const descOracle = oracleOrder(oracle, 'title', 'desc', 0, rows.length);
  assert.deepEqual(
    values(indexed, 'title', desc),
    values(oracle, 'title', descOracle),
    'desc visible value sequence incl. null placement matches brute',
  );
  // The trailing block on DESC is exactly the empty-string/NULL rows.
  for (let i = desc.length - nullIds.length; i < desc.length; i++) {
    assert.equal(indexed.column('title').at(desc[i]!), '', 'desc trailing block is empty-string/NULL');
  }

  // Sanity: every NULL row decodes to '' and they form a contiguous block at the front (asc) / back (desc).
  const isEmptyOrNull = (row: number): boolean => indexed.column('title').at(row) === '';
  let i = 0;
  while (i < asc.length && isEmptyOrNull(asc[i]!)) i++;
  assert.ok(i >= nullIds.length, 'all NULL rows are in the leading empty-string block on asc');
});

test('deep OFFSET into a string sort returns the identical page as the brute oracle (asc + desc)', () => {
  const rows = unicodeRows(5000, 33);
  const { indexed, oracle } = buildPair(rows);
  for (const offset of [0, 25, 1234, 4990]) {
    // ASC: exact page (row ids identical — both engines stable-ascending on ties).
    const asc = indexed.query({ sort: [{ field: 'title', dir: 'asc' }], offset, limit: 25 });
    assert.deepEqual(asc, oracleOrder(oracle, 'title', 'asc', offset, 25), `title/asc offset ${offset} exact page`);
    // DESC: visible value sequence identical (numeric-index tie-break may pick a different row id).
    const desc = indexed.query({ sort: [{ field: 'title', dir: 'desc' }], offset, limit: 25 });
    assert.deepEqual(
      values(indexed, 'title', desc),
      values(oracle, 'title', oracleOrder(oracle, 'title', 'desc', offset, 25)),
      `title/desc offset ${offset} visible page`,
    );
  }
});

test('ties (repeated strings) break by ASCENDING row id on asc, DESCENDING on desc — same as numeric index', () => {
  // All-equal column => pure tie-break observation. Numeric sorted-index semantics: asc keeps the
  // ascending row-id seed; desc reverse-walks it => descending row id. The brute comparator returns 0
  // on ties and V8 stable-sorts the ascending match seed (asc) / the engine reverse-walk (desc).
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 200; i++) rows.push({ id: i, title: 'same', category: 'x' });
  const { indexed, oracle } = buildPair(rows);

  // ASC: index AND brute both keep ascending row id (V8 stable over the ascending match seed).
  const asc = indexed.query({ sort: [{ field: 'title', dir: 'asc' }], limit: rows.length });
  assert.deepEqual(asc, oracleOrder(oracle, 'title', 'asc', 0, rows.length), 'asc tie-break matches brute');
  assert.deepEqual(asc, [...Array(200).keys()], 'asc ties == ascending row id');

  // DESC: the dict-rank index reverse-walks the ASC permutation => DESCENDING row id, the SAME as the
  // numeric sorted index (verified: numeric idx DESC on all-equal rows yields 9..0). This is the
  // engine's accepted DESC-tie semantics and DIVERGES from the brute comparator (which would keep
  // ascending) — exactly the pre-existing, documented numeric-index divergence.
  const desc = indexed.query({ sort: [{ field: 'title', dir: 'desc' }], limit: rows.length });
  assert.deepEqual(desc, [...Array(200).keys()].reverse(), 'desc ties == descending row id (numeric-index semantics)');

  // Cross-check the numeric sorted index produces the IDENTICAL descending-row-id order on all-equal
  // rows, proving the string index is byte-identical to it (the real oracle).
  const numeric = new Table([{ name: 'id', type: 'i32' }, { name: 'n', type: 'i32' }]);
  numeric.createSortedIndex('n');
  for (let i = 0; i < 200; i++) numeric.insert({ id: i, n: 7 });
  numeric.warmIndexes();
  assert.deepEqual(
    numeric.query({ sort: [{ field: 'n', dir: 'desc' }], limit: 200 }),
    desc,
    'string index DESC tie order == numeric index DESC tie order',
  );
});

// --- Rebuild-on-write keeps the order correct ----------------------------------------------------

test('an insert that adds a NEW distinct string rebuilds the index and keeps the order correct', () => {
  const rows = unicodeRows(800, 44);
  const { indexed, oracle } = buildPair(rows);
  assert.equal(indexed.hasDirtyIndex(), false, 'clean after warm');

  // Insert rows whose titles shift ranks: a string that sorts BEFORE everything, one in the MIDDLE,
  // one AFTER, plus a NULL — each on both tables.
  const extra: Array<Record<string, unknown>> = [
    { id: 9001, title: '-front', category: 'cat-0' }, // sorts near the very front
    { id: 9002, title: 'mmmm-middle', category: 'cat-5' },
    { id: 9003, title: '￿-back', category: 'cat-9' }, // sorts at the very back
    { id: 9004, title: null, category: null },
  ];
  for (const r of extra) {
    indexed.insert(r);
    oracle.insert(r);
  }
  assert.equal(indexed.hasDirtyIndex(), true, 'insert re-dirtied the string index');

  const total = rows.length + extra.length;
  // ASC: exact permutation. DESC: visible value sequence (numeric-index tie-break).
  const asc = indexed.query({ sort: [{ field: 'title', dir: 'asc' }], limit: total });
  assert.deepEqual(asc, oracleOrder(oracle, 'title', 'asc', 0, total), 'post-insert asc exact (index rebuilt)');
  const desc = indexed.query({ sort: [{ field: 'title', dir: 'desc' }], limit: total });
  assert.deepEqual(
    values(indexed, 'title', desc),
    values(oracle, 'title', oracleOrder(oracle, 'title', 'desc', 0, total)),
    'post-insert desc visible value sequence (index rebuilt)',
  );
  // The new distinct strings are present and ordered (proven by the value-sequence equality above);
  // spot-check they were ranked into the result at all (a rebuild that ignored them would drop them).
  const ascTitles = values(indexed, 'title', asc);
  for (const s of ['-front', 'mmmm-middle', '￿-back']) {
    assert.ok(ascTitles.includes(s), `new distinct string ${JSON.stringify(s)} present after rebuild`);
  }
  // The next read rebuilt it; warming now reports clean.
  indexed.warmIndexes();
  assert.equal(indexed.hasDirtyIndex(), false, 'clean after re-warm');
});

// --- Numeric sort is NOT regressed (the string index is additive) --------------------------------

test('numeric ORDER BY still uses the numeric sorted index and is unchanged by the string path', () => {
  const N = 1500;
  const fields: FieldDef[] = [
    { name: 'id', type: 'i32' },
    { name: 'n', type: 'i32' },
    { name: 'label', type: 'string' },
  ];
  const indexed = new Table(fields);
  const oracle = new Table(fields);
  indexed.createSortedIndex('n'); // numeric
  indexed.createSortedIndex('label'); // string — must not interfere with the numeric path
  const rng = lcg(55);
  const ns: number[] = [];
  for (let i = 0; i < N; i++) {
    const n = Math.floor(rng() * 4000) - 2000;
    ns.push(n);
    const row = { id: i, n, label: `l-${i % 50}` };
    indexed.insert(row);
    oracle.insert(row);
  }
  indexed.warmIndexes();
  for (const dir of ['asc', 'desc'] as const) {
    const got = indexed.query({ sort: [{ field: 'n', dir }], offset: 7, limit: 40 });
    const want = oracle.query({ sort: [{ field: 'n', dir }], offset: 7, limit: 40 });
    // Identical value sequence (the numeric index's accepted equivalence; ties may pick a different
    // stable row id between engines — exactly as sorted-index.test.ts:210-212 documents).
    assert.deepEqual(got.map((r) => ns[r]!), want.map((r) => ns[r]!), `numeric ${dir} unchanged`);
  }
});

// --- Speed: the indexed path is dramatically faster than the brute baseline at large N ------------

test('large-N string ORDER BY is dramatically faster via the index than the brute comparator', () => {
  // Large enough that the brute O(n log n) string comparator is clearly measurable, while the indexed
  // page is sub-page-size work after a one-time build. We compare a WARM indexed page (the steady
  // state the engine serves) against a single brute sort of the same N (the old Finding #5 path).
  const N = 200_000;
  const rng = lcg(66);
  const indexed = new Table(FIELDS);
  const brute = new Table(FIELDS);
  indexed.createSortedIndex('title');
  for (let i = 0; i < N; i++) {
    const title = rng() < 0.08 ? null : `Article ${i} about ${(rng() * 9000) | 0} topic ${(rng() * 9000) | 0}`;
    const row = { id: i, title, category: `cat-${i % 20}` };
    indexed.insert(row);
    brute.insert(row);
  }
  indexed.warmIndexes(); // pay the one-time build up front (the rare-write CMS profile)

  // Correctness first (the hard gate): the fast page equals the brute page.
  const fastPage = indexed.query({ sort: [{ field: 'title', dir: 'asc' }], limit: 25 });
  const brutePage = brute.query({ sort: [{ field: 'title', dir: 'asc' }], limit: 25 });
  assert.deepEqual(fastPage, brutePage, 'fast page == brute page at large N');

  // Time a warm indexed page.
  const tFastStart = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) indexed.query({ sort: [{ field: 'title', dir: 'asc' }], limit: 25 });
  const fastMs = Number(process.hrtime.bigint() - tFastStart) / 1e6 / 50;

  // Time ONE brute sort+page (the unindexed comparator path — Finding #5).
  const tBruteStart = process.hrtime.bigint();
  brute.query({ sort: [{ field: 'title', dir: 'asc' }], limit: 25 });
  const bruteMs = Number(process.hrtime.bigint() - tBruteStart) / 1e6;

  // The indexed page must be at least an order of magnitude faster than one brute sort. (In practice
  // it is ~1000x+; 10x is a generous, non-flaky floor that still proves the defect is fixed.)
  assert.ok(
    fastMs * 10 < bruteMs,
    `indexed page (${fastMs.toFixed(4)} ms) must be >=10x faster than brute (${bruteMs.toFixed(1)} ms)`,
  );
});
