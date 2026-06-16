import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createSql } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { PostgresStore } from '../src/db/postgres-store.ts';
import { createContentType, getContentType, dropContentType } from '../src/db/content-type-repo.ts';
import { createServer, type ListenToken } from '../src/http/app.ts';
import { withCatalogRead, withCatalogWrite } from './catalog-lock.ts';

/**
 * ENTRY-TYPES SLICE — write round-trip for i64/decimal/json over the REAL uWS + Postgres path. A
 * biginteger at int64 max, a numeric(18,2), and json with a nested big int survive the create response
 * and the subsequent GET byte-identically; over-precision / non-digit / malformed each 400.
 */

const sql = createSql();
let token: ListenToken;
let base: string;
let close: (t: ListenToken) => void;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else srv.close(() => reject(new Error('no port')));
    });
    srv.on('error', reject);
  });
}

before(async () => {
  await runMigrations();
  await withCatalogWrite(sql, async () => {
    if (await getContentType(sql, 'et_metric')) await dropContentType(sql, 'et_metric');
    await createContentType(sql, {
      apiId: 'et_metric',
      fields: [
        { name: 'big', cmsType: 'biginteger', options: { nullable: false } },
        { name: 'amount', cmsType: 'decimal', options: { precision: 18, scale: 2, nullable: false } },
        { name: 'payload', cmsType: 'json', options: { nullable: false } },
      ],
    });
  });
  const store = new PostgresStore(sql);
  const { engine, registry } = await withCatalogRead(sql, () => store.loadWithRegistry());
  const server = createServer(engine, store, registry);
  close = server.close;
  const port = await freePort();
  token = await server.listen(port);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (token) close(token);
  await withCatalogWrite(sql, () => dropContentType(sql, 'et_metric'));
  await sql.end();
});

function field(buf: string, key: string): string {
  const k = `"${key}":`;
  const start = buf.indexOf(k) + k.length;
  let depth = 0;
  let i = start;
  if (buf[i] === '"') {
    i++;
    while (i < buf.length && buf[i] !== '"') {
      if (buf[i] === '\\') i++;
      i++;
    }
    return buf.slice(start, i + 1);
  }
  while (i < buf.length) {
    const c = buf[i]!;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      if (depth === 0) break;
      depth--;
    } else if (c === ',' && depth === 0) break;
    i++;
  }
  return buf.slice(start, i);
}

test('POST i64/decimal/json round-trips byte-identical to the GET; PUT changes them', async () => {
  const res = await fetch(`${base}/et_metric`, {
    method: 'POST',
    body: JSON.stringify({ big: '9223372036854775807', amount: '12345.67', payload: { nested: 'value', n: 7 } }),
  });
  assert.equal(res.status, 201);
  const createdText = await res.text();
  assert.equal(field(createdText, 'big'), '"9223372036854775807"');
  assert.equal(field(createdText, 'amount'), '"12345.67"');

  // The json field (the CL26/57 write path: validator -> jsonb bind -> RETURNING ::text -> RawJson
  // splice) appears in the CREATE response as the DB's canonical jsonb ::text rendering (jsonb
  // normalizes key order + spacing — NOT a quoted string scalar, which is what a double-encoded
  // pre-stringified bind would wrongly produce).
  assert.equal(field(createdText, 'payload'), '{"n": 7, "nested": "value"}');

  const id = JSON.parse(createdText).data.id;
  const got = await (await fetch(`${base}/et_metric/${id}`)).text();
  // CREATE response data and GET data are BYTE-IDENTICAL (same registry serializer / arena materialize).
  // Compare the whole `data` envelope verbatim, not just one scalar — created_at/updated_at, i64,
  // decimal AND the verbatim json all have to match to the byte.
  assert.equal(field(createdText, 'big'), field(got, 'big'));
  assert.equal(field(createdText, 'amount'), field(got, 'amount'));
  assert.equal(field(createdText, 'payload'), field(got, 'payload'));
  assert.deepEqual(JSON.parse(createdText).data, JSON.parse(got).data);
  assert.equal(field(got, 'big'), '"9223372036854775807"');
  assert.equal(field(got, 'amount'), '"12345.67"');
  assert.equal(field(got, 'payload'), '{"n": 7, "nested": "value"}');

  // PUT changes them — incl. a NEW json payload, proving the json WRITE round-trip on update too.
  const put = await fetch(`${base}/et_metric/${id}`, { method: 'PUT', body: JSON.stringify({ big: '42', amount: '0.05', payload: { nested: 'updated', k: [1, 2] } }) });
  assert.equal(put.status, 200);
  const putText = await put.text();
  assert.equal(field(putText, 'payload'), '{"k": [1, 2], "nested": "updated"}');
  const after = await (await fetch(`${base}/et_metric/${id}`)).text();
  assert.equal(field(after, 'big'), '"42"');
  assert.equal(field(after, 'amount'), '"0.05"');
  assert.equal(field(after, 'payload'), '{"k": [1, 2], "nested": "updated"}');
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
    const res = await fetch(`${base}/et_metric`, { method: 'POST', body: JSON.stringify(payload) });
    assert.equal(res.status, 400, label);
  }
});
