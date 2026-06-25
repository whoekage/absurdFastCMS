import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIdentifier,
  validateFieldName,
  deriveTableName,
  validateDefault,
  compileCreateTable,
  compileAlterColumnType,
  InvalidIdentifierError,
  IdentifierTooLongError,
  ReservedFieldNameError,
  ReservedTableNameError,
  DuplicateFieldError,
  DefaultTypeError,
  type ResolvedField,
} from '../src/db/ddl.ts';
import { resolveType, classifyTypeChange, UnknownCmsTypeError, TypeOptionError, EnumValueError, INTENT_ONLY_ENGINE_TYPES, type CmsType, type EngineTypeIntent } from '../src/db/type.catalog.ts';
import { resolveFields } from '../src/db/module.fields.ts';
import { type ColumnType } from '../src/store/column.ts';

/**
 * DDL UNIT SLICE — pure, DB-free coverage of identifier safety, the type catalog, default-value
 * validation, the type-change classifier, and the COMPILED DDL strings. Mock-free: it exercises the
 * real validators and the real Kysely compile path (no connection). Maps to the blueprint T1..T17.
 */

// T1 — SQL injection via field/column name is rejected BEFORE any SQL is built. [1,13]
test('T1 validateIdentifier rejects injection payloads', () => {
  for (const bad of ['x"; DROP TABLE articles; --', 'a" GENERATED ALWAYS AS (1) STORED', 'a""b', "x';--", 'foo bar']) {
    assert.throws(() => validateIdentifier(bad), InvalidIdentifierError, bad);
  }
});

// T2 — non-string inputs -> InvalidIdentifierError (no coercion). [51]
test('T2 non-string identifier inputs rejected', () => {
  for (const bad of [1, true, false, [], {}, null, undefined, 1.5, Symbol('x') as unknown]) {
    assert.throws(() => validateIdentifier(bad as unknown), InvalidIdentifierError);
  }
});

// T3 — empty / whitespace-only / surrounding-whitespace rejected, no trim. [53]
test('T3 empty and whitespace names rejected', () => {
  assert.throws(() => validateIdentifier(''), InvalidIdentifierError);
  assert.throws(() => validateIdentifier('   '), InvalidIdentifierError);
  assert.throws(() => validateIdentifier(' name'), InvalidIdentifierError);
  assert.throws(() => validateIdentifier('name '), InvalidIdentifierError);
});

// T4 — leading digit/symbol rejected; `$` allowed only non-first. [54]
test('T4 illegal first char rejected, $ allowed mid-identifier', () => {
  for (const bad of ['2fa', '$ref', '-x', '.x', '9lives']) assert.throws(() => validateIdentifier(bad), InvalidIdentifierError);
  assert.equal(validateIdentifier('a$b'), 'a$b');
  assert.equal(validateIdentifier('_ok'), '_ok'); // valid identifier (field-name rule rejects leading _, not this).
});

// T5 — 64-byte ASCII rejected, 63-byte accepted, multibyte over-budget rejected. [3,52]
test('T5 63-byte boundary enforced in BYTES', () => {
  const n63 = 'a'.repeat(63);
  const n64 = 'a'.repeat(64);
  assert.equal(validateIdentifier(n63), n63);
  assert.throws(() => validateIdentifier(n64), IdentifierTooLongError);
  // 32 two-byte chars = 64 bytes but only 32 chars; rejected for bytes, not length. (Also fails the
  // ASCII allowlist, but the byte check runs first.)
  const multibyte = 'é'.repeat(32);
  assert.equal(multibyte.length, 32);
  assert.ok(Buffer.byteLength(multibyte, 'utf8') > 63);
  assert.throws(() => validateIdentifier(multibyte), IdentifierTooLongError);
});

// T6 — Unicode/homoglyph/combining/ZWJ/emoji + NUL/control rejected. [26,50]
test('T6 Unicode and control chars rejected', () => {
  for (const bad of ['café', 'аpi' /* Cyrillic a */, 'á' /* combining */, 'a‍b' /* ZWJ */, '😀', 'x\u0000y', 'x\ny', 'x\ty']) {
    assert.throws(() => validateIdentifier(bad), InvalidIdentifierError, bad);
  }
});

// T7 — reserved field names + leading underscore rejected (case-insensitive). [22,49]
test('T7 reserved field names rejected', () => {
  for (const bad of ['id', 'ID', 'created_at', 'Created_At', 'updated_at']) assert.throws(() => validateFieldName(bad), ReservedFieldNameError, bad);
  assert.throws(() => validateFieldName('_secret'), ReservedFieldNameError);
  assert.equal(validateFieldName('title'), 'title');
  assert.equal(validateFieldName('order'), 'order'); // a reserved SQL keyword is a fine identifier (quoted later).
});

// T8 — deriveTableName: reserved / ct_-prefixed / _-leading rejected; 63-byte on the assembly. [2,4,49]
test('T8 deriveTableName guards', () => {
  assert.equal(deriveTableName('post'), 'ct_post');
  for (const bad of ['content_types', 'content_type_fields', '_migrations']) assert.throws(() => deriveTableName(bad), ReservedTableNameError, bad);
  assert.throws(() => deriveTableName('ct_post'), ReservedTableNameError); // prefix-leading
  assert.throws(() => deriveTableName('_x'), ReservedTableNameError);
  // 61-char api_id -> ct_ + 61 = 64 bytes -> rejected on the ASSEMBLED name even though api_id is <= 63.
  const api61 = 'a'.repeat(61);
  assert.equal(validateIdentifier(api61), api61);
  assert.throws(() => deriveTableName(api61), IdentifierTooLongError);
  // 60-char api_id -> ct_ + 60 = 63 bytes -> accepted.
  assert.equal(deriveTableName('a'.repeat(60)), 'ct_' + 'a'.repeat(60));
});

// T9 — case-insensitive duplicate field detection THROUGH the real resolveFields path. [23,24]
test('T9 duplicate field names within a type rejected case-insensitively', () => {
  // Exercise the PRODUCTION dedup (resolveFields), not a re-implemented loop: a regression that
  // removed the Set/lower() dedup in resolveFields would now fail this test.
  assert.throws(
    () => resolveFields([{ name: 'Title', cmsType: 'string' }, { name: 'title', cmsType: 'string' }]),
    DuplicateFieldError,
  );
  // distinct names resolve cleanly (no false positive).
  assert.doesNotThrow(() => resolveFields([{ name: 'title', cmsType: 'string' }, { name: 'body', cmsType: 'text' }]));
});

// T10 — resolveType exhaustive table: every cms_type -> exact pgType + engineType + params. [6,7,29,30,31,32,33,34,56,67]
test('T10 resolveType exhaustive catalog', () => {
  const table: Array<[CmsType, FieldOptionsLite, string, EngineTypeIntent]> = [
    ['string', {}, 'varchar(255)', 'string'],
    ['text', {}, 'text', 'text'],
    ['email', {}, 'varchar(254)', 'string'],
    ['uid', {}, 'varchar(255)', 'string'],
    ['integer', {}, 'integer', 'i32'],
    ['biginteger', {}, 'bigint', 'i64'],
    ['float', {}, 'double precision', 'f64'],
    ['decimal', { precision: 10, scale: 2 }, 'numeric(10,2)', 'decimal'],
    ['boolean', {}, 'boolean', 'bool'],
    ['date', {}, 'date', 'date'],
    ['datetime', {}, 'timestamptz', 'date'],
    ['time', {}, 'time', 'i32'],
    ['json', {}, 'jsonb', 'json'],
    ['array', {}, 'jsonb', 'json'],
    ['uuid', {}, 'uuid', 'string'],
  ];
  for (const [cms, opts, pg, eng] of table) {
    const r = resolveType(cms, opts);
    assert.equal(r.pgType, pg, `${cms} pgType`);
    assert.equal(r.engineType, eng, `${cms} engineType`);
  }
  assert.equal(resolveType('string', { length: 80 }).pgType, 'varchar(80)');
  const en = resolveType('enumeration', { values: ['draft', 'published'] });
  assert.equal(en.pgType, 'varchar(9)'); // sized to the longest member ("published")
  assert.deepEqual(en.params['values'], ['draft', 'published']);
  // params are the meta=physical source of truth: assert the STORED params object per type.
  assert.deepEqual(resolveType('string').params, { length: 255 });
  assert.deepEqual(resolveType('email').params, { length: 254 });
  assert.deepEqual(resolveType('uid').params, { length: 255 });
  assert.deepEqual(resolveType('decimal', { precision: 10, scale: 2 }).params, { precision: 10, scale: 2 });
  assert.deepEqual(en.params, { values: ['draft', 'published'], length: 9 });
  // engineType for the varchar-backed cms_types is the real 'string' ColumnType (NOT an intent string).
  assert.equal(resolveType('email').engineType, 'string');
  assert.equal(resolveType('uid').engineType, 'string');
  assert.equal(resolveType('enumeration', { values: ['a', 'b'] }).engineType, 'string');
});

// T11 — unknown cms_type -> UnknownCmsTypeError. [36]
test('T11 unknown cms_type rejected', () => {
  // NOTE: `media` is now a SUPPORTED scalar cms_type (be-04) and is intentionally NOT in this list.
  for (const bad of ['relation', 'component', 'dynamiczone', 'richtext']) {
    assert.throws(() => resolveType(bad as CmsType), UnknownCmsTypeError, bad);
  }
});

// T12 — decimal precision cap (p<=18), scale<=precision, 10,2 NOT hard-coded. [7]
test('T12 decimal precision/scale bounds', () => {
  assert.equal(resolveType('decimal', { precision: 18, scale: 4 }).pgType, 'numeric(18,4)');
  assert.throws(() => resolveType('decimal', { precision: 19, scale: 2 }), TypeOptionError);
  assert.throws(() => resolveType('decimal', { precision: 5, scale: 6 }), TypeOptionError);
  assert.equal(resolveType('decimal').pgType, 'numeric(10,2)'); // documented fallback, not a forced literal
});

// T13 — enum: empty/duplicate rejected, varchar sized >= longest, members rendered as escaped literals. [5,62,63]
test('T13 enumeration validation and CHECK literal rendering', () => {
  assert.throws(() => resolveType('enumeration', { values: [] }), EnumValueError);
  assert.throws(() => resolveType('enumeration', { values: ['a', 'a'] }), EnumValueError);
  const r = resolveType('enumeration', { values: ['a', 'longest'] });
  assert.equal(r.pgType, 'varchar(7)');
  // The compiled CREATE TABLE carries the values as ESCAPED LITERALS in the CHECK, not as a param,
  // and an injection-y member is single-quote-doubled.
  const evil = resolveType('enumeration', { values: ["a'); DROP TABLE x;--", 'b'] });
  const c = compileCreateTable('ct_t', [{ name: 'k', resolved: evil, nullable: true }]);
  assert.match(c.sql, /check \("k" in \('a''\); DROP TABLE x;--', 'b'\)\)/);
  assert.deepEqual(c.parameters, []); // enum members are escaped literals, never bound params
});

// T14 — compiled CREATE TABLE: system cols injected, user cols in sort order, reserved keyword quoted,
//        native types via escape hatch; zero-field type valid. [27,44,48,55]
test('T14 compileCreateTable shape', () => {
  const fields: ResolvedField[] = [
    { name: 'order', resolved: resolveType('integer'), nullable: false },
    { name: 'amount', resolved: resolveType('decimal', { precision: 12, scale: 4 }), nullable: true },
    { name: 'ref', resolved: resolveType('uuid'), nullable: true },
  ];
  const c = compileCreateTable('ct_thing', fields);
  assert.match(c.sql, /"id" serial not null primary key/);
  // document_id: the i32 variant-grouping system column, auto-allocated from the global sequence.
  assert.match(c.sql, /"document_id" integer default nextval\('document_id_seq'\) not null/);
  assert.match(c.sql, /"created_at" timestamptz default now\(\) not null/);
  assert.match(c.sql, /"updated_at" timestamptz default now\(\) not null/);
  assert.match(c.sql, /"order" integer not null/);
  assert.match(c.sql, /"amount" numeric\(12,4\)/);
  assert.match(c.sql, /"ref" uuid/);
  // document_id sits between id and created_at (system cols ordered id, document_id, created_at, updated_at).
  assert.ok(c.sql.indexOf('"id"') < c.sql.indexOf('"document_id"'));
  assert.ok(c.sql.indexOf('"document_id"') < c.sql.indexOf('"created_at"'));
  // user cols come AFTER the four system cols, in the given order.
  assert.ok(c.sql.indexOf('"order"') < c.sql.indexOf('"amount"'));
  assert.ok(c.sql.indexOf('"updated_at"') < c.sql.indexOf('"order"'));
  // zero user fields -> still valid, only system cols.
  const empty = compileCreateTable('ct_empty', []);
  assert.match(empty.sql, /create table "ct_empty" \("id" serial not null primary key/);
  // ALTER COLUMN TYPE escape-hatch carries the exact pg type + USING.
  const at = compileAlterColumnType('ct_thing', 'amount', resolveType('decimal', { precision: 18, scale: 2 }));
  assert.match(at.sql, /alter column "amount" type numeric\(18,2\) using "amount"::numeric\(18,2\)/);
});

// T15 — classifyTypeChange. [15,57]
test('T15 classifyTypeChange rewrite vs metadata-only', () => {
  assert.equal(classifyTypeChange(resolveType('integer'), resolveType('biginteger')), 'rewrite'); // int4->int8
  assert.equal(classifyTypeChange(resolveType('decimal', { precision: 10, scale: 2 }), resolveType('decimal', { precision: 10, scale: 4 })), 'rewrite');
  assert.equal(classifyTypeChange(resolveType('text'), resolveType('integer')), 'rewrite'); // text->int
  assert.equal(classifyTypeChange(resolveType('string', { length: 255 }), resolveType('string', { length: 100 })), 'rewrite'); // varchar shrink
  assert.equal(classifyTypeChange(resolveType('string', { length: 100 }), resolveType('string', { length: 255 })), 'metadata-only'); // varchar grow
  assert.equal(classifyTypeChange(resolveType('string', { length: 255 }), resolveType('text')), 'metadata-only'); // varchar->text
  // Enum CHECK / cms_type semantics guard: an identical-pgType change that would leave the physical
  // CHECK stale is NOT metadata-only. (The plain ALTER COLUMN TYPE never touches the CHECK.)
  const enA = resolveType('enumeration', { values: ['a', 'b'] }); // varchar(1)
  const enX = resolveType('enumeration', { values: ['x', 'y'] }); // varchar(1) — SAME pgType, different members
  assert.equal(classifyTypeChange(enA, enX), 'rewrite'); // enum value-set change must NOT be metadata-only
  const enSame = resolveType('enumeration', { values: ['b', 'a'] }); // same set, different order
  assert.equal(classifyTypeChange(enA, enSame), 'metadata-only'); // identical members + pgType => allowed
  // string(2) -> enum(['aa','bb']) (both varchar(2)) must NOT be metadata-only (no CHECK would be added).
  assert.equal(classifyTypeChange(resolveType('string', { length: 2 }), resolveType('enumeration', { values: ['aa', 'bb'] })), 'rewrite');
  // enum(['aaa','bbb']) -> string(3) (both varchar(3)) must NOT be metadata-only (stale CHECK remains).
  assert.equal(classifyTypeChange(resolveType('enumeration', { values: ['aaa', 'bbb'] }), resolveType('string', { length: 3 })), 'rewrite');
  // json -> array (both jsonb) flips cms_type with no physical change => not metadata-only.
  assert.equal(classifyTypeChange(resolveType('json'), resolveType('array')), 'rewrite');
  // string -> uid / string -> email (all varchar(255), engine 'string') flip cms_type => not metadata-only.
  assert.equal(classifyTypeChange(resolveType('string'), resolveType('uid')), 'rewrite');
  // a categorically-impossible cast (jsonb <-> integer) is 'forbidden', not merely 'rewrite'.
  assert.equal(classifyTypeChange(resolveType('json'), resolveType('integer')), 'forbidden');
});

// T16 — default-value validation. [17,35,46,58,68]
test('T16 default value type validation', () => {
  assert.throws(() => validateDefault(resolveType('integer'), 'x'), DefaultTypeError);
  assert.throws(() => validateDefault(resolveType('integer'), 1.5), DefaultTypeError);
  assert.throws(() => validateDefault(resolveType('enumeration', { values: ['a', 'b'] }), 'c'), DefaultTypeError);
  assert.throws(() => validateDefault(resolveType('date'), 'not-a-date'), DefaultTypeError);
  assert.throws(() => validateDefault(resolveType('biginteger'), 1.5), DefaultTypeError); // bigint via float Number
  assert.throws(() => validateDefault(resolveType('datetime'), 'now()'), DefaultTypeError); // volatile rejected
  assert.throws(() => validateDefault(resolveType('uuid'), 'gen_random_uuid()'), DefaultTypeError);
  assert.throws(() => validateDefault(resolveType('boolean'), 'true'), DefaultTypeError); // string, not real boolean
  // constants ok:
  assert.equal(validateDefault(resolveType('integer'), 5).sqlLiteral, 5);
  assert.equal(validateDefault(resolveType('boolean'), true).sqlLiteral, true);
  assert.equal(validateDefault(resolveType('biginteger'), 10n).sqlLiteral, '10');
  assert.equal(validateDefault(resolveType('biginteger'), '9007199254740993').sqlLiteral, '9007199254740993');
  assert.equal(validateDefault(resolveType('enumeration', { values: ['a', 'b'] }), 'a').sqlLiteral, 'a');
  // decimal default integer-digit overflow: '12345.6' on numeric(4,2) exceeds (precision-scale)=2 int
  // digits and must be rejected UP FRONT (PG would otherwise defer to a 22003 at INSERT). [7,58]
  assert.throws(() => validateDefault(resolveType('decimal', { precision: 4, scale: 2 }), '12345.6'), DefaultTypeError);
  assert.throws(() => validateDefault(resolveType('decimal', { precision: 4, scale: 2 }), 123.4), DefaultTypeError);
  assert.equal(validateDefault(resolveType('decimal', { precision: 4, scale: 2 }), '12.34').sqlLiteral, '12.34'); // exactly fits
  assert.equal(validateDefault(resolveType('decimal', { precision: 4, scale: 2 }), '0.5').sqlLiteral, '0.5'); // leading zero not counted
});

// T17 — intent-only engine types are STRUCTURALLY separate from the engine's ColumnType union. [8]
test('T17 intent-only engine types separated from ColumnType', () => {
  const realColumnTypes: ColumnType[] = ['i32', 'f64', 'bool', 'string', 'date', 'text'];
  // The real safety property is structural: the intent-only strings are disjoint from ColumnType, so
  // they can never be a value the engine's createColumn(type: ColumnType) accepts. We assert that
  // invariant directly rather than depending on createColumn's switch falling through to undefined.
  for (const intent of INTENT_ONLY_ENGINE_TYPES) {
    assert.ok(!realColumnTypes.includes(intent as ColumnType), `${intent} must NOT be a ColumnType`);
  }
  // and the catalog only ever emits a real ColumnType OR a declared intent-only string — never a third thing.
  const allCms: CmsType[] = ['string', 'text', 'email', 'uid', 'enumeration', 'integer', 'biginteger', 'float', 'decimal', 'boolean', 'date', 'datetime', 'time', 'json', 'array', 'uuid'];
  for (const cms of allCms) {
    const eng = cms === 'enumeration' ? resolveType(cms, { values: ['a'] }).engineType : resolveType(cms).engineType;
    const isReal = realColumnTypes.includes(eng as ColumnType);
    const isIntent = INTENT_ONLY_ENGINE_TYPES.has(eng);
    assert.ok(isReal !== isIntent, `${cms} -> ${eng} must be EITHER a ColumnType or an intent-only string, not both/neither`);
  }
});

/** Local options alias to keep the T10 table terse. */
type FieldOptionsLite = Parameters<typeof resolveType>[1];
