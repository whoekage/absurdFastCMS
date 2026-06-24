// Slice 5 — write methods (create / update / delete) + relation ops (connect / disconnect / set).
//
// NO MOCKS: every assertion drives the REAL @conti/api uWS server booted by startTestServer() over a
// fresh per-file Postgres. create/update/delete go through the SDK's typed methods; read-backs use the
// SDK's findOne/list so the persisted rows under test are the genuine wire shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, withType } from './server.ts';
import { ARTICLE_SEED_FIELDS } from '../../api/src/http/server.ts';
import {
  createClient,
  BadRequestError,
  NotFoundError,
  PayloadTooLargeError,
  type Entry,
} from '../src/index.ts';

/** A valid create body for the seeded `article` type. */
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

test('create() returns 201 SingleResponse and the row reads back', async () => {
  const server = await startTestServer('write-create');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_SEED_FIELDS }, async (apiId) => {
      const client = createClient({ baseUrl: server.baseUrl });

      const created = await client.create(apiId, articleBody({ title: 'Created' }));
      assert.ok(created.data.id, 'created row has a server-assigned id');
      assert.equal(created.data.title, 'Created');
      assert.equal(created.data.views, 42);

      const back = await client.findOne(apiId, created.data.id as number);
      assert.equal(back.data.id, created.data.id);
      assert.equal(back.data.title, 'Created');
    });
  } finally {
    await server.close();
  }
});

test('create() with a missing required field throws BadRequestError (400)', async () => {
  const server = await startTestServer('write-create-required');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_SEED_FIELDS }, async (apiId) => {
      const client = createClient({ baseUrl: server.baseUrl });
      const bad = articleBody();
      delete bad.body; // `body` is NOT NULL without a default → required on create.
      await assert.rejects(() => client.create(apiId, bad), (e: unknown) => {
        assert.ok(e instanceof BadRequestError);
        assert.equal((e as BadRequestError).status, 400);
        return true;
      });
    });
  } finally {
    await server.close();
  }
});

test('update() is partial — only the supplied key changes; others keep their value', async () => {
  const server = await startTestServer('write-update');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_SEED_FIELDS }, async (apiId) => {
      const client = createClient({ baseUrl: server.baseUrl });
      const created = await client.create(apiId, articleBody({ title: 'Before', views: 1 }));
      const id = created.data.id as number;

      const updated = await client.update(apiId, id, { title: 'After' });
      assert.equal(updated.data.title, 'After');
      assert.equal(updated.data.views, 1, 'untouched field is preserved');

      const back = await client.findOne(apiId, id);
      assert.equal(back.data.title, 'After');
      assert.equal(back.data.views, 1);
    });
  } finally {
    await server.close();
  }
});

test('update() of a missing id throws NotFoundError (404)', async () => {
  const server = await startTestServer('write-update-404');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_SEED_FIELDS }, async (apiId) => {
      const client = createClient({ baseUrl: server.baseUrl });
      await assert.rejects(
        () => client.update(apiId, 999999, { title: 'nope' }),
        (e: unknown) => e instanceof NotFoundError,
      );
    });
  } finally {
    await server.close();
  }
});

test('update() with an empty body throws BadRequestError (400)', async () => {
  const server = await startTestServer('write-update-empty');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_SEED_FIELDS }, async (apiId) => {
      const client = createClient({ baseUrl: server.baseUrl });
      const created = await client.create(apiId, articleBody());
      await assert.rejects(
        () => client.update(apiId, created.data.id as number, {}),
        (e: unknown) => e instanceof BadRequestError,
      );
    });
  } finally {
    await server.close();
  }
});

test('delete() returns the deleted row (200) and a re-read is a 404', async () => {
  const server = await startTestServer('write-delete');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_SEED_FIELDS }, async (apiId) => {
      const client = createClient({ baseUrl: server.baseUrl });
      const created = await client.create(apiId, articleBody({ title: 'Doomed' }));
      const id = created.data.id as number;

      const deleted = await client.delete(apiId, id);
      assert.equal(deleted.data.id, id);
      assert.equal(deleted.data.title, 'Doomed');

      assert.equal(await client.findOneOrNull(apiId, id), null);
    });
  } finally {
    await server.close();
  }
});

test('delete() of a missing id throws NotFoundError (404)', async () => {
  const server = await startTestServer('write-delete-404');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_SEED_FIELDS }, async (apiId) => {
      const client = createClient({ baseUrl: server.baseUrl });
      await assert.rejects(
        () => client.delete(apiId, 999999),
        (e: unknown) => e instanceof NotFoundError,
      );
    });
  } finally {
    await server.close();
  }
});

test('relation ops: shorthand set, connect, disconnect, and {set:[]} clear', async () => {
  const server = await startTestServer('write-relations');
  try {
    // `article` owns a manyToMany `tags` relation to a `tag` type.
    await withType(server, { apiId: 'tag', fields: [{ name: 'name', cmsType: 'string' }] }, async (tagId) => {
      await withType(
        server,
        {
          apiId: 'article',
          fields: ARTICLE_SEED_FIELDS,
          relations: [{ field: 'tags', kind: 'manyToMany', target: tagId }],
        },
        async (apiId) => {
          const client = createClient({ baseUrl: server.baseUrl });

          const t1 = (await client.create(tagId, { name: 'one' })).data.id as number;
          const t2 = (await client.create(tagId, { name: 'two' })).data.id as number;
          const t3 = (await client.create(tagId, { name: 'three' })).data.id as number;

          // create with a shorthand-set relation (array of ids).
          const art = await client.create(apiId, articleBody({ tags: [t1, t2] }));
          const id = art.data.id as number;
          const tagIdsOf = async (): Promise<number[]> => {
            const r = await client.findOne(apiId, id, { populate: ['tags'] });
            const tags = (r.data.tags as Entry[]) ?? [];
            return tags.map((t) => t.id as number).sort((a, b) => a - b);
          };
          assert.deepEqual(await tagIdsOf(), [t1, t2].sort((a, b) => a - b));

          // connect t3 (ADDS), disconnect t1 (REMOVES) in one op.
          await client.update(apiId, id, { tags: { connect: [t3], disconnect: [t1] } });
          assert.deepEqual(await tagIdsOf(), [t2, t3].sort((a, b) => a - b));

          // explicit set REPLACES the whole set.
          await client.update(apiId, id, { tags: { set: [t1] } });
          assert.deepEqual(await tagIdsOf(), [t1]);

          // {set: []} clears.
          await client.update(apiId, id, { tags: { set: [] } });
          assert.deepEqual(await tagIdsOf(), []);
        },
      );
    });
  } finally {
    await server.close();
  }
});

test('relation op with a nonexistent FK throws BadRequestError (400)', async () => {
  const server = await startTestServer('write-relations-fk');
  try {
    await withType(server, { apiId: 'tag', fields: [{ name: 'name', cmsType: 'string' }] }, async (tagId) => {
      await withType(
        server,
        {
          apiId: 'article',
          fields: ARTICLE_SEED_FIELDS,
          relations: [{ field: 'tags', kind: 'manyToMany', target: tagId }],
        },
        async (apiId) => {
          const client = createClient({ baseUrl: server.baseUrl });
          await assert.rejects(
            () => client.create(apiId, articleBody({ tags: [999999] })),
            (e: unknown) => e instanceof BadRequestError,
          );
        },
      );
    });
  } finally {
    await server.close();
  }
});

test('create() with an oversized body throws PayloadTooLargeError (413)', async () => {
  const server = await startTestServer('write-413');
  try {
    await withType(server, { apiId: 'article', fields: ARTICLE_SEED_FIELDS }, async (apiId) => {
      const client = createClient({ baseUrl: server.baseUrl });
      // A multi-megabyte text body overruns the server's max-body limit.
      const huge = 'x'.repeat(8 * 1024 * 1024);
      await assert.rejects(
        () => client.create(apiId, articleBody({ body: huge })),
        (e: unknown) => e instanceof PayloadTooLargeError,
      );
    });
  } finally {
    await server.close();
  }
});
