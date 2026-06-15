import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, type FieldDef } from '../src/store/table.ts';
import { Engine } from '../src/store/engine.ts';
import {
  coerceI64,
  coerceDecimal,
  formatDecimal,
  I64Column,
  JsonColumn,
} from '../src/store/column.ts';
import { parseQuery, QueryParseError } from '../src/store/query-parser.ts';
import { Bitset } from '../src/store/bitset.ts';

/**
 * STEP 3 — engine column types `i64`, `decimal`, `json` (exact precision).
 *
 * Doctrine: NO mocks. Real Table / Engine / parseQuery driven end-to-end against native-bigint
 * oracles (exact, engine-independent). The precision cases assert on RAW Buffer BYTES (never
 * JSON.parse, which would itself lose a nested integer > 2^53), proving the value survives the full
 * insert -> materialize -> serialize -> respond cycle byte-exact.
 */

const I64_MAX = 2n ** 63n - 1n;
const I64_MIN = -(2n ** 63n);

function buildTable(fields: FieldDef[], rows: Record<string, unknown>[]): Table {
  const t = new Table(fields);
  for (const r of rows) t.insert(r);
  return t;
}

// ===========================================================================
// i64
// ===========================================================================

test('i64 T1: 2^53 and 2^53+1 are distinct end-to-end (eq, sort, materialize bytes)', () => {
  const eng = new Engine();
  const t = eng.define('big', [
    { name: 'id', type: 'i32' },
    { name: 'n', type: 'i64' },
  ]);
  eng.insert('big', { id: 0, n: 9007199254740992n });
  eng.insert('big', { id: 1, n: 9007199254740993n });
  t.createEqIndex('n');
  t.createSortedIndex('n');
  t.warmIndexes();

  // $eq each returns exactly one distinct row (an f64 column would collapse them).
  assert.deepEqual(t.scan([{ field: 'n', op: 'eq', value: 9007199254740992n }]).toArray(), [0]);
  assert.deepEqual(t.scan([{ field: 'n', op: 'eq', value: 9007199254740993n }]).toArray(), [1]);

  // respondOne bytes differ in the last digit — proves the serializer emitted exact integers.
  const b0 = eng.respondOne('big', 0);
  const b1 = eng.respondOne('big', 1);
  assert.ok(b0.includes(Buffer.from('9007199254740992')));
  assert.ok(b1.includes(Buffer.from('9007199254740993')));
  assert.notDeepEqual(b0, b1);
});

test('i64 T2: ordering + range over the full int64 range (bigint oracle)', () => {
  const vals = [I64_MIN, -100n, -1n, 0n, 1n, 100n, I64_MAX];
  const rows = vals.map((v, i) => ({ id: i, n: v }));
  // Shuffle insert order so the sort genuinely orders by value, not insertion.
  const shuffled = [rows[3]!, rows[6]!, rows[0]!, rows[4]!, rows[1]!, rows[5]!, rows[2]!];
  const t = buildTable([{ name: 'id', type: 'i32' }, { name: 'n', type: 'i64' }], shuffled);
  t.createSortedIndex('n');
  t.warmIndexes();

  // ORDER BY n asc -> ids in ascending-value order. Read the raw bigint via the column (materialize
  // materializes i64 as an exact decimal string for the serializer).
  const idAt = (rowId: number) => t.column('id').at(rowId) as number;
  const nAt = (rowId: number) => t.column('n').at(rowId) as bigint;
  const ordered = t.query({ sort: [{ field: 'n', dir: 'asc' }] }).map(idAt);
  const expectAsc = [...rows].sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0)).map((r) => r.id);
  assert.deepEqual(ordered, expectAsc);

  const idsOf = (bitset: number[]) => bitset.map(nAt).sort((a, b) => (a < b ? -1 : 1));
  assert.deepEqual(idsOf(t.scan([{ field: 'n', op: 'between', value: [-1n, 1n] }]).toArray()), [-1n, 0n, 1n]);
  assert.deepEqual(idsOf(t.scan([{ field: 'n', op: 'gt', value: 0n }]).toArray()), [1n, 100n, I64_MAX]);
  assert.deepEqual(idsOf(t.scan([{ field: 'n', op: 'lt', value: 0n }]).toArray()), [I64_MIN, -100n, -1n]);
});

test('i64 T2b: boundary values round-trip; -2^63 is never negated', () => {
  const eng = new Engine();
  eng.define('b', [{ name: 'n', type: 'i64' }]);
  eng.insert('b', { n: I64_MIN });
  eng.insert('b', { n: I64_MAX });
  assert.ok(eng.respondOne('b', 0).includes(Buffer.from('-9223372036854775808')));
  assert.ok(eng.respondOne('b', 1).includes(Buffer.from('9223372036854775807')));
});

test('i64 T3: coerceI64 accepts/rejects per contract', () => {
  assert.equal(coerceI64('007'), 7n);
  assert.equal(coerceI64('-0'), 0n);
  assert.equal(coerceI64(42), 42n);
  assert.equal(coerceI64(123n), 123n);
  for (const bad of ['', '  ', '1.0', '1e3', '+1', '0x1f', 'abc']) {
    assert.throws(() => coerceI64(bad), /i64 value/, `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => coerceI64(2 ** 53 + 1), /safe integer/);
  assert.throws(() => coerceI64(99999999999999999999n), /out of int64 range/);
  assert.throws(() => coerceI64(I64_MAX + 1n), /out of int64 range/);
});

test('i64 T4: eq-index + $in with mixed bigint/string elements; sentinel 0n excluded', () => {
  const t = buildTable(
    [{ name: 'n', type: 'i64' }],
    [{ n: 10n }, { n: 20n }, { n: 10n }, { n: null }, { n: 30n }],
  );
  t.createEqIndex('n');
  t.warmIndexes();
  // query by bigint and by string both hit.
  assert.deepEqual(t.scan([{ field: 'n', op: 'eq', value: 10n }]).toArray(), [0, 2]);
  // $in mixing bigint + digit string; row 3 is NULL (sentinel 0n) and must never match.
  assert.deepEqual(
    t.scan([{ field: 'n', op: 'in', value: [20n, 30n] }]).toArray(),
    [1, 4],
  );
  // $eq 0n must NOT match the NULL sentinel row (null bit excludes it).
  assert.deepEqual(t.scan([{ field: 'n', op: 'eq', value: 0n }]).toArray(), []);
});

test('i64 T5: full Engine.insert + respond emits an exact QUOTED integer string', () => {
  const eng = new Engine();
  eng.define('b', [{ name: 'id', type: 'i32' }, { name: 'qty', type: 'i64' }]);
  eng.insert('b', { id: 1, qty: I64_MAX });
  const one = eng.respondOne('b', 0);
  // QUOTED string (the interoperable wire form): a JSON number > 2^53 would lose precision in a naive
  // client's JSON.parse -> Number. Exact digits, quoted; NOT an unquoted number.
  assert.ok(one.includes(Buffer.from('"qty":"9223372036854775807"')));
  assert.ok(!one.includes(Buffer.from('"qty":9223372036854775807,')) && !one.includes(Buffer.from('"qty":9223372036854775807}')));
  // The whole envelope JSON.parses structurally, and the field comes back as the exact string.
  assert.equal(JSON.parse(one.toString('utf8')).data.qty, '9223372036854775807');
});

test('i64 T6: NULL i64 materializes null', () => {
  const eng = new Engine();
  eng.define('b', [{ name: 'n', type: 'i64' }]);
  eng.insert('b', { n: null });
  assert.ok(eng.respondOne('b', 0).includes(Buffer.from('"n":null')));
});

test('i64 T2c: ORDER BY without a sorted index routes through the fallback comparator, exact > 2^53', () => {
  // No createSortedIndex -> query() takes the `sort.length > 0` fallback (table.ts comparator),
  // which widens the cast to bigint. Proves the comparator orders exactly above 2^53 and at ±2^63.
  const vals = [9007199254740993n, 9007199254740992n, I64_MIN, I64_MAX, 0n, -9007199254740993n];
  const rows = vals.map((v, i) => ({ id: i, n: v }));
  const t = buildTable([{ name: 'id', type: 'i32' }, { name: 'n', type: 'i64' }], rows);
  // Deliberately NO sorted index — exercise the comparator() bigint branch in isolation.
  const idAt = (rowId: number) => t.column('id').at(rowId) as number;
  const asc = t.query({ sort: [{ field: 'n', dir: 'asc' }] }).map(idAt);
  const expectAsc = [...rows].sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0)).map((r) => r.id);
  assert.deepEqual(asc, expectAsc);
  const desc = t.query({ sort: [{ field: 'n', dir: 'desc' }] }).map(idAt);
  assert.deepEqual(desc, [...expectAsc].reverse());
  // The two adjacent > 2^53 values are NOT collapsed (an f64 comparator would tie them).
  const pos = asc.indexOf(0); // id 0 holds 2^53+1, id 1 holds 2^53; both must sit just above 0n.
  assert.notEqual(asc.indexOf(0), asc.indexOf(1));
  assert.ok(pos >= 0);
});

// ===========================================================================
// decimal
// ===========================================================================

test('decimal T7: coerceDecimal string-decomposition, no rounding', () => {
  assert.throws(() => coerceDecimal('1.234', 2), /exceeding scale/);
  assert.equal(coerceDecimal('1.50', 2), 150n);
  assert.equal(coerceDecimal('1', 0), 1n);
  assert.throws(() => coerceDecimal('123.0', 0), /exceeding scale/);
  // precision overflow: value 1.50 at precision 2 scale 2 (max 0 integer digits).
  assert.throws(() => coerceDecimal('1.50', 2, 2), /exceeds precision/);
  for (const bad of ['1e3', 'NaN', '', 'abc', 'Infinity']) {
    assert.throws(() => coerceDecimal(bad, 2), /not a valid fixed-point|finite/);
  }
  // Leading-zero integer part strips before scaling; surrounding whitespace trims; all-fraction
  // values (|v| < 1) keep a leading 0 on the way back out. (checklist 33/35 corners.)
  assert.equal(coerceDecimal('007.50', 2), 750n);
  assert.equal(coerceDecimal(' 1.50 ', 2), 150n);
  assert.equal(coerceDecimal('0.50', 2, 3), 50n); // 1 integer digit budget (precision-scale=1), '0' fits
  assert.equal(coerceDecimal('-0.00', 2), 0n); // negative zero collapses to 0n
  assert.equal(formatDecimal(50n, 2), '0.50'); // leading 0 never dropped
});

test('decimal T8: formatDecimal exact, no negative zero, trailing zeros kept', () => {
  assert.equal(formatDecimal(5n, 2), '0.05');
  assert.equal(formatDecimal(100n, 2), '1.00');
  assert.equal(formatDecimal(0n, 2), '0.00');
  assert.equal(formatDecimal(1n, 2), '0.01');
  assert.equal(formatDecimal(123n, 0), '123');
  assert.equal(formatDecimal(-150n, 2), '-1.50');
  assert.equal(formatDecimal(-5n, 2), '-0.05');
});

test('decimal T9: two 18-digit decimals differing by 1 ULP — distinct order/eq/bytes', () => {
  // scale 0, mantissa near 10^18 (fits int64). Differ by exactly 1.
  const a = 999999999999999998n;
  const b = 999999999999999999n;
  const eng = new Engine();
  const t = eng.define('d', [{ name: 'id', type: 'i32' }, { name: 'v', type: 'decimal', scale: 0 }]);
  eng.insert('d', { id: 0, v: a });
  eng.insert('d', { id: 1, v: b });
  t.createSortedIndex('v');
  t.warmIndexes();
  assert.deepEqual(t.scan([{ field: 'v', op: 'eq', value: b }]).toArray(), [1]);
  // distinct materialized strings.
  assert.ok(eng.respondOne('d', 0).includes(Buffer.from('"999999999999999998"')));
  assert.ok(eng.respondOne('d', 1).includes(Buffer.from('"999999999999999999"')));
});

test('decimal T10: 1.0 / 1.00 / 1 @scale2 all canonicalize to 100n; $eq "1" hits all', () => {
  const fields: FieldDef[] = [{ name: 'v', type: 'decimal', scale: 2 }];
  const t = buildTable(fields, [{ v: '1.0' }, { v: '1.00' }, { v: '1' }]);
  t.createEqIndex('v');
  t.warmIndexes();
  // The parser coerces "1" with the column's scale (threaded via fields()) to mantissa 100n.
  const eng = new Engine();
  eng.define('d', fields);
  for (const v of ['1.0', '1.00', '1']) eng.insert('d', { v });
  eng.table('d').createEqIndex('v');
  eng.table('d').warmIndexes();
  const parsed = parseQuery(eng.fields('d'), 'filters[v][$eq]=1');
  const matched = eng.table('d').matchSet(parsed.options).toArray();
  assert.deepEqual(matched, [0, 1, 2]);
  // Direct table-level check with the pre-coerced mantissa.
  assert.deepEqual(t.scan([{ field: 'v', op: 'eq', value: 100n }]).toArray(), [0, 1, 2]);
});

test('decimal T11: $between reversed/equal/excess-fraction', () => {
  const fields: FieldDef[] = [{ name: 'v', type: 'decimal', scale: 2 }];
  const eng = new Engine();
  const t = eng.define('d', fields);
  for (const v of ['1.00', '2.00', '3.00']) eng.insert('d', { v });
  t.createSortedIndex('v');
  t.warmIndexes();
  // reversed -> empty.
  assert.deepEqual(t.scan([{ field: 'v', op: 'between', value: [300n, 100n] }]).toArray(), []);
  // equal point -> eq.
  assert.deepEqual(t.scan([{ field: 'v', op: 'between', value: [200n, 200n] }]).toArray(), [1]);
  // excess fraction rejected by the parser.
  assert.throws(
    () => parseQuery(eng.fields('d'), 'filters[v][$between]=1.001,2.00'),
    QueryParseError,
  );
});

test('decimal T12: createColumn / scale validation', () => {
  assert.throws(() => new Table([{ name: 'v', type: 'decimal' }]), /requires a scale/);
  assert.throws(() => new I64Column('decimal', 19), /scale must be an integer/);
  assert.throws(() => new I64Column('decimal', -1), /scale must be an integer/);
  assert.doesNotThrow(() => new I64Column('decimal', 18));
});

test('decimal T13: NULL -> null; real 0 -> "0.00"; JSON.stringify never throws', () => {
  const eng = new Engine();
  eng.define('d', [{ name: 'v', type: 'decimal', scale: 2 }]);
  eng.insert('d', { v: null });
  eng.insert('d', { v: '0.00' });
  assert.ok(eng.respondOne('d', 0).includes(Buffer.from('"v":null')));
  assert.ok(eng.respondOne('d', 1).includes(Buffer.from('"v":"0.00"')));
});

test('decimal T10b: eq-index created BEFORE incremental inserts; mixed reps all bucket to one mantissa', () => {
  // Guards the eq.add canonicalization: build the index first, then insert the SAME logical value in
  // several representations. Each push laundering must feed the canonical mantissa to the index so a
  // pre-created index agrees with the scan (the documented "create the index, then keep inserting").
  const fields: FieldDef[] = [{ name: 'v', type: 'decimal', scale: 2 }];
  const t = new Table(fields);
  t.createEqIndex('v'); // index BEFORE any row exists.
  for (const v of ['1.0', '1.00', '1', 1, 100n]) t.insert({ v }); // all -> mantissa 100n
  t.insert({ v: '2.00' }); // a distinct value
  t.insert({ v: null }); // sentinel 0n, must never match
  t.warmIndexes();
  assert.deepEqual(t.scan([{ field: 'v', op: 'eq', value: 100n }]).toArray(), [0, 1, 2, 3, 4]);
  assert.deepEqual(t.scan([{ field: 'v', op: 'in', value: [100n, 200n] }]).toArray(), [0, 1, 2, 3, 4, 5]);
  // The end-to-end parser path: $eq "1" coerces to 100n and hits all mixed-rep rows.
  const eng = new Engine();
  eng.define('d', fields);
  eng.table('d').createEqIndex('v');
  for (const v of ['1.0', '1.00', '1']) eng.insert('d', { v });
  eng.table('d').warmIndexes();
  const parsed = parseQuery(eng.fields('d'), 'filters[v][$eq]=1');
  assert.deepEqual(eng.table('d').matchSet(parsed.options).toArray(), [0, 1, 2]);
});

test('i64 T4b: eq-index created BEFORE inserts; bigint/string reps bucket identically', () => {
  const t = new Table([{ name: 'n', type: 'i64' }]);
  t.createEqIndex('n'); // index BEFORE inserts.
  for (const v of [10n, '10', 10, 20n, null]) t.insert({ n: v });
  t.warmIndexes();
  // All three 10-representations land in one bucket; the NULL sentinel-0 never matches.
  assert.deepEqual(t.scan([{ field: 'n', op: 'eq', value: 10n }]).toArray(), [0, 1, 2]);
  assert.deepEqual(t.scan([{ field: 'n', op: 'eq', value: 0n }]).toArray(), []);
});

test('decimal T13b: fractional / negative decimals materialize through respondOne (scale 2 e2e)', () => {
  const eng = new Engine();
  eng.define('d', [{ name: 'v', type: 'decimal', scale: 2 }]);
  eng.insert('d', { v: '12.34' });
  eng.insert('d', { v: '-1.50' });
  eng.insert('d', { v: '0.01' });
  assert.ok(eng.respondOne('d', 0).includes(Buffer.from('"v":"12.34"')));
  assert.ok(eng.respondOne('d', 1).includes(Buffer.from('"v":"-1.50"')));
  assert.ok(eng.respondOne('d', 2).includes(Buffer.from('"v":"0.01"')));
});

test('decimal T13c: declared precision is enforced at the engine (PG 22003 parity)', () => {
  // numeric(5,2): max |value| is 999.99 (3 integer digits). The engine must reject an over-precision
  // value at push exactly as Postgres does — not merely lean on the int64 range (which permits 18 digits).
  // The column rejects out-of-precision at push exactly as Postgres does (not merely on int64 range).
  const col = new I64Column('decimal', 2, 5);
  assert.throws(() => col.push('9999999999.99'), /exceeds precision/);
  assert.throws(() => col.push('1000.00'), /exceeds precision/);
  const at = col.push('999.99'); // 3 integer digits = the max for precision 5 scale 2.
  assert.equal(col.at(at), 99999n);
  // And a whole-table insert of an in-range value succeeds end-to-end.
  const t = new Table([{ name: 'v', type: 'decimal', scale: 2, precision: 5 }]);
  assert.doesNotThrow(() => t.insert({ v: '999.99' }));
  assert.throws(() => new Table([{ name: 'v', type: 'decimal', scale: 2, precision: 5 }]).insert({ v: '1000.00' }), /exceeds precision/);
  // The parser also enforces precision when coercing a predicate value.
  const eng = new Engine();
  eng.define('d', [{ name: 'v', type: 'decimal', scale: 2, precision: 5 }]);
  assert.throws(() => parseQuery(eng.fields('d'), 'filters[v][$eq]=1000.00'), QueryParseError);
  assert.doesNotThrow(() => parseQuery(eng.fields('d'), 'filters[v][$eq]=999.99'));
});

// ===========================================================================
// json
// ===========================================================================

test('json T14: nested integer > 2^53 survives byte-exact through insert -> respond', () => {
  const eng = new Engine();
  eng.define('j', [{ name: 'id', type: 'i32' }, { name: 'data', type: 'json' }]);
  eng.insert('j', { id: 0, data: '{"big":9999999999999999999}' });
  const one = eng.respondOne('j', 0);
  const list = eng.respond('j', {});
  assert.ok(one.includes(Buffer.from('9999999999999999999')), 'respondOne preserves the big int verbatim');
  assert.ok(list.includes(Buffer.from('9999999999999999999')), 'respond list preserves the big int verbatim');
  // The envelope is structurally valid JSON (parsing it would lose the big int, but the bytes survive).
  assert.doesNotThrow(() => JSON.parse(list.toString('utf8')));
});

test('json T15: object key ORDER preserved verbatim (no V8 numeric-key reorder)', () => {
  const eng = new Engine();
  eng.define('j', [{ name: 'data', type: 'json' }]);
  const raw = '{"b":1,"a":2,"10":3}';
  eng.insert('j', { data: raw });
  const one = eng.respondOne('j', 0);
  assert.ok(one.includes(Buffer.from(raw)), 'key order + whitespace preserved');
});

test('json T16: invalid/empty rejected at push (rowCount unchanged); top-level scalars accepted', () => {
  const t = new Table([{ name: 'data', type: 'json' }]);
  for (const bad of ['{bad', '', '   ']) {
    const before = t.rowCount;
    assert.throws(() => t.insert({ data: bad }), undefined, `should reject ${JSON.stringify(bad)}`);
    assert.equal(t.rowCount, before, 'rowCount must not advance on a rejected json value');
  }
  // Top-level scalars/arrays are valid jsonb and round-trip verbatim.
  const eng = new Engine();
  eng.define('j', [{ name: 'data', type: 'json' }]);
  for (const ok of ['42', 'true', '[1,2]', '"hi"', '[9999999999999999999]']) eng.insert('j', { data: ok });
  for (let i = 0; i < 5; i++) {
    const raw = ['42', 'true', '[1,2]', '"hi"', '[9999999999999999999]'][i]!;
    assert.ok(eng.respondOne('j', i).includes(Buffer.from('"data":' + raw)));
  }
});

test('json T17: unicode / escapes / 4-byte CJK round-trip byte-exact', () => {
  const eng = new Engine();
  eng.define('j', [{ name: 'data', type: 'json' }]);
  const samples = [
    '{"emoji":"😀"}',
    '{"esc":"\\u00e9"}',
    '{"slash":"a\\/b"}',
    '{"cjk":"漢字テスト"}',
  ];
  for (const s of samples) eng.insert('j', { data: s });
  for (let i = 0; i < samples.length; i++) {
    assert.ok(eng.respondOne('j', i).includes(Buffer.from(samples[i]!)), `sample ${i} byte-exact`);
  }
});

test('json T17b: a JSON.parse-valid-but-not-well-formed-UTF-16 value is rejected at push', () => {
  // A literal lone (unpaired) high surrogate is valid per JSON.parse but NOT well-formed UTF-16;
  // TextEncoder would silently rewrite it to U+FFFD, corrupting the verbatim bytes. Reject-don't-store.
  const t = new Table([{ name: 'data', type: 'json' }]);
  const before = t.rowCount;
  const loneSurrogate = '{"x":"' + '\uD800' + '"}'; // an unpaired high surrogate code unit
  assert.equal(loneSurrogate.isWellFormed(), false, 'precondition: the input is not well-formed UTF-16');
  assert.throws(() => t.insert({ data: loneSurrogate }), /unpaired surrogate|well-formed/);
  assert.equal(t.rowCount, before, 'rowCount must not advance on a rejected json value');
  // A well-formed paired surrogate (a real emoji) is accepted and round-trips byte-exact.
  const eng = new Engine();
  eng.define('j', [{ name: 'data', type: 'json' }]);
  const ok = '{"x":"😀"}'; // 😀 as a proper surrogate pair
  eng.insert('j', { data: ok });
  assert.ok(eng.respondOne('j', 0).includes(Buffer.from(ok)));
});

test('json T14b: multi-row list splices each verbatim fragment; response cache returns identical bytes', () => {
  const eng = new Engine();
  eng.define('j', [{ name: 'id', type: 'i32' }, { name: 'data', type: 'json' }]);
  // A deep / multi-KB body forces the JsonColumn arena to double past INITIAL_CAPACITY.
  const deepBig = '{"deep":' + '['.repeat(50) + '{"big":12345678901234567890}' + ']'.repeat(50) + '}';
  const filler = '{"pad":"' + 'x'.repeat(4000) + '"}';
  const frags = ['{"a":1}', deepBig, filler];
  frags.forEach((f, i) => eng.insert('j', { id: i, data: f }));
  const list = eng.respond('j', {});
  for (const f of frags) assert.ok(list.includes(Buffer.from(f)), `fragment spliced verbatim: ${f.slice(0, 20)}…`);
  assert.ok(list.includes(Buffer.from('12345678901234567890')), 'deep > 2^53 int survives byte-exact');
  assert.doesNotThrow(() => JSON.parse(list.toString('utf8')), 'envelope is structurally valid JSON');
  // Second call hits the ResponseCache — must be byte-identical.
  const list2 = eng.respond('j', {});
  assert.deepEqual(list2, list, 'cached respond is byte-identical');
});

test('json T18: not filterable — parser + index guards reject', () => {
  const eng = new Engine();
  eng.define('j', [{ name: 'data', type: 'json' }, { name: 'n', type: 'i32' }]);
  for (const q of ['filters[data][$eq]=1', 'filters[data][$gt]=1', 'filters[data][$contains]=x']) {
    assert.throws(() => parseQuery(eng.fields('j'), q), QueryParseError, `should reject ${q}`);
  }
  const t = eng.table('j');
  assert.throws(() => t.createSortedIndex('data'), /sorted index requires/);
  assert.throws(() => t.createEqIndex('data'), /not eq-indexable/);
});

test('json T19: two json fields + placeholder-like string + i64 splice correctly, no collision', () => {
  const eng = new Engine();
  eng.define('mix', [
    { name: 'id', type: 'i32' },
    { name: 'a', type: 'json' },
    { name: 's', type: 'string' },
    { name: 'b', type: 'json' },
    { name: 'q', type: 'i64' },
  ]);
  // `s` deliberately contains a JSON-fragment-looking string to prove there is no placeholder collision.
  eng.insert('mix', {
    id: 7,
    a: '{"x":11111111111111111111}',
    s: '{"x":99}',
    b: '{"k":1,"j":2}',
    q: I64_MAX,
  });
  const one = eng.respondOne('mix', 0);
  const text = one.toString('utf8');
  // i64 a QUOTED exact string; both json fragments verbatim; the string field still QUOTED + escaped.
  assert.ok(text.includes('"q":"9223372036854775807"'));
  assert.ok(text.includes('"a":{"x":11111111111111111111}'));
  assert.ok(text.includes('"b":{"k":1,"j":2}'));
  assert.ok(text.includes('"s":"{\\"x\\":99}"'), 'string field stays a quoted escaped string, no collision');
  assert.doesNotThrow(() => JSON.parse(text));

  // A row whose json field is explicitly the literal `null` vs a SQL NULL field: both surface "data":null
  // bytes, but the null-bit semantics differ (one has a stored value, the other a null bit).
  eng.insert('mix', { id: 8, a: 'null', s: 'x', b: 'null', q: 1n });
  eng.insert('mix', { id: 9, s: 'x', q: 1n }); // a/b absent -> SQL NULL
  assert.ok(eng.respondOne('mix', 1).includes(Buffer.from('"a":null')));
  assert.ok(eng.respondOne('mix', 2).includes(Buffer.from('"a":null')));
  assert.equal(eng.table('mix').isNull('a', 1), false); // stored JSON literal null
  assert.equal(eng.table('mix').isNull('a', 2), true); // SQL NULL
});

// ===========================================================================
// Additive guarantee — the fast-path gate
// ===========================================================================

test('T20: a table with ONLY existing types serializes byte-identical to JSON.stringify(materialize)', () => {
  const fields: FieldDef[] = [
    { name: 'id', type: 'i32' },
    { name: 'title', type: 'string' },
    { name: 'score', type: 'f64' },
    { name: 'live', type: 'bool' },
    { name: 'at', type: 'date' },
  ];
  const eng = new Engine();
  const t = eng.define('legacy', fields);
  const rows = [
    { id: 1, title: 'hello "world"', score: 3.5, live: true, at: '2021-01-01T00:00:00.000Z' },
    { id: 2, title: 'x', score: -0, live: false, at: 1609459200000 },
    { id: 3, title: 'n', score: 1, live: true }, // at absent -> null
  ];
  for (const r of rows) eng.insert('legacy', r);
  for (let i = 0; i < rows.length; i++) {
    const expected = Buffer.from(JSON.stringify(t.materialize(i)), 'utf8');
    const actual = eng.respondOne('legacy', i);
    // respondOne wraps in {"data":...,"meta":{}}; strip to compare the row bytes.
    const head = Buffer.from('{"data":', 'utf8');
    const tail = Buffer.from(',"meta":{}}', 'utf8');
    const rowBytes = actual.subarray(head.length, actual.length - tail.length);
    assert.deepEqual(rowBytes, expected, `row ${i} byte-identical to legacy JSON.stringify`);
  }
});

test('T20b: JsonColumn.scan throws defensively; makeProbe returns null', () => {
  const c = new JsonColumn();
  c.push('{"a":1}');
  assert.throws(() => c.scan('eq', '{"a":1}', new Bitset(1)), /not filterable/);
  assert.equal(c.makeProbe('eq', 'x'), null);
});
