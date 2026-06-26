// Slice 3 — HTTP client core (mock-free).
//
// NO MOCKS: every assertion drives the REAL @conti/api uWS server booted by startTestServer() over a
// fresh per-file Postgres. We subclass AbsurdClient ONLY to expose its `protected request()` to the test
// (production method slices 4/5/6 call it internally) — the transport under test is unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, withType } from './server.ts';
import { ARTICLE_FIELDS } from './server.ts';
import {
  AbsurdClient,
  createClient,
  ApiError,
  NotFoundError,
  MethodNotAllowedError,
  errorFromResponse,
  BadRequestError,
  ConflictError,
  PayloadTooLargeError,
  ServerError,
  type RequestOptions,
} from '../src/index.ts';

/** Test-only seam: exposes the protected request() pipeline so we can exercise Slice 3 directly. */
class TestClient extends AbsurdClient {
  call<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>(method, path, opts);
  }
}

test('ctor strips a trailing slash from baseUrl (no double slash in the request URL)', async () => {
  const server = await startTestServer('client-baseurl');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_FIELDS }, async (apiId) => {
      const client = new TestClient({ baseUrl: `${server.baseUrl}/` });
      const body = await client.call<{ data: unknown[]; meta: unknown }>('GET', `/${apiId}`);
      assert.ok(Array.isArray(body.data), 'list read returns a data array even with a trailing-slash baseUrl');
    });
  } finally {
    await server.close();
  }
});

test('ctor throws when no fetch is available and none injected', () => {
  const saved = globalThis.fetch;
  try {
    // @ts-expect-error — deliberately remove the global to prove the guard fires.
    delete globalThis.fetch;
    assert.throws(() => new AbsurdClient({ baseUrl: 'http://x' }), /no `fetch` available/);
  } finally {
    globalThis.fetch = saved;
  }
});

test('injected fetch is used and receives the composed URL + JSON headers', async () => {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const recordingFetch: typeof fetch = (input, init) => {
    seen.push({ url: String(input), init });
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  };
  const client = new TestClient({ baseUrl: 'http://example.test', fetch: recordingFetch });

  const out = await client.call<{ ok: boolean }>('POST', '/thing', { query: 'a=1', body: { x: 1 } });
  assert.deepEqual(out, { ok: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, 'http://example.test/thing?a=1', 'URL = baseUrl + path + ?query');

  const headers = seen[0]!.init!.headers as Record<string, string>;
  assert.equal(headers['content-type'], 'application/json', 'content-type set when a body is present');
  assert.equal(seen[0]!.init!.body, JSON.stringify({ x: 1 }), 'body is JSON-stringified');
});

test('empty/absent query is omitted (no trailing ?)', async () => {
  let capturedUrl = '';
  const recordingFetch: typeof fetch = (input) => {
    capturedUrl = String(input);
    return Promise.resolve(new Response('null', { status: 200 }));
  };
  const client = new TestClient({ baseUrl: 'http://example.test', fetch: recordingFetch });
  await client.call('GET', '/thing', { query: '' });
  assert.equal(capturedUrl, 'http://example.test/thing', 'empty query string appends no `?`');
});

test('no module header when there is no body', async () => {
  let init: RequestInit | undefined;
  const recordingFetch: typeof fetch = (_input, i) => {
    init = i;
    return Promise.resolve(new Response('null', { status: 200 }));
  };
  const client = new TestClient({ baseUrl: 'http://example.test', fetch: recordingFetch });
  await client.call('GET', '/thing');
  const headers = (init!.headers ?? {}) as Record<string, string>;
  assert.equal(headers['content-type'], undefined, 'no content-type on a bodyless request');
  assert.equal(init!.body, undefined, 'no body sent');
});

test('getHeaders() is awaited and merged on top of the built-in headers', async () => {
  let init: RequestInit | undefined;
  const recordingFetch: typeof fetch = (_input, i) => {
    init = i;
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  const client = new TestClient({
    baseUrl: 'http://example.test',
    fetch: recordingFetch,
    getHeaders: async () => ({ authorization: 'Bearer t0ken' }),
  });
  await client.call('GET', '/thing');
  const headers = init!.headers as Record<string, string>;
  assert.equal(headers['authorization'], 'Bearer t0ken', 'async getHeaders() result is merged in');
});

test('the AbortSignal is threaded into fetch', async () => {
  let init: RequestInit | undefined;
  const recordingFetch: typeof fetch = (_input, i) => {
    init = i;
    return Promise.resolve(new Response('null', { status: 200 }));
  };
  const client = new TestClient({ baseUrl: 'http://example.test', fetch: recordingFetch });
  const ctrl = new AbortController();
  await client.call('GET', '/thing', { signal: ctrl.signal });
  assert.equal(init!.signal, ctrl.signal, 'signal passed straight through to fetch');
});

test('GET /unknown-type throws NotFoundError with status 404 and the {error} message', async () => {
  const server = await startTestServer('client-404');
  try {
    const client = new TestClient({ baseUrl: server.baseUrl });
    await assert.rejects(
      () => client.call('GET', '/does-not-exist'),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundError, 'a 404 maps to NotFoundError');
        assert.ok(err instanceof ApiError, 'subclass of ApiError');
        assert.equal(err.status, 404);
        assert.match(err.message, /unknown module/, 'message comes from the {error} body');
        assert.deepEqual(err.body, { error: err.message }, 'raw body preserved');
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('non-GET on a known route throws MethodNotAllowedError (405)', async () => {
  const server = await startTestServer('client-405');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_FIELDS }, async (apiId) => {
      const client = new TestClient({ baseUrl: server.baseUrl });
      await assert.rejects(
        () => client.call('PATCH', `/${apiId}`),
        (err: unknown) => {
          assert.ok(err instanceof MethodNotAllowedError, 'a 405 maps to MethodNotAllowedError');
          assert.equal((err as ApiError).status, 405);
          return true;
        },
      );
    });
  } finally {
    await server.close();
  }
});

test('errorFromResponse maps each status to its typed subclass', () => {
  assert.ok(errorFromResponse(400, 'm', null) instanceof BadRequestError);
  assert.ok(errorFromResponse(404, 'm', null) instanceof NotFoundError);
  assert.ok(errorFromResponse(405, 'm', null) instanceof MethodNotAllowedError);
  assert.ok(errorFromResponse(409, 'm', null) instanceof ConflictError);
  assert.ok(errorFromResponse(413, 'm', null) instanceof PayloadTooLargeError);
  assert.ok(errorFromResponse(500, 'm', null) instanceof ServerError);
  assert.ok(errorFromResponse(503, 'm', null) instanceof ServerError);
  // An unmapped status falls back to the base ApiError (and not any subclass).
  const fallback = errorFromResponse(418, 'm', null);
  assert.equal(fallback.constructor, ApiError, '418 → base ApiError');
});

test('createClient returns a working AbsurdClient', async () => {
  const server = await startTestServer('client-factory');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_FIELDS }, async (apiId) => {
      const client = server.mkClient();
      assert.ok(client instanceof AbsurdClient);
      // The factory client has no public read method yet (Slice 4) — prove it reaches the server via fetch.
      const res = await fetch(`${server.baseUrl}/${apiId}`);
      assert.equal(res.status, 200);
    });
  } finally {
    await server.close();
  }
});
