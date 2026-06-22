import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StringColumn } from '../src/store/column.ts';
import { Bitset } from '../src/store/bitset.ts';

/**
 * be-22f: the off-heap folded-key -> raw-codes grouping ($eqi / $nei) REMOVES the old V8 Map
 * ~8.4M (2^23) overflow that the on-heap `Map<string, number[]>` threw at on a high-cardinality
 * `-i` column. These tests drive a StringColumn directly (NO mocks, real fold + real off-heap
 * build) and assert the resolved rows EXACTLY equal a brute foldedDict reference (decode each
 * row's value, fold, compare) — the correctness oracle.
 *
 * The heaviest >=10M-distinct case is GATED behind FOLDED_HIGHCARD_PROOF=1 (it allocates and
 * indexes ~10M near-unique strings, multi-GB / multi-second) so the default suite stays fast;
 * run it with:  FOLDED_HIGHCARD_PROOF=1 node --expose-gc --test test/folded-highcard.test.ts
 */

function fold(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

/** Build a StringColumn from raw row values (no nulls — null exclusion lives at the Table boundary). */
function colOf(rows: string[]): StringColumn {
  const col = new StringColumn();
  for (const v of rows) col.push(v);
  return col;
}

/** Brute foldedDict oracle on the public column: rows whose folded value equals fold(query). */
function bruteEqi(rows: string[], query: string): number[] {
  const q = fold(query);
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) if (fold(rows[i]!) === q) out.push(i);
  return out;
}
function bruteNei(rows: string[], query: string): number[] {
  const q = fold(query);
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) if (fold(rows[i]!) !== q) out.push(i);
  return out;
}

function scanRows(col: StringColumn, op: 'eqi' | 'nei', value: string, n: number): number[] {
  const out = new Bitset(n);
  col.scan(op, value, out);
  return out.toArray();
}

test('eqi/nei match the brute foldedDict reference over mixed casing + NFKC fold collisions', () => {
  // STRASSE/strasse collide; straße folds only to itself; CAFÉ/café/decomposed café collapse; ﬀ->ff.
  const rows = [
    'STRASSE',
    'strasse',
    'Strasse',
    'straße',
    'CAFÉ',
    'café',
    'café', // decomposed: NFKC composes -> café
    'ﬀ oo', // ﬀ ligature -> ff oo
    'FF oo',
    'ＡＢＣ', // fullwidth ABC -> ABC
    'abc',
  ];
  const col = colOf(rows);
  const n = rows.length;
  for (const q of ['strasse', 'STRASSE', 'straße', 'café', 'CAFÉ', 'ff oo', 'ABC', 'abc', 'absent', '']) {
    assert.deepEqual(scanRows(col, 'eqi', q, n), bruteEqi(rows, q), `eqi ${JSON.stringify(q)}`);
    assert.deepEqual(scanRows(col, 'nei', q, n), bruteNei(rows, q), `nei ${JSON.stringify(q)}`);
  }
  // Collected codes must be strictly ascending (byte-identical to the old ascending bucket order):
  // an eqi hit on a multi-code folded key returns rows in ascending row order.
  const strasse = scanRows(col, 'eqi', 'strasse', n);
  assert.deepEqual(strasse, [0, 1, 2], 'STRASSE/strasse/Strasse, ascending');
  assert.deepEqual(scanRows(col, 'eqi', 'straße', n), [3], 'straße folds only to itself');
});

test('low-card status column is unchanged + tiny (no regression vs the old tiny Map)', () => {
  const rows: string[] = [];
  const variants = ['draft', 'Published', 'ARCHIVED'];
  for (let i = 0; i < 30_000; i++) rows.push(variants[i % 3]!);
  const col = colOf(rows);
  const n = rows.length;
  for (const q of ['DRAFT', 'published', 'archived', 'missing']) {
    assert.deepEqual(scanRows(col, 'eqi', q, n), bruteEqi(rows, q), `eqi ${q}`);
    assert.deepEqual(scanRows(col, 'nei', q, n), bruteNei(rows, q), `nei ${q}`);
  }
  // 3 distinct folded keys -> the off-heap grouping is in the low-KiB minimum, not megabytes.
  assert.equal(col.foldedDictLength(), 3, 'one folded slot per distinct raw string');
});

test('rebuild-on-grow: eqi/nei stay correct after more strings are interned post-build', () => {
  const rows = ['Red', 'GREEN', 'blue'];
  const col = colOf(rows);
  // Force a first folded build.
  assert.deepEqual(scanRows(col, 'eqi', 'red', 3), [0]);
  // Intern more (new distinct folded keys) then query again — must rebuild + serve.
  col.push('YELLOW');
  col.push('green'); // folds to an existing key
  const grown = ['Red', 'GREEN', 'blue', 'YELLOW', 'green'];
  for (const q of ['green', 'yellow', 'red', 'blue', 'absent']) {
    assert.deepEqual(scanRows(col, 'eqi', q, 5), bruteEqi(grown, q), `eqi ${q} grown`);
    assert.deepEqual(scanRows(col, 'nei', q, 5), bruteNei(grown, q), `nei ${q} grown`);
  }
});

// ── GATED >=10M-distinct proof: used to overflow the V8 Map; now builds + serves ────────────────
const PROOF = process.env.FOLDED_HIGHCARD_PROOF === '1';
test('>=10M distinct folded keys: eqi BUILDS + serves with no Map overflow', { skip: !PROOF }, () => {
  const D = 10_000_000; // > the old V8 Map 2^23 (~8.4M) ceiling
  const col = new StringColumn();
  // Near-unique rows: each row its own distinct folded key (lowercased so fold is identity here).
  for (let i = 0; i < D; i++) col.push(`row-${i}`);
  // The first eqi triggers the off-heap build (intern + CSR) over all D distinct folded keys.
  const probe = 7_777_777;
  const hit = scanRows(col, 'eqi', `ROW-${probe}`, D); // mixed casing -> exercises fold()
  assert.deepEqual(hit, [probe], 'eqi resolves the single matching row at >10M distinct');
  // A miss resolves to nothing (codeOf === undefined, the exact old Map.get miss-signal).
  const out = new Bitset(D);
  col.scan('eqi', 'definitely-absent-value', out);
  assert.equal(out.count(), 0, 'eqi miss matches nothing at >10M distinct');
  // nei of the absent value => all rows (off-heap fill, no Map).
  const all = new Bitset(D);
  col.scan('nei', 'definitely-absent-value', all);
  assert.equal(all.count(), D, 'nei of an absent value matches all rows');
});
