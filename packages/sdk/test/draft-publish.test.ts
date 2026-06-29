// Draft & Publish — the SDK lifecycle surface (status read param + publish/unpublish actions) end-to-end
// against the REAL @conti/api uWS server over a fresh per-file Postgres. NO MOCKS.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, withType } from './server.ts';
import { createClient, BadRequestError, NotFoundError } from '../src/index.ts';

const POST_FIELDS = [{ name: 'title', type: 'string' as const, options: { nullable: false } }];

test('create → draft (hidden by default), status=draft shows it, publish → visible, unpublish → hidden', async () => {
  const server = await startTestServer('dp-lifecycle');
  try {
    await withType(server, { name: 'post', fields: POST_FIELDS, draftPublish: true }, async (name) => {
      const client = server.mkClient();

      const created = await client.create(name, { title: 'Hello' });
      assert.equal(created.data.published_at, null, 'a new entry is a draft');
      const id = created.data.id as number;

      // Default read = published-only → the draft is hidden.
      assert.equal((await client.list(name)).data.length, 0);
      // status=draft → visible.
      const drafts = await client.list(name, { status: 'draft' });
      assert.equal(drafts.data.length, 1);
      assert.equal(drafts.data[0]!.id, id);
      // findOne defaults to published-only → 404 for a draft; status=draft resolves it.
      await assert.rejects(client.findOne(name, id), NotFoundError);
      assert.equal((await client.findOne(name, id, { status: 'draft' })).data.id, id);

      // Publish → visible by default, published_at set.
      const pub = await client.publish(name, id);
      assert.notEqual(pub.data.published_at, null);
      assert.equal((await client.list(name)).data.length, 1);
      assert.equal((await client.findOne(name, id)).data.id, id);

      // Unpublish → back to draft.
      const unpub = await client.unpublish(name, id);
      assert.equal(unpub.data.published_at, null);
      assert.equal((await client.list(name)).data.length, 0);
    });
  } finally {
    await server.close();
  }
});

test('publish/unpublish on a non-D&P type → BadRequestError (400)', async () => {
  const server = await startTestServer('dp-non-dp');
  try {
    await withType(server, { name: 'plain', fields: POST_FIELDS }, async (name) => {
      const client = server.mkClient();
      const created = await client.create(name, { title: 'x' });
      const id = created.data.id as number;
      await assert.rejects(client.publish(name, id), BadRequestError);
      // A non-D&P entry has NO published_at key and is immediately visible (byte-identical behavior).
      assert.equal(created.data.published_at, undefined);
      assert.equal((await client.list(name)).data.length, 1);
    });
  } finally {
    await server.close();
  }
});
