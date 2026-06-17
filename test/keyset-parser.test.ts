import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, QueryParseError } from '../src/store/query.parser.ts';
import type { FieldDef } from '../src/store/table.ts';

/**
 * KEYSET parser — PURE-RAM, no DB. Drives parseQuery directly: the additive cursor/before/pageSize/
 * withCount params, mutual exclusivity, defaults, and back-compat (pageSize-alone stays offset/page).
 *
 * Run ONLY this file: `node --test test/keyset-parser.test.ts`.
 */

const FIELDS: FieldDef[] = [
  { name: 'id', type: 'i32' },
  { name: 'views', type: 'i32' },
  { name: 'title', type: 'string' },
];

test('parser: cursor + pageSize + withCount enters keyset mode', () => {
  const { options } = parseQuery(FIELDS, 'sort=views:asc&pagination[cursor]=abc&pagination[pageSize]=10&pagination[withCount]=true');
  assert.ok(options.keysetRaw);
  assert.equal(options.keysetRaw!.cursorToken, 'abc');
  assert.equal(options.keysetRaw!.beforeToken, undefined);
  assert.equal(options.keysetRaw!.pageSize, 10);
  assert.equal(options.keysetRaw!.withCount, true);
  assert.equal(options.offset, undefined);
  assert.equal(options.limit, undefined);
});

test('parser: before enters backward keyset mode', () => {
  const { options } = parseQuery(FIELDS, 'pagination[before]=xyz');
  assert.ok(options.keysetRaw);
  assert.equal(options.keysetRaw!.beforeToken, 'xyz');
  assert.equal(options.keysetRaw!.cursorToken, undefined);
  assert.equal(options.keysetRaw!.pageSize, 25); // default
  assert.equal(options.keysetRaw!.withCount, false); // default
});

test('parser: pageSize-alone stays legacy page (offset) mode', () => {
  const { options } = parseQuery(FIELDS, 'pagination[pageSize]=10');
  assert.equal(options.keysetRaw, undefined);
  assert.equal(options.offset, 0);
  assert.equal(options.limit, 10);
});

test('parser: page+pageSize stays offset mode byte-for-byte', () => {
  const { options } = parseQuery(FIELDS, 'pagination[page]=3&pagination[pageSize]=10');
  assert.equal(options.keysetRaw, undefined);
  assert.equal(options.offset, 20);
  assert.equal(options.limit, 10);
});

test('parser: start/limit stays offset mode', () => {
  const { options } = parseQuery(FIELDS, 'pagination[start]=5&pagination[limit]=15');
  assert.equal(options.keysetRaw, undefined);
  assert.equal(options.offset, 5);
  assert.equal(options.limit, 15);
});

test('parser: cursor + before rejected', () => {
  assert.throws(() => parseQuery(FIELDS, 'pagination[cursor]=a&pagination[before]=b'), QueryParseError);
});

test('parser: cursor + page rejected', () => {
  assert.throws(() => parseQuery(FIELDS, 'pagination[cursor]=a&pagination[page]=2'), QueryParseError);
});

test('parser: before + start rejected', () => {
  assert.throws(() => parseQuery(FIELDS, 'pagination[before]=a&pagination[start]=2'), QueryParseError);
});

test('parser: page + start still rejected (back-compat)', () => {
  assert.throws(() => parseQuery(FIELDS, 'pagination[page]=1&pagination[start]=2'), QueryParseError);
});

test('parser: pageSize=0 rejected in cursor mode', () => {
  assert.throws(() => parseQuery(FIELDS, 'pagination[cursor]=a&pagination[pageSize]=0'), QueryParseError);
});

test('parser: withCount non-bool rejected', () => {
  assert.throws(() => parseQuery(FIELDS, 'pagination[cursor]=a&pagination[withCount]=yes'), QueryParseError);
});

test('parser: unknown pagination key rejected', () => {
  assert.throws(() => parseQuery(FIELDS, 'pagination[bogus]=1'), QueryParseError);
});

test('parser: empty cursor token is the keyset-mode bootstrap (accepted)', () => {
  const { options } = parseQuery(FIELDS, 'sort=views:asc&pagination[cursor]=');
  assert.ok(options.keysetRaw);
  assert.equal(options.keysetRaw!.cursorToken, '');
});

test('parser: empty before token rejected (only cursor= bootstraps)', () => {
  assert.throws(() => parseQuery(FIELDS, 'pagination[before]='), QueryParseError);
});

test('parser: withCount in page mode rejected (only valid with cursor/before)', () => {
  assert.throws(() => parseQuery(FIELDS, 'pagination[page]=1&pagination[withCount]=true'), QueryParseError);
});

test('parser: withCount in start/limit mode rejected', () => {
  assert.throws(() => parseQuery(FIELDS, 'pagination[start]=0&pagination[limit]=5&pagination[withCount]=true'), QueryParseError);
});

test('parser: bare withCount (no other knob) rejected', () => {
  assert.throws(() => parseQuery(FIELDS, 'pagination[withCount]=true'), QueryParseError);
});
