import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { createContentType } from '../src/db/content-type-repo.ts';
import type { ListenToken } from '../src/http/app.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { rawField, startTestServer } from './helpers.ts';

/**
 * ENTRY-TYPES SLICE — write round-trip for i64/decimal/json over the REAL uWS + Postgres path. A
 * biginteger at int64 max, a numeric(18,2), and json with a nested big int survive the create response
 * and the subsequent GET byte-identically; over-precision / non-digit / malformed each 400.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let token: ListenToken;
let base: string;
let close: (t: ListenToken) => void;

before(async () => {
  db = await createFileDatabase('et');
  sql = db.sql;
  await createContentType(sql, {
    apiId: 'metric',
    fields: [
      { name: 'big', cmsType: 'biginteger', options: { nullable: false } },
      { name: 'amount', cmsType: 'decimal', options: { precision: 18, scale: 2, nullable: false } },
      { name: 'payload', cmsType: 'json', options: { nullable: false } },
    ],
  });
  const server = await startTestServer(sql);
  close = server.close;
  token = server.token;
  base = server.base;
});

after(async () => {
  if (token) close(token);
  // Guard so a failing before() (db/sql undefined) surfaces the real error, not a deref of undefined.
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

test('POST i64/decimal/json round-trips byte-identical to the GET; PUT changes them', async () => {
  const res = await fetch(`${base}/metric`, {
    method: 'POST',
    body: JSON.stringify({ big: '9223372036854775807', amount: '12345.67', payload: { nested: 'value', n: 7 } }),
  });
  assert.equal(res.status, 201);
  const createdText = await res.text();
  assert.equal(rawField(createdText, 'big'), '"9223372036854775807"');
  assert.equal(rawField(createdText, 'amount'), '"12345.67"');

  // The json field (the CL26/57 write path: validator -> jsonb bind -> RETURNING ::text -> RawJson
  // splice) appears in the CREATE response as the DB's canonical jsonb ::text rendering (jsonb
  // normalizes key order + spacing — NOT a quoted string scalar, which is what a double-encoded
  // pre-stringified bind would wrongly produce).
  assert.equal(rawField(createdText, 'payload'), '{"n": 7, "nested": "value"}');

  const id = JSON.parse(createdText).data.id;
  const got = await (await fetch(`${base}/metric/${id}`)).text();
  // CREATE response data and GET data are BYTE-IDENTICAL (same registry serializer / arena materialize).
  // Compare the whole `data` envelope verbatim, not just one scalar — created_at/updated_at, i64,
  // decimal AND the verbatim json all have to match to the byte.
  assert.equal(rawField(createdText, 'big'), rawField(got, 'big'));
  assert.equal(rawField(createdText, 'amount'), rawField(got, 'amount'));
  assert.equal(rawField(createdText, 'payload'), rawField(got, 'payload'));
  assert.deepEqual(JSON.parse(createdText).data, JSON.parse(got).data);
  assert.equal(rawField(got, 'big'), '"9223372036854775807"');
  assert.equal(rawField(got, 'amount'), '"12345.67"');
  assert.equal(rawField(got, 'payload'), '{"n": 7, "nested": "value"}');

  // PUT changes them — incl. a NEW json payload, proving the json WRITE round-trip on update too.
  const put = await fetch(`${base}/metric/${id}`, { method: 'PUT', body: JSON.stringify({ big: '42', amount: '0.05', payload: { nested: 'updated', k: [1, 2] } }) });
  assert.equal(put.status, 200);
  const putText = await put.text();
  assert.equal(rawField(putText, 'payload'), '{"k": [1, 2], "nested": "updated"}');
  const after = await (await fetch(`${base}/metric/${id}`)).text();
  assert.equal(rawField(after, 'big'), '"42"');
  assert.equal(rawField(after, 'amount'), '"0.05"');
  assert.equal(rawField(after, 'payload'), '{"k": [1, 2], "nested": "updated"}');
  // The PUT response and the subsequent GET are byte-identical too.
  assert.deepEqual(JSON.parse(putText).data, JSON.parse(after).data);
});

test('invalid i64/decimal/json -> 400', async () => {
  const cases: Record<string, unknown> = {
    'over-precision decimal': { big: '1', amount: '123456789012345678.99', payload: {} },
    'non-digit i64': { big: 'abc', amount: '1.00', payload: {} },
    'malformed json (string body)': { big: '1', amount: '1.00', payload: '{not json' },
  };
  for (const [label, payload] of Object.entries(cases)) {
    const res = await fetch(`${base}/metric`, { method: 'POST', body: JSON.stringify(payload) });
    assert.equal(res.status, 400, label);
  }
});
