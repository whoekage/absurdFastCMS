// @conti/sdk — Slice 8.2/8.3/8.4 DX: bound collection, retries/timeout, request/response hooks.
//
// NO MOCKS:
//   • The bound COLLECTION is verified against the REAL @conti/api uWS server (startTestServer) — a
//     full create → read-back → list/count → update → delete lifecycle through client.collection<T>().
//   • The HOOKS (onRequest/onResponse) are verified against that same real server (they fire on a real
//     GET and a real POST, see the real Response/status).
//   • RETRIES / TIMEOUT are verified against a REAL local node:http server (genuine sockets, not a stub)
//     that is scripted to fail-then-succeed / hang — exercising the retry loop and the timeout abort
//     over the actual transport. No SDK internals are mocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { startTestServer, withType } from './server.ts';
import { ARTICLE_SEED_FIELDS } from '../../api/src/http/server.ts';
import { createClient, ServerError, type Entry } from '../src/index.ts';

interface Article extends Entry {
  id: number;
  title: string;
  views: number;
}

function articleBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Hello',
    body: 'the body',
    status: 'published',
    views: 42,
    rating: 1.5,
    active: true,
    publishedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    ...over,
  };
}

// === 8.2 — bound collection (real server) =======================================================

test('collection<T>() binds the type across the full CRUD lifecycle', async () => {
  const server = await startTestServer('dx-collection');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_SEED_FIELDS }, async (apiId) => {
      const client = createClient({ baseUrl: server.baseUrl });
      const articles = client.collection<Article>(apiId);

      assert.equal(articles.type, apiId);

      const created = await articles.create(articleBody({ title: 'Bound', views: 7 }));
      const id = created.data.id;
      assert.equal(created.data.title, 'Bound');

      const back = await articles.findOne(id);
      assert.equal(back.data.id, id);

      const missing = await articles.findOneOrNull(999_999);
      assert.equal(missing, null);

      const listed = await articles.list();
      assert.equal(listed.data.length, 1);

      assert.equal(await articles.count(), 1);
      assert.equal(await articles.count({ views: { $gte: 7 } }), 1);
      assert.equal(await articles.count({ views: { $gte: 8 } }), 0);

      const updated = await articles.update(id, { title: 'Renamed' });
      assert.equal(updated.data.title, 'Renamed');

      const collected: Article[] = [];
      for await (const row of articles.listAll()) collected.push(row);
      assert.equal(collected.length, 1);
      assert.equal(collected[0]!.title, 'Renamed');

      const deleted = await articles.delete(id);
      assert.equal(deleted.data.id, id);
      assert.equal(await articles.count(), 0);
    });
  } finally {
    await server.close();
  }
});

// === 8.4 — onRequest / onResponse hooks (real server) ===========================================

test('onRequest / onResponse fire on real GET and POST with real status', async () => {
  const server = await startTestServer('dx-hooks');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_SEED_FIELDS }, async (apiId) => {
      const reqs: Array<{ method: string; attempt: number }> = [];
      const ress: Array<{ method: string; status: number }> = [];
      const client = createClient({
        baseUrl: server.baseUrl,
        onRequest: (r) => {
          reqs.push({ method: r.method, attempt: r.attempt });
          r.headers['x-correlation-id'] = 'abc'; // mutate-in-place seam
        },
        onResponse: (r) => {
          ress.push({ method: r.method, status: r.response.status });
        },
      });

      const created = await client.create(apiId, articleBody());
      await client.list(apiId);

      assert.deepEqual(reqs[0], { method: 'POST', attempt: 1 });
      assert.equal(ress[0]!.method, 'POST');
      assert.equal(ress[0]!.status, 201);

      const getReq = reqs.find((r) => r.method === 'GET');
      const getRes = ress.find((r) => r.method === 'GET');
      assert.ok(getReq, 'onRequest saw the GET');
      assert.equal(getRes!.status, 200);
      assert.ok(created.data.id);
    });
  } finally {
    await server.close();
  }
});

// === 8.3 — retries on idempotent GET (real local http server) ===================================

/** Stand up a real node:http server that runs `handler` per request; returns base URL + close + count. */
async function flakyServer(
  handler: (count: number, res: http.ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void>; count: () => number }> {
  let n = 0;
  const srv = http.createServer((_req, res) => {
    n += 1;
    handler(n, res);
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    count: () => n,
    close: () =>
      new Promise<void>((resolve) => {
        srv.close(() => resolve());
      }),
  };
}

test('GET retries a 503 then succeeds (idempotent)', async () => {
  const srv = await flakyServer((count, res) => {
    if (count < 3) {
      res.writeHead(503);
      res.end('{"error":"unavailable"}');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[],"meta":{"pagination":{"total":0,"page":1,"pageSize":25,"pageCount":0}}}');
    }
  });
  try {
    const client = createClient({
      baseUrl: srv.baseUrl,
      retry: { retries: 3, backoff: () => 1 },
    });
    const res = await client.list('article');
    assert.deepEqual(res.data, []);
    assert.equal(srv.count(), 3, 'two 503s + one 200 = three attempts');
  } finally {
    await srv.close();
  }
});

test('GET gives up after exhausting retries and throws the typed error', async () => {
  const srv = await flakyServer((_count, res) => {
    res.writeHead(503);
    res.end('{"error":"always down"}');
  });
  try {
    const client = createClient({ baseUrl: srv.baseUrl, retry: { retries: 2, backoff: () => 1 } });
    await assert.rejects(() => client.list('article'), (e) => e instanceof ServerError);
    assert.equal(srv.count(), 3, 'initial + 2 retries = 3 attempts');
  } finally {
    await srv.close();
  }
});

test('writes are NEVER retried even with a retry policy', async () => {
  const srv = await flakyServer((_count, res) => {
    res.writeHead(503);
    res.end('{"error":"down"}');
  });
  try {
    const client = createClient({ baseUrl: srv.baseUrl, retry: { retries: 5, backoff: () => 1 } });
    await assert.rejects(() => client.create('article', { title: 'x' }), (e) => e instanceof ServerError);
    assert.equal(srv.count(), 1, 'a POST is attempted exactly once');
  } finally {
    await srv.close();
  }
});

test('a non-retryable status (400) is NOT retried', async () => {
  const srv = await flakyServer((_count, res) => {
    res.writeHead(400);
    res.end('{"error":"bad"}');
  });
  try {
    const client = createClient({ baseUrl: srv.baseUrl, retry: { retries: 3, backoff: () => 1 } });
    await assert.rejects(() => client.list('article'));
    assert.equal(srv.count(), 1, '400 is a client error — one attempt only');
  } finally {
    await srv.close();
  }
});

test('per-request timeout aborts a hanging GET', async () => {
  // A server that never responds — the timeout must abort the in-flight fetch.
  const srv = await flakyServer(() => {
    /* never call res.end() */
  });
  try {
    const client = createClient({ baseUrl: srv.baseUrl, timeout: 50 });
    await assert.rejects(() => client.list('article'), (e: unknown) => {
      const err = e as { name?: string };
      // AbortSignal.timeout aborts with a TimeoutError (DOMException) — surfaced verbatim by fetch.
      return err.name === 'TimeoutError' || err.name === 'AbortError';
    });
  } finally {
    await srv.close();
  }
});
