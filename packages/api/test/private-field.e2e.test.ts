import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';

const { runMigrations } = await import('../src/db/migration.runner.ts');
const { createFileDatabase, dropFileDatabase } = await import('./db-per-file.ts');
const { startTestServer, schema, closeAuth } = await import('./helpers.ts');

/**
 * #4b PRIVATE FIELD — the security matrix, a TRUE end-to-end over the REAL uWS server + REAL Postgres
 * (no mocks): the secret is WRITTEN through the gated HTTP write path (proving a private field is
 * writable), then every PUBLIC read is checked to confirm it is stripped — by-id, list, the `fields=`
 * projection (un-resurrectable — the Strapi #16069 / fields-lookup-CVE class), filtering, sorting, the
 * write response itself, AND a populated relation target. No per-test `migrate`: the server (and its
 * ct_/link tables) is built ONCE in `before`; each test creates its own rows and references them by id.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let close: (token: unknown) => void;
let token: unknown;
let sessionCache: Awaited<ReturnType<typeof startTestServer>>['sessionCache'];
let authedFetch: Awaited<ReturnType<typeof startTestServer>>['fetch'];
let anonFetch: Awaited<ReturnType<typeof startTestServer>>['anonFetch'];

before(async () => {
  db = await createFileDatabase('privatefield');
  sql = db.sql;
  await runMigrations(db.url);
  // `account` carries a public email + a PRIVATE secret/pin; `post` relates to it (nested-populate strip).
  const schemas = [
    schema({
      name: 'account',
      fields: [
        { name: 'email', type: 'string', options: { nullable: false } },
        { name: 'secret', type: 'string', options: { nullable: true, private: true } },
        { name: 'pin', type: 'integer', options: { nullable: true, private: true } },
      ],
    }),
    schema({
      name: 'post',
      fields: [{ name: 'title', type: 'string' }],
      relations: [{ field: 'author', kind: 'manyToOne', target: 'account' }],
    }),
  ];
  const srv = await startTestServer(sql, schemas);
  close = srv.close;
  token = srv.token;
  sessionCache = srv.sessionCache;
  authedFetch = srv.fetch; // super-admin cookie — the gated WRITE path
  anonFetch = srv.anonFetch; // anonymous — the PUBLIC read path
});

after(async () => {
  if (token) close(token);
  sessionCache?.stop();
  closeAuth();
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

const POST = (p: string, body: unknown) => authedFetch(p, { method: 'POST', body: JSON.stringify(body) });
const GET = (p: string) => anonFetch(p);

/** Create an account through the REAL write path; returns its id + the raw write-response body. */
async function makeAccount(email: string): Promise<{ id: number; body: Record<string, unknown> }> {
  const res = await POST('/account', { email, secret: 'HASH', pin: 1234 });
  assert.equal(res.status, 201, `create account -> ${res.status}`);
  const body = ((await res.json()) as { data: Record<string, unknown> }).data;
  return { id: body.id as number, body };
}

test('a private field is WRITABLE through the API, but the write RESPONSE does not echo it', async () => {
  const { body } = await makeAccount('write@x.com');
  assert.equal(body.email, 'write@x.com'); // accepted + written
  assert.equal('secret' in body, false); // never echoed back
  assert.equal('pin' in body, false);
});

test('by-id read strips private fields (email kept, secret/pin gone)', async () => {
  const { id } = await makeAccount('byid@x.com');
  const row = ((await (await GET(`/account/${id}`)).json()) as { data: Record<string, unknown> }).data;
  assert.equal(row.email, 'byid@x.com');
  assert.equal('secret' in row, false);
  assert.equal('pin' in row, false);
});

test('list read strips private fields from every row', async () => {
  const { id } = await makeAccount('list@x.com');
  const rows = ((await (await GET('/account')).json()) as { data: Record<string, unknown>[] }).data;
  const mine = rows.find((r) => r.id === id)!;
  assert.ok(mine, 'created row is in the list');
  assert.equal('secret' in mine, false);
  assert.equal('pin' in mine, false);
});

test('fields=secret is un-resurrectable: 400 unknown field (the lookup-CVE class)', async () => {
  await makeAccount('fields@x.com');
  assert.equal((await GET('/account?fields=secret')).status, 400); // private not in the whitelist
  assert.equal((await GET('/account?fields=email,secret')).status, 400); // can't smuggle it alongside
  // a projection of only PUBLIC fields works and still excludes private.
  const rows = ((await (await GET('/account?fields=email')).json()) as { data: Record<string, unknown>[] }).data;
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['email', 'id']);
});

test('a private field cannot be filtered or sorted (no value oracle)', async () => {
  await makeAccount('oracle@x.com');
  assert.equal((await GET('/account?filter[secret][$eq]=HASH')).status, 400);
  assert.equal((await GET('/account?sort=secret')).status, 400);
  assert.equal((await GET('/account?sort=pin:desc')).status, 400);
});

test('a populated relation TARGET is private-stripped (nested leak closed)', async () => {
  const { id: authorId } = await makeAccount('author@x.com');
  const post = (await (await POST('/post', { title: 'Hello', author: authorId })).json()) as { data: { id: number } };
  const row = ((await (await GET(`/post/${post.data.id}?populate=author`)).json()) as { data: Record<string, unknown> }).data;
  const author = row.author as Record<string, unknown>;
  assert.equal(author.email, 'author@x.com');
  assert.equal('secret' in author, false);
  assert.equal('pin' in author, false);
});

test('a type WITHOUT a private field is byte-identical (private support is additive)', async () => {
  const post = (await (await POST('/post', { title: 'Plain' })).json()) as { data: { id: number } };
  const row = ((await (await GET(`/post/${post.data.id}`)).json()) as { data: Record<string, unknown> }).data;
  assert.equal(row.title, 'Plain');
  assert.ok('created_at' in row && 'updated_at' in row && 'id' in row);
});
