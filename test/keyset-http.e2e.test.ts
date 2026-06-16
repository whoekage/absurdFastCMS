import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/http/router.ts';
import { Engine } from '../src/store/engine.ts';
import { CursorCodec } from '../src/store/cursor-codec.ts';
import type { FieldDef } from '../src/store/table.ts';

/**
 * KEYSET HTTP end-to-end (router level). This DOES run mock-free in-process (no Testcontainers, no
 * socket) — it drives the pure `handleRequest` core over an in-RAM Engine. It is left SKIPPED in the
 * agent run per the workflow contract (the LEAD runs the full suite); flip `skip` to false to run it.
 *
 * Covers: a full cursor scroll over GET /:type, a sig-mismatched cursor -> 400, a malformed cursor
 * -> 400. The cursor is opaque to the client.
 */

const FIELDS: FieldDef[] = [
  { name: 'id', type: 'i32' },
  { name: 'views', type: 'i32' },
];

function engine(): Engine {
  const eng = new Engine({ cursorCodec: new CursorCodec('e2e-secret') });
  const t = eng.define('article', FIELDS);
  t.createEqIndex('id');
  for (let i = 0; i < 12; i++) eng.insert('article', { id: i + 1, views: (i * 5) % 7 });
  t.warmIndexes();
  return eng;
}

test('e2e: full cursor scroll + sig-mismatch 400 + malformed 400', () => {
  const eng = engine();
  const get = (q: string) => handleRequest(eng, { method: 'GET', path: '/article', query: q });

  // First page (empty cursor bootstrap).
  let res = get('sort=views:asc&pagination[pageSize]=4&pagination[cursor]=');
  assert.equal(res.status, 200);
  let body = JSON.parse(res.body.toString('utf8'));
  const all: number[] = body.data.map((r: any) => r.id);
  let next = body.meta.pagination.nextCursor;
  while (body.meta.pagination.hasNextPage) {
    res = get(`sort=views:asc&pagination[pageSize]=4&pagination[cursor]=${encodeURIComponent(next)}`);
    body = JSON.parse(res.body.toString('utf8'));
    for (const r of body.data) all.push(r.id);
    next = body.meta.pagination.nextCursor;
  }
  assert.equal(all.length, 12);

  // sig mismatch: reuse a valid cursor under a DIFFERENT sort -> 400.
  res = get('sort=views:asc&pagination[pageSize]=4&pagination[cursor]=');
  const validCursor = JSON.parse(res.body.toString('utf8')).meta.pagination.nextCursor;
  const mism = get(`sort=views:desc&pagination[pageSize]=4&pagination[cursor]=${encodeURIComponent(validCursor)}`);
  assert.equal(mism.status, 400);

  // malformed cursor -> 400.
  const bad = get('sort=views:asc&pagination[pageSize]=4&pagination[cursor]=not-a-real-cursor!!');
  assert.equal(bad.status, 400);
});
