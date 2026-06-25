import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { PostgresStore } from '../src/db/postgres.store.ts';
import { createServer, type ListenToken } from '../src/http/uws.adapter.ts';
import { migrate } from '../src/db/schema/migrate.ts';
import type { ContentTypeSchema } from '../src/db/schema/model.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { freePort, physicalColumns, ct, ARTICLE_SCHEMA } from './helpers.ts';

/**
 * be-06 i18n — READ-SIDE + SCHEMA, end-to-end over a REAL uWS server + REAL Postgres (.env.test), no
 * mocks. Proves the conditional schema (an i18n type gets a NOT NULL `locale` column + UNIQUE(document_id,
 * locale); document_id un-skips: loaded + indexed + emitted as a JSON number), the locale read semantics
 * (default DEFAULT_LOCALE, locale=<code>, locale=*, no fallback, index-backed eq), and — CRITICALLY — that
 * a NON-i18n type stays BYTE-IDENTICAL (no locale column, document_id still loader-skipped, not emitted).
 *
 * The WRITE-SIDE (locale fan-out + variant create over HTTP) is the NEXT slice; here the locale variant
 * rows are inserted directly via SQL (the read-side does not depend on the write verb), then the engine is
 * loaded fresh so the read path sees them — exactly the surface this slice owns.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let token: ListenToken;
let base: string;
let close: (t: ListenToken) => void;
let baseSchemas: ContentTypeSchema[]; // the catalog seeded in before() — the mid-test type adds to this
let baseRegistry: Awaited<ReturnType<PostgresStore['loadFromSchemas']>>['registry'];

// DEFAULT_LOCALE is read from .env.test; the read router resolves a locale-less read of an i18n type to it.
// We do NOT assume a specific value — we assert relative to whichever variant we tag as the default below.
const DEFAULT_LOCALE = process.env.DEFAULT_LOCALE?.trim() || 'en';

before(async () => {
  db = await createFileDatabase('i18n');
  sql = db.sql;
  // A NON-i18n type (the seed article) to assert byte-identity is unaffected + an i18n-ENABLED `page`.
  const page = ct({
    apiId: 'page',
    fields: [{ name: 'title', cmsType: 'string', options: { nullable: false } }],
    i18n: true,
  });
  baseSchemas = [ARTICLE_SCHEMA, page];
  await migrate(sql, baseSchemas, { allowDestructive: true });

  // Seed locale variants DIRECTLY (write verb is the next slice). Two documents, each with 2 locales:
  //   document_id=100: { DEFAULT_LOCALE: "Home", "fr": "Accueil" }
  //   document_id=200: { DEFAULT_LOCALE: "About" }   (only the default-locale variant exists)
  await sql.unsafe(
    `INSERT INTO ct_page (document_id, locale, title) VALUES
       (100, $1, 'Home'),
       (100, 'fr', 'Accueil'),
       (200, $1, 'About')`,
    [DEFAULT_LOCALE],
  );

  const store = new PostgresStore(sql);
  const { engine, registry } = await store.loadFromSchemas(baseSchemas);
  baseRegistry = registry;
  const server = createServer(engine, store, registry);
  const port = await freePort();
  token = await server.listen(port);
  close = server.close;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (token) close(token);
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

test('an i18n type physically has a NOT NULL locale column + UNIQUE(document_id, locale)', async () => {
  const cols = await physicalColumns(sql, 'ct_page');
  const loc = cols.find((c) => c.name === 'locale');
  assert.ok(loc, 'locale column must exist on an i18n type');
  assert.equal(loc!.nullable, false, 'locale must be NOT NULL (every variant row has a locale)');

  // The UNIQUE(document_id, locale) constraint exists.
  const uq = await sql<{ conname: string }[]>`
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'ct_page' AND con.contype = 'u'
      AND (SELECT array_agg(att.attname::text ORDER BY att.attname)
           FROM unnest(con.conkey) AS k(attnum)
           JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum)
          = ARRAY['document_id','locale']
  `;
  assert.equal(uq.length, 1, 'UNIQUE(document_id, locale) must exist on an i18n type');

  // A duplicate (document_id, locale) is rejected by the DB.
  await assert.rejects(
    sql.unsafe(`INSERT INTO ct_page (document_id, locale, title) VALUES (100, $1, 'Dup')`, [DEFAULT_LOCALE]),
    /duplicate key|unique/i,
  );
});

test('a NON-i18n type (article) has NO locale column — byte-identical', async () => {
  const cols = await physicalColumns(sql, 'ct_article');
  assert.equal(cols.find((c) => c.name === 'locale'), undefined, 'a non-i18n type must NOT have a locale column');
});

test('document_id is loaded + emitted as a JSON NUMBER for an i18n type', async () => {
  // GET a single variant: document_id + locale appear on the wire; document_id is a plain number.
  const res = await fetch(`${base}/page?locale=${encodeURIComponent(DEFAULT_LOCALE)}&filters[document_id][$eq]=100`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.length, 1, 'document_id must be queryable (index-backed eq filter)');
  const row = body.data[0];
  assert.equal(row.document_id, 100);
  assert.equal(typeof row.document_id, 'number', 'document_id is a plain JSON number, never a string');
  assert.equal(row.locale, DEFAULT_LOCALE);
  assert.equal(row.title, 'Home');
});

test('document_id is NOT emitted for a NON-i18n type (the be-02b loader-skip stays in force)', async () => {
  const res = await fetch(`${base}/article`);
  assert.equal(res.status, 200);
  const body = await res.json();
  // The seed article may have 0 rows; just assert the key is absent if any row exists, and that a
  // document_id filter is rejected as an unknown field (it is NOT a projected/queryable column).
  for (const row of body.data) {
    assert.equal('document_id' in row, false, 'document_id must NOT be emitted on a non-i18n type');
    assert.equal('locale' in row, false, 'locale must NOT be emitted on a non-i18n type');
  }
  const bad = await fetch(`${base}/article?filters[document_id][$eq]=1`);
  assert.equal(bad.status, 400, 'document_id is not a queryable field on a non-i18n type');
});

test('default locale: a locale-less read returns only the DEFAULT_LOCALE variants', async () => {
  const res = await fetch(`${base}/page`);
  assert.equal(res.status, 200);
  const body = await res.json();
  // document 100 (default) + document 200 (default) — the fr variant of 100 is excluded.
  assert.equal(body.data.length, 2);
  for (const row of body.data) assert.equal(row.locale, DEFAULT_LOCALE);
  const titles = body.data.map((r: { title: string }) => r.title).sort();
  assert.deepEqual(titles, ['About', 'Home']);
});

test('locale=<code> selects exactly that locale; no fallback for a missing variant', async () => {
  const fr = await (await fetch(`${base}/page?locale=fr`)).json();
  assert.equal(fr.data.length, 1, 'only document 100 has an fr variant; document 200 does NOT fall back');
  assert.equal(fr.data[0].locale, 'fr');
  assert.equal(fr.data[0].title, 'Accueil');
  assert.equal(fr.data[0].document_id, 100);

  // A locale with NO variants at all -> empty (no fallback to default).
  const de = await (await fetch(`${base}/page?locale=de`)).json();
  assert.equal(de.data.length, 0, 'a locale with no variants returns nothing (NO fallback)');
});

test('locale=* returns ALL variants (no predicate)', async () => {
  const res = await fetch(`${base}/page?locale=*`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.length, 3, 'all variants: 100/default, 100/fr, 200/default');
});

test('an invalid locale slug is a 400 on any type (validated at parse time)', async () => {
  assert.equal((await fetch(`${base}/page?locale=en%20US`)).status, 400, 'space is illegal in a slug');
  assert.equal((await fetch(`${base}/page?locale=`)).status, 400, 'empty locale is rejected');
  // Validated even on a NON-i18n type (the effect is a no-op there, but the token must still parse).
  assert.equal((await fetch(`${base}/article?locale=en%20US`)).status, 400);
});

test('locale is a no-op on a NON-i18n type (byte-identical to no locale param)', async () => {
  const withLocale = await fetch(`${base}/article?locale=fr`);
  const without = await fetch(`${base}/article`);
  assert.equal(withLocale.status, 200);
  assert.equal(without.status, 200);
  assert.deepEqual(await withLocale.json(), await without.json(), 'locale must not change a non-i18n read');
});

// --- WRITE-SIDE: variant create + shared-field fan-out + locale-scoped updates -------------------

/**
 * A second i18n type with a SHARED field (`summary`, localized:false) and a LOCALIZED field (`title`),
 * plus draft_publish, exercised entirely over the HTTP write verbs (no direct SQL). `post`/`put`/`get`
 * are tiny fetch helpers.
 */
async function post(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: res.status === 204 ? null : await res.json() };
}
async function put(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
async function getJson(path: string): Promise<any> {
  return (await fetch(`${base}${path}`)).json();
}

test('write-side: plain create -> variant create (same document_id, distinct id+locale) -> locale reads', async () => {
  // A dedicated i18n type: localized `title`, SHARED `summary`, plus draft_publish (compose test below).
  const doc = ct({
    apiId: 'doc',
    fields: [
      { name: 'title', cmsType: 'string', options: { nullable: false }, localized: true },
      { name: 'summary', cmsType: 'string', options: { nullable: true }, localized: false },
    ],
    i18n: true,
    draftPublish: true,
  });
  const schemas = [...baseSchemas, doc]; // the FULL desired catalog (migrate diffs against the applied snapshot)
  await migrate(sql, schemas, { allowDestructive: true });
  // Reload the running server's engine+registry so the new type is live on THIS server instance.
  const store = new PostgresStore(sql);
  const { engine, registry } = await store.loadFromSchemas(schemas);
  if (token) close(token);
  const server = createServer(engine, store, registry, () => new Date('2026-01-01T00:00:00.000Z'));
  const port = await freePort();
  token = await server.listen(port);
  close = server.close;
  base = `http://127.0.0.1:${port}`;

  // 1) Plain create -> default-locale variant, fresh document_id, server-set locale.
  const created = await post('/doc', { title: 'Hello', summary: 'A doc' });
  assert.equal(created.status, 201);
  const enRow = created.json.data;
  assert.equal(enRow.locale, DEFAULT_LOCALE, 'a plain create uses the default locale');
  assert.equal(typeof enRow.document_id, 'number');
  const docId = enRow.document_id;
  const enId = enRow.id;

  // 2) Variant create -> joins the SAME document, distinct id + locale, COPIES the shared `summary`.
  const fr = await post(`/doc/${enId}/locales/fr`, { title: 'Bonjour' });
  assert.equal(fr.status, 201);
  assert.equal(fr.json.data.document_id, docId, 'a variant reuses the document_id');
  assert.notEqual(fr.json.data.id, enId, 'a variant is a distinct physical row');
  assert.equal(fr.json.data.locale, 'fr');
  assert.equal(fr.json.data.title, 'Bonjour', 'the localized field is the request value');
  assert.equal(fr.json.data.summary, 'A doc', 'the shared field is COPIED from the sibling');

  // These are DRAFT (draft_publish defaults to draft); publish both so the default status read sees them.
  await post(`/doc/${enId}/actions/publish`);
  await post(`/doc/${fr.json.data.id}/actions/publish`);

  // 3) locale reads: default returns en only, locale=fr returns fr, locale=* returns both.
  const def = await getJson('/doc');
  assert.equal(def.data.length, 1);
  assert.equal(def.data[0].locale, DEFAULT_LOCALE);
  const frRead = await getJson('/doc?locale=fr');
  assert.equal(frRead.data.length, 1);
  assert.equal(frRead.data[0].title, 'Bonjour');
  const all = await getJson('/doc?locale=*');
  assert.equal(all.data.length, 2);
});

test('write-side: a SHARED-field update propagates to ALL variants; a LOCALIZED update stays scoped', async () => {
  // Grab the two variants of the single document created above (locale=* lists both).
  const all = await getJson('/doc?locale=*');
  const en = all.data.find((r: any) => r.locale === DEFAULT_LOCALE);
  const fr = all.data.find((r: any) => r.locale === 'fr');

  // Update the SHARED `summary` on the EN row -> must fan out to the FR sibling too.
  const upd = await put(`/doc/${en.id}`, { summary: 'Updated shared' });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.data.summary, 'Updated shared');
  const frAfter = (await getJson('/doc?locale=fr')).data[0];
  assert.equal(frAfter.summary, 'Updated shared', 'a shared-field update fans out to the fr variant');

  // Update the LOCALIZED `title` on the EN row -> must NOT touch the FR title.
  await put(`/doc/${en.id}`, { title: 'Hello again' });
  const enAfter = (await getJson(`/doc?locale=${encodeURIComponent(DEFAULT_LOCALE)}`)).data[0];
  const frTitle = (await getJson('/doc?locale=fr')).data[0];
  assert.equal(enAfter.title, 'Hello again');
  assert.equal(frTitle.title, 'Bonjour', 'a localized-field update stays scoped to the addressed variant');
});

test('write-side: UNIQUE(document_id, locale) rejects a duplicate-locale variant create -> 400', async () => {
  const all = await getJson('/doc?locale=*');
  const en = all.data.find((r: any) => r.locale === DEFAULT_LOCALE);
  // fr already exists for this document -> a second fr variant collides on UNIQUE(document_id, locale).
  const dup = await post(`/doc/${en.id}/locales/fr`, { title: 'Doublon' });
  assert.equal(dup.status, 400, 'a duplicate (document_id, locale) is a clean 400, not a 500');
});

test('write-side: variant create on a NON-i18n type -> 400; bad slug -> 400; missing sibling -> 404', async () => {
  // article is non-i18n: the variant verb is rejected.
  const article = await getJson('/article');
  const someId = article.data[0]?.id ?? 1;
  const notI18n = await post(`/article/${someId}/locales/fr`, {});
  assert.equal(notI18n.status, 400, 'variant create on a non-i18n type -> 400');

  // A malformed locale slug -> 400 (validated identically to the read query param).
  const badSlug = await post(`/doc/1/locales/en%20US`, { title: 'x' });
  assert.equal(badSlug.status, 400);

  // A non-existent sibling id -> 404.
  const missing = await post(`/doc/99999999/locales/es`, { title: 'Hola' });
  assert.equal(missing.status, 404);
});

test('write-side: i18n composes with draft & publish (locale=fr&status=published)', async () => {
  // Create a fresh document, add an fr variant, publish ONLY the fr variant.
  const created = await post('/doc', { title: 'Compose', summary: 's' });
  const enId = created.json.data.id;
  const fr = await post(`/doc/${enId}/locales/fr`, { title: 'Composer' });
  await post(`/doc/${fr.json.data.id}/actions/publish`);

  // locale=fr & status=published -> the published fr variant.
  const pub = await getJson('/doc?locale=fr&status=published');
  const composeFr = pub.data.find((r: any) => r.title === 'Composer');
  assert.ok(composeFr, 'the published fr variant is returned by locale=fr&status=published');

  // locale=fr & status=draft -> the fr variant is published, so it must NOT appear as a draft.
  const draft = await getJson('/doc?locale=fr&status=draft');
  assert.equal(draft.data.find((r: any) => r.title === 'Composer'), undefined, 'a published fr variant is not a draft');

  // The EN variant is still a draft -> default (published-only) read excludes it.
  const enDefault = await getJson('/doc');
  assert.equal(enDefault.data.find((r: any) => r.title === 'Compose'), undefined, 'the unpublished en variant is excluded by default');
});

test('the registry def carries i18n + per-field localized + the synthesized system fields only for an i18n type', () => {
  // Files-first source of truth: the registry def (the legacy GET /content-types/:apiId projection is gone).
  const page = baseRegistry.get('page')!;
  assert.equal(page.i18n, true, 'an i18n type carries i18n:true');
  assert.equal(page.fields.find((f) => f.name === 'title')!.localized, true, 'a field defaults to localized:true');
  // document_id + locale are synthesized + appended as system fields on an i18n type's def.
  assert.ok(page.fields.find((f) => f.name === 'document_id'));
  assert.ok(page.fields.find((f) => f.name === 'locale'));

  const article = baseRegistry.get('article')!;
  assert.equal(article.i18n, false, 'a non-i18n type carries i18n:false');
  // A non-i18n type synthesizes NEITHER document_id (loader-skip stays) NOR locale.
  assert.equal(article.fields.find((f) => f.name === 'document_id'), undefined);
  assert.equal(article.fields.find((f) => f.name === 'locale'), undefined);
});
