// Slice 6 — module builder (client.modules: list / get / create / drop + add/update/drop field).
//
// NO MOCKS: every assertion drives the REAL @conti/api uWS server booted by startTestServer(), which
// mounts the builder routes ONLY because it is started with store + registry (runtime DDL). The full DDL
// lifecycle is exercised over the wire; error cases assert the Slice 3 typed-error mapping (400/404/409).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer } from './server.ts';
import {
  createClient,
  BadRequestError,
  NotFoundError,
  ConflictError,
  type ModuleDefinition,
} from '../src/index.ts';

/** The user fields of the projected def (system id/created_at/updated_at are stripped). */
function userFields(def: ModuleDefinition): { name: string; cmsType: string }[] {
  return def.fields.filter((f) => !f.system).map((f) => ({ name: f.name, cmsType: f.cmsType }));
}

test('create() → 201 projected def; get() and list() reflect it; drop() removes it', async () => {
  const server = await startTestServer('ct-lifecycle');
  try {
    const client = createClient({ baseUrl: server.baseUrl });

    const created = await client.modules.create({
      apiId: 'widget',
      fields: [
        { name: 'title', cmsType: 'string' },
        { name: 'count', cmsType: 'integer' },
      ],
    });
    assert.equal(created.apiId, 'widget');
    // System fields come first; the two user fields follow in declaration order.
    assert.ok(created.fields.some((f) => f.name === 'id' && f.system));
    assert.deepEqual(userFields(created), [
      { name: 'title', cmsType: 'string' },
      { name: 'count', cmsType: 'integer' },
    ]);

    const got = await client.modules.get('widget');
    assert.equal(got.apiId, 'widget');
    assert.deepEqual(userFields(got), userFields(created));

    const all = await client.modules.list();
    assert.ok(Array.isArray(all));
    assert.ok(all.some((d) => d.apiId === 'widget'), 'list contains the new type');

    const dropped = await client.modules.drop('widget');
    assert.deepEqual(dropped, { apiId: 'widget', dropped: true });

    // After drop the type is gone.
    await assert.rejects(() => client.modules.get('widget'), (e: unknown) => e instanceof NotFoundError);
  } finally {
    await server.close();
  }
});

test('addField / updateField (rename + type change) / dropField mutate the def', async () => {
  const server = await startTestServer('ct-fields');
  try {
    const client = createClient({ baseUrl: server.baseUrl });
    await client.modules.create({ apiId: 'widget', fields: [{ name: 'title', cmsType: 'string' }] });
    try {
      // ADD.
      const added = await client.modules.addField('widget', { name: 'subtitle', cmsType: 'string' });
      assert.ok(added.fields.some((f) => f.name === 'subtitle' && f.cmsType === 'string'));

      // UPDATE: rename `subtitle` → `tagline` AND widen string → text (a metadata-only change) in one PUT.
      const updated = await client.modules.updateField('widget', 'subtitle', {
        newName: 'tagline',
        cmsType: 'text',
      });
      assert.ok(!updated.fields.some((f) => f.name === 'subtitle'), 'old name is gone');
      const tagline = updated.fields.find((f) => f.name === 'tagline');
      assert.ok(tagline, 'renamed field exists');
      assert.equal(tagline!.cmsType, 'text', 'type changed to text');

      // DROP.
      const dropped = await client.modules.dropField('widget', 'tagline');
      assert.ok(!dropped.fields.some((f) => f.name === 'tagline'), 'dropped field is gone');
    } finally {
      await client.modules.drop('widget');
    }
  } finally {
    await server.close();
  }
});

test('create() of a duplicate api_id throws ConflictError (409)', async () => {
  const server = await startTestServer('ct-409');
  try {
    const client = createClient({ baseUrl: server.baseUrl });
    await client.modules.create({ apiId: 'widget', fields: [{ name: 'title', cmsType: 'string' }] });
    try {
      await assert.rejects(
        () => client.modules.create({ apiId: 'widget', fields: [{ name: 'x', cmsType: 'string' }] }),
        (e: unknown) => {
          assert.ok(e instanceof ConflictError);
          assert.equal((e as ConflictError).status, 409);
          return true;
        },
      );
    } finally {
      await client.modules.drop('widget');
    }
  } finally {
    await server.close();
  }
});

test('addField with a duplicate field name throws ConflictError (409)', async () => {
  const server = await startTestServer('ct-field-409');
  try {
    const client = createClient({ baseUrl: server.baseUrl });
    await client.modules.create({ apiId: 'widget', fields: [{ name: 'title', cmsType: 'string' }] });
    try {
      await assert.rejects(
        () => client.modules.addField('widget', { name: 'title', cmsType: 'string' }),
        (e: unknown) => e instanceof ConflictError,
      );
    } finally {
      await client.modules.drop('widget');
    }
  } finally {
    await server.close();
  }
});

test('create() with an invalid api_id throws BadRequestError (400)', async () => {
  const server = await startTestServer('ct-400');
  try {
    const client = createClient({ baseUrl: server.baseUrl });
    await assert.rejects(
      () => client.modules.create({ apiId: '1-bad name!', fields: [{ name: 'title', cmsType: 'string' }] }),
      (e: unknown) => {
        assert.ok(e instanceof BadRequestError);
        assert.equal((e as BadRequestError).status, 400);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('create() with an unknown cmsType throws BadRequestError (400)', async () => {
  const server = await startTestServer('ct-400-type');
  try {
    const client = createClient({ baseUrl: server.baseUrl });
    await assert.rejects(
      // Deliberately bypass the CmsType union to exercise the server's unknown-type 400.
      () => client.modules.create({ apiId: 'widget', fields: [{ name: 'x', cmsType: 'nope' as never }] }),
      (e: unknown) => e instanceof BadRequestError,
    );
  } finally {
    await server.close();
  }
});

test('get / addField / drop on an unknown type throw NotFoundError (404)', async () => {
  const server = await startTestServer('ct-404');
  try {
    const client = createClient({ baseUrl: server.baseUrl });
    await assert.rejects(() => client.modules.get('ghost'), (e: unknown) => e instanceof NotFoundError);
    await assert.rejects(() => client.modules.drop('ghost'), (e: unknown) => e instanceof NotFoundError);
    await assert.rejects(
      () => client.modules.addField('ghost', { name: 'x', cmsType: 'string' }),
      (e: unknown) => e instanceof NotFoundError,
    );
  } finally {
    await server.close();
  }
});

test('updateField with an empty change throws BadRequestError (400); a forbidden type-change too', async () => {
  const server = await startTestServer('ct-update-400');
  try {
    const client = createClient({ baseUrl: server.baseUrl });
    await client.modules.create({
      apiId: 'widget',
      fields: [{ name: 'title', cmsType: 'string' }],
    });
    try {
      // Empty change (no newName, no cmsType) → 400.
      await assert.rejects(
        () => client.modules.updateField('widget', 'title', {}),
        (e: unknown) => e instanceof BadRequestError,
      );
      // string → integer is a data-rewrite change, forbidden in this step → 400.
      await assert.rejects(
        () => client.modules.updateField('widget', 'title', { cmsType: 'integer' }),
        (e: unknown) => e instanceof BadRequestError,
      );
    } finally {
      await client.modules.drop('widget');
    }
  } finally {
    await server.close();
  }
});
