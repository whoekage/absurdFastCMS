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
