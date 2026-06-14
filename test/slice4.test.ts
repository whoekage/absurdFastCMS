import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef, type Predicate } from '../src/store/table.ts';

/**
 * Slice 4 — CSR equality index + cardinality gate.
 *
 * Doctrine: NO mocks. Every expectation is computed by a trivial O(n) brute-force oracle over
 * the inserted rows, and cross-checked against BOTH the indexed engine and the plain (no-index)
 * engine — the index must be a transparent accelerator, never change a result. The cardinality
 * gate is asserted via the real `eqStrategy()` introspection hook (real built state, not a mock).
 */

// Deterministic pseudo-random source (seeded LCG) — no Math.random, per the testing doctrine.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904229) >>> 0;
    return s / 0x100000000;
  };
}

const FIELDS: FieldDef[] = [
  { name: 'status', type: 'string' }, // ~3-4 distinct => low-card => 'plane'
  { name: 'stock', type: 'i32' }, //    ~500 distinct => medium => 'csr'
  { name: 'slug', type: 'string' }, //  ~n distinct => near-unique => 'dict'
  { name: 'active', type: 'bool' }, //  2 distinct => always 'plane'
];

interface OracleRow {
  status: string | null;
  stock: number | null;
  slug: string | null;
  active: boolean | null;
}

const STATUSES = ['draft', 'published', 'archived'];

/**
 * Build two tables (plain + indexed) over the SAME deterministic rows, and the parallel oracle
 * row array. `nulls` toggles whether ~15% of each field is dropped (missing -> NULL).
 */
function buildTriple(n: number, nulls: boolean): {
  plain: Table;
  indexed: Table;
  rows: OracleRow[];
} {
  const rng = lcg(0xC5A4);
  const plain = new Table(FIELDS);
  const indexed = new Table(FIELDS);
  // Create indexes BEFORE inserting so live `add` maintenance + lazy rebuild are exercised.
  indexed.createHashIndex('status'); // old alias, must still work
  indexed.createEqIndex('stock');
  indexed.createEqIndex('slug');
  indexed.createEqIndex('active');

  const rows: OracleRow[] = [];
  for (let i = 0; i < n; i++) {
    const statusNull = nulls && rng() < 0.15;
    const stockNull = nulls && rng() < 0.15;
    const slugNull = nulls && rng() < 0.15;
    const activeNull = nulls && rng() < 0.15;

    const status = statusNull ? null : STATUSES[Math.floor(rng() * STATUSES.length)]!;
    const stock = stockNull ? null : Math.floor(rng() * 500); // ~500 distinct
    const slug = slugNull ? null : `slug-${i}`; // unique per row => near-unique
    const active = activeNull ? null : rng() < 0.5;

    rows.push({ status, stock, slug, active });

    const insertRow: Record<string, unknown> = {};
    if (!statusNull) insertRow.status = status;
    if (!stockNull) insertRow.stock = stock;
    if (!slugNull) insertRow.slug = slug;
    if (!activeNull) insertRow.active = active;
    plain.insert(insertRow);
    indexed.insert(insertRow);
  }
  return { plain, indexed, rows };
}

/** Brute-force oracle: row ids where `field` equals `value` (NULL never equals anything). */
function oracleEq(rows: OracleRow[], field: keyof OracleRow, value: unknown): number[] {
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i]![field];
    if (v !== null && v === value) out.push(i);
  }
  return out;
}

/** Brute-force oracle: row ids where `field` is in `values` (NULL is never a member). */
function oracleIn(rows: OracleRow[], field: keyof OracleRow, values: unknown[]): number[] {
  const set = new Set(values);
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i]![field];
    if (v !== null && set.has(v)) out.push(i);
  }
  return out;
}

function eqResult(t: Table, field: string, value: unknown): number[] {
  return t.scan([{ field, op: 'eq', value } as Predicate]).toArray();
}
function inResult(t: Table, field: string, values: unknown[]): number[] {
  return t.scan([{ field, op: 'in', value: values } as Predicate]).toArray();
}

// --- the cardinality gate picks the right structure -------------------------

test('cardinality gate: planes ONLY for low-card / bool, CSR for medium, dict for near-unique', () => {
  const { indexed } = buildTriple(5000, false);
  // status ~3 distinct over 3000 rows => 3/3000 < 1/1000 => dense planes.
  assert.equal(indexed.eqStrategy('status'), 'plane');
  // bool: cardinality 2, textbook dense-plane tier.
  assert.equal(indexed.eqStrategy('active'), 'plane');
  // stock ~500 distinct over 3000 rows => not low-card, not near-unique => CSR (no planes).
  assert.equal(indexed.eqStrategy('stock'), 'csr');
  // slug unique per row => c/n ~ 1 > 0.5 => dict (the Map is the index, no plane blowup).
  assert.equal(indexed.eqStrategy('slug'), 'dict');
});

test('cardinality gate: same classification holds with NULL-bearing rows', () => {
  const { indexed } = buildTriple(5000, true);
  assert.equal(indexed.eqStrategy('status'), 'plane');
  assert.equal(indexed.eqStrategy('active'), 'plane');
  assert.equal(indexed.eqStrategy('stock'), 'csr');
  assert.equal(indexed.eqStrategy('slug'), 'dict');
});

// --- $eq equivalence across every tier, with and without nulls --------------

for (const nulls of [false, true]) {
  const label = nulls ? 'with NULLs' : 'no NULLs';

  test(`$eq equivalence (${label}): index == brute == plain-scan across all tiers`, () => {
    const { plain, indexed, rows } = buildTriple(2600, nulls);

    // Low-card 'plane' tier (status) — include a never-seen value and the '' sentinel.
    for (const v of [...STATUSES, 'nope', '']) {
      const oracle = oracleEq(rows, 'status', v);
      assert.deepEqual(eqResult(indexed, 'status', v), oracle, `status=${v} index`);
      assert.deepEqual(eqResult(plain, 'status', v), oracle, `status=${v} plain`);
    }

    // Medium-card 'csr' tier (stock) — sweep a spread of codes plus an absent one.
    for (const v of [0, 1, 7, 250, 499, 500, 12345]) {
      const oracle = oracleEq(rows, 'stock', v);
      assert.deepEqual(eqResult(indexed, 'stock', v), oracle, `stock=${v} index`);
      assert.deepEqual(eqResult(plain, 'stock', v), oracle, `stock=${v} plain`);
    }

    // Near-unique 'dict' tier (slug) — a present slug, an absent one.
    for (const v of ['slug-0', 'slug-1299', 'slug-2599', 'slug-missing']) {
      const oracle = oracleEq(rows, 'slug', v);
      assert.deepEqual(eqResult(indexed, 'slug', v), oracle, `slug=${v} index`);
      assert.deepEqual(eqResult(plain, 'slug', v), oracle, `slug=${v} plain`);
    }

    // Bool 'plane' tier (active).
    for (const v of [true, false]) {
      const oracle = oracleEq(rows, 'active', v);
      assert.deepEqual(eqResult(indexed, 'active', v), oracle, `active=${v} index`);
      assert.deepEqual(eqResult(plain, 'active', v), oracle, `active=${v} plain`);
    }
  });

  test(`$in equivalence (${label}): index == brute == plain-scan across all tiers`, () => {
    const { plain, indexed, rows } = buildTriple(2600, nulls);

    const inCases: Array<[keyof OracleRow, unknown[]]> = [
      ['status', ['published', 'archived']],
      ['status', ['draft', 'nope', '']],
      ['status', []], // empty set matches nothing
      ['stock', [0, 1, 2, 499]],
      ['stock', [250, 9999]], // one present, one absent
      ['slug', ['slug-0', 'slug-2599', 'slug-missing']],
      ['active', [true]],
      ['active', [true, false]],
    ];
    for (const [field, values] of inCases) {
      const oracle = oracleIn(rows, field, values);
      assert.deepEqual(inResult(indexed, field, values), oracle, `${field} in ${values} index`);
      assert.deepEqual(inResult(plain, field, values), oracle, `${field} in ${values} plain`);
    }
  });
}

// --- NULL exclusion is preserved through the index (three-valued logic) -----

test('$eq via index excludes NULL rows whose dense sentinel collides ($eq 0 / $eq "")', () => {
  const { plain, indexed, rows } = buildTriple(2000, true);
  // The NULL sentinel for i32 is 0 and for string is '' — a real 0 / '' must match, a NULL must NOT.
  const oracleStock0 = oracleEq(rows, 'stock', 0);
  assert.deepEqual(eqResult(indexed, 'stock', 0), oracleStock0);
  assert.deepEqual(eqResult(plain, 'stock', 0), oracleStock0);

  // Confirm at least one NULL stock row exists so the exclusion is actually under test.
  assert.ok(rows.some((r) => r.stock === null), 'expected some NULL stock rows in fixture');

  const oracleStatusEmpty = oracleEq(rows, 'status', '');
  assert.deepEqual(eqResult(indexed, 'status', ''), oracleStatusEmpty);
  assert.deepEqual(eqResult(plain, 'status', ''), oracleStatusEmpty);
});

// --- build correctness after capacity growth past INITIAL_CAPACITY (1024) ----

test('CSR/plane build is correct after growth past INITIAL_CAPACITY (1024)', () => {
  // 2600 rows forces several column grows; word-boundary rows (31/32/63/64) must classify right.
  const { plain, indexed, rows } = buildTriple(2600, true);
  assert.equal(indexed.rowCount, 2600);

  // Spot-check the exact word-boundary rows resolve identically via index vs brute vs plain.
  for (const boundaryRow of [0, 31, 32, 63, 64, 1023, 1024, 2047, 2048, 2599]) {
    const status = rows[boundaryRow]!.status;
    if (status === null) continue;
    const oracle = oracleEq(rows, 'status', status);
    assert.ok(eqResult(indexed, 'status', status).includes(boundaryRow), `row ${boundaryRow} present`);
    assert.deepEqual(eqResult(indexed, 'status', status), oracle, `boundary ${boundaryRow}`);
    assert.deepEqual(eqResult(plain, 'status', status), oracle, `boundary ${boundaryRow} plain`);
  }

  // Full-column equivalence over every distinct stock value (CSR tier) after growth.
  const distinctStock = new Set(rows.map((r) => r.stock).filter((s): s is number => s !== null));
  for (const v of distinctStock) {
    assert.deepEqual(eqResult(indexed, 'stock', v), oracleEq(rows, 'stock', v), `stock=${v}`);
  }
});

// --- the old public API name still behaves identically ----------------------

test('createHashIndex alias produces identical $eq results to createEqIndex', () => {
  const rng = lcg(7);
  const aliased = new Table(FIELDS);
  const named = new Table(FIELDS);
  aliased.createHashIndex('status');
  named.createEqIndex('status');
  for (let i = 0; i < 5000; i++) {
    const status = STATUSES[Math.floor(rng() * STATUSES.length)]!;
    const r = { status, stock: i % 500, slug: `s-${i}`, active: (i & 1) === 0 };
    aliased.insert(r);
    named.insert(r);
  }
  for (const v of STATUSES) {
    assert.deepEqual(eqResult(aliased, 'status', v), eqResult(named, 'status', v), `alias status=${v}`);
  }
  assert.equal(aliased.eqStrategy('status'), 'plane');
});

// --- empty-table edge case --------------------------------------------------

test('empty table: $eq/$in via index match nothing and gate stays sane', () => {
  const t = new Table(FIELDS);
  t.createEqIndex('status');
  t.createEqIndex('active');
  assert.equal(eqResult(t, 'status', 'published').length, 0);
  assert.equal(inResult(t, 'status', ['draft', 'published']).length, 0);
  // No rows => CSR fallback for string; bool always plane.
  assert.equal(t.eqStrategy('status'), 'csr');
  assert.equal(t.eqStrategy('active'), 'plane');
});
