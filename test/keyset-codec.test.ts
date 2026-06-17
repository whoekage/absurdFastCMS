import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CursorCodec, InvalidCursorError, type CursorPayload, type SigInput, type SortFieldType } from '../src/store/cursor.codec.ts';

/**
 * KEYSET cursor codec — PURE-RAM, mock-free, NO Postgres. Drives CursorCodec directly: lossless
 * per-type round-trips, HMAC tamper-evidence, sig/context binding, shape validation.
 *
 * Run ONLY this file: `node --test test/keyset-codec.test.ts` (no global-setup, no DB).
 */

const SECRET = 'unit-test-secret';

function sig(sortCanonical: string, filterCanonical = '[]', schemaVersion = 1, typeName = 't'): SigInput {
  return { typeName, sortCanonical, filterCanonical, schemaVersion };
}

test('codec: round-trips every type losslessly', () => {
  const codec = new CursorCodec(SECRET);
  const fieldTypes: SortFieldType[] = [
    { type: 'i32' },
    { type: 'f64' },
    { type: 'date' },
    { type: 'i64' },
    { type: 'decimal', scale: 2, precision: 10 },
    { type: 'bool' },
    { type: 'string' },
    { type: 'text' },
  ];
  const s = sig('views:a:nl,id:a:nl');
  const payload: CursorPayload = {
    v: 1,
    sortValues: [
      42,
      3.14159,
      1609459200000,
      9007199254740993n, // > 2^53, must survive as bigint
      12345n, // decimal mantissa for 123.45 @ scale 2
      true,
      'hello "world"',
      'a longer text value',
    ],
    id: 7,
  };
  const token = codec.encode(s, fieldTypes, payload);
  const out = codec.decode(s, fieldTypes, token);
  assert.equal(out.v, 1);
  assert.equal(out.id, 7);
  assert.deepEqual(out.sortValues, payload.sortValues);
  // bigints preserved exactly
  assert.equal(out.sortValues[3], 9007199254740993n);
  assert.equal(out.sortValues[4], 12345n);
});

test('codec: NULL marker round-trips as null', () => {
  const codec = new CursorCodec(SECRET);
  const fieldTypes: SortFieldType[] = [{ type: 'i32' }, { type: 'string' }];
  const s = sig('a:a:nl,b:a:nl,id:a:nl');
  const payload: CursorPayload = { v: 1, sortValues: [null, null], id: 3 };
  const out = codec.decode(s, fieldTypes, codec.encode(s, fieldTypes, payload));
  assert.deepEqual(out.sortValues, [null, null]);
});

test('codec: tampered body (flipped sortValue) is rejected', () => {
  const codec = new CursorCodec(SECRET);
  const fieldTypes: SortFieldType[] = [{ type: 'i32' }];
  const s = sig('v:a:nl,id:a:nl');
  const token = codec.encode(s, fieldTypes, { v: 1, sortValues: [10], id: 1 });
  // Decode the base64 body, flip a value, re-encode WITHOUT a valid sig.
  const json = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  json.sortValues = [11];
  const tampered = Buffer.from(JSON.stringify(json), 'utf8').toString('base64url');
  assert.throws(() => codec.decode(s, fieldTypes, tampered), InvalidCursorError);
});

test('codec: tampered id is rejected', () => {
  const codec = new CursorCodec(SECRET);
  const fieldTypes: SortFieldType[] = [{ type: 'i32' }];
  const s = sig('v:a:nl,id:a:nl');
  const token = codec.encode(s, fieldTypes, { v: 1, sortValues: [10], id: 1 });
  const json = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  json.id = 999;
  const tampered = Buffer.from(JSON.stringify(json), 'utf8').toString('base64url');
  assert.throws(() => codec.decode(s, fieldTypes, tampered), InvalidCursorError);
});

test('codec: sig mismatch on different sort spec is rejected', () => {
  const codec = new CursorCodec(SECRET);
  const fieldTypes: SortFieldType[] = [{ type: 'i32' }];
  const token = codec.encode(sig('v:a:nl,id:a:nl'), fieldTypes, { v: 1, sortValues: [10], id: 1 });
  assert.throws(() => codec.decode(sig('v:d:nf,id:a:nl'), fieldTypes, token), InvalidCursorError);
});

test('codec: sig mismatch on different filter is rejected', () => {
  const codec = new CursorCodec(SECRET);
  const fieldTypes: SortFieldType[] = [{ type: 'i32' }];
  const token = codec.encode(sig('v:a:nl,id:a:nl', '[]'), fieldTypes, { v: 1, sortValues: [10], id: 1 });
  assert.throws(() => codec.decode(sig('v:a:nl,id:a:nl', 'L(status|eq|x)'), fieldTypes, token), InvalidCursorError);
});

test('codec: cross-type replay is rejected (sig binds the content-type name)', () => {
  const codec = new CursorCodec(SECRET);
  const fieldTypes: SortFieldType[] = [{ type: 'i32' }];
  // Identical sort/filter/schemaVersion, only the type name differs.
  const token = codec.encode(sig('v:a:nl,id:a:nl', '[]', 1, 'articles'), fieldTypes, { v: 1, sortValues: [10], id: 1 });
  assert.throws(() => codec.decode(sig('v:a:nl,id:a:nl', '[]', 1, 'comments'), fieldTypes, token), InvalidCursorError);
});

test('codec: token body is exactly {v,sig,sortValues,id} — no dense row index ever encoded', () => {
  const codec = new CursorCodec(SECRET);
  const fieldTypes: SortFieldType[] = [{ type: 'i32' }, { type: 'string' }];
  const s = sig('a:a:nl,b:a:nl,id:a:nl');
  const token = codec.encode(s, fieldTypes, { v: 1, sortValues: [5, 'x'], id: 42 });
  const body = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(body).sort(), ['id', 'sig', 'sortValues', 'v']);
  assert.equal(body.id, 42); // the stable PK, not a 0..rowCount position
});

test('codec: schema-version bump is rejected (DDL invalidates old cursors)', () => {
  const codec = new CursorCodec(SECRET);
  const fieldTypes: SortFieldType[] = [{ type: 'i32' }];
  const token = codec.encode(sig('v:a:nl,id:a:nl', '[]', 1), fieldTypes, { v: 1, sortValues: [10], id: 1 });
  assert.throws(() => codec.decode(sig('v:a:nl,id:a:nl', '[]', 2), fieldTypes, token), InvalidCursorError);
});

test('codec: different secret is rejected', () => {
  const a = new CursorCodec(SECRET);
  const b = new CursorCodec('other-secret');
  const fieldTypes: SortFieldType[] = [{ type: 'i32' }];
  const s = sig('v:a:nl,id:a:nl');
  const token = a.encode(s, fieldTypes, { v: 1, sortValues: [10], id: 1 });
  assert.throws(() => b.decode(s, fieldTypes, token), InvalidCursorError);
});

test('codec: malformed base64url / non-JSON / wrong version / wrong length rejected', () => {
  const codec = new CursorCodec(SECRET);
  const fieldTypes: SortFieldType[] = [{ type: 'i32' }];
  const s = sig('v:a:nl,id:a:nl');
  // non-base64url alphabet
  assert.throws(() => codec.decode(s, fieldTypes, 'not base64!!'), InvalidCursorError);
  // valid base64url but not JSON
  const notJson = Buffer.from('not json at all', 'utf8').toString('base64url');
  assert.throws(() => codec.decode(s, fieldTypes, notJson), InvalidCursorError);
  // empty token
  assert.throws(() => codec.decode(s, fieldTypes, ''), InvalidCursorError);
  // oversized token
  assert.throws(() => codec.decode(s, fieldTypes, 'A'.repeat(9000)), InvalidCursorError);
  // wrong version
  const v2 = Buffer.from(JSON.stringify({ v: 2, sig: 'x', sortValues: [1], id: 0 }), 'utf8').toString('base64url');
  assert.throws(() => codec.decode(s, fieldTypes, v2), InvalidCursorError);
  // wrong sortValues length
  const wrongLen = codec.encode(s, fieldTypes, { v: 1, sortValues: [10], id: 1 });
  assert.throws(() => codec.decode(s, [{ type: 'i32' }, { type: 'i32' }], wrongLen), InvalidCursorError);
});

test('codec: sig of wrong length is rejected (length guard, no throw-through)', () => {
  const codec = new CursorCodec(SECRET);
  const fieldTypes: SortFieldType[] = [{ type: 'i32' }];
  const s = sig('v:a:nl,id:a:nl');
  const json = { v: 1, sig: 'deadbeef', sortValues: [10], id: 1 }; // short, wrong-length sig
  const token = Buffer.from(JSON.stringify(json), 'utf8').toString('base64url');
  assert.throws(() => codec.decode(s, fieldTypes, token), InvalidCursorError);
});
