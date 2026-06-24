// Slice 3.5 — harness smoke test (mock-free).
//
// Proves the integration harness end-to-end with NO MOCKS: startTestServer() clones a fresh per-file
// Postgres from the golden template and boots a REAL @conti/api uWS server over it; withType() seeds the
// canonical `article` content-type (the production ARTICLE_SEED_FIELDS spec) and live-syncs it into the
// running engine/registry. We then do a raw `fetch` GET against baseUrl/article (no SDK client yet — that
// is Slice 3) and assert the real wire returns HTTP 200 with a `{ data, meta }` list envelope. close()
// stops the listen socket and drops the per-file DB.
//
// This is the prerequisite the read/write/builder slices (4/5/6) build their tests on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, withType } from './server.ts';
import { ARTICLE_SEED_FIELDS } from '../../api/src/http/server.ts';

test('harness boots a real server and serves the seeded article type', async () => {
  const server = await startTestServer('harness-smoke');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_SEED_FIELDS }, async (apiId) => {
      const res = await fetch(`${server.baseUrl}/${apiId}`);
      assert.equal(res.status, 200, 'GET /article should return HTTP 200');

      const ct = res.headers.get('content-type') ?? '';
      assert.match(ct, /application\/json/, 'response should be JSON');

      const body = (await res.json()) as { data: unknown; meta: unknown };
      assert.ok('data' in body, 'envelope must have a `data` key');
      assert.ok('meta' in body, 'envelope must have a `meta` key');
      assert.ok(Array.isArray(body.data), '`data` must be an array for a list read');
      assert.ok(body.meta && typeof body.meta === 'object', '`meta` must be an object');
    });
  } finally {
    await server.close();
  }
});
