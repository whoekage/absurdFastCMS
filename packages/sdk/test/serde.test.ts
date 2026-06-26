// Slice 7 — wire fidelity: schema-aware (de)serialization, verified against the REAL server.
//
// NO MOCKS: every value under test is written to (and read back from) the real @conti/api uWS server
// over a fresh per-file Postgres. We pin the documented wire facts with REAL values:
//   • biginteger > 2^53 arrives as a QUOTED STRING and survives lossless (string default; BigInt opt-in);
//   • decimal keeps its fixed scale as a string (never widened, never Number()-coerced);
//   • json round-trips byte-exact (nested values);
//   • date / datetime arrive as ISO strings (Date opt-in);
//   • encodeEntry lowers Date → ISO and bigint → string so a write body is accepted by the api.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, withType } from './server.ts';
import {
  createClient,
  decodeEntry,
  encodeEntry,
  isLosslessBigDecode,
  assertNoNumberCoercion,
  type ModuleDefinition,
  type FieldDefinition,
} from '../src/index.ts';

/** A module exercising every lossy-prone wire type. */
const WIRE_FIELDS = [
  { name: 'big', cmsType: 'biginteger' as const },
  { name: 'price', cmsType: 'decimal' as const, options: { precision: 12, scale: 2 } },
  { name: 'payload', cmsType: 'json' as const },
  { name: 'day', cmsType: 'date' as const },
  { name: 'at', cmsType: 'datetime' as const },
  { name: 'count', cmsType: 'integer' as const },
];

/** A biginteger well above 2^53 (Number would round it) and a fixed-scale decimal. */
const BIG = '9007199254740993'; // 2^53 + 1 — the canonical IEEE-754 collision.
const HUGE = '92233720368547758'; // far beyond 2^53.
const PRICE = '1234567890.55';

// NOTE (legacy-meta teardown): the Builder route GET /modules/:apiId (which returned the projected
// def) was removed — the SDK no longer fetches defs over the wire. decodeEntry only needs each field's
// { name, cmsType }, so we build the decode def locally from WIRE_FIELDS (system fields prepended).
function wireDef(apiId: string): ModuleDefinition {
  const sys = (name: string, cmsType: FieldDefinition['cmsType']): FieldDefinition => ({ name, cmsType, nullable: name !== 'id', system: true });
  return {
    apiId,
    relations: [],
    fields: [
      sys('id', 'integer'), sys('created_at', 'datetime'), sys('updated_at', 'datetime'),
      ...WIRE_FIELDS.map((f): FieldDefinition => ({
        name: f.name,
        cmsType: f.cmsType,
        nullable: (f as { options?: { nullable?: boolean } }).options?.nullable ?? true,
        system: false,
        ...((f as { options?: { scale?: number } }).options?.scale !== undefined ? { scale: (f as { options: { scale: number } }).options.scale } : {}),
      })),
    ],
  };
}

test('biginteger > 2^53 round-trips lossless as a string; BigInt opt-in is exact', async () => {
  const server = await startTestServer('serde-bigint');
  try {
    await withType(server, { apiId: 'wire', fields: WIRE_FIELDS }, async (apiId) => {
      const client = server.mkClient();
      const def = wireDef(apiId);

      const created = await client.create(apiId, {
        big: HUGE,
        price: PRICE,
        payload: { a: 1, nested: { b: [true, null, 'x'] } },
        day: '2026-06-18',
        at: new Date(Date.UTC(2026, 5, 18, 12, 0, 0)).toISOString(),
        count: 5,
      });
      const id = created.data.id as number;

      // Wire fact: biginteger/decimal arrive as QUOTED STRINGS.
      const raw = (await client.findOne(apiId, id)).data;
      assert.equal(typeof raw['big'], 'string');
      assert.equal(raw['big'], HUGE);
      assert.equal(typeof raw['price'], 'string');

      // Default decode keeps them strings — NEVER Number()-coerced.
      const def0 = decodeEntry(def, raw);
      assert.equal(def0['big'], HUGE);
      assert.ok(isLosslessBigDecode(HUGE, def0['big']));

      // BigInt opt-in is EXACT for arbitrary magnitude.
      const dec = decodeEntry(def, raw, { bigints: true });
      assert.equal(typeof dec['big'], 'bigint');
      assert.equal(dec['big'], BigInt(HUGE));
      assert.ok(isLosslessBigDecode(HUGE, dec['big']));

      // The lossy path the module forbids: Number() collides at 2^53+1.
      assert.equal(Number(BIG), Number('9007199254740992'));
      assert.equal(isLosslessBigDecode(BIG, Number(BIG)), false);
    });
  } finally {
    await server.close();
  }
});

test('decimal keeps its fixed scale as a string and is never widened', async () => {
  const server = await startTestServer('serde-decimal');
  try {
    await withType(server, { apiId: 'wire', fields: WIRE_FIELDS }, async (apiId) => {
      const client = server.mkClient();
      const def = wireDef(apiId);

      const created = await client.create(apiId, {
        big: '1',
        price: '10.50', // trailing zero is significant at scale 2.
        payload: {},
        day: '2026-01-01',
        at: new Date().toISOString(),
        count: 0,
      });
      const raw = (await client.findOne(apiId, created.data.id as number)).data;

      assert.equal(typeof raw['price'], 'string');
      assert.equal(raw['price'], '10.50'); // scale preserved on the wire.

      // decimal stays a string even with both opt-ins enabled (no JS primitive is exact-scale + big).
      const dec = decodeEntry(def, raw, { bigints: true, dates: true });
      assert.equal(typeof dec['price'], 'string');
      assert.equal(dec['price'], '10.50');
      assert.ok(isLosslessBigDecode('10.50', dec['price']));
    });
  } finally {
    await server.close();
  }
});

test('json round-trips byte-exact (nested values)', async () => {
  const server = await startTestServer('serde-json');
  try {
    await withType(server, { apiId: 'wire', fields: WIRE_FIELDS }, async (apiId) => {
      const client = server.mkClient();
      const def = wireDef(apiId);

      const payload = { s: 'héllo', n: 3.14, arr: [1, 2, { deep: true }], nul: null, o: { x: { y: 'z' } } };
      const created = await client.create(apiId, {
        big: '0',
        price: '0.00',
        payload,
        day: '2026-01-01',
        at: new Date().toISOString(),
        count: 0,
      });
      const raw = (await client.findOne(apiId, created.data.id as number)).data;

      assert.deepEqual(raw['payload'], payload);
      const dec = decodeEntry(def, raw);
      assert.deepEqual(dec['payload'], payload); // decode leaves json untouched.
    });
  } finally {
    await server.close();
  }
});

test('date/datetime arrive as ISO strings; { dates: true } yields a Date', async () => {
  const server = await startTestServer('serde-dates');
  try {
    await withType(server, { apiId: 'wire', fields: WIRE_FIELDS }, async (apiId) => {
      const client = server.mkClient();
      const def = wireDef(apiId);

      const at = new Date(Date.UTC(2026, 5, 18, 9, 30, 0));
      const created = await client.create(apiId, {
        big: '0',
        price: '0.00',
        payload: {},
        day: '2026-06-18',
        at: at.toISOString(),
        count: 0,
      });
      const raw = (await client.findOne(apiId, created.data.id as number)).data;

      assert.equal(typeof raw['at'], 'string'); // ISO string on the wire.
      const def0 = decodeEntry(def, raw);
      assert.equal(typeof def0['at'], 'string'); // default keeps ISO string.

      const dec = decodeEntry(def, raw, { dates: true });
      assert.ok(dec['at'] instanceof Date);
      assert.equal((dec['at'] as Date).getTime(), at.getTime());
      assert.ok(dec['day'] instanceof Date);
    });
  } finally {
    await server.close();
  }
});

test('encodeEntry lowers Date -> ISO and bigint -> string; the api accepts the body', async () => {
  const server = await startTestServer('serde-encode');
  try {
    await withType(server, { apiId: 'wire', fields: WIRE_FIELDS }, async (apiId) => {
      const client = server.mkClient();
      const def = wireDef(apiId);

      const at = new Date(Date.UTC(2026, 5, 18, 0, 0, 0));
      const body = encodeEntry(def, {
        big: BigInt(HUGE), // bigint -> string
        price: '5.00',
        payload: { ok: true },
        day: '2026-06-18',
        at, // Date -> ISO
        count: 7,
      });
      assert.equal(body['big'], HUGE);
      assert.equal(body['at'], at.toISOString());

      const created = await client.create(apiId, body);
      const raw = (await client.findOne(apiId, created.data.id as number)).data;
      assert.equal(raw['big'], HUGE);
      assert.equal(typeof raw['big'], 'string');

      const dec = decodeEntry(def, raw, { bigints: true });
      assert.equal(dec['big'], BigInt(HUGE));
    });
  } finally {
    await server.close();
  }
});

test('listDecoded / findOneDecoded apply decodeEntry with a supplied def', async () => {
  const server = await startTestServer('serde-client-convenience');
  try {
    await withType(server, { apiId: 'wire', fields: WIRE_FIELDS }, async (apiId) => {
      const client = server.mkClient();
      const def: ModuleDefinition = wireDef(apiId);

      const created = await client.create(apiId, {
        big: HUGE,
        price: '3.50',
        payload: { k: 'v' },
        day: '2026-06-18',
        at: new Date().toISOString(),
        count: 1,
      });
      const id = created.data.id as number;

      const single = await client.findOneDecoded(apiId, id, def, { bigints: true, dates: true });
      assert.equal(typeof single.data['big'], 'bigint');
      assert.ok(single.data['at'] instanceof Date);
      assert.equal(typeof single.data['price'], 'string');

      const listed = await client.listDecoded(apiId, def, {}, { bigints: true });
      const row = listed.data.find((r) => r['id'] === id)!;
      assert.equal(typeof row['big'], 'bigint');
      assert.equal(row['big'], BigInt(HUGE));
      assert.ok('pagination' in listed.meta);
    });
  } finally {
    await server.close();
  }
});

test('assertNoNumberCoercion throws for a number, passes for string/bigint', () => {
  assert.throws(() => assertNoNumberCoercion('big', 9007199254740993), RangeError);
  assert.doesNotThrow(() => assertNoNumberCoercion('big', '9007199254740993'));
  assert.doesNotThrow(() => assertNoNumberCoercion('big', BigInt(HUGE)));
});
