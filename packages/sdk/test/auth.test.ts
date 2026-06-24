// @conti/sdk — Slice 9: auth readiness (token/header seam + 401/403 handling), forward-compat.
//
// NO MOCKS. The @conti/api server has NO auth yet (README roadmap: "AuthN/authZ — gate the Builder
// (and writes) behind an admin scope"), so this slice is a NO-OP against today's open API. We verify:
//   • token / setToken / getHeaders SEND the right Authorization header — observed via a REAL fetch
//     WRAPPER that records the outgoing init then delegates to the real platform fetch — AND that the
//     request still SUCCEEDS against the real uWS server (the open api ignores the header).
//   • 401 → UnauthorizedError(401) and 403 → ForbiddenError(403), and the onUnauthorized hook fires on a
//     401 — driven against a REAL local node:http server scripted to answer 401/403 (genuine sockets).
// Nothing in the SDK is stubbed; the "wrapper" is a real fetch that observes then forwards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { startTestServer, withType } from './server.ts';
import { ARTICLE_SEED_FIELDS } from '../../api/src/http/server.ts';
import {
  createClient,
  AbsurdClient,
  ApiError,
  UnauthorizedError,
  ForbiddenError,
  errorFromResponse,
  type RequestOptions,
  type ClientOptions,
  type UnauthorizedHook,
  type HeaderProvider,
} from '../src/index.ts';

// === Type-level assertions (compile-time; erased at runtime) =====================================
// These never execute — they exist so `tsc` (and node's type-stripping) prove the Slice 9 surface is
// present and correctly shaped. UnauthorizedError / ForbiddenError are ApiError subclasses, and
// onUnauthorized / token / getHeaders live in ClientOptions with the right types.
{
  // The two new typed errors exist and are ApiError subclasses.
  const _u: ApiError = new UnauthorizedError(401, 'm', null);
  const _f: ApiError = new ForbiddenError(403, 'm', null);
  void _u;
  void _f;

  // `onUnauthorized` (and the token/header seam) are part of ClientOptions with the expected types.
  const _opts: ClientOptions = {
    baseUrl: 'http://x',
    token: 'tok',
    getHeaders: (() => ({ authorization: 'Bearer t' })) satisfies HeaderProvider,
    onUnauthorized: ((ctx) => {
      const _s: 401 = ctx.status;
      void _s;
    }) satisfies UnauthorizedHook,
  };
  void _opts;

  // Assert the key is assignable on the interface itself (would error if it were removed/renamed).
  type _HasOnUnauthorized = ClientOptions['onUnauthorized'];
  const _hook: _HasOnUnauthorized = undefined;
  void _hook;
}

/** A real fetch that records every outgoing request's headers, then delegates to the platform fetch. */
function recordingFetch(): { fetch: typeof fetch; headers: Array<Record<string, string>> } {
  const headers: Array<Record<string, string>> = [];
  const wrapped: typeof fetch = (input, init) => {
    // Normalize the init.headers (a plain object in our pipeline) into a lowercase lookup.
    const h: Record<string, string> = {};
    const raw = (init?.headers ?? {}) as Record<string, string>;
    for (const k in raw) h[k.toLowerCase()] = raw[k]!;
    headers.push(h);
    return globalThis.fetch(input, init);
  };
  return { fetch: wrapped, headers };
}

/** Stand up a real node:http server running `handler` per request; returns base URL + close + count. */
async function localServer(
  handler: (count: number, req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void>; count: () => number }> {
  let n = 0;
  const srv = http.createServer((req, res) => {
    n += 1;
    handler(n, req, res);
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    count: () => n,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

// === 9.1 — token / setToken / getHeaders SEND the Bearer header, real request still succeeds ======

test('token option sends `Authorization: Bearer <token>` and the open api still answers 200', async () => {
  const server = await startTestServer('auth-token');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_SEED_FIELDS }, async (apiId) => {
      const rec = recordingFetch();
      const client = createClient({ baseUrl: server.baseUrl, fetch: rec.fetch, token: 'sekret' });

      const res = await client.list(apiId); // a REAL list against the real server
      assert.ok(Array.isArray(res.data), 'request succeeds against the open api (header ignored)');

      assert.equal(rec.headers.length, 1);
      assert.equal(
        rec.headers[0]!['authorization'],
        'Bearer sekret',
        'the static token is sent as a Bearer header on the wire',
      );
    });
  } finally {
    await server.close();
  }
});

test('setToken() updates the Bearer header on subsequent real requests; undefined clears it', async () => {
  const server = await startTestServer('auth-settoken');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_SEED_FIELDS }, async (apiId) => {
      const rec = recordingFetch();
      const client = createClient({ baseUrl: server.baseUrl, fetch: rec.fetch });

      await client.list(apiId); // no token yet
      client.setToken('after-login');
      await client.list(apiId); // token set
      client.setToken(undefined);
      await client.list(apiId); // token cleared

      assert.equal(rec.headers[0]!['authorization'], undefined, 'no Authorization before a token is set');
      assert.equal(rec.headers[1]!['authorization'], 'Bearer after-login', 'token sent after setToken()');
      assert.equal(rec.headers[2]!['authorization'], undefined, 'header dropped after setToken(undefined)');
    });
  } finally {
    await server.close();
  }
});

test('getHeaders() is awaited, merged, and overrides the static token on `authorization`', async () => {
  const server = await startTestServer('auth-getheaders');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_SEED_FIELDS }, async (apiId) => {
      const rec = recordingFetch();
      const client = createClient({
        baseUrl: server.baseUrl,
        fetch: rec.fetch,
        token: 'static',
        // dynamic provider wins (merged last) — the rotating-token seam
        getHeaders: async () => ({ authorization: 'Bearer dynamic', 'x-trace': 'on' }),
      });

      const res = await client.list(apiId);
      assert.ok(Array.isArray(res.data), 'real request still succeeds');
      assert.equal(rec.headers[0]!['authorization'], 'Bearer dynamic', 'async getHeaders() overrides token');
      assert.equal(rec.headers[0]!['x-trace'], 'on', 'extra headers from getHeaders() are sent too');
    });
  } finally {
    await server.close();
  }
});

test('the token header rides on a real WRITE (create) too, which still succeeds on the open api', async () => {
  const server = await startTestServer('auth-write');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_SEED_FIELDS }, async (apiId) => {
      const rec = recordingFetch();
      const client = createClient({ baseUrl: server.baseUrl, fetch: rec.fetch, token: 'admin' });
      const body: Record<string, unknown> = {
        title: 'Hello',
        body: 'b',
        status: 'published',
        views: 1,
        rating: 1.0,
        active: true,
        publishedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      };
      const created = await client.create(apiId, body);
      assert.ok(created.data.id, 'create succeeds against the open api');
      assert.equal(rec.headers[0]!['authorization'], 'Bearer admin', 'Bearer header sent on the POST');
      assert.equal(rec.headers[0]!['content-type'], 'application/json', 'content-type still set on a body');
    });
  } finally {
    await server.close();
  }
});

// === 9.2 — 401/403 mapping + onUnauthorized hook (real local http server) ========================

test('a 401 maps to UnauthorizedError and fires the onUnauthorized hook before throwing', async () => {
  const srv = await localServer((_n, _req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"missing token"}');
  });
  try {
    const calls: Array<{ status: number; method: string; url: string; body: unknown }> = [];
    const client = createClient({
      baseUrl: srv.baseUrl,
      onUnauthorized: async (ctx) => {
        calls.push(ctx);
      },
    });

    await assert.rejects(
      () => client.list('article'),
      (err: unknown) => {
        assert.ok(err instanceof UnauthorizedError, 'a 401 maps to UnauthorizedError');
        assert.ok(err instanceof ApiError, 'subclass of ApiError');
        assert.equal((err as ApiError).status, 401);
        assert.match((err as ApiError).message, /missing token/, 'message from the {error} body');
        return true;
      },
    );

    assert.equal(calls.length, 1, 'onUnauthorized fired exactly once');
    assert.equal(calls[0]!.status, 401);
    assert.equal(calls[0]!.method, 'GET');
    assert.match(calls[0]!.url, /\/article$/);
    assert.deepEqual(calls[0]!.body, { error: 'missing token' }, 'hook receives the parsed error body');
  } finally {
    await srv.close();
  }
});

test('a 403 maps to ForbiddenError and does NOT fire onUnauthorized', async () => {
  const srv = await localServer((_n, _req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end('{"error":"admin scope required"}');
  });
  try {
    let unauthorizedFired = false;
    const client = createClient({
      baseUrl: srv.baseUrl,
      onUnauthorized: () => {
        unauthorizedFired = true;
      },
    });
    await assert.rejects(
      () => client.list('article'),
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenError, 'a 403 maps to ForbiddenError');
        assert.equal((err as ApiError).status, 403);
        assert.match((err as ApiError).message, /admin scope/, 'message from the {error} body');
        return true;
      },
    );
    assert.equal(unauthorizedFired, false, 'the 401 hook is scoped to 401 only');
  } finally {
    await srv.close();
  }
});

test('errorFromResponse maps 401 → UnauthorizedError and 403 → ForbiddenError', () => {
  assert.ok(errorFromResponse(401, 'm', null) instanceof UnauthorizedError);
  assert.ok(errorFromResponse(403, 'm', null) instanceof ForbiddenError);
});

test('without an onUnauthorized hook, a 401 still throws UnauthorizedError (hook is optional)', async () => {
  const srv = await localServer((_n, _req, res) => {
    res.writeHead(401);
    res.end('{"error":"nope"}');
  });
  try {
    const client = createClient({ baseUrl: srv.baseUrl });
    await assert.rejects(() => client.list('article'), (e) => e instanceof UnauthorizedError);
  } finally {
    await srv.close();
  }
});

// Test-only seam to prove setToken also works through the protected request() pipeline directly.
class TestClient extends AbsurdClient {
  call<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>(method, path, opts);
  }
}

test('setToken via the raw request() pipeline emits the Bearer header', async () => {
  const rec = recordingFetch();
  // Point the recording fetch at a local server so the request actually completes.
  const srv = await localServer((_n, _req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  try {
    const client = new TestClient({ baseUrl: srv.baseUrl, fetch: rec.fetch });
    client.setToken('raw');
    const out = await client.call<{ ok: boolean }>('GET', '/thing');
    assert.deepEqual(out, { ok: true });
    assert.equal(rec.headers[0]!['authorization'], 'Bearer raw');
  } finally {
    await srv.close();
  }
});
