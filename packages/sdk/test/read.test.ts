// Slice 4 — read methods (list / findOne / findOneOrNull / count + offset & keyset iterators).
//
// NO MOCKS: every assertion drives the REAL @conti/api uWS server booted by startTestServer() over a
// fresh per-file Postgres. Rows are seeded over the REAL write path (raw POST /:type via fetch — the
// SDK's typed create() lands in Slice 5), so the reads under test see genuine persisted rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, withType, type TestServer } from './server.ts';
import { ARTICLE_FIELDS } from './server.ts';
import { createClient, isKeysetPagination, type Entry } from '../src/index.ts';

/** Seed one article over the real write path; returns the created row (with its server-assigned id). */
async function seedArticle(
  baseUrl: string,
  apiId: string,
  data: Record<string, unknown>,
): Promise<Entry> {
  const res = await fetch(`${baseUrl}/${apiId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  const raw = await res.text();
  assert.equal(res.status, 201, `seed POST should 201 (got ${res.status}: ${raw})`);
  const body = JSON.parse(raw) as { data: Entry };
  return body.data;
}

/** Seed `n` articles `title=row-0..n-1`, ascending `views`, all published/active. */
async function seedN(server: TestServer, apiId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await seedArticle(server.baseUrl, apiId, {
      title: `row-${i}`,
      body: `body ${i}`,
      status: 'published',
      views: i,
      rating: 1.5,
      active: true,
      publishedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    });
  }
}

test('list() returns the data array + offset pagination meta with total', async () => {
  const server = await startTestServer('read-list');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_FIELDS }, async (apiId) => {
      await seedN(server, apiId, 5);
      const client = createClient({ baseUrl: server.baseUrl });

      const res = await client.list(apiId);
      assert.ok(Array.isArray(res.data));
      assert.equal(res.data.length, 5);
      assert.ok(!isKeysetPagination(res.meta.pagination), 'default is offset meta');
      assert.equal((res.meta.pagination as { total: number }).total, 5);
    });
  } finally {
    await server.close();
  }
});

test('list() honors filters + sort + pagination', async () => {
  const server = await startTestServer('read-list-params');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_FIELDS }, async (apiId) => {
      await seedN(server, apiId, 10);
      const client = createClient({ baseUrl: server.baseUrl });

      const res = await client.list(apiId, {
        filters: { views: { $gte: 5 } },
        sort: 'views:desc',
        pagination: { start: 0, limit: 2 },
      });
      assert.equal(res.data.length, 2);
      assert.deepEqual(res.data.map((r) => r['views']), [9, 8], 'sorted desc, page of 2');
      assert.equal((res.meta.pagination as { total: number }).total, 5, 'total = matches of the filter');
    });
  } finally {
    await server.close();
  }
});

test('list() $contains + sort:desc + pagination[pageSize] over ~30 rows returns the expected subset/order', async () => {
  const server = await startTestServer('read-contains');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_FIELDS }, async (apiId) => {
      // 30 rows: title=row-0..row-29. "row-1" is a substring of row-1 and every row-1X (10..19),
      // i.e. 11 matches: views 1, 10,11,12,13,14,15,16,17,18,19. sort views:desc, page of 5 → top 5.
      await seedN(server, apiId, 30);
      const client = createClient({ baseUrl: server.baseUrl });

      const res = await client.list(apiId, {
        filters: { title: { $contains: 'row-1' } },
        sort: 'views:desc',
        pagination: { page: 1, pageSize: 5 },
      });
      assert.equal(res.data.length, 5, 'one page of pageSize=5');
      assert.deepEqual(res.data.map((r) => r['views']), [19, 18, 17, 16, 15], 'top-5 of the $contains matches, desc');
      assert.equal((res.meta.pagination as { total: number }).total, 11, 'total = all "row-1*" matches');
    });
  } finally {
    await server.close();
  }
});

test('findOne() resolves by public id; findOneOrNull() returns null on 404', async () => {
  const server = await startTestServer('read-findone');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_FIELDS }, async (apiId) => {
      const created = await seedArticle(server.baseUrl, apiId, {
        title: 'hello',
        body: 'b',
        status: 'published',
        views: 1,
        rating: 1,
        active: true,
        publishedAt: new Date().toISOString(),
      });
      const id = created['id'] as number;
      const client = createClient({ baseUrl: server.baseUrl });

      const one = await client.findOne(apiId, id);
      assert.equal(one.data['id'], id);
      assert.equal(one.data['title'], 'hello');
      assert.deepEqual(one.meta, {}, 'single route has empty meta');

      const missing = await client.findOneOrNull(apiId, 999999);
      assert.equal(missing, null, '404 → null');

      await assert.rejects(() => client.findOne(apiId, 999999), /not found/i, 'findOne throws on 404');
    });
  } finally {
    await server.close();
  }
});

test('fields: list AND findOne project to id + the requested scalar columns (Strapi v5)', async () => {
  const server = await startTestServer('read-fields');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_FIELDS }, async (apiId) => {
      const created = await seedArticle(server.baseUrl, apiId, {
        title: 'sparse', body: 'long body', status: 'published', views: 7, rating: 2.5, active: true,
        publishedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      });
      const id = created['id'] as number;
      const client = createClient({ baseUrl: server.baseUrl });

      // LIST: only id + the two requested columns; body/views/etc. dropped.
      const listRes = await client.list(apiId, { fields: ['title', 'rating'] });
      assert.deepEqual(Object.keys(listRes.data[0]!).sort(), ['id', 'rating', 'title']);
      assert.equal(listRes.data[0]!['title'], 'sparse');

      // FINDONE now threads fields too (it was previously ignored on the single route).
      const oneRes = await client.findOne(apiId, id, { fields: ['title'] });
      assert.deepEqual(Object.keys(oneRes.data).sort(), ['id', 'title']);
      assert.equal(oneRes.data['title'], 'sparse');
      assert.equal(oneRes.data['id'], id);
    });
  } finally {
    await server.close();
  }
});

test('count() returns the filtered total without fetching rows', async () => {
  const server = await startTestServer('read-count');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_FIELDS }, async (apiId) => {
      await seedN(server, apiId, 8);
      const client = createClient({ baseUrl: server.baseUrl });

      assert.equal(await client.count(apiId), 8, 'unfiltered count');
      assert.equal(await client.count(apiId, { views: { $gte: 5 } }), 3, 'filtered count');
    });
  } finally {
    await server.close();
  }
});

test('listAll() iterates every row page-by-page in offset mode', async () => {
  const server = await startTestServer('read-listall');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_FIELDS }, async (apiId) => {
      await seedN(server, apiId, 30);
      const client = createClient({ baseUrl: server.baseUrl });

      const seen: unknown[] = [];
      for await (const row of client.listAll(apiId, {
        sort: 'views:asc',
        pagination: { limit: 7 },
      })) {
        seen.push(row['views']);
      }
      const expected = Array.from({ length: 30 }, (_, i) => i);
      assert.deepEqual(seen, expected, 'all 30 rows, in order, across a short last page');
      assert.equal(new Set(seen).size, 30, 'each row exactly once');
    });
  } finally {
    await server.close();
  }
});

test('listAll() stops cleanly on an exact-multiple total (empty trailing page)', async () => {
  const server = await startTestServer('read-listall-exact');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_FIELDS }, async (apiId) => {
      await seedN(server, apiId, 6);
      const client = createClient({ baseUrl: server.baseUrl });

      const seen: unknown[] = [];
      for await (const row of client.listAll(apiId, { sort: 'views:asc', pagination: { limit: 2 } })) {
        seen.push(row['views']);
      }
      assert.deepEqual(seen, [0, 1, 2, 3, 4, 5]);
    });
  } finally {
    await server.close();
  }
});

test('listAllKeyset() follows nextCursor until hasNextPage=false', async () => {
  const server = await startTestServer('read-listall-keyset');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_FIELDS }, async (apiId) => {
      await seedN(server, apiId, 30);
      const client = createClient({ baseUrl: server.baseUrl });

      const seen: unknown[] = [];
      for await (const row of client.listAllKeyset(apiId, { pagination: { pageSize: 7 } })) {
        seen.push(row['views']);
      }
      assert.equal(seen.length, 30, 'every row yielded');
      assert.equal(new Set(seen).size, 30, 'every row yielded exactly once');
      assert.deepEqual(
        [...seen].sort((a, b) => (a as number) - (b as number)),
        Array.from({ length: 30 }, (_, i) => i),
      );
    });
  } finally {
    await server.close();
  }
});
