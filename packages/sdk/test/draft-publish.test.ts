// Draft & Publish — the SDK lifecycle surface (status read param + publish/unpublish actions) end-to-end
// against the REAL @conti/api uWS server over a fresh per-file Postgres. NO MOCKS.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, withType } from './server.ts';
import { createClient, BadRequestError, NotFoundError } from '../src/index.ts';

const POST_FIELDS = [{ name: 'title', cmsType: 'string' as const, options: { nullable: false } }];

test('create → draft (hidden by default), status=draft shows it, publish → visible, unpublish → hidden', async () => {
  const server = await startTestServer('dp-lifecycle');
  try {
    await withType(server, { apiId: 'post', fields: POST_FIELDS, draftPublish: true }, async (apiId) => {
      const client = createClient({ baseUrl: server.baseUrl });

      const created = await client.create(apiId, { title: 'Hello' });
      assert.equal(created.data.published_at, null, 'a new entry is a draft');
      const id = created.data.id as number;

      // Default read = published-only → the draft is hidden.
      assert.equal((await client.list(apiId)).data.length, 0);
      // status=draft → visible.
      const drafts = await client.list(apiId, { status: 'draft' });
      assert.equal(drafts.data.length, 1);
      assert.equal(drafts.data[0]!.id, id);
      // findOne defaults to published-only → 404 for a draft; status=draft resolves it.
      await assert.rejects(client.findOne(apiId, id), NotFoundError);
      assert.equal((await client.findOne(apiId, id, { status: 'draft' })).data.id, id);

      // Publish → visible by default, published_at set.
      const pub = await client.publish(apiId, id);
      assert.notEqual(pub.data.published_at, null);
      assert.equal((await client.list(apiId)).data.length, 1);
      assert.equal((await client.findOne(apiId, id)).data.id, id);

      // Unpublish → back to draft.
      const unpub = await client.unpublish(apiId, id);
      assert.equal(unpub.data.published_at, null);
      assert.equal((await client.list(apiId)).data.length, 0);
    });
  } finally {
    await server.close();
  }
});

test('publish/unpublish on a non-D&P type → BadRequestError (400)', async () => {
  const server = await startTestServer('dp-non-dp');
  try {
    await withType(server, { apiId: 'plain', fields: POST_FIELDS }, async (apiId) => {
      const client = createClient({ baseUrl: server.baseUrl });
      const created = await client.create(apiId, { title: 'x' });
      const id = created.data.id as number;
      await assert.rejects(client.publish(apiId, id), BadRequestError);
      // A non-D&P entry has NO published_at key and is immediately visible (byte-identical behavior).
      assert.equal(created.data.published_at, undefined);
      assert.equal((await client.list(apiId)).data.length, 1);
    });
  } finally {
    await server.close();
  }
});
