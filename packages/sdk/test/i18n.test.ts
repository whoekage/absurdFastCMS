// i18n — the SDK localization surface (locale read param + createVariant + shared/localized fields)
// end-to-end against the REAL @conti/api uWS server over a fresh per-file Postgres. NO MOCKS.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, withType } from './server.ts';
import { createClient, BadRequestError, NotFoundError } from '../src/index.ts';

// A localized title + a SHARED slug, so the fan-out + copy semantics are both exercised.
const PAGE_FIELDS = [
  { name: 'title', cmsType: 'string' as const, options: { nullable: false }, localized: true },
  { name: 'slug', cmsType: 'string' as const, options: { nullable: true }, localized: false },
];

const DEFAULT_LOCALE = process.env.DEFAULT_LOCALE?.trim() || 'en';

test('create (default locale) → createVariant (fr): same document_id, distinct id+locale, shared slug copied', async () => {
  const server = await startTestServer('i18n-variant');
  try {
    await withType(server, { apiId: 'page', fields: PAGE_FIELDS, i18n: true }, async (apiId) => {
      const client = createClient({ baseUrl: server.baseUrl });

      const en = await client.create(apiId, { title: 'Home', slug: 'home' });
      assert.equal(en.data.locale, DEFAULT_LOCALE, 'a plain create uses the default locale');
      assert.equal(typeof en.data.document_id, 'number', 'document_id is a plain JSON number');
      const docId = en.data.document_id;
      const enId = en.data.id as number;

      const fr = await client.createVariant(apiId, enId, 'fr', { title: 'Accueil' });
      assert.equal(fr.data.document_id, docId, 'a variant reuses the document_id');
      assert.notEqual(fr.data.id, enId, 'a variant is a distinct physical row');
      assert.equal(fr.data.locale, 'fr');
      assert.equal(fr.data.title, 'Accueil', 'the localized field is the request value');
      assert.equal(fr.data.slug, 'home', 'the shared field is COPIED from the sibling');

      // Read semantics: default → en, locale=fr → fr (no fallback), locale=* → all.
      assert.deepEqual((await client.list(apiId)).data.map((r) => r.locale), [DEFAULT_LOCALE]);
      const frRead = await client.list(apiId, { locale: 'fr' });
      assert.equal(frRead.data.length, 1);
      assert.equal(frRead.data[0]!.title, 'Accueil');
      assert.equal((await client.list(apiId, { locale: 'de' })).data.length, 0, 'no fallback for a missing locale');
      assert.equal((await client.list(apiId, { locale: '*' })).data.length, 2, 'locale=* returns all variants');

      // findOne honors locale: the fr variant resolves only under locale=fr.
      assert.equal((await client.findOne(apiId, fr.data.id as number, { locale: 'fr' })).data.title, 'Accueil');
    });
  } finally {
    await server.close();
  }
});

test('shared-field update fans out to all variants; localized-field update stays scoped', async () => {
  const server = await startTestServer('i18n-fanout');
  try {
    await withType(server, { apiId: 'page', fields: PAGE_FIELDS, i18n: true }, async (apiId) => {
      const client = createClient({ baseUrl: server.baseUrl });
      const en = await client.create(apiId, { title: 'Home', slug: 'home' });
      const enId = en.data.id as number;
      const fr = await client.createVariant(apiId, enId, 'fr', { title: 'Accueil' });
      const frId = fr.data.id as number;

      // Shared `slug` update on en → fans out to fr.
      await client.update(apiId, enId, { slug: 'accueil' });
      assert.equal((await client.findOne(apiId, frId, { locale: 'fr' })).data.slug, 'accueil', 'shared field fanned out');

      // Localized `title` update on en → fr title untouched.
      await client.update(apiId, enId, { title: 'Home v2' });
      assert.equal((await client.findOne(apiId, frId, { locale: 'fr' })).data.title, 'Accueil', 'localized field stays scoped');
    });
  } finally {
    await server.close();
  }
});

test('createVariant errors: duplicate locale → 400, missing sibling → 404, non-i18n type → 400, no-op locale on non-i18n', async () => {
  const server = await startTestServer('i18n-errors');
  try {
    await withType(server, { apiId: 'page', fields: PAGE_FIELDS, i18n: true }, async (apiId) => {
      const client = createClient({ baseUrl: server.baseUrl });
      const en = await client.create(apiId, { title: 'Home', slug: 'home' });
      const enId = en.data.id as number;
      await client.createVariant(apiId, enId, 'fr', { title: 'Accueil' });

      // A second fr variant of the same document collides on UNIQUE(document_id, locale).
      await assert.rejects(client.createVariant(apiId, enId, 'fr', { title: 'Dup' }), BadRequestError);
      // A non-existent sibling id → 404.
      await assert.rejects(client.createVariant(apiId, 99999999, 'es', { title: 'Hola' }), NotFoundError);
    });

    // Variant create + locale param on a NON-i18n type.
    await withType(server, { apiId: 'plain', fields: [{ name: 'title', cmsType: 'string' as const }] }, async (apiId) => {
      const client = createClient({ baseUrl: server.baseUrl });
      const row = await client.create(apiId, { title: 'x' });
      await assert.rejects(client.createVariant(apiId, row.data.id as number, 'fr'), BadRequestError);
      // locale is a no-op on a non-i18n type (byte-identical to omitting it); document_id/locale not emitted.
      assert.deepEqual((await client.list(apiId, { locale: 'fr' })).data, (await client.list(apiId)).data);
      assert.equal('document_id' in row.data, false);
      assert.equal('locale' in row.data, false);
    });
  } finally {
    await server.close();
  }
});

test('i18n composes with Draft & Publish (locale=fr & status=published) + projected def exposes flags', async () => {
  const server = await startTestServer('i18n-dp');
  try {
    await withType(server, { apiId: 'page', fields: PAGE_FIELDS, i18n: true, draftPublish: true }, async (apiId) => {
      const client = createClient({ baseUrl: server.baseUrl });

      const en = await client.create(apiId, { title: 'Home', slug: 'home' });
      const fr = await client.createVariant(apiId, en.data.id as number, 'fr', { title: 'Accueil' });
      await client.publish(apiId, fr.data.id as number); // publish ONLY the fr variant.

      const pub = await client.list(apiId, { locale: 'fr', status: 'published' });
      assert.equal(pub.data.length, 1, 'the published fr variant is returned');
      assert.equal(pub.data[0]!.title, 'Accueil');
      // The en variant is still a draft → excluded from the default (published-only) read.
      assert.equal((await client.list(apiId)).data.length, 0);

      // The projected def exposes i18n + per-field localized.
      const def = await client.modules.get(apiId);
      assert.equal(def.i18n, true);
      assert.equal(def.fields.find((f) => f.name === 'title')!.localized, true);
      assert.equal(def.fields.find((f) => f.name === 'slug')!.localized, false);
      assert.ok(def.fields.find((f) => f.name === 'document_id'));
      assert.ok(def.fields.find((f) => f.name === 'locale'));
    });
  } finally {
    await server.close();
  }
});
