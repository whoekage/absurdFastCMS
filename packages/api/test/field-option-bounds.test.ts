import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../src/db/registry.ts';
import { validateBody, BodyParseError } from '../src/db/body.parser.ts';
import { schema } from './helpers.ts';

/**
 * Write-time enforcement of the deferred field options (no DB — validateBody is pure over a Registry def):
 *  - biginteger / decimal VALUE bounds compared via BigInt / scaled-BigInt (never a lossy JS number);
 *  - array item guards (minItems / maxItems / uniqueItems) + must-be-an-array.
 */

const reg = Registry.fromSchemas([
  schema({
    name: 'bounded',
    fields: [
      { name: 'big', type: 'biginteger', options: { nullable: true, min: '-100', max: '9007199254740993' } },
      { name: 'price', type: 'decimal', options: { precision: 10, scale: 2, nullable: true, min: '0', max: '100.00' } },
      { name: 'tags', type: 'array', options: { nullable: true, uniqueItems: true, minItems: 1, maxItems: 3 } },
    ],
  }),
]);
const def = reg.get('bounded')!;
const ok = (raw: Record<string, unknown>) => assert.doesNotThrow(() => validateBody(def, raw, 'create', reg));
const bad = (raw: Record<string, unknown>) => assert.throws(() => validateBody(def, raw, 'create', reg), BodyParseError);

test('biginteger value bounds are enforced via BigInt (exact past 2^53)', () => {
  ok({ big: '9007199254740993' }); // == max, accepted exactly
  ok({ big: '-100' }); // == min
  bad({ big: '9007199254740994' }); // > max
  bad({ big: '-101' }); // < min
});

test('decimal value bounds are enforced via the scaled mantissa', () => {
  ok({ price: '100.00' });
  ok({ price: '0' });
  bad({ price: '100.01' }); // > max
  bad({ price: '-0.01' }); // < min
});

test('array item guards: count bounds + uniqueItems + must be an array', () => {
  ok({ tags: ['a', 'b'] });
  bad({ tags: [] }); // < minItems 1
  bad({ tags: ['a', 'b', 'c', 'd'] }); // > maxItems 3
  bad({ tags: ['a', 'a'] }); // duplicate (uniqueItems)
  bad({ tags: 'not-an-array' }); // array field must receive an array
});

// date/datetime min/max — absolute bounds + relative `$now` tokens resolved against the request instant.
const dated = Registry.fromSchemas([
  schema({
    name: 'dated',
    fields: [
      { name: 'born', type: 'date', options: { nullable: true, min: '2000-01-01', max: '2020-12-31' } },
      { name: 'at', type: 'datetime', options: { nullable: true, min: '2000-01-01T00:00:00Z' } },
      { name: 'past', type: 'datetime', options: { nullable: true, max: '$now' } },
      { name: 'recent', type: 'date', options: { nullable: true, min: '$now(-7 days)' } },
    ],
  }),
]);
const ddef = dated.get('dated')!;
const dok = (raw: Record<string, unknown>) => assert.doesNotThrow(() => validateBody(ddef, raw, 'create', dated));
const dbad = (raw: Record<string, unknown>) => assert.throws(() => validateBody(ddef, raw, 'create', dated), BodyParseError);

test('date calendar bounds are inclusive + UTC-truncated', () => {
  dok({ born: '2000-01-01' }); // == min
  dok({ born: '2020-12-31' }); // == max
  dok({ born: '2010-06-15' });
  dbad({ born: '1999-12-31' }); // < min
  dbad({ born: '2021-01-01' }); // > max
});

test('datetime instant bounds (inclusive)', () => {
  dok({ at: '2000-01-01T00:00:00Z' }); // == min
  dbad({ at: '1999-12-31T23:59:59Z' }); // < min
});

test('relative $now bounds resolve against the request instant', () => {
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  dok({ past: yesterday }); // before $now → ok
  dbad({ past: tomorrow }); // after $now → rejected
  // recent: a date on/after $now(-7 days). 30 days ago is out; today is in.
  const days = (n: number) => new Date(Date.now() + n * 24 * 3600 * 1000).toISOString().slice(0, 10);
  dok({ recent: days(0) });
  dbad({ recent: days(-30) });
});

// media COUNT bounds (minItems/maxItems on a MULTIPLE field) — pure body-parser guard (no DB / mime here).
const galleries = Registry.fromSchemas([
  schema({
    name: 'gallery',
    fields: [{ name: 'photos', type: 'media', options: { nullable: true, multiple: true, minItems: 1, maxItems: 2 } }],
  }),
]);
const gdef = galleries.get('gallery')!;

test('multiple-media count bounds are enforced (distinct ids)', () => {
  assert.doesNotThrow(() => validateBody(gdef, { photos: [10] }, 'create', galleries)); // == min
  assert.doesNotThrow(() => validateBody(gdef, { photos: [10, 11] }, 'create', galleries)); // == max
  assert.throws(() => validateBody(gdef, { photos: [] }, 'create', galleries), BodyParseError); // < min
  assert.throws(() => validateBody(gdef, { photos: [10, 11, 12] }, 'create', galleries), BodyParseError); // > max
});

// string/text regex pattern — RE2 full-match enforcement (ReDoS-safe).
const patterned = Registry.fromSchemas([
  schema({
    name: 'patterned',
    fields: [
      { name: 'sku', type: 'string', options: { nullable: true, pattern: '\\d{3}-[A-Z]{2}', patternMessage: 'must look like 123-AB' } },
      { name: 'slug', type: 'text', options: { nullable: true, pattern: '[a-z0-9-]+' } },
      { name: 'evil', type: 'text', options: { nullable: true, pattern: '(?:a+)+' } }, // catastrophic for a backtracking engine
    ],
  }),
]);
const pdef = patterned.get('patterned')!;

test('regex pattern is FULL-match (anchored), not partial', () => {
  assert.doesNotThrow(() => validateBody(pdef, { sku: '123-AB' }, 'create', patterned));
  assert.throws(() => validateBody(pdef, { sku: '123-ABC' }, 'create', patterned), BodyParseError); // trailing char
  assert.throws(() => validateBody(pdef, { sku: 'x123-AB' }, 'create', patterned), BodyParseError); // leading char
  assert.throws(() => validateBody(pdef, { sku: '12-AB' }, 'create', patterned), BodyParseError); // too few digits
  assert.doesNotThrow(() => validateBody(pdef, { slug: 'hello-world-2' }, 'create', patterned));
  assert.throws(() => validateBody(pdef, { slug: 'Hello World' }, 'create', patterned), BodyParseError);
});

test('the custom patternMessage is surfaced on failure', () => {
  assert.throws(
    () => validateBody(pdef, { sku: 'nope' }, 'create', patterned),
    (e: unknown) => e instanceof BodyParseError && /123-AB/.test(e.message),
  );
});

test('a catastrophic pattern + long non-matching input returns FAST (RE2 is linear, no ReDoS)', () => {
  const start = Date.now();
  // A backtracking engine would hang on `(?:a+)+` with a long non-matching input; RE2 returns ~instantly.
  assert.throws(() => validateBody(pdef, { evil: `${'a'.repeat(50)}!` }, 'create', patterned), BodyParseError);
  assert.ok(Date.now() - start < 1000, 'pattern match must be linear-time');
});
