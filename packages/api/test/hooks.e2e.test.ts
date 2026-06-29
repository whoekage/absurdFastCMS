import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { HookRegistry, HookError } from '../src/db/schema/hooks.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { schema, startTestServer, closeAuth, type TestServer } from './helpers.ts';

/**
 * Phase 4 — content lifecycle hooks over a REAL server + Postgres. Proves the two-class model:
 *  - `beforeCreate` TRANSFORMS the data (derives `slug` from `title`) — the return-value mutation contract,
 *    and the transform lands in the persisted row.
 *  - `afterCreate` fires AFTER commit (post-rebuild) with the committed row — side-effect observed.
 *  - `beforeUpdate` VETOES by throwing HookError → 400, and the write ROLLS BACK (row unchanged).
 *  - an `afterCreate` that throws is swallowed (post-commit, never fatal): the create still 201s.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let server: TestServer;
const afterIds: number[] = [];

before(async () => {
  db = await createFileDatabase('hooks');
  sql = db.sql;
  const widget = schema({
    name: 'widget',
    fields: [
      { name: 'title', cmsType: 'string', options: { nullable: true } },
      { name: 'slug', cmsType: 'string', options: { nullable: true } },
    ],
  });

  const hooks = new HookRegistry(
    new Map([
      [
        'widget',
        {
          // TRANSFORM: derive slug from title (return-value contract).
          beforeCreate: (data) => ({ ...data, slug: String(data['title'] ?? '').toLowerCase() }),
          // REACT (post-commit): record the committed id; a throw here must NOT fail the request.
          afterCreate: (entry) => {
            afterIds.push(Number(entry['id']));
            throw new Error('after-hooks must be non-fatal'); // swallowed + logged
          },
          // VETO: block a specific update.
          beforeUpdate: (data) => {
            if (data['title'] === 'BLOCK') throw new HookError('update blocked by policy');
            return data;
          },
        },
      ],
    ]),
  );

  server = await startTestServer(sql, [widget], { hooks });
});

after(async () => {
  if (server) {
    server.close(server.token);
    server.sessionCache.stop();
  }
  closeAuth();
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

test('beforeCreate transforms the data; afterCreate fires post-commit (and its throw is non-fatal)', async () => {
  const res = await server.fetch('/widget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Hello' }) });
  assert.equal(res.status, 201); // afterCreate threw, but post-commit → swallowed → still 201
  const body = (await res.json()) as { data: { id: number; title: string; slug: string } };
  assert.equal(body.data.title, 'Hello');
  assert.equal(body.data.slug, 'hello'); // the before-hook derived + persisted slug
  assert.ok(afterIds.includes(body.data.id), 'afterCreate ran post-commit with the committed id');
});

test('beforeUpdate vetoes with HookError → 400 and the write ROLLS BACK (row unchanged)', async () => {
  const created = (await (await server.fetch('/widget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Keep' }) })).json()) as { data: { id: number } };
  const id = created.data.id;

  const blocked = await server.fetch(`/widget/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'BLOCK' }) });
  assert.equal(blocked.status, 400);
  const err = (await blocked.json()) as { error: string };
  assert.match(err.error, /update blocked by policy/);

  // rollback: the row still has its original title (public read).
  const got = (await (await server.anonFetch(`/widget/${id}`)).json()) as { data: { title: string } };
  assert.equal(got.data.title, 'Keep');
});
